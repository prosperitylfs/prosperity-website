// Twilio webhook signature verification — extracted as a small, dependency-light,
// unit-testable module with no database or network access of its own.
//
// Fails closed everywhere: missing auth token, missing signature header, or a
// mismatch are all treated identically (rejected). Nothing here ever assumes a
// request is legitimate just because verification couldn't be attempted.

const twilio = require('twilio');

// Builds the exact public URL Twilio would have signed: the app's own
// configured public base URL plus the request's own path (and query string,
// if any). Twilio signs the URL it actually POSTed to, so this must match
// CRM_PUBLIC_URL exactly, or verification will fail even for genuine requests.
function buildTwilioUrl(req, publicUrlOverride) {
  const base = (publicUrlOverride ?? process.env.CRM_PUBLIC_URL ?? '').replace(/\/$/, '');
  return `${base}${req.originalUrl}`;
}

// Pure verification — takes explicit inputs rather than reading environment
// variables or request objects directly, so it's trivially unit-testable.
function isValidTwilioRequest({ authToken, signature, url, params }) {
  if (!authToken) return false;
  if (!signature) return false;
  if (!url) return false;
  try {
    return twilio.validateRequest(authToken, signature, url, params || {});
  } catch {
    return false;
  }
}

// Express middleware — validates every request against this router using
// TWILIO_AUTH_TOKEN and the request's own path. Rejects with 403 before any
// route handler (and therefore any database write) runs.
function requireValidTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  const url = buildTwilioUrl(req);
  const ok = isValidTwilioRequest({ authToken, signature, url, params: req.body });
  if (!ok) {
    console.warn(`[twilio/signature] rejected ${req.method} ${req.originalUrl} — invalid or missing X-Twilio-Signature`);
    return res.status(403).send('Invalid Twilio signature');
  }
  next();
}

module.exports = { isValidTwilioRequest, buildTwilioUrl, requireValidTwilioSignature };
