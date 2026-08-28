// HTTP-shaped orchestration for POST /api/leads, factored out of
// crm/routes/leads.js specifically so it can be tested end-to-end (honeypot
// → Turnstile-or-internal-key → source/brand resolution → intake) against
// an in-memory test database and a stubbed Turnstile check.
//
// crm/routes/leads.js still imports the live crm/db/database.js at module
// scope, exactly like every other route in this app (crm/routes/twilio.js,
// crm/routes/calcom.js) — tests must never require that route file, since
// doing so opens the live database file as a side effect. This module never
// does that: like every crm/lib module, it takes `db` as an explicit
// parameter.
//
// Trust model (corrected — see the Checkpoint E1 Phase 1 correction report):
//   - PRIVATE server-to-server credential: CRM_INTERNAL_KEY, sent as the
//     x-internal-key header. Known only to our own Cloudflare Pages
//     Functions (functions/submit-lead.js, functions/send-guide.js) and
//     this CRM server's environment — NEVER sent to, stored in, or
//     readable by a browser. This is the ONLY signal that resolves a
//     verified source/brand — see resolveSourceId() below.
//   - PUBLIC source label: x-api-key. Historically shipped in browser code
//     (assets/js/main.v2.js) and is documented there as public. A public
//     value can prove a request came from *a* script that had the value —
//     it can never prove which website that script ran on, so it is never
//     used to authenticate or resolve a brand. No browser call reaches this
//     endpoint directly anymore (see below); the header is not checked here
//     at all.
//   - SPAM-CONTROL signal: the Turnstile token / honeypot field. These
//     prove "a human solved a challenge on some page," not "this request
//     came from our site" — they gate whether a request is processed at
//     all, never which brand it belongs to.
//
// Every browser-originated Prosperity form (book.html, life-insurance.html,
// life-insurance-qualifier.html, contact.html) now submits through the
// same-origin /submit-lead Cloudflare Pages Function, which verifies
// Turnstile/honeypot itself and then calls this endpoint server-to-server
// with the private credential (functions/submit-lead.js). No browser script
// calls POST /api/leads directly.

const crypto = require('crypto');
const { processLeadIntake } = require('./leadIntake');

// Fixed-length SHA-256 digest comparison via crypto.timingSafeEqual — same
// technique crm/server.js already uses for the dashboard credentials —
// avoids a length-based timing side-channel and the need for equal-length
// input (timingSafeEqual itself throws on mismatched lengths).
function safeEqualStrings(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

// Verifies a Turnstile token with Cloudflare's siteverify API — the
// production default. This is what actually stops bots and direct-POST
// bypasses of this endpoint; the widget on the frontend only proves the
// *browser* solved a challenge. Tests inject a stub via handleLeadSubmission's
// `deps` parameter instead of calling Cloudflare's real network API.
async function verifyTurnstile(token, remoteIp) {
  if (!token) return false;
  if (!process.env.TURNSTILE_SECRET_KEY) {
    console.warn('WARNING: TURNSTILE_SECRET_KEY is not set. Rejecting all submissions until configured.');
    return false;
  }
  try {
    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret:   process.env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteIp || '',
      }),
    });
    const result = await verifyRes.json();
    return result.success === true;
  } catch (err) {
    console.error('[leads] turnstile verification request error:', err.message);
    return false;
  }
}

// Which VERIFIED source this request came from, for brand resolution only —
// never taken from the request body, and never taken from a browser-visible
// value. isTrustedInternalCall (computed by the caller from the private
// x-internal-key header — see handleLeadSubmission below) is the ONLY
// signal that resolves a source. A browser-supplied x-api-key is
// deliberately NOT consulted here at all — it is a public value and proves
// nothing about which site a request originated from. A request that isn't
// a trusted internal call is NOT rejected here (Turnstile has already
// gated out bots for public callers) — it proceeds, but
// processLeadIntake() stages it for Brand Review Required instead of
// silently assigning a brand. See crm/config/leadSources.js.
function resolveSourceId(isTrustedInternalCall) {
  return isTrustedInternalCall ? 'prosperity-website' : null;
}

// Core request handler, independent of Express. Returns { status, body } —
// crm/routes/leads.js's router.post callback maps this straight onto
// res.status().json(). deps.verifyTurnstile lets tests stub out the network
// call; production always uses the real one defined above.
async function handleLeadSubmission(db, { headers, body, ip }, deps = {}) {
  const verifyTurnstileFn = deps.verifyTurnstile || verifyTurnstile;
  try {
    const { honeypot, turnstile_token, email, phone } = body || {};

    // Basic spam check
    if (honeypot) {
      return { status: 200, body: { ok: true } }; // silent discard
    }

    // Internal server-to-server calls (functions/submit-lead.js,
    // functions/send-guide.js) already verified Turnstile themselves before
    // reaching here — a Turnstile token is single-use, so re-checking the
    // same token here would always fail. Those calls authenticate instead
    // with CRM_INTERNAL_KEY — the PRIVATE server-to-server credential,
    // known only to our own backends and never sent to, stored in, or
    // readable by any browser. Compared in constant time since this is now
    // the sole signal that resolves a verified source (see resolveSourceId
    // above). Direct public POSTs to this endpoint never have this header
    // and must still pass Turnstile below.
    const configuredInternalKey = process.env.CRM_INTERNAL_KEY;
    const suppliedInternalKey   = headers && headers['x-internal-key'];
    const isTrustedInternalCall =
      !!configuredInternalKey && !!suppliedInternalKey &&
      safeEqualStrings(suppliedInternalKey, configuredInternalKey);

    if (!isTrustedInternalCall) {
      const turnstileOk = await verifyTurnstileFn(turnstile_token, ip);
      if (!turnstileOk) {
        return { status: 400, body: { error: 'Verification failed. Please refresh the page and try again.' } };
      }
    }

    if (!email && !phone) {
      return { status: 400, body: { error: 'email or phone required' } };
    }

    const sourceId = resolveSourceId(isTrustedInternalCall);
    const result = processLeadIntake(db, { sourceId, payload: body });

    return { status: 201, body: { ok: true, contact_id: result.contact.id } };

  } catch (err) {
    console.error('Lead capture error:', err);
    return { status: 500, body: { error: 'Server error' } };
  }
}

module.exports = { handleLeadSubmission, verifyTurnstile, resolveSourceId, safeEqualStrings };
