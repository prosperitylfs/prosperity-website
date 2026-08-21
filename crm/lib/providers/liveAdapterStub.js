// NOT WIRED IN. Never required by getAdapter() or by any route in this
// checkpoint — exists only to document the shape a real Twilio/Microsoft/
// Gmail-backed adapter would take later, implementing the same interface
// as fakeAdapter.js, so activating live sending in a future checkpoint
// means writing this file's real implementation and flipping getAdapter()
// — never rewriting crm/lib/communicationDraftService.js or any route.
//
// A real implementation would read its provider credentials from
// process.env (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / brand-specific FROM
// numbers, or MICROSOFT_*/GMAIL_* — see crm/config/brands.js
// credentialEnvVars) at call time, the same way crm/routes/twilio.js and
// crm/routes/email.js already do elsewhere in this app. Nothing here reads
// any of that today.

async function placeCall({ toNumber, fromNumber, brandId }) {
  throw new Error('liveAdapterStub.placeCall is not implemented — this file is not wired in');
}

async function sendText({ toNumber, fromNumber, brandId, body }) {
  throw new Error('liveAdapterStub.sendText is not implemented — this file is not wired in');
}

async function sendEmail({ toAddress, fromAddress, brandId, subject, body }) {
  throw new Error('liveAdapterStub.sendEmail is not implemented — this file is not wired in');
}

module.exports = { placeCall, sendText, sendEmail };
