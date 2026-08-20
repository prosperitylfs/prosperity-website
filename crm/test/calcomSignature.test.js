// Unit tests for crm/lib/calcomSignature.js — pure function, no database,
// no network calls, no real credentials.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { isValidCalcomSignature } = require('../lib/calcomSignature');

const FAKE_SECRET = 'unit_test_fake_calcom_secret_0000000000';
const FAKE_BODY = Buffer.from(JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: { uid: 'test-uid' } }));

function computeCalcomSignature(secret, body) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

test('accepts a correctly signed payload', () => {
  const signature = computeCalcomSignature(FAKE_SECRET, FAKE_BODY);
  const result = isValidCalcomSignature({
    secret: FAKE_SECRET,
    signatureHeader: signature,
    rawBody: FAKE_BODY,
  });
  assert.equal(result, true);
});

test('rejects a payload with the wrong signature', () => {
  const result = isValidCalcomSignature({
    secret: FAKE_SECRET,
    signatureHeader: 'deadbeef'.repeat(8),
    rawBody: FAKE_BODY,
  });
  assert.equal(result, false);
});

test('rejects a body tampered with after signing', () => {
  const signature = computeCalcomSignature(FAKE_SECRET, FAKE_BODY);
  const tamperedBody = Buffer.from(JSON.stringify({ triggerEvent: 'BOOKING_CANCELLED', payload: { uid: 'test-uid' } }));
  const result = isValidCalcomSignature({
    secret: FAKE_SECRET,
    signatureHeader: signature,
    rawBody: tamperedBody,
  });
  assert.equal(result, false);
});

// Behavior change from the previous implementation: previously, an unset
// CALCOM_WEBHOOK_SECRET caused verifySignature() to return true (fail open).
// It now must return false (fail closed).
test('fails closed when no secret is configured, even with a header present', () => {
  const signature = computeCalcomSignature(FAKE_SECRET, FAKE_BODY);
  const result = isValidCalcomSignature({
    secret: undefined,
    signatureHeader: signature,
    rawBody: FAKE_BODY,
  });
  assert.equal(result, false);
});

test('fails closed when the signature header is missing', () => {
  const result = isValidCalcomSignature({
    secret: FAKE_SECRET,
    signatureHeader: undefined,
    rawBody: FAKE_BODY,
  });
  assert.equal(result, false);
});

test('fails closed when the signature header is an empty string', () => {
  const result = isValidCalcomSignature({
    secret: FAKE_SECRET,
    signatureHeader: '   ',
    rawBody: FAKE_BODY,
  });
  assert.equal(result, false);
});

test('does not throw on a malformed (non-hex, wrong-length) signature header', () => {
  assert.doesNotThrow(() => {
    isValidCalcomSignature({
      secret: FAKE_SECRET,
      signatureHeader: 'not-hex-and-wrong-length',
      rawBody: FAKE_BODY,
    });
  });
});
