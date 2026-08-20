// Cal.com webhook HMAC-SHA256 signature verification — pure, unit-testable,
// no database or network access.
//
// Fails closed: no secret configured, no header present, or a mismatch are
// all treated identically (rejected). This corrects the previous behavior,
// which returned true (accepted) whenever CALCOM_WEBHOOK_SECRET was unset.

const crypto = require('crypto');

function isValidCalcomSignature({ secret, signatureHeader, rawBody }) {
  if (!secret) return false;
  const sig = (signatureHeader || '').trim();
  if (!sig) return false;
  const body = rawBody || Buffer.alloc(0);
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig.toLowerCase()),
      Buffer.from(expected.toLowerCase())
    );
  } catch {
    return false;
  }
}

module.exports = { isValidCalcomSignature };
