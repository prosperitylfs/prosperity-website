// Provider adapter interface for Call/Text/Email. Every adapter — fake or
// real — implements this exact shape, so the CRM workflow (draft, resolve
// sender, confirm) never needs to change when a real adapter is activated;
// only which adapter getAdapter() returns changes.
//
//   placeCall({ toNumber, fromNumber, brandId })
//     -> { ok, status, message }
//   sendText({ toNumber, fromNumber, brandId, body, hasConsent, isOptedOut }, deps?)
//     -> { ok, status, message?, sid?, errorCode? }
//   sendEmail({ toAddress, fromAddress, brandId, subject, body })
//     -> { ok, status, message }
//
// status is one of 'blocked' | 'sent' | 'failed'. fakeAdapter.js
// (crm/lib/providers/fakeAdapter.js) always returns 'blocked', regardless
// of input, and is the ONLY adapter selected unless
// process.env.COMMUNICATION_PROVIDER === 'twilio' exactly (see
// crm/lib/providers/index.js).
//
// crm/lib/providers/liveTwilioAdapter.js implements sendText() for real —
// it independently re-verifies brand/consent/opt-out/phone-format/sender-
// match itself (never trusting the caller blindly) before ever
// constructing a Twilio client, and reads TWILIO_ACCOUNT_SID /
// TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER_PROSPERITY from process.env only —
// never the legacy TWILIO_FROM_NUMBER, never an Insurance Lady variable,
// never anything from a browser request. Its placeCall()/sendEmail() stay
// hard-blocked (not implemented) even when this adapter is active — only
// outbound Prosperity SMS is implemented so far.
//
// sendText()'s optional second `deps` argument (`{ getTwilioClient }`) lets
// tests inject a fully mocked Twilio client so no adapter test ever makes a
// real network call; when omitted, the real 'twilio' package is
// constructed lazily, only after every guard has already passed.
//
// The outbound message record's lifecycle (queued -> sent | failed |
// blocked, and delivered only via a verified Twilio status callback) lives
// in crm/lib/prosperitySmsGateway.js, one layer above every adapter — not
// inside the adapters themselves.

module.exports = {}; // documentation-only module; nothing to export
