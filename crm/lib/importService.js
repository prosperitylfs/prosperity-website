// CSV client import: parsing, preview (dry run), commit, and a downloadable
// fake sample. Every function takes an explicit better-sqlite3 `db` handle
// — never opens a connection itself, never imports crm/db/database.js.
//
// Company is NEVER inferred from product — the caller must supply either a
// single brandSlug for the whole batch, or a mapped "company" column with a
// value that resolves to a known brand for every row; a batch with neither
// is rejected outright before any row is processed.
//
// A dry run (dryRun: true) never creates or updates a row in contacts,
// contact_brands, or cases — only the import_batches/import_rows AUDIT
// tables are written, so the preview and its audit record exist even
// though no client data changed. A likely duplicate (matched by normalized
// email or phone) is never silently created or overwritten in EITHER mode
// — it always requires an explicit per-row decision ('skip' | 'update'),
// defaulting to 'skip' when none is given.

const { normalizeEmail, normalizePhone, toStringOrNull } = require('./leadNormalize');
const { resolveContactBrand, findConflictingActiveBrand, stageUnresolvedIntake } = require('./caseMatching');
const { isKnownBrandId, BRANDS } = require('../config/brands');
const { createCaseForClient } = require('./caseService');
const { createPolicy } = require('./policyService');

// ── CSV parsing (no external dependency — RFC4180-ish, handles quoted
//    fields containing commas/quotes/newlines) ────────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\r') { /* ignore, \n handles the line break */ }
    else if (c === '\n') pushRow();
    else field += c;
  }
  if (field !== '' || row.length) pushRow();
  const clean = rows.filter(r => !(r.length === 1 && r[0] === ''));
  if (!clean.length) return { headers: [], records: [] };
  const headers = clean[0].map(h => h.trim());
  const records = clean.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] || '').trim(); });
    return obj;
  });
  return { headers, records };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function findExistingContact(db, { email, phone_e164, phone }) {
  let existing = null;
  if (email) existing = db.prepare('SELECT * FROM contacts WHERE email = ?').get(email);
  if (!existing && phone_e164) existing = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get(phone_e164);
  if (!existing && phone) existing = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  return existing || null;
}

function resolveRowBrandSlug(row, columnMapping, batchBrandSlug) {
  if (columnMapping.company && row[columnMapping.company]) {
    const raw = row[columnMapping.company].trim().toLowerCase();
    if (raw === 'insurance lady' || raw === 'insurance-lady') return 'insurance-lady';
    if (raw === 'prosperity') return 'prosperity';
    return null; // unrecognized company value -- treated as invalid below
  }
  return batchBrandSlug || null;
}

function mapRow(row, columnMapping) {
  const get = (key) => (columnMapping[key] ? (row[columnMapping[key]] || '').trim() : '');
  return {
    firstName: get('firstName'), lastName: get('lastName'), email: get('email'),
    phone: get('phone'), address: get('address'), city: get('city'), state: get('state'),
    zip: get('zip'), dateOfBirth: get('dateOfBirth'), originalSource: get('originalSource'),
    generalNotes: get('generalNotes'),
    // Policy/case fields — used for importing an existing client's policy
    // from any carrier (Prosperity Revenue MVP, Requirement 1). Company is
    // still NEVER inferred from any of these — see resolveRowBrandSlug,
    // which never reads productName/carrier/etc. Carrier itself is always
    // taken from the row's own data, never assumed or hard-coded.
    productName: get('productName'), carrier: get('carrier'), policyNumber: get('policyNumber'),
    effectiveDate: get('effectiveDate'), premium: get('premium'),
    premiumFrequency: get('premiumFrequency'), policyStatus: get('policyStatus'),
  };
}

function validateRow(mapped, brandSlug) {
  const errors = [];
  if (!mapped.firstName && !mapped.lastName) errors.push('missing name');
  const email = normalizeEmail(mapped.email);
  const { e164: phoneE164 } = normalizePhone(mapped.phone);
  if (mapped.email && !EMAIL_RE.test(mapped.email)) errors.push('invalid email format');
  if (mapped.phone && !phoneE164) errors.push('invalid phone number');
  if (!email && !phoneE164) errors.push('email or phone is required');
  if (mapped.dateOfBirth && !DATE_RE.test(mapped.dateOfBirth)) errors.push('date of birth must be YYYY-MM-DD');
  if (mapped.effectiveDate && !DATE_RE.test(mapped.effectiveDate)) errors.push('effective date must be YYYY-MM-DD');
  if (mapped.premium && !/^\d+(\.\d{1,2})?$/.test(mapped.premium)) errors.push('premium must be a plain number');
  if (!brandSlug) errors.push('company could not be determined for this row (no batch company and no valid company column value)');
  else if (!isKnownBrandId(brandSlug)) errors.push(`unknown company '${brandSlug}'`);
  return errors;
}

