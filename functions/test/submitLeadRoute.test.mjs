// Tests for functions/submit-lead.js's onRequestPost() — the full
// same-origin entry point every browser Prosperity form now uses. Proves
// the corrected architecture end-to-end: browser sends no credential at
// all, this Function verifies Turnstile itself, then adds the PRIVATE
// server-to-server credential (env.CRM_API_KEY / env.CRM_INTERNAL_KEY) from
// its own environment — never from the request body — before forwarding to
// the CRM. global.fetch is mocked in every test; nothing here makes a real
// network call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost } from '../submit-lead.js';

const FAKE_ENV = { CRM_API_KEY: 'unit-test-fake-api-key', CRM_INTERNAL_KEY: 'unit-test-fake-internal-key', TURNSTILE_SECRET_KEY: 'unit-test-fake-turnstile-secret' };

function fakeRequest(body) {
  return {
    json: async () => body,
    headers: { get: () => null },
  };
}

// Routes the two distinct external calls this Function makes (Cloudflare's
// Turnstile siteverify, then the CRM's /api/leads) to different canned
// responses based on URL, and captures the CRM call's body/headers for
// assertions.
function withMockedFetch({ turnstileOk = true, crmOk = true } = {}, fn) {
  const original = global.fetch;
  let capturedCrmBody;
  let capturedCrmHeaders;
  global.fetch = async (url, options) => {
    if (String(url).includes('challenges.cloudflare.com')) {
      return { json: async () => ({ success: turnstileOk }) };
    }
    if (String(url).includes('/api/leads')) {
      capturedCrmBody = JSON.parse(options.body);
      capturedCrmHeaders = options.headers;
      return { ok: crmOk, status: crmOk ? 200 : 502, text: async () => 'ok' };
    }
    throw new Error('unexpected fetch call to ' + url);
  };
  return fn(() => ({ crmBody: capturedCrmBody, crmHeaders: capturedCrmHeaders })).finally(() => {
    global.fetch = original;
  });
}

test('life-insurance-qualifier.html-shaped payload: every field is forwarded to the CRM unchanged', async () => {
  await withMockedFetch({}, async (getCaptured) => {
    const body = {
      first_name: 'Sam', last_name: 'Ortiz', phone: '+14144411177', email: 'sam@example.com',
      lead_type: 'Life Insurance Lead', lead_source: 'https://www.prosperitylfs.com/life-insurance-qualifier.html',
      state: 'WI', age_range: '35-44', coverage_type: 'Term', coverage_for: 'self',
      tobacco: 'no', health_concerns: 'none', sms_consent: 'yes', terms_accepted: 'yes',
      turnstile_token: 'fake-token',
    };
    const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    const status = res.status;
    const json = await res.json();

    assert.equal(status, 200);
    assert.equal(json.ok, true);

    const { crmBody } = getCaptured();
    for (const [key, value] of Object.entries(body)) {
      if (key === 'turnstile_token') continue; // deliberately stripped before forwarding
      assert.equal(crmBody[key], value, `expected forwarded field '${key}' to match`);
    }
    assert.ok(!('turnstile_token' in crmBody), 'turnstile_token must not be forwarded to the CRM');
  });
});

test('contact.html-shaped payload (message field): forwarded to the CRM unchanged', async () => {
  await withMockedFetch({}, async (getCaptured) => {
    const body = {
      first_name: 'Robin', last_name: 'Doe', email: 'robin@example.com', phone: '+14144412222',
      message: 'Please call me about a policy.', terms_accepted: 'yes', lead_type: 'contact',
      lead_source: 'https://www.prosperitylfs.com/contact.html', turnstile_token: 'fake-token',
    };
    const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    assert.equal(res.status, 200);

    const { crmBody } = getCaptured();
    assert.equal(crmBody.message, body.message);
    assert.equal(crmBody.first_name, body.first_name);
    assert.equal(crmBody.lead_type, body.lead_type);
  });
});

test('the CRM credential is added from env, never from the request body, even if the body tries to supply one', async () => {
  await withMockedFetch({}, async (getCaptured) => {
    const body = {
      email: 'spoof@example.com', lead_type: 'contact', turnstile_token: 'fake-token',
      // A malicious/confused client including credential-shaped fields must
      // have zero effect — they're just inert data fields, never read as
      // headers.
      'x-api-key': 'attacker-supplied-value',
      'x-internal-key': 'attacker-supplied-value',
      CRM_API_KEY: 'attacker-supplied-value',
    };
    const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    assert.equal(res.status, 200);

    const { crmHeaders } = getCaptured();
    assert.equal(crmHeaders['x-api-key'], FAKE_ENV.CRM_API_KEY, 'the real header must come from env, not the body');
    assert.equal(crmHeaders['x-internal-key'], FAKE_ENV.CRM_INTERNAL_KEY, 'the real header must come from env, not the body');
    assert.notEqual(crmHeaders['x-api-key'], 'attacker-supplied-value');
    assert.notEqual(crmHeaders['x-internal-key'], 'attacker-supplied-value');
  });
});

test('missing/invalid Turnstile token blocks the request before the CRM is ever called', async () => {
  await withMockedFetch({ turnstileOk: false }, async (getCaptured) => {
    const body = { email: 'bot@example.com', lead_type: 'contact', turnstile_token: 'bad-token' };
    const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.match(json.error, /Verification failed/);
    assert.equal(getCaptured().crmBody, undefined, 'the CRM must never be called when Turnstile fails');
  });
});

test('missing email and phone -> 400, never reaches Turnstile or the CRM', async () => {
  await withMockedFetch({}, async (getCaptured) => {
    const body = { first_name: 'No Contact Info', turnstile_token: 'fake-token' };
    const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    assert.equal(res.status, 400);
    assert.equal(getCaptured().crmBody, undefined);
  });
});

test('no CRM credential value ever appears in the JSON response body', async () => {
  await withMockedFetch({}, async () => {
    const body = { email: 'sam@example.com', lead_type: 'contact', turnstile_token: 'fake-token' };
    const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    const text = JSON.stringify(await res.json());
    assert.ok(!text.includes(FAKE_ENV.CRM_API_KEY));
    assert.ok(!text.includes(FAKE_ENV.CRM_INTERNAL_KEY));
  });
});
