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
//   - PRIVATE server-to-server credentials: one PER VERIFIED SOURCE, sent as
//     the x-internal-key header — CRM_INTERNAL_KEY for
//     functions/submit-lead.js / functions/send-guide.js (Prosperity), and
//     CRM_INTERNAL_KEY_INSURANCE_LADY for the insurance-lady-website
//     Cloudflare Worker's own lead-capture relay (added 2026-09-30 for
//     retirement-booking.html's 3-step qualification flow). Deliberately
//     TWO DISTINCT secrets, not one shared key plus a caller-supplied label
//     — a single shared secret could never tell which site a request came
//     from, and brand must never be taken from anything the caller merely
//     claims. Known only to our own backends — NEVER sent to, stored in, or
//     readable by a browser. Which key (if any) matched is the ONLY signal
//     that resolves a verified source/brand — see resolveSourceId() below.
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
// with its private credential (functions/submit-lead.js). Insurance Lady's
// retirement-booking.html follows the identical pattern through its own
// Worker instead of a Pages Function, with its own distinct credential. No
// browser script calls POST /api/leads directly for either brand.

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
// value. Checks the supplied x-internal-key against EVERY known source's
// own configured key (never a single shared secret) and returns whichever
// sourceId matched, or null if none did — that match is the ONLY signal
// that resolves a source. A browser-supplied x-api-key is deliberately NOT
// consulted here at all — it is a public value and proves nothing about
// which site a request originated from. A request that matches no known
// key is NOT rejected here (Turnstile has already gated out bots for
// public callers) — it proceeds, but processLeadIntake() stages it for
// Brand Review Required instead of silently assigning a brand. See
// crm/config/leadSources.js.
const INTERNAL_KEY_ENV_BY_SOURCE = {
  'prosperity-website': 'CRM_INTERNAL_KEY',
  'insurance-lady-website': 'CRM_INTERNAL_KEY_INSURANCE_LADY',
};

function resolveSourceId(suppliedInternalKey) {
  if (!suppliedInternalKey) return null;
  for (const [sourceId, envVar] of Object.entries(INTERNAL_KEY_ENV_BY_SOURCE)) {
    const configuredKey = process.env[envVar];
    if (configuredKey && safeEqualStrings(suppliedInternalKey, configuredKey)) {
      return sourceId;
    }
  }
  return null;
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
    // functions/send-guide.js, and Insurance Lady's own Worker relay)
    // already verified Turnstile themselves before reaching here — a
    // Turnstile token is single-use, so re-checking the same token here
    // would always fail. Those calls authenticate instead with their own
    // private per-source key (compared in constant time; see
    // resolveSourceId above, the sole signal that resolves a verified
    // source). Direct public POSTs to this endpoint never have this header
    // and must still pass Turnstile below.
    const suppliedInternalKey = headers && headers['x-internal-key'];
    const sourceId = resolveSourceId(suppliedInternalKey);
    const isTrustedInternalCall = sourceId !== null;

    if (!isTrustedInternalCall) {
      const turnstileOk = await verifyTurnstileFn(turnstile_token, ip);
      if (!turnstileOk) {
        return { status: 400, body: { error: 'Verification failed. Please refresh the page and try again.' } };
      }
    }

    if (!email && !phone) {
      return { status: 400, body: { error: 'email or phone required' } };
    }

    const result = processLeadIntake(db, { sourceId, payload: body });

    return { status: 201, body: { ok: true, contact_id: result.contact.id } };

  } catch (err) {
    console.error('Lead capture error:', err);
    return { status: 500, body: { error: 'Server error' } };
  }
}

module.exports = { handleLeadSubmission, verifyTurnstile, resolveSourceId, safeEqualStrings };