// A row carrying any policy field is an existing-book-of-business import
// (e.g. the Occidental client list) rather than a fresh inbound lead — used
// both to decide whether to attach a case+policy (below) and to classify
// the resulting contact as an existing client rather than 'New Lead' (see
// the lead_status assignment in runImport). An ordinary CSV import with no
// policy columns mapped is completely unaffected — it still gets 'New
// Lead', exactly as before.
function hasPolicyData(mapped) {
  return !!(mapped.productName || mapped.carrier || mapped.policyNumber || mapped.premium
    || mapped.effectiveDate || mapped.premiumFrequency || mapped.policyStatus);
}

// Product/carrier/policy number/effective date/premium are only ever used
// to attach a case+policy to a client that was just created or explicitly
// updated in THIS row — never inferred, never applied to a skipped
// duplicate, and never used to determine which company the row belongs to
// (see resolveRowBrandSlug above, which this function is never called by).
function attachPolicyIfPresent(db, { contactId, rowBrandSlug, mapped, actor }) {
  if (!hasPolicyData(mapped)) return null;

  const brandRow = db.prepare('SELECT id FROM brands WHERE slug = ?').get(rowBrandSlug);
  let productId = null;
  if (mapped.productName) {
    const product = db.prepare('SELECT id FROM products WHERE brand_id = ? AND LOWER(name) = LOWER(?)').get(brandRow.id, mapped.productName);
    productId = product ? product.id : null;
  }

  const newCase = createCaseForClient(db, {
    contactId, productId, title: mapped.productName || 'Imported policy',
  }, actor);

  const policy = createPolicy(db, {
    caseId: newCase.id,
    carrier: mapped.carrier || null,
    policyNumber: mapped.policyNumber || null,
    effectiveDate: mapped.effectiveDate || null,
    premium: mapped.premium || null,
    premiumFrequency: mapped.premiumFrequency || null,
    policyStatus: mapped.policyStatus || null,
    notes: mapped.generalNotes || null,
  }, actor);

  return { case: newCase, policy };
}

