// The default adapter — active unless process.env.COMMUNICATION_PROVIDER is
// exactly 'twilio' (see getAdapter() in ./index.js). Never contacts a
// network, never reads an environment variable, and always returns
// status:'blocked' regardless of input — this is what "Sending is disabled
// in this local checkpoint." means at the code level: not a UI-only message
// layered on top of a real send path, but the actual terminus of the
// call/text/email workflow. sendText() accepts the same richer parameter
// shape crm/lib/providers/liveTwilioAdapter.js does (hasConsent,
// isOptedOut, etc.) but never inspects any of it — every input, valid or
// not, produces the identical blocked result.

const BLOCKED_MESSAGE = 'Sending is disabled in this local checkpoint.';

async function placeCall({ toNumber, fromNumber, brandId } = {}) {
  return { ok: false, status: 'blocked', message: BLOCKED_MESSAGE };
}

async function sendText({ toNumber, fromNumber, brandId, body } = {}) {
  return { ok: false, status: 'blocked', message: BLOCKED_MESSAGE };
}

async function sendEmail({ toAddress, fromAddress, brandId, subject, body } = {}) {
  return { ok: false, status: 'blocked', message: BLOCKED_MESSAGE };
}

module.exports = { placeCall, sendText, sendEmail };
