// BackNine application tracking -- storage, status mapping, and manual
// contact matching for the backnine_applications table (crm/db/migrateBackNine.js).
//
// Every function takes an explicit better-sqlite3 `db` handle supplied by
// the caller, exactly like crm/lib/caseMatching.js -- never opens a
// connection itself and never imports crm/db/database.js.
//
// Why contact matching here is always manual, never automatic: BackNine's
// documented eApp webhook payload has no confirmed field for the insured
// applicant's own email or phone (the only email/phone fields found are
// nullable and unlabeled by role inside case.contract_parties[]) -- so an
// automated match would be a guess, not a verified identity. Every new
// application is stored with contact_id = NULL and match_status =
// 'needs_review' until a human explicitly matches it via
// matchApplicationToContact. This file never attempts to infer a match.

function tableExists(db, name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// Deliberately conservative: BackNine's documentation does not provide a
// complete status/step vocabulary, so this maps only the one unambiguous
// signal confirmed in BackNine's own example data -- a `timeline` entry of
// "Issued" means the policy has actually been issued. Everything else
// (including every other example value seen: "Completed" on the eApp
// itself only means the APPLICATION was signed, not that the POLICY was
// issued, and "Entered"/"Approved"/"Submitted to Carrier" have no confirmed
// meaning in a 3-bucket Action-Required/Waiting-on-Carrier/Completed
// scheme) resolves to 'Needs Review' rather than a guessed bucket -- per
// the explicit instruction that an unknown status must read "Needs Review,"
// never "Action Required". The raw BackNine status/named_step/case_status
// strings are stored and displayed alongside this bucket unchanged, so
// nothing is ever hidden behind the bucket label.
function computeDisplayStatus({ timeline }) {
  const entries = Array.isArray(timeline) ? timeline.map(String) : [];
  if (entries.includes('Issued')) return 'Completed';
  return 'Needs Review';
}

// summary is the result of crm/lib/backNineWebhook.js's
// extractConfirmedEappSummary -- only fields confirmed by BackNine's own
// documentation. rawPayload is the full original webhook body (stored
// verbatim, same pattern as unresolved_intake.raw_payload) so nothing
// BackNine actually sent is ever lost even though only the confirmed
// fields are parsed into their own columns.
//
// Idempotent on backnine_uuid: a repeat delivery for the same application
// UPDATEs product/face amount/premium/status/raw_payload in place and NEVER
// touches contact_id/match_status/matched_at/matched_by -- a manual match
// already made by a human is never undone by a later webhook delivery.
//
// Returns { ok: false, reason: 'migration_not_run' } rather than throwing
// if the table doesn't exist yet (crm/db/migrateBackNine.js's migration is
// NOT automatic on every boot -- see crm/lib/migrationRunner.js -- a
// database that hasn't had it run yet must not crash the webhook).
function upsertApplicationFromEapp(db, summary, rawPayload) {
  if (!summary || !summary.backNineUuid) {
    return { ok: false, reason: 'missing_uuid' };
  }
  if (!tableExists(db, 'backnine_applications')) {
    return { ok: false, reason: 'migration_not_run' };
  }

  const displayStatus = computeDisplayStatus(summary);
  const rawPayloadJson = JSON.stringify(rawPayload || {});

  const existing = db.prepare('SELECT * FROM backnine_applications WHERE backnine_uuid = ?').get(summary.backNineUuid);
  const params = summaryToRowParams(summary, displayStatus, rawPayloadJson);

  if (existing) {
    db.prepare(`
      UPDATE backnine_applications SET
        backnine_id        = @backnine_id,
        first_name         = @first_name,
        last_name          = @last_name,
        product_name       = @product_name,
        carrier_name       = @carrier_name,
        product_category   = @product_category,
        face_amount        = @face_amount,
        premium            = @premium,
        pay_duration_years = @pay_duration_years,
        backnine_status    = @backnine_status,
        named_step         = @named_step,
        case_status        = @case_status,
        display_status     = @display_status,
        raw_payload        = @raw_payload,
        updated_at         = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({ ...params, id: existing.id });
    return { ok: true, outcome: 'updated', application: db.prepare('SELECT * FROM backnine_applications WHERE id = ?').get(existing.id) };
  }

  const result = db.prepare(`
    INSERT INTO backnine_applications
      (backnine_uuid, backnine_id, first_name, last_name, product_name, carrier_name, product_category,
       face_amount, premium, pay_duration_years, backnine_status, named_step, case_status, display_status,
       raw_payload, match_status)
    VALUES
      (@backnine_uuid, @backnine_id, @first_name, @last_name, @product_name, @carrier_name, @product_category,
       @face_amount, @premium, @pay_duration_years, @backnine_status, @named_step, @case_status, @display_status,
       @raw_payload, 'needs_review')
  `).run(params);
  return { ok: true, outcome: 'created', application: db.prepare('SELECT * FROM backnine_applications WHERE id = ?').get(result.lastInsertRowid) };
}

function summaryToRowParams(summary, displayStatus, rawPayloadJson) {
  return {
    backnine_uuid:      summary.backNineUuid,
    backnine_id:        summary.backNineId,
    first_name:         summary.firstName,
    last_name:          summary.lastName,
    product_name:       summary.productName,
    carrier_name:       summary.carrierName,
    product_category:   summary.productCategory,
    face_amount:        summary.faceAmount,
    premium:            summary.premium,
    pay_duration_years: summary.payDurationYears,
    backnine_status:    summary.eappStatus,
    named_step:         summary.namedStep,
    case_status:        summary.caseStatus,
    display_status:     displayStatus,
    raw_payload:        rawPayloadJson,
  };
}

// Re-derives the display/summary columns (product/carrier/face amount/
// premium/term/status bucket) for every stored application from its own
// already-saved raw_payload, using whatever the CURRENT extraction logic
// (crm/lib/backNineWebhook.js's extractConfirmedEappSummary) knows how to
// read -- lets a field-mapping fix (like the 2026-10-12 one that added
// product.name/carrier.name/individuals[0].quote.*) apply retroactively to
// applications already received, without needing BackNine to resend
// anything. raw_payload itself, contact_id, match_status, matched_at, and
// matched_by are NEVER touched -- this only recomputes columns that are
// themselves derived from raw_payload, never the original data or any
// human decision already made.
function backfillApplicationFields(db, { extractConfirmedEappSummary }) {
  if (!tableExists(db, 'backnine_applications')) return { ok: false, reason: 'migration_not_run' };

  const rows = db.prepare('SELECT id, raw_payload FROM backnine_applications').all();
  let updated = 0;
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.raw_payload); } catch { continue; }
    const summary = extractConfirmedEappSummary(payload);
    if (!summary) continue;
    const displayStatus = computeDisplayStatus(summary);
    db.prepare(`
      UPDATE backnine_applications SET
        product_name       = @product_name,
        carrier_name       = @carrier_name,
        product_category   = @product_category,
        face_amount        = @face_amount,
        premium            = @premium,
        pay_duration_years = @pay_duration_years,
        backnine_status    = @backnine_status,
        named_step         = @named_step,
        case_status        = @case_status,
        display_status     = @display_status
      WHERE id = @id
    `).run({
      id: row.id,
      product_name:       summary.productName,
      carrier_name:       summary.carrierName,
      product_category:   summary.productCategory,
      face_amount:        summary.faceAmount,
      premium:            summary.premium,
      pay_duration_years: summary.payDurationYears,
      backnine_status:    summary.eappStatus,
      named_step:         summary.namedStep,
      case_status:        summary.caseStatus,
      display_status:     displayStatus,
    });
    updated += 1;
  }
  return { ok: true, totalRows: rows.length, updated };
}

// Powers the click-to-open detail view (crm/routes/backNineApplications.js).
// Returns only the already-extracted, structured columns -- never
// raw_payload -- so the detail endpoint can never leak more than the
// summary card already could.
function getApplicationById(db, applicationId) {
  if (!tableExists(db, 'backnine_applications')) return null;
  let row;
  try {
    row = db.prepare('SELECT * FROM backnine_applications WHERE id = ?').get(applicationId);
  } catch (err) {
    console.error('getApplicationById: query failed (migration not fully run against this database?):', err.message);
    return null;
  }
  if (!row) return null;
  const { raw_payload, ...safe } = row;
  return safe;
}

// The one explicit, human-triggered action that ever sets contact_id on a
// backnine_applications row -- never called automatically. Re-matching an
// already-matched row (correcting a mistake) is allowed; the caller's own
// UI is what decides whether to expose that.
function matchApplicationToContact(db, { applicationId, contactId, actor }) {
  if (!actor) throw new Error('matchApplicationToContact: actor is required for the audit trail');
  const application = db.prepare('SELECT * FROM backnine_applications WHERE id = ?').get(applicationId);
  if (!application) throw new Error(`matchApplicationToContact: application ${applicationId} does not exist`);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!contact) throw new Error(`matchApplicationToContact: contact ${contactId} does not exist`);

  db.prepare(`
    UPDATE backnine_applications
    SET contact_id = ?, match_status = 'matched', matched_at = CURRENT_TIMESTAMP, matched_by = ?
    WHERE id = ?
  `).run(contactId, actor, applicationId);

  return db.prepare('SELECT * FROM backnine_applications WHERE id = ?').get(applicationId);
}

// Used by crm/lib/dashboardQueries.js's getClientDetail to populate the
// Life & Annuities tab's Pending Applications section -- matched
// applications only, so an unmatched one never appears on any client's
// record (nobody has confirmed whose application it is yet). Returns []
// (never throws) if the table doesn't exist yet, for the same
// migration-not-run reason as upsertApplicationFromEapp above -- a client
// page must never break because this one optional feature's migration
// hasn't been run in a given environment.
// Every column except raw_payload -- shared by both list functions and
// getApplicationById above so none of them ever return the complete raw
// webhook body to the interface, only the already-extracted summary
// fields (also keeps every reader's column list from silently drifting
// apart if a column is ever added again).
const SAFE_COLUMNS = `
  id, backnine_uuid, backnine_id, contact_id, match_status,
  first_name, last_name, product_name, carrier_name, product_category,
  face_amount, premium, pay_duration_years, backnine_status, named_step,
  case_status, display_status, received_at, updated_at, matched_at, matched_by
`;

// 2026-10-13 PRODUCTION BUG FIX: calling this unconditionally for every
// client (getClientDetail does, regardless of whether that client has any
// BackNine data) means a SELECT naming a column that doesn't exist YET on
// a given database -- e.g. product_name/carrier_name/pay_duration_years,
// added by a later migration a production environment may not have run
// yet -- throws for every single client, not just ones with BackNine
// applications, breaking the entire Client Record page. tableExists alone
// only catches the table being completely absent; it says nothing about
// which columns an EXISTING table actually has. Wrapping the query itself
// and falling back to [] on failure (same "degrade gracefully, log it,
// never crash the page" contract as the tableExists check already makes)
// closes that gap -- confirmed exactly this scenario in production
// 2026-10-13 (the 3 columns were deployed before the follow-up migration
// that adds them had been run).
function listApplicationsForContact(db, contactId) {
  if (!tableExists(db, 'backnine_applications')) return [];
  try {
    return db.prepare(`
      SELECT ${SAFE_COLUMNS} FROM backnine_applications WHERE contact_id = ? AND match_status = 'matched'
      ORDER BY received_at DESC
    `).all(contactId);
  } catch (err) {
    console.error('listApplicationsForContact: query failed (migration not fully run against this database?):', err.message);
    return [];
  }
}

// Used by the manual-matching admin page (crm/public/app/backnine-applications.html).
// See listApplicationsForContact's own comment for why this is wrapped too.
function listNeedsReviewApplications(db) {
  if (!tableExists(db, 'backnine_applications')) return [];
  try {
    return db.prepare(`
      SELECT ${SAFE_COLUMNS} FROM backnine_applications WHERE match_status = 'needs_review'
      ORDER BY received_at DESC
    `).all();
  } catch (err) {
    console.error('listNeedsReviewApplications: query failed (migration not fully run against this database?):', err.message);
    return [];
  }
}

module.exports = {
  computeDisplayStatus,
  upsertApplicationFromEapp,
  matchApplicationToContact,
  listApplicationsForContact,
  listNeedsReviewApplications,
  backfillApplicationFields,
  getApplicationById,
};
