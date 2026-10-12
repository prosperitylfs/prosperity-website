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

  if (existing) {
    db.prepare(`
      UPDATE backnine_applications SET
        backnine_id      = @backnine_id,
        first_name       = @first_name,
        last_name        = @last_name,
        product_category = @product_category,
        face_amount      = @face_amount,
        premium          = @premium,
        backnine_status  = @backnine_status,
        named_step       = @named_step,
        case_status      = @case_status,
        display_status   = @display_status,
        raw_payload      = @raw_payload,
        updated_at       = CURRENT_TIMESTAMP
      WHERE id = @id
    `).run({
      id: existing.id,
      backnine_id:      summary.backNineId,
      first_name:       summary.firstName,
      last_name:        summary.lastName,
      product_category: summary.productCategory,
      face_amount:      summary.faceAmount,
      premium:          summary.premium,
      backnine_status:  summary.eappStatus,
      named_step:       summary.namedStep,
      case_status:      summary.caseStatus,
      display_status:   displayStatus,
      raw_payload:       rawPayloadJson,
    });
    return { ok: true, outcome: 'updated', application: db.prepare('SELECT * FROM backnine_applications WHERE id = ?').get(existing.id) };
  }

  const result = db.prepare(`
    INSERT INTO backnine_applications
      (backnine_uuid, backnine_id, first_name, last_name, product_category, face_amount, premium,
       backnine_status, named_step, case_status, display_status, raw_payload, match_status)
    VALUES
      (@backnine_uuid, @backnine_id, @first_name, @last_name, @product_category, @face_amount, @premium,
       @backnine_status, @named_step, @case_status, @display_status, @raw_payload, 'needs_review')
  `).run({
    backnine_uuid:    summary.backNineUuid,
    backnine_id:      summary.backNineId,
    first_name:       summary.firstName,
    last_name:        summary.lastName,
    product_category: summary.productCategory,
    face_amount:      summary.faceAmount,
    premium:          summary.premium,
    backnine_status:  summary.eappStatus,
    named_step:       summary.namedStep,
    case_status:      summary.caseStatus,
    display_status:   displayStatus,
    raw_payload:       rawPayloadJson,
  });
  return { ok: true, outcome: 'created', application: db.prepare('SELECT * FROM backnine_applications WHERE id = ?').get(result.lastInsertRowid) };
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
function listApplicationsForContact(db, contactId) {
  if (!tableExists(db, 'backnine_applications')) return [];
  return db.prepare(`
    SELECT * FROM backnine_applications WHERE contact_id = ? AND match_status = 'matched'
    ORDER BY received_at DESC
  `).all(contactId);
}

// Used by the manual-matching admin page (crm/public/app/backnine-applications.html).
function listNeedsReviewApplications(db) {
  if (!tableExists(db, 'backnine_applications')) return [];
  return db.prepare(`
    SELECT * FROM backnine_applications WHERE match_status = 'needs_review'
    ORDER BY received_at DESC
  `).all();
}

module.exports = {
  computeDisplayStatus,
  upsertApplicationFromEapp,
  matchApplicationToContact,
  listApplicationsForContact,
  listNeedsReviewApplications,
};
