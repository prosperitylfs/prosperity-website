// Confirms POST /api/twilio/sms/inbound -- the number-level webhook the
// Prosperity 414 number's Messaging Service actually defers to today, and
// therefore the one authoritative production inbound-SMS URL -- is
// protected by the exact same X-Twilio-Signature verification as every
// other Twilio route in this app, and that verification is computed
// against THAT route's own production URL specifically. Fake signed
// fixtures only (crypto), no network, no real Twilio credential.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { isValidTwilioRequest, requireValidTwilioSignature, buildTwilioUrl } = require('../lib/twilioSignature');

const AUTHORITATIVE_PATH = '/api/twilio/sms/inbound';

function computeTwilioSignature(authToken, url, params) {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

test('a garbage signature on the authoritative production URL is rejected', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const url = `https://prosperity-crm.onrender.com${AUTHORITATIVE_PATH}`;
  const params = { From: '+14145551234', To: '+14144411177', Body: 'hi', MessageSid: 'SMfake00000000000000000000000020' };
  assert.equal(isValidTwilioRequest({ authToken, signature: 'not-a-real-signature', url, params }), false);
});

test('a signature computed against a DIFFERENT path than the authoritative one is rejected -- signature validation is path-specific', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const host = 'https://prosperity-crm.onrender.com';
  const params = { From: '+14145551234', To: '+14144411177', Body: 'hi', MessageSid: 'SMfake00000000000000000000000021' };
  // Signed for a different route...
  const signature = computeTwilioSignature(authToken, `${host}/api/twilio-prosperity/sms/inbound`, params);
  // ...but presented against the authoritative one.
  assert.equal(isValidTwilioRequest({ authToken, signature, url: `${host}${AUTHORITATIVE_PATH}`, params }), false);
});

test('a genuinely fake-signed fixture for the exact authoritative production URL verifies as valid', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const url = `https://prosperity-crm.onrender.com${AUTHORITATIVE_PATH}`;
  const params = { From: '+14145551234', To: '+14144411177', Body: 'hi', MessageSid: 'SMfake00000000000000000000000022' };
  const signature = computeTwilioSignature(authToken, url, params);
  assert.equal(isValidTwilioRequest({ authToken, signature, url, params }), true);
});

test('requireValidTwilioSignature builds the URL from CRM_PUBLIC_URL + the request\'s own path -- confirms it resolves to the authoritative production URL when CRM_PUBLIC_URL matches production', () => {
  const originalPublicUrl = process.env.CRM_PUBLIC_URL;
  process.env.CRM_PUBLIC_URL = 'https://prosperity-crm.onrender.com';
  try {
    const url = buildTwilioUrl({ originalUrl: AUTHORITATIVE_PATH });
    assert.equal(url, 'https://prosperity-crm.onrender.com/api/twilio/sms/inbound');
  } finally {
    if (originalPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL; else process.env.CRM_PUBLIC_URL = originalPublicUrl;
  }
});

test('requireValidTwilioSignature middleware rejects an invalid signature on the authoritative path, never calling next()', () => {
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalPublicUrl = process.env.CRM_PUBLIC_URL;
  process.env.TWILIO_AUTH_TOKEN = 'fake_test_only_auth_token_never_real';
  process.env.CRM_PUBLIC_URL = 'https://prosperity-crm.onrender.com';
  try {
    const req = {
      headers: { 'x-twilio-signature': 'garbage' },
      body: { From: '+14145551234', To: '+14144411177', Body: 'hi', MessageSid: 'SMfake00000000000000000000000023' },
      originalUrl: AUTHORITATIVE_PATH, method: 'POST',
    };
    let nextCalled = false, statusCode;
    const res = { status(code) { statusCode = code; return this; }, send() {} };
    requireValidTwilioSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(statusCode, 403);
  } finally {
    if (originalToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = originalToken;
    if (originalPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL; else process.env.CRM_PUBLIC_URL = originalPublicUrl;
  }
});

test('requireValidTwilioSignature middleware accepts a validly fake-signed request for the authoritative production URL', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalPublicUrl = process.env.CRM_PUBLIC_URL;
  process.env.TWILIO_AUTH_TOKEN = authToken;
  process.env.CRM_PUBLIC_URL = 'https://prosperity-crm.onrender.com';
  try {
    const params = { From: '+14145551234', To: '+14144411177', Body: 'hi', MessageSid: 'SMfake00000000000000000000000024' };
    const url = buildTwilioUrl({ originalUrl: AUTHORITATIVE_PATH });
    const signature = computeTwilioSignature(authToken, url, params);
    const req = { headers: { 'x-twilio-signature': signature }, body: params, originalUrl: AUTHORITATIVE_PATH, method: 'POST' };
    let nextCalled = false;
    const res = { status() { return this; }, send() {} };
    requireValidTwilioSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally {
    if (originalToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = originalToken;
    if (originalPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL; else process.env.CRM_PUBLIC_URL = originalPublicUrl;
  }
});
