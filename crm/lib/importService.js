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
const SLASH_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

// Two-digit-year resolution: same convention Excel itself uses for typed
// two-digit years — 00-29 resolves to 2000-2029, 30-99 resolves to
// 1930-1999. This is why a Date of Birth like "02/26/50" correctly becomes
// 1950 (a plausible birth year) rather than 2050, while a Policy Date like
// "11/03/24" correctly becomes 2024 (a plausible recent policy date) —
// same fixed rule, no per-field guessing about which date type it is.
const TWO_DIGIT_YEAR_PIVOT = 30;
function resolveTwoDigitYear(yy) {
  return yy < TWO_DIGIT_YEAR_PIVOT ? 2000 + yy : 1900 + yy;
}

// Accepts YYYY-MM-DD (passed through unchanged), MM/DD/YYYY, or MM/DD/YY
// and normalizes all three to YYYY-MM-DD for storage. Anything else —
// including a value SLASH_DATE_RE matches syntactically but that isn't a
// real calendar date (e.g. 02/30/2020), or genuinely unrecognized text —
// is returned UNCHANGED rather than guessed at, so validateRow's existing
// strict YYYY-MM-DD check still correctly flags it as invalid. Never
// throws; a malformed or empty value just passes through untouched.
function normalizeDateField(raw) {
  const s = String(raw || '').trim();
  if (!s || DATE_RE.test(s)) return s;

  const m = SLASH_DATE_RE.exec(s);
  if (!m) return s;

  const month = Number(m[1]);
  const day = Number(m[2]);
  const yearPart = m[3];
  const year = yearPart.length === 2 ? resolveTwoDigitYear(Number(yearPart)) : Number(yearPart);

  if (month < 1 || month > 12 || day < 1 || day > 31) return s;

  // Round-trip through Date.UTC to reject calendar-impossible combinations
  // (e.g. 02/30/2020, 04/31/2019) instead of silently accepting them.
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return s;
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function findExistingContact(db, { email, phone_e164, phone }) {
  let existing = null;
  if (email) existing = db.prepare('SELECT * FROM contacts WHERE email = ?').get(email);
  if (!existing && phone_e164) existing = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get(phone_e164);
  if (!existing && phone) existing = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  return existing || null;
}

// Same email -> phone_e164 -> phone lookup priority as findExistingContact,
// but against the dry-run-only in-memory pendingContacts list in runImport
// instead of the database.
function findPendingContact(pending, { email, phone_e164, phone }) {
  if (email) { const m = pending.find(p => p.email && p.email === email); if (m) return m; }
  if (phone_e164) { const m = pending.find(p => p.phone_e164 && p.phone_e164 === phone_e164); if (m) return m; }
  if (phone) { const m = pending.find(p => p.phone && p.phone === phone); if (m) return m; }
  return null;
}

// Trim, collapse internal whitespace to single spaces, drop trailing
// periods/commas, lowercase — so "Prosperity Life & Financial Solutions
// LLC.", "prosperity  llc", and "Prosperity" all normalize the same way
// before comparison.
function normalizeCompanyValue(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ').replace(/[.,]+$/g, '').toLowerCase();
}

// Built from the actual brand config (config/brands.js) rather than a
// hand-guessed list, so every brand's slug, slug-with-space, short name,
// and full legal name are all recognized — e.g. a CSV Company column
// containing "Prosperity Life & Financial Solutions LLC" (the real legal
// name) resolves exactly the same as one containing plain "Prosperity".
const COMPANY_VALUE_ALIASES = (() => {
  const map = {};
  for (const [slug, cfg] of Object.entries(BRANDS)) {
    for (const name of [slug, slug.replace(/-/g, ' '), cfg.shortName, cfg.legalName]) {
      map[normalizeCompanyValue(name)] = slug;
    }
  }
  return map;
})();

// Company is NEVER inferred — an unrecognized value returns null exactly
// like before, and is treated as invalid by validateRow. The only change
// from a plain lookup is recognizing more legitimate spellings of a real
// brand name (via COMPANY_VALUE_ALIASES) and, in validateRow, surfacing
// the raw value that failed to match so an unrecognized entry is
// diagnosable instead of a silent, unexplained rejection.
function resolveRowBrandSlug(row, columnMapping, batchBrandSlug) {
  if (columnMapping.company && row[columnMapping.company]) {
    const normalized = normalizeCompanyValue(row[columnMapping.company]);
    return COMPANY_VALUE_ALIASES[normalized] || null;
  }
  return batchBrandSlug || null;
}

// Mirrors resolveRowBrandSlug's per-row-column-wins-over-batch-value shape,
// but carrier is free text (not a fixed set of known slugs like brand), so
// there is no validity check here -- any non-empty string is accepted.
function resolveRowCarrier(row, columnMapping, batchCarrier) {
  if (columnMapping.carrier && row[columnMapping.carrier]) {
    const raw = row[columnMapping.carrier].trim();
    if (raw) return raw;
  }
  const batch = (batchCarrier || '').trim();
  return batch || null;
}

function mapRow(row, columnMapping) {
  const get = (key) => (columnMapping[key] ? (row[columnMapping[key]] || '').trim() : '');
  return {
    firstName: get('firstName'), lastName: get('lastName'), middleName: get('middleName'), email: get('email'),
    phone: get('phone'), address: get('address'), city: get('city'), state: get('state'),
    zip: get('zip'), dateOfBirth: normalizeDateField(get('dateOfBirth')), originalSource: get('originalSource'),
    generalNotes: get('generalNotes'),
    // Policy/case fields — used for importing an existing client's policy
    // from any carrier (Prosperity Revenue MVP, Requirement 1). Company is
    // still NEVER inferred from any of these — see resolveRowBrandSlug,
    // which never reads productName/carrier/etc. Carrier itself is always
    // taken from the row's own data or the batch value (resolveRowCarrier),
    // never assumed or hard-coded.
    productName: get('productName'), carrier: get('carrier'), policyNumber: get('policyNumber'),
    effectiveDate: normalizeDateField(get('effectiveDate')), applicationDate: normalizeDateField(get('applicationDate')),
    premium: get('premium'),
    premiumFrequency: get('premiumFrequency'), policyStatus: get('policyStatus'), faceAmount: get('faceAmount'),
  };
}

// rawCompanyValue is the untouched CSV cell that resolveRowBrandSlug tried
// to match, if a company column was mapped -- passed through purely so an
// unrecognized value can be surfaced in the error instead of leaving the
// row's rejection unexplained.
function validateRow(mapped, brandSlug, rawCompanyValue) {
  const errors = [];
  if (!mapped.firstName && !mapped.lastName) errors.push('missing name');
  const email = normalizeEmail(mapped.email);
  const { e164: phoneE164 } = normalizePhone(mapped.phone);
  if (mapped.email && !EMAIL_RE.test(mapped.email)) errors.push('invalid email format');
  if (mapped.phone && !phoneE164) errors.push('invalid phone number');
  if (!email && !phoneE164) errors.push('email or phone is required');
  if (mapped.dateOfBirth && !DATE_RE.test(mapped.dateOfBirth)) errors.push(`date of birth must be YYYY-MM-DD, MM/DD/YYYY, or MM/DD/YY (got "${mapped.dateOfBirth}")`);
  if (mapped.effectiveDate && !DATE_RE.test(mapped.effectiveDate)) errors.push(`effective date must be YYYY-MM-DD, MM/DD/YYYY, or MM/DD/YY (got "${mapped.effectiveDate}")`);
  if (mapped.applicationDate && !DATE_RE.test(mapped.applicationDate)) errors.push(`application date must be YYYY-MM-DD, MM/DD/YYYY, or MM/DD/YY (got "${mapped.applicationDate}")`);
  if (mapped.premium && !/^\d+(\.\d{1,2})?$/.test(mapped.premium)) errors.push('premium must be a plain number');
  if (mapped.faceAmount && !/^\d+(\.\d{1,2})?$/.test(mapped.faceAmount)) errors.push('face amount must be a plain number');
  if (!brandSlug) {
    errors.push(rawCompanyValue
      ? `company value "${rawCompanyValue}" was not recognized (expected "Prosperity", "Insurance Lady", or their full legal names) — check for typos, or that this column really holds the CRM company, not the insurance carrier`
      : 'company could not be determined for this row (no batch company and no valid company column value)');
  } else if (!isKnownBrandId(brandSlug)) errors.push(`unknown company '${brandSlug}'`);
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
    || mapped.effectiveDate || mapped.premiumFrequency || mapped.policyStatus
    || mapped.faceAmount || mapped.applicationDate);
}