// Processes every row once, in either mode. Returns { batchId, results,
// summary }. results[i]: { rowNumber, outcome, detail, contactId }.
// outcome: 'would_create' | 'would_update' | 'likely_duplicate' | 'invalid'
//   (dry run) or 'created' | 'updated' | 'skipped' | 'staged_for_review' |
//   'failed' (commit).
function runImport(db, { records, columnMapping, brandSlug, dryRun, filename, duplicateDecisions = {}, actor }) {
  if (!actor) throw new Error('runImport: actor is required for the audit trail');
  if (!columnMapping || (!columnMapping.email && !columnMapping.phone)) {
    throw new Error('runImport: column mapping must map at least an email or phone column');
  }

  const batchResult = db.prepare(`
    INSERT INTO import_batches (filename, brand_id, status, created_by)
    VALUES (?, ?, ?, ?)
  `).run(filename || null, brandSlug ? (db.prepare('SELECT id FROM brands WHERE slug = ?').get(brandSlug) || {}).id || null : null, dryRun ? 'dry_run' : 'committed', actor);
  const batchId = batchResult.lastInsertRowid;

  const results = [];
  const summary = { created: 0, updated: 0, skipped: 0, staged_for_review: 0, failed: 0, would_create: 0, would_update: 0, likely_duplicate: 0, invalid: 0 };

  records.forEach((row, idx) => {
    const rowNumber = idx + 1;
    const mapped = mapRow(row, columnMapping);
    const rowBrandSlug = resolveRowBrandSlug(row, columnMapping, brandSlug);
    const errors = validateRow(mapped, rowBrandSlug);

    if (errors.length) {
      const outcome = dryRun ? 'invalid' : 'failed';
      summary[outcome]++;
      results.push(recordRow(db, batchId, rowNumber, row, outcome, errors.join('; '), null));
      return;
    }

    const email = normalizeEmail(mapped.email);
    const { display: phoneDisplay, e164: phoneE164 } = normalizePhone(mapped.phone);
    const existing = findExistingContact(db, { email, phone_e164: phoneE164, phone: phoneDisplay });

    if (existing) {
      const decision = duplicateDecisions[String(rowNumber)] || 'skip';
      if (dryRun) {
        summary.likely_duplicate++;
        results.push(recordRow(db, batchId, rowNumber, row, 'likely_duplicate', `matches existing client #${existing.id} (${existing.first_name || ''} ${existing.last_name || ''})`.trim(), existing.id));
        return;
      }
      if (decision === 'update') {
        const brandRow = db.prepare('SELECT id FROM brands WHERE slug = ?').get(rowBrandSlug);
        const conflict = findConflictingActiveBrand(db, existing.id, brandRow.id);
        if (conflict) {
          stageUnresolvedIntake(db, {
            source: `csv_import:${filename || 'unnamed'}`, rawPayload: row, candidateContactId: existing.id,
            reason: `CSV import row ${rowNumber} resolved to a different company than this client's existing active assignment — requires deliberate review`,
            reviewType: 'company_conflict', contactBrandId: conflict.id, incomingBrandId: brandRow.id,
          });
          summary.staged_for_review++;
          results.push(recordRow(db, batchId, rowNumber, row, 'staged_for_review', 'company conflict staged for review — client not modified', existing.id));
          return;
        }
        db.prepare(`
          UPDATE contacts SET
            first_name = COALESCE(@first_name, first_name), last_name = COALESCE(@last_name, last_name),
            street_address = COALESCE(@street_address, street_address), city = COALESCE(@city, city),
            state = COALESCE(@state, state), zip_code = COALESCE(@zip_code, zip_code),
            date_of_birth = COALESCE(@date_of_birth, date_of_birth), lead_source = COALESCE(@lead_source, lead_source),
            general_notes = COALESCE(@general_notes, general_notes), updated_at = CURRENT_TIMESTAMP
          WHERE id = @id
        `).run({
          first_name: toStringOrNull(mapped.firstName), last_name: toStringOrNull(mapped.lastName),
          street_address: toStringOrNull(mapped.address), city: toStringOrNull(mapped.city),
          state: toStringOrNull(mapped.state), zip_code: toStringOrNull(mapped.zip),
          date_of_birth: toStringOrNull(mapped.dateOfBirth), lead_source: toStringOrNull(mapped.originalSource),
          general_notes: toStringOrNull(mapped.generalNotes), id: existing.id,
        });
        resolveContactBrand(db, { contactId: existing.id, brandId: brandRow.id });
        const attached = attachPolicyIfPresent(db, { contactId: existing.id, rowBrandSlug, mapped, actor });
        summary.updated++;
        results.push(recordRow(db, batchId, rowNumber, row, 'updated', `updated existing client #${existing.id}`
          + (attached ? ` and attached a new case + policy (case #${attached.case.id}, policy #${attached.policy.id})` : ''), existing.id));
        return;
      }
      // decision === 'skip' (default) or 'review' -- never silently overwrite.
      summary.skipped++;
      results.push(recordRow(db, batchId, rowNumber, row, 'skipped', 'likely duplicate — left unchanged (no explicit "update" decision given)', existing.id));
      return;
    }

    // No existing contact.
    const rowHasPolicyData = hasPolicyData(mapped);
    if (dryRun) {
      summary.would_create++;
      const policyNote = rowHasPolicyData ? ` as an Existing Client with a ${mapped.productName || 'policy'} case + policy` : '';
      results.push(recordRow(db, batchId, rowNumber, row, 'would_create', `would create a new ${BRANDS[rowBrandSlug].shortName} client${policyNote}`, null));
      return;
    }

    // A row carrying policy data represents an existing policyholder being
    // brought into the CRM (e.g. the Occidental import), never a fresh
    // inbound lead — classified 'Existing Client' so it can never be
    // counted as a New Lead (crm/routes/stats.js's New Leads tile filters
    // on lead_status = 'New Lead' directly). A plain CSV import with no
    // policy columns mapped is unaffected and still becomes 'New Lead'.
    const insert = db.prepare(`
      INSERT INTO contacts (first_name, last_name, email, phone, phone_e164, street_address, city, state, zip_code, date_of_birth, lead_source, general_notes, lead_status, updated_at)
      VALUES (@first_name, @last_name, @email, @phone, @phone_e164, @street_address, @city, @state, @zip_code, @date_of_birth, @lead_source, @general_notes, @lead_status, CURRENT_TIMESTAMP)
    `).run({
      first_name: toStringOrNull(mapped.firstName), last_name: toStringOrNull(mapped.lastName),
      email: email || null, phone: phoneDisplay, phone_e164: phoneE164,
      street_address: toStringOrNull(mapped.address), city: toStringOrNull(mapped.city),
      state: toStringOrNull(mapped.state), zip_code: toStringOrNull(mapped.zip),
      date_of_birth: toStringOrNull(mapped.dateOfBirth), lead_source: toStringOrNull(mapped.originalSource) || `CSV import: ${filename || 'unnamed'}`,
      general_notes: toStringOrNull(mapped.generalNotes),
      lead_status: rowHasPolicyData ? 'Existing Client' : 'New Lead',
    });
    const newContactId = insert.lastInsertRowid;
    const brandRow = db.prepare('SELECT id FROM brands WHERE slug = ?').get(rowBrandSlug);
    resolveContactBrand(db, { contactId: newContactId, brandId: brandRow.id });
    const attached = attachPolicyIfPresent(db, { contactId: newContactId, rowBrandSlug, mapped, actor });
    summary.created++;
    results.push(recordRow(db, batchId, rowNumber, row, 'created', `created new client #${newContactId}`
      + (attached ? ` with a new case + policy (case #${attached.case.id}, policy #${attached.policy.id})` : ''), newContactId));
  });

  if (!dryRun) {
    db.prepare("UPDATE import_batches SET committed_at = CURRENT_TIMESTAMP WHERE id = ?").run(batchId);
  }

  return { batchId, results, summary };
}

