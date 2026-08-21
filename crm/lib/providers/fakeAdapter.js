// The only adapter actually wired up in this checkpoint (see
// getAdapter() in ./index.js). Never contacts a network, never reads an
// environment variable, and always returns status:'blocked' — this is what
// "Sending is disabled in this local checkpoint." means at the code level:
// not a UI-only message layered on top of a real send path, but the actual
// terminus of the call/text/email workflow.

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