// Policy identity for dedup purposes = carrier + policy number, scoped to
// one specific client's relationship with one specific brand (never across
// brands, and never just "this carrier+number exists somewhere" globally —
// two different clients, or the same client under a different brand, could
// legitimately share a policy number at another carrier's numbering scheme).
// Only ever checked when both values are present -- "when available", per
// the approved design; a row missing either simply can't be deduped at the
// policy level and always proceeds to create.
function findExistingPolicy(db, { contactId, brandId, carrier, policyNumber }) {
  if (!carrier || !policyNumber) return null;
  return db.prepare(`
    SELECT p.* FROM policies p
    JOIN cases c ON c.id = p.case_id
    JOIN contact_brands cb ON cb.id = c.contact_brand_id
    WHERE cb.contact_id = ? AND cb.brand_id = ?
      AND LOWER(TRIM(p.carrier)) = LOWER(TRIM(?))
      AND LOWER(TRIM(p.policy_number)) = LOWER(TRIM(?))
  `).get(contactId, brandId, carrier, policyNumber);
}

// Product/carrier/policy number/effective date/premium are only ever used
// to attach a case+policy to a client that was just created or explicitly
// matched in THIS row — never inferred, never applied to a skipped
// duplicate, and never used to determine which company the row belongs to
// (see resolveRowBrandSlug above, which this function is never called by).
//
// One case per policy (never one shared case across a client's multiple
// policies) — a case's single status/next-action/product fields can't
// represent several independently-diverging already-issued policies. The
// client/contact and their contact_brands relationship are what's shared
// across all of a client's cases; a new case is created here every time.
function attachPolicyIfPresent(db, { contactId, rowBrandSlug, mapped, actor, carrier }) {
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
    carrier: carrier || null,
    policyNumber: mapped.policyNumber || null,
    effectiveDate: mapped.effectiveDate || null,
    applicationDate: mapped.applicationDate || null,
    premium: mapped.premium || null,
    premiumFrequency: mapped.premiumFrequency || null,
    policyStatus: mapped.policyStatus || null,
    coverageAmount: mapped.faceAmount || null,
    notes: mapped.generalNotes || null,
  }, actor);

  return { case: newCase, policy };
}

