// In-memory CSRF `state` store for the Microsoft OAuth authorize/callback
// round-trip (crm/routes/msEmail.js) -- 2026-10-16.
//
// This CRM has no session framework at all (crm/routes/crmActions.js's own
// comment: "a single-operator local CRM with no per-request session"), and
// the existing Gmail OAuth flow (crm/routes/email.js's /auth + /callback)
// has no `state` parameter either. Rather than introduce a session/cookie
// framework just for this, a `state` value is a short-lived, single-use,
// server-side-only random token held in a plain in-memory Map, matching
// the size and lifetime of this problem: the round-trip between visiting
// /auth and Microsoft redirecting back to /callback takes seconds, never
// needs to survive a process restart, and only ever has (at most) one
// operator using it at a time.
//
// A state expires after STATE_TTL_MS even if never consumed (guards
// against an abandoned /auth visit growing this Map forever), and is
// deleted the instant it's successfully consumed (single-use -- a replayed
// callback URL can never be re-accepted).

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes -- generous for a human to complete an interactive Microsoft sign-in

const crypto = require('crypto');
const pending = new Map(); // state -> expiresAt (epoch ms)

function sweepExpired(now) {
  for (const [state, expiresAt] of pending) {
    if (expiresAt <= now) pending.delete(state);
  }
}

// Generates and remembers a new state value, returning it for the caller
// to embed in the Microsoft authorize URL.
function createState() {
  const now = Date.now();
  sweepExpired(now);
  const state = crypto.randomBytes(24).toString('hex');
  pending.set(state, now + STATE_TTL_MS);
  return state;
}

// Returns true and deletes the entry (single-use) if `state` is a value
// this store issued and it hasn't expired; false otherwise (unknown,
// already-consumed, expired, or missing/empty). Never throws.
function consumeState(state) {
  if (!state || typeof state !== 'string') return false;
  const now = Date.now();
  sweepExpired(now);
  const expiresAt = pending.get(state);
  if (expiresAt === undefined) return false;
  pending.delete(state);
  return expiresAt > now;
}

// Test-only escape hatch -- lets tests reset state between runs without
// waiting out STATE_TTL_MS or restarting the process.
function _clearAllForTests() {
  pending.clear();
}

module.exports = { createState, consumeState, _clearAllForTests };
