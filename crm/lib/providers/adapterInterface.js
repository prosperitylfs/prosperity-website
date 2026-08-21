// Provider adapter interface for Call/Text/Email. Every adapter — fake or
// real — implements this exact shape, so the CRM workflow (draft, resolve
// sender, confirm) never needs to change when a real adapter is added
// later; only which adapter getAdapter() returns changes.
//
//   placeCall({ toNumber, fromNumber, brandId })   -> { ok, status, message }
//   sendText({ toNumber, fromNumber, brandId, body }) -> { ok, status, message }
//   sendEmail({ toAddress, fromAddress, brandId, subject, body }) -> { ok, status, message }
//
// status is one of 'blocked' | 'sent' | 'failed'. Every adapter in this
// checkpoint returns 'blocked' — see fakeAdapter.js. No adapter reads a
// provider credential from `.env`; only a real, future adapter would, and
// none exists yet (see liveAdapterStub.js, which documents the shape and is
// never wired in or invoked).

module.exports = {}; // documentation-only module; nothing to export
