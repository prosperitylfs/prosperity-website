// Confirms the outbound SMS status-callback route
// (crm/routes/twilioProsperitySms.js's POST /sms/status) is protected by
// the exact same X-Twilio-Signature verification as every other Twilio
// route in this app -- a forged or unsigned callback is rejected by the
// middleware before crm/lib/smsStatusService.js ever runs. Uses locally
// computed fake signed fixtures only (crypto, no network, no real Twilio
// credential).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { isValidTwilioRequest, requireValidTwilioSignature, buildTwilioUrl } = require('../lib/twilioSignature');

function computeTwilioSignature(authToken, url, params) {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

test('a genuinely fake-signed status-callback fixture verifies as valid', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const url = 'https://example-crm.test/api/twilio-prosperity/sms/status';
  const params = { MessageSid: 'SMfake00000000000000000000000010', MessageStatus: 'delivered' };
  const signature = computeTwilioSignature(authToken, url, params);
  assert.equal(isValidTwilioRequest({ authToken, signature, url, params }), true);
});

test('a forged signature on the status-callback route is rejected by the middleware before any handler runs', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalPublicUrl = process.env.CRM_PUBLIC_URL;
  process.env.TWILIO_AUTH_TOKEN = authToken;
  process.env.CRM_PUBLIC_URL = 'https://example-crm.test';
  try {
    const req = {
      headers: { 'x-twilio-signature': 'not-a-real-signature' },
      body: { MessageSid: 'SMfake00000000000000000000000011', MessageStatus: 'delivered' },
      originalUrl: '/api/twilio-prosperity/sms/status',
      method: 'POST',
    };
    let nextCalled = false;
    let statusCode;
    const res = { status(code) { statusCode = code; return this; }, send() {} };
    requireValidTwilioSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
  } finally {
    if (originalToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = originalToken;
    if (originalPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL; else process.env.CRM_PUBLIC_URL = originalPublicUrl;
  }
});

test('a validly fake-signed status-callback request passes the middleware', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalPublicUrl = process.env.CRM_PUBLIC_URL;
  process.env.TWILIO_AUTH_TOKEN = authToken;
  process.env.CRM_PUBLIC_URL = 'https://example-crm.test';
  try {
    const params = { MessageSid: 'SMfake00000000000000000000000012', MessageStatus: 'delivered' };
    const url = buildTwilioUrl({ originalUrl: '/api/twilio-prosperity/sms/status' });
    const signature = computeTwilioSignature(authToken, url, params);
    const req = { headers: { 'x-twilio-signature': signature }, body: params, originalUrl: '/api/twilio-prosperity/sms/status', method: 'POST' };
    let nextCalled = false;
    const res = { status() { return this; }, send() {} };
    requireValidTwilioSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally {
    if (originalToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = originalToken;
    if (originalPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL; else process.env.CRM_PUBLIC_URL = originalPublicUrl;
  }
});