// Processes every row once, in either mode. Returns { batchId, results,
// summary }. results[i]: { rowNumber, outcome, detail, contactId }.
//
// outcome (dry run): 'would_create' | 'would_attach_policy' |
//   'would_skip_existing_policy' | 'would_update' | 'likely_duplicate' | 'invalid'
// outcome (commit): 'created' | 'attached_policy' | 'skipped_existing_policy' |
//   'updated' | 'skipped' | 'staged_for_review' | 'failed'
//
// Two-level dedup for policy-bearing rows (client/policy book imports, e.g.
// Occidental): a person is matched/reused by email or phone exactly like
// any other row (never a second contact just because they have another
// policy) -- see findExistingContact, and this also works correctly for
// multiple rows of the same person within one CSV batch, since each row
// commits before the next is read. A policy is matched by carrier + policy
// number, scoped to that one client's relationship with the resolved brand
// -- see findExistingPolicy. If the client exists but this exact policy
// doesn't, a NEW case + policy is attached to the EXISTING contact (one
// case per policy — see attachPolicyIfPresent's comment for why cases are
// never shared across a client's multiple policies). If the exact policy
// already exists, nothing is created and the row is flagged
// "Existing Policy — Skip". Rows with no policy data at all keep the
// original manual duplicateDecisions ('skip' | 'update') behavior,
// unchanged, since there's nothing new to attach for a plain lead row.
function runImport(db, { records, columnMapping, brandSlug, carrierSlug, dryRun, filename, duplicateDecisions = {}, actor }) {
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
  const summary = {
    created: 0, attached_policy: 0, skipped_existing_policy: 0, updated: 0, skipped: 0, staged_for_review: 0, failed: 0,
    would_create: 0, would_attach_policy: 0, would_skip_existing_policy: 0, would_update: 0, likely_duplicate: 0, invalid: 0,
    // Informational counts, computed for EVERY row regardless of outcome or
    // dry-run/commit mode -- lets Preview answer "how many rows have no
    // email, no phone, or neither" without weakening the existing "email or
    // phone is required" rule in validateRow, which stays exactly as strict
    // as before (this never affects which rows pass or fail).
    rows_missing_email: 0, rows_missing_phone: 0, rows_missing_both: 0,
  };
  // Dry-run-only, in-memory tracking of rows that "would create" a new
  // contact this batch -- see the "No existing DB contact" branch below.
  const pendingContacts = [];

  records.forEach((row, idx) => {
    const rowNumber = idx + 1;
    const mapped = mapRow(row, columnMapping);
    const rowBrandSlug = resolveRowBrandSlug(row, columnMapping, brandSlug);
    const rowCarrier = resolveRowCarrier(row, columnMapping, carrierSlug);
    const rawCompanyValue = columnMapping.company ? (row[columnMapping.company] || '').trim() : '';

    if (!mapped.email) summary.rows_missing_email++;
    if (!mapped.phone) summary.rows_missing_phone++;
    if (!mapped.email && !mapped.phone) summary.rows_missing_both++;

    const errors = validateRow(mapped, rowBrandSlug, rawCompanyValue);

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
      const rowHasPolicyData = hasPolicyData(mapped);

      if (rowHasPolicyData) {
        const brandRow = db.prepare('SELECT id FROM brands WHERE slug = ?').get(rowBrandSlug);
        const dupPolicy = findExistingPolicy(db, {
          contactId: existing.id, brandId: brandRow.id, carrier: rowCarrier, policyNumber: mapped.policyNumber,
        });
        const clientLabel = `${existing.first_name || ''} ${existing.last_name || ''}`.trim() || `client #${existing.id}`;

        if (dupPolicy) {
          const outcome = dryRun ? 'would_skip_existing_policy' : 'skipped_existing_policy';
          summary[outcome]++;
          results.push(recordRow(db, batchId, rowNumber, row, outcome,
            `Existing Policy — Skip: ${rowCarrier || 'this carrier'} ${mapped.policyNumber} is already on file for ${clientLabel} — nothing created`,
            existing.id));
          return;
        }

        if (dryRun) {
          summary.would_attach_policy++;
          results.push(recordRow(db, batchId, rowNumber, row, 'would_attach_policy',
            `${clientLabel} already exists — would attach a new ${mapped.productName || 'policy'} case + policy, contact reused`,
            existing.id));
          return;
        }

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

        resolveContactBrand(db, { contactId: existing.id, brandId: brandRow.id });
        const attached = attachPolicyIfPresent(db, { contactId: existing.id, rowBrandSlug, mapped, actor, carrier: rowCarrier });
        summary.attached_policy++;
        results.push(recordRow(db, batchId, rowNumber, row, 'attached_policy',
          `${clientLabel} already exists (contact reused) — attached new case + policy (case #${attached.case.id}, policy #${attached.policy.id})`,
          existing.id));
        return;
      }

      // No policy data on this row -- unchanged manual decision behavior
      // (plain lead-style CSV import; nothing new to attach either way).
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
            middle_name = COALESCE(@middle_name, middle_name),
            street_address = COALESCE(@street_address, street_address), city = COALESCE(@city, city),
            state = COALESCE(@state, state), zip_code = COALESCE(@zip_code, zip_code),
            date_of_birth = COALESCE(@date_of_birth, date_of_birth), lead_source = COALESCE(@lead_source, lead_source),
            general_notes = COALESCE(@general_notes, general_notes), updated_at = CURRENT_TIMESTAMP
          WHERE id = @id
        `).run({
          first_name: toStringOrNull(mapped.firstName), last_name: toStringOrNull(mapped.lastName),
          middle_name: toStringOrNull(mapped.middleName),
          street_address: toStringOrNull(mapped.address), city: toStringOrNull(mapped.city),
          state: toStringOrNull(mapped.state), zip_code: toStringOrNull(mapped.zip),
          date_of_birth: toStringOrNull(mapped.dateOfBirth), lead_source: toStringOrNull(mapped.originalSource),
          general_notes: toStringOrNull(mapped.generalNotes), id: existing.id,
        });
        resolveContactBrand(db, { contactId: existing.id, brandId: brandRow.id });
        summary.updated++;
        results.push(recordRow(db, batchId, rowNumber, row, 'updated', `updated existing client #${existing.id}`, existing.id));
        return;
      }
      // decision === 'skip' (default) or 'review' -- never silently overwrite.
      summary.skipped++;
      results.push(recordRow(db, batchId, rowNumber, row, 'skipped', 'likely duplicate — left unchanged (no explicit "update" decision given)', existing.id));
      return;
    }

    // No existing DB contact. In a dry run specifically, also check whether
    // an EARLIER row in this same batch already "would create" this same
    // person -- a dry run never writes, so without this check every
    // repeat occurrence of the same person within one file would
    // incorrectly preview as ANOTHER "would create" instead of correctly
    // previewing as attaching to (or skipping a repeat policy for) the
    // person their first row already covers. Commit mode needs no such
    // tracking: each row's writes are already visible to the next row's
    // normal DB lookup above.
    if (dryRun) {
      const pending = findPendingContact(pendingContacts, { email, phone_e164: phoneE164, phone: phoneDisplay });
      if (pending) {
        const rowHasPolicyData = hasPolicyData(mapped);
        if (!rowHasPolicyData) {
          summary.likely_duplicate++;
          results.push(recordRow(db, batchId, rowNumber, row, 'likely_duplicate', `matches ${pending.label}, who appears earlier in this same file`, null));
          return;
        }
        const dupPending = rowCarrier && mapped.policyNumber && pending.policies.find(p =>
          p.carrier.toLowerCase() === rowCarrier.toLowerCase() && p.policyNumber.toLowerCase() === mapped.policyNumber.toLowerCase());
        if (dupPending) {
          summary.would_skip_existing_policy++;
          results.push(recordRow(db, batchId, rowNumber, row, 'would_skip_existing_policy',
            `Existing Policy — Skip: ${rowCarrier || 'this carrier'} ${mapped.policyNumber} already appears earlier in this same file for ${pending.label}`, null));
          return;
        }
        if (rowCarrier && mapped.policyNumber) pending.policies.push({ carrier: rowCarrier, policyNumber: mapped.policyNumber });
        summary.would_attach_policy++;
        results.push(recordRow(db, batchId, rowNumber, row, 'would_attach_policy',
          `${pending.label} appears earlier in this same file — would attach a new ${mapped.productName || 'policy'} case + policy`, null));
        return;
      }
    }

    // No existing contact, in the database or earlier in this batch.
    const rowHasPolicyData = hasPolicyData(mapped);
    if (dryRun) {
      summary.would_create++;
      pendingContacts.push({
        email, phone_e164: phoneE164, phone: phoneDisplay,
        label: `${mapped.firstName || ''} ${mapped.lastName || ''}`.trim() || 'this client',
        policies: rowHasPolicyData && rowCarrier && mapped.policyNumber ? [{ carrier: rowCarrier, policyNumber: mapped.policyNumber }] : [],
      });
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
      INSERT INTO contacts (first_name, last_name, middle_name, email, phone, phone_e164, street_address, city, state, zip_code, date_of_birth, lead_source, general_notes, lead_status, updated_at)
      VALUES (@first_name, @last_name, @middle_name, @email, @phone, @phone_e164, @street_address, @city, @state, @zip_code, @date_of_birth, @lead_source, @general_notes, @lead_status, CURRENT_TIMESTAMP)
    `).run({
      first_name: toStringOrNull(mapped.firstName), last_name: toStringOrNull(mapped.lastName),
      middle_name: toStringOrNull(mapped.middleName),
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
    const attached = attachPolicyIfPresent(db, { contactId: newContactId, rowBrandSlug, mapped, actor, carrier: rowCarrier });
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
  const header = 'First Name,Last Name,Phone,Email,Address,City,State,Zip,Product,Carrier,Policy Number,Effective Date,Application Date,Premium,Premium Frequency,Policy Status,Face Amount,Notes,Original Source';
  const rows = [
    'Harold,Voss,414-555-2201,harold.voss@example-mail.com,118 Maple Ct,Milwaukee,WI,53204,Life insurance,Occidental Life,OCC-40021,2019-06-01,2019-05-15,54.00,Monthly,Active,50000,Existing whole life policy — annual review due,Existing Client',
    'Ines,Calloway,414-555-2202,ines.calloway@example-mail.com,872 Elm St,Greenfield,WI,53220,Annuities,Mutual of Omaha,MOO-77213,2021-02-15,2021-01-20,,Annual,Active,,Fixed annuity — client asked about withdrawal options,Existing Client',
    'Deshawn,Priest,414-555-2203,deshawn.priest@example-mail.com,,,,,Life insurance,Foresters Financial,FF-90042,2016-09-10,2016-08-22,88.50,Monthly,Active,100000,,Existing Client',
  ];
  return [header, ...rows].join('\n') + '\n';
}

module.exports = {
  parseCsv, runImport, getImportBatch, generateSampleCsv, generateClientPolicySampleCsv, findExistingContact,
  normalizeDateField, resolveRowBrandSlug,
};
