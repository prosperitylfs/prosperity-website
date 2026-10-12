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
//   - `first_name` / `last_name` appear at the top level of the eApp payload.
//
// CONFIRMED 2026-10-12 from a REAL production delivery (BackNine case
// #560015, Janet Jackson) -- this superseded the docs' own illustrative
// example, which had product_category/face_amount/premium at the TOP
// LEVEL. The real payload nests quote data instead:
//   - `product.name` -- the specific product (e.g. "OPTerm 20")
//   - `product.carrier.name` -- the carrier (e.g. "Banner")
//   - `individuals[0].quote.product_category` -- e.g. "20 Year Term"
//   - `individuals[0].quote.face_amount` / `.premium` / `.pay_duration`
//     (pay_duration is the term length in years, e.g. 20)
// Both the old top-level paths and the new confirmed-real nested paths are
// read here (nested checked first) -- the docs' shape is kept as a
// fallback rather than deleted outright, since only ONE real payload has
// been inspected and a different BackNine product/flow could still use it.
//
// NOT CONFIRMED, and deliberately NOT guessed at here:
//   - The applicant/insured's own email or phone number. Case #560015's
//     own `individuals[0]` had both as null (an early-stage quote, per its
//     named_step "Quote - 10% Complete"), so this remains unconfirmed
//     either way. The only OTHER email/phone fields ever found are nested
//     under case.contract_parties[], nullable and not labeled by role
//     (owner vs. insured vs. beneficiary) -- matching a contact by one of
//     those without knowing which party is the insured risks attaching a
//     real application to the wrong person.
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
  const product = (row.product && typeof row.product === 'object') ? row.product : null;
  const carrier = (product && product.carrier && typeof product.carrier === 'object') ? product.carrier : null;
  const individual = Array.isArray(row.individuals) ? row.individuals[0] : null;
  const quote = (individual && individual.quote && typeof individual.quote === 'object') ? individual.quote : null;

  return {
    backNineUuid:   row.uuid != null ? String(row.uuid) : null,
    backNineId:     row.id   != null ? String(row.id)   : null,
    firstName:      row.first_name || null,
    lastName:       row.last_name  || null,
    productName:    product ? (product.name || null) : null,
    carrierName:    carrier ? (carrier.name || null) : null,
    // Nested quote path confirmed against a real delivery; the docs'
    // top-level path is kept as a fallback -- see this file's header
    // comment for why both are checked.
    productCategory: (quote && quote.product_category) || row.product_category || null,
    faceAmount:      (quote && quote.face_amount != null) ? quote.face_amount : (row.face_amount != null ? row.face_amount : null),
    premium:         (quote && quote.premium != null) ? quote.premium : (row.premium != null ? row.premium : null),
    payDurationYears: quote && quote.pay_duration != null ? quote.pay_duration : null,
    eappStatus:     row.status || null,
    step:           row.step != null ? row.step : null,
    namedStep:      row.named_step || null,
    caseStatus:     nestedCase ? (nestedCase.status || null) : null,
    timeline:       nestedCase && Array.isArray(nestedCase.timeline) ? nestedCase.timeline : null,
  };
}

module.exports = { safeEqualStrings, verifyBackNineAuth, extractConfirmedEappSummary };
