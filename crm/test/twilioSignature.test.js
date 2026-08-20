// Unit tests for crm/lib/twilioSignature.js — pure functions, no database,
// no network calls, no real credentials. All tokens/URLs below are fake
// values used only to exercise the verification logic.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  isValidTwilioRequest,
  buildTwilioUrl,
  requireValidTwilioSignature,
} = require('../lib/twilioSignature');

// Replicates Twilio's documented X-Twilio-Signature algorithm (HMAC-SHA1 of
// the URL with sorted param key+value pairs appended, base64-encoded) so
// tests can construct a signature Twilio itself would consider valid,
// without needing any real Twilio credential.
function computeTwilioSignature(authToken, url, params) {
  let data = url;
  for (const key of Object.keys(params).sort()) {
    data += key + params[key];
  }
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

const FAKE_AUTH_TOKEN = 'unit_test_fake_auth_token_0000000000';
const FAKE_URL = 'https://example-crm.test/api/twilio/incoming';
const FAKE_PARAMS = { From: '+15551234567', CallSid: 'CAtest00000000000000000000000000' };

test('accepts a correctly signed request', () => {
  const signature = computeTwilioSignature(FAKE_AUTH_TOKEN, FAKE_URL, FAKE_PARAMS);
  const result = isValidTwilioRequest({
    authToken: FAKE_AUTH_TOKEN,
    signature,
    url: FAKE_URL,
    params: FAKE_PARAMS,
  });
  assert.equal(result, true);
});

test('rejects a request with a garbage signature', () => {
  const result = isValidTwilioRequest({
    authToken: FAKE_AUTH_TOKEN,
    signature: 'not-a-real-signature',
    url: FAKE_URL,
    params: FAKE_PARAMS,
  });
  assert.equal(result, false);
});

test('rejects a request whose params were tampered with after signing', () => {
  const signedParams = { From: '+15551234567' };
  const signature = computeTwilioSignature(FAKE_AUTH_TOKEN, FAKE_URL, signedParams);
  const tamperedParams = { From: '+19995551234' }; // caller ID changed after signing
  const result = isValidTwilioRequest({
    authToken: FAKE_AUTH_TOKEN,
    signature,
    url: FAKE_URL,
    params: tamperedParams,
  });
  assert.equal(result, false);
});

test('rejects a request replayed against a different URL than it was signed for', () => {
  const signature = computeTwilioSignature(FAKE_AUTH_TOKEN, FAKE_URL, FAKE_PARAMS);
  const result = isValidTwilioRequest({
    authToken: FAKE_AUTH_TOKEN,
    signature,
    url: 'https://example-crm.test/api/twilio/sms/inbound',
    params: FAKE_PARAMS,
  });
  assert.equal(result, false);
});

test('fails closed when the auth token is not configured', () => {
  const signature = computeTwilioSignature(FAKE_AUTH_TOKEN, FAKE_URL, FAKE_PARAMS);
  const result = isValidTwilioRequest({
    authToken: undefined,
    signature,
    url: FAKE_URL,
    params: FAKE_PARAMS,
  });
  assert.equal(result, false);
});

test('fails closed when the signature header is missing', () => {
  const result = isValidTwilioRequest({
    authToken: FAKE_AUTH_TOKEN,
    signature: undefined,
    url: FAKE_URL,
    params: FAKE_PARAMS,
  });
  assert.equal(result, false);
});

test('fails closed when the URL is missing', () => {
  const signature = computeTwilioSignature(FAKE_AUTH_TOKEN, FAKE_URL, FAKE_PARAMS);
  const result = isValidTwilioRequest({
    authToken: FAKE_AUTH_TOKEN,
    signature,
    url: undefined,
    params: FAKE_PARAMS,
  });
  assert.equal(result, false);
});

test('buildTwilioUrl combines the configured public base URL and the request path', () => {
  const req = { originalUrl: '/api/twilio/incoming' };
  const url = buildTwilioUrl(req, 'https://example-crm.test/');
  assert.equal(url, 'https://example-crm.test/api/twilio/incoming');
});

test('requireValidTwilioSignature middleware rejects with 403 and never calls next() when invalid', () => {
  const req = { headers: {}, body: {}, originalUrl: '/api/twilio/incoming', method: 'POST' };
  let statusCode, sentBody;
  const res = {
    status(code) { statusCode = code; return this; },
    send(body) { sentBody = body; },
  };
  let nextCalled = false;

  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TWILIO_AUTH_TOKEN; // simulate not-yet-configured
  try {
    requireValidTwilioSignature(req, res, () => { nextCalled = true; });
  } finally {
    if (originalToken === undefined) delete process.env.TWILIO_AUTH_TOKEN;
    else process.env.TWILIO_AUTH_TOKEN = originalToken;
  }

  assert.equal(nextCalled, false);
  assert.equal(statusCode, 403);
  assert.ok(sentBody);
});

test('requireValidTwilioSignature middleware calls next() when the signature is valid', () => {
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalPublicUrl = process.env.CRM_PUBLIC_URL;
  process.env.TWILIO_AUTH_TOKEN = FAKE_AUTH_TOKEN;
  process.env.CRM_PUBLIC_URL = 'https://example-crm.test';

  try {
    const url = buildTwilioUrl({ originalUrl: '/api/twilio/incoming' });
    const signature = computeTwilioSignature(FAKE_AUTH_TOKEN, url, FAKE_PARAMS);
    const req = {
      headers: { 'x-twilio-signature': signature },
      body: FAKE_PARAMS,
      originalUrl: '/api/twilio/incoming',
      method: 'POST',
    };
    let nextCalled = false;
    const res = { status() { return this; }, send() {} };
    requireValidTwilioSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally {
    if (originalToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = originalToken;
    if (originalPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL; else process.env.CRM_PUBLIC_URL = originalPublicUrl;
  }
});
