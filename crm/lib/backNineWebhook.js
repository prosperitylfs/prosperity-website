// BackNine BOSS webhook receiver -- Phase 1 (secure scaffolding only).
//
// CONFIRMED from BackNine's own documentation (docs.back9ins.com, reviewed
// 2026-10-12):
//   - Every webhook request carries a static, per-endpoint shared secret in
//     the X-BACKNINE-AUTHENTICATION header -- not a computed HMAC signature,
//     just a plain string to compare (same trust model as this app's own
//     CRM_API_KEY/x-api-key header -- see crm/server.js's requireApiKey).
//   - The eApp (Quote & Apply) payload includes a stable `uuid` and numeric
//     `id` uniquely identifying one application -- the identifier needed to
//     prevent a duplicate case/record on a repeated webhook delivery.
//   - `step` / `named_step`, top-level `status`, and nested `case.status` /
//     `case.timeline` track an application's progress, but only a handful
//     of example values were ever confirmed (e.g. step 14 / "DocuSign -
//     Final Step"; case.timeline entries like "Approved", "Issued",
//     "Submitted to Carrier") -- nowhere near a complete enumeration.
//   - `first_name` / `last_name` / `product_category` / `face_amount` /
//     `premium` appear at the top level of the eApp payload.
//
// NOT CONFIRMED, and deliberately NOT guessed at here:
//   - The applicant/insured's own email or phone number. The only email/
//     phone fields found are nested under case.contract_parties[], which are
//     nullable and not labeled by role (owner vs. insured vs. beneficiary) --
//     matching a contact by one of those without knowing which party is the
//     insured risks attaching a real application to the wrong person.
//   - The Case webhook's payload shape -- BackNine's docs point only to a
//     live example-fetch endpoint for it, not a documented schema.
//   - The complete application-status/step vocabulary needed to drive
//     Pending -> Underwriting -> Issued/Declined case-status progression.
//
// Because of those gaps, this file intentionally does NOT create or update
// any contact, case, or policy, and does NOT persist applicant PII anywhere.
// It only verifies a request genuinely came from BackNine and safely
// acknowledges receipt, logging just the fields confirmed above -- so
// nothing here can silently create a wrong, duplicate, or mismatched record
// from a guessed field path. See crm/routes/backNineWebhook.js for how this
// is used, and the implementation report for what's needed to complete the
// next phase (automatic contact/case creation).

const crypto = require('crypto');

function safeEqualStrings(a, b) {
  if (!a || !b) return false;
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// Fails closed: an unconfigured secret rejects every request rather than
// allowing them through unauthenticated (unlike crm/server.js's requireApiKey,
// which fails OPEN in local dev to preserve long-standing existing behavior --
// there is no existing BackNine behavior to preserve here, and this endpoint
// will receive real applicant data once configured, so there's no reason to
// default it open).
function verifyBackNineAuth(req, expectedSecret) {
  if (!expectedSecret) return false;
  const supplied = req.headers['x-backnine-authentication'];
  return safeEqualStrings(supplied, expectedSecret);
}

// Extracts ONLY the fields confirmed by BackNine's own documentation -- see
// this file's header comment. Returns null for anything not confirmed
// (rather than a guessed/wrong path), and never reads case.contract_parties
// or any other field that would amount to guessing.
function extractConfirmedEappSummary(payload) {
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row || typeof row !== 'object') return null;
  const nestedCase = (row.case && typeof row.case === 'object') ? row.case : null;
  return {
    backNineUuid:   row.uuid != null ? String(row.uuid) : null,
    backNineId:     row.id   != null ? String(row.id)   : null,
    firstName:      row.first_name || null,
    lastName:       row.last_name  || null,
    productCategory: row.product_category || null,
    faceAmount:     row.face_amount != null ? row.face_amount : null,
    premium:        row.premium     != null ? row.premium     : null,
    eappStatus:     row.status || null,
    step:           row.step != null ? row.step : null,
    namedStep:      row.named_step || null,
    caseStatus:     nestedCase ? (nestedCase.status || null) : null,
    timeline:       nestedCase && Array.isArray(nestedCase.timeline) ? nestedCase.timeline : null,
  };
}

module.exports = { safeEqualStrings, verifyBackNineAuth, extractConfirmedEappSummary };