function recordRow(db, batchId, rowNumber, rawRow, outcome, detail, contactId) {
  db.prepare(`
    INSERT INTO import_rows (batch_id, row_number, raw_row, outcome, outcome_detail, contact_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(batchId, rowNumber, JSON.stringify(rawRow), outcome, detail || null, contactId || null);
  return { rowNumber, outcome, detail, contactId };
}

function getImportBatch(db, batchId) {
  const batch = db.prepare('SELECT * FROM import_batches WHERE id = ?').get(batchId);
  if (!batch) return null;
  const rows = db.prepare('SELECT * FROM import_rows WHERE batch_id = ? ORDER BY row_number ASC').all(batchId);
  return { batch, rows };
}

function generateSampleCsv() {
  const header = 'First Name,Last Name,Email,Phone,Address,City,State,Zip,Date of Birth,Company,Original Source,Notes';
  const rows = [
    'Wendell,Park,wendell.park@example-mail.com,414-555-7712,921 Oak St,Milwaukee,WI,53202,1968-04-11,Prosperity,Referral - Family,Interested in retirement rollover',
    'Sylvia,Ortega,sylvia.ortega@example-mail.com,414-555-7713,44 Birch Ave,West Allis,WI,53214,1979-11-02,Insurance Lady,Facebook Ad,Wants final expense coverage',
    'Marcus,Bell,marcus.bell@example-mail.com,414-555-7714,,,,,,Prosperity,Existing Client,',
  ];
  return [header, ...rows].join('\n') + '\n';
}

// Sample matching the field list for importing an existing client with a
// policy attached (Prosperity Revenue MVP, Requirement 1) — carrier-neutral:
// the Carrier column is just another mapped field, filled in per row from
// the CSV data, exactly like every other field here. Never hard-coded to
// any one insurance company. The three sample rows deliberately use
// different carriers to make that explicit. Every name, number, and policy
// detail below is invented for this download, never real client data.
function generateClientPolicySampleCsv() {
  const header = 'First Name,Last Name,Phone,Email,Address,City,State,Zip,Product,Carrier,Policy Number,Effective Date,Premium,Premium Frequency,Policy Status,Notes,Original Source';
  const rows = [
    'Harold,Voss,414-555-2201,harold.voss@example-mail.com,118 Maple Ct,Milwaukee,WI,53204,Life insurance,Occidental Life,OCC-40021,2019-06-01,54.00,Monthly,Active,Existing whole life policy — annual review due,Existing Client',
    'Ines,Calloway,414-555-2202,ines.calloway@example-mail.com,872 Elm St,Greenfield,WI,53220,Annuities,Mutual of Omaha,MOO-77213,2021-02-15,,Annual,Active,Fixed annuity — client asked about withdrawal options,Existing Client',
    'Deshawn,Priest,414-555-2203,deshawn.priest@example-mail.com,,,,,Life insurance,Foresters Financial,FF-90042,2016-09-10,88.50,Monthly,Active,,Existing Client',
  ];
  return [header, ...rows].join('\n') + '\n';
}

module.exports = { parseCsv, runImport, getImportBatch, generateSampleCsv, generateClientPolicySampleCsv, findExistingContact };
