// The real Twilio adapter for outbound Prosperity SMS. NOT wired in by
// default — crm/lib/providers/index.js only returns this module when
// process.env.COMMUNICATION_PROVIDER === 'twilio' exactly; every other
// value (missing, empty, misspelled, or anything else) keeps the fake
// adapter active. That switch can only ever be set on the server process
// environment — nothing in this file, or anywhere it's called from, ever
// reads a provider selection from a browser request.
//
// sendText() is a single, self-contained safety boundary: it independently
// re-verifies every one of the "Reject the send if..." conditions itself,
// using ONLY the arguments it's given plus process.env — it never queries a
// database. The caller (crm/lib/prosperitySmsGateway.js) resolves fresh
// consent/company/phone state from the db and passes it in; this function
// never trusts that resolution blindly for the one check that matters most
// (the FROM number), which it cross-checks against server-side config
// itself before ever constructing a Twilio client.
//
// Calling and email are explicitly OUT of scope for this checkpoint and
// stay hard-blocked here, never touching a network, even when this adapter
// is selected.

const { BRANDS } = require('../../config/brands');

const E164_RE = /^\+1\d{10}$/;

// Never includes headers, request/response bodies, or the auth token —
// Twilio SDK errors already expose a sanitized .code/.message pair that
// never contains the credential used to make the request.
function sanitizeTwilioError(err) {
  const code = err && err.code ? err.code : null;
  const message = (err && err.message) || 'Unknown Twilio error';
  return code ? `Twilio error ${code}: ${message}` : `Twilio error: ${message}`;
}

function blocked(message) {
  return { ok: false, status: 'blocked', message };
}

// deps.getTwilioClient lets tests inject a fully mocked Twilio client so
// this function never makes a real network call under test — when omitted,
// the real 'twilio' package is constructed lazily, only once every guard
// above has already passed.
async function sendText({ toNumber, fromNumber, brandId, body, hasConsent, isOptedOut } = {}, deps = {}) {
  if (!brandId) {
    return blocked('Sender company could not be resolved for this client — refusing to send.');
  }
  if (brandId !== 'prosperity') {
    return blocked(`This adapter only sends Prosperity SMS — refusing to send for '${brandId}'.`);
  }
  if (!toNumber || !E164_RE.test(toNumber)) {
    return blocked('This client has no valid mobile number on file.');
  }
  if (!hasConsent) {
    return blocked('This client has not given SMS consent.');
  }
  if (isOptedOut) {
    return blocked('This client replied STOP and must not receive nonessential texts.');
  }
  if (!toStringNonEmpty(body)) {
    return blocked('Message body is required.');
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  // Deliberately TWILIO_FROM_NUMBER_PROSPERITY only — never the legacy
  // single-number TWILIO_FROM_NUMBER used by crm/routes/twilio.js, and
  // never any Insurance Lady variable. If this brand-specific var isn't
  // set, there is no fallback; the send is blocked. Trimmed because
  // environment values pasted into a hosting dashboard routinely pick up
  // incidental leading/trailing whitespace or a trailing newline, which
  // would otherwise fail the exact-equality check below for a number that
  // is, in every way that actually matters, correctly configured. Nothing
  // else about the comparison is loosened — it's still exact equality on
  // the number itself, just blind to whitespace noise around it.
  const configuredFromNumber = (process.env.TWILIO_FROM_NUMBER_PROSPERITY || '').trim();

  const missing = [];
  if (!accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!authToken) missing.push('TWILIO_AUTH_TOKEN');
  if (!configuredFromNumber) missing.push('TWILIO_FROM_NUMBER_PROSPERITY');
  if (missing.length) {
    return blocked(`Twilio is not configured — missing ${missing.join(', ')}.`);
  }

  // The FROM number must match BOTH the server-side brand config and the
  // env-configured sending number exactly. A caller-supplied fromNumber
  // that differs from either — whatever the reason — is refused rather
  // than silently corrected or substituted. The specific values are
  // included in the blocked message (a phone number, not a secret) so a
  // real mismatch is immediately diagnosable instead of opaque.
  if (fromNumber !== configuredFromNumber || fromNumber !== BRANDS.prosperity.phone.e164) {
    return blocked(
      `Requested sender does not match the configured Prosperity number — refusing to send. `
      + `(requested: ${fromNumber || '(none)'}, TWILIO_FROM_NUMBER_PROSPERITY: ${configuredFromNumber || '(not set)'}, `
      + `expected: ${BRANDS.prosperity.phone.e164})`
    );
  }

  const getClient = deps.getTwilioClient || (() => require('twilio')(accountSid, authToken));
  const client = getClient();

  const publicUrl = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');
  const params = { to: toNumber, from: configuredFromNumber, body };
  if (publicUrl) params.statusCallback = `${publicUrl}/api/twilio-prosperity/sms/status`;

  try {
    const message = await client.messages.create(params);
    return { ok: true, status: 'sent', sid: message.sid, providerStatus: message.status || null };
  } catch (err) {
    return { ok: false, status: 'failed', message: sanitizeTwilioError(err), errorCode: err && err.code ? err.code : null };
  }
}

function toStringNonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '';
}

// Calling and email are not implemented by this adapter in this
// checkpoint — always blocked, never throws, never touches a network, even
// when this adapter is the one getAdapter() returns.
async function placeCall() {
  return blocked('Calling is not implemented yet.');
}
async function sendEmail() {
  return blocked('Email sending is not implemented yet.');
}

module.exports = { sendText, placeCall, sendEmail };
