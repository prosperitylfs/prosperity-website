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

// ── CRM fail-safe: a qualified prospect must never lose scheduling access
//    because CRM lead capture failed (functions/submit-lead.js) ──────────

function withCapturedConsoleError(fn) {
  const original = console.error;
  const calls = [];
  console.error = (...args) => { calls.push(args.join(' ')); };
  return fn(calls).finally(() => { console.error = original; });
}

// A. CRM save succeeds -> normal successful response, crm_saved:true.
test('A: CRM save succeeds -> 200 {ok:true, crm_saved:true}', async () => {
  await withMockedFetch({ crmOk: true }, async (getCaptured) => {
    const body = {
      first_name: 'Pat', last_name: 'Retiree', email: 'pat@example.com', phone: '+14144411177',
      lead_type: 'Retirement Lead', retirement_timeline: 'Already retired', assets: '$100,000–$250,000',
      turnstile_token: 'fake-token',
    };
    const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json, { ok: true, crm_saved: true });
    assert.ok(getCaptured().crmBody, 'the CRM must still have been called on the success path');
  });
});

// B. CRM save fails -> logged, and now HONESTLY reported via crm_saved:false
//    (HTTP status/ok stay 200/true unconditionally -- see the file-level
//    comment in functions/submit-lead.js for why: every OTHER caller of this
//    same-origin Function, schedule.html/life-insurance.html/
//    life-insurance-qualifier.html/contact.html, reads only `ok` and must
//    stay completely unaffected by this change. book.html's schSubmitLead()
//    is the only caller that inspects crm_saved, to block its own next step
//    and show a friendly error -- that blocking behavior lives in book.html
//    itself, not in this shared Function).
test('B: CRM save fails -> logged server-side, HTTP stays 200/ok:true (unchanged for other callers), but crm_saved:false now honestly reports the failure', async () => {
  await withCapturedConsoleError(async (logCalls) => {
    await withMockedFetch({ crmOk: false }, async (getCaptured) => {
      const body = {
        first_name: 'Pat', last_name: 'Retiree', email: 'pat@example.com', phone: '+14144411177',
        lead_type: 'Retirement Lead', retirement_timeline: 'Already retired', assets: '$100,000–$250,000',
        turnstile_token: 'fake-token',
      };
      const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });

      assert.equal(res.status, 200, 'HTTP status stays 200 -- other callers that only check res.ok are unaffected');
      const json = await res.json();
      assert.deepEqual(json, { ok: true, crm_saved: false }, 'crm_saved must honestly reflect the failure -- this is the exact field book.html now checks to avoid the Renee Jones production bug (a CRM save that silently failed while the visitor was told nothing was wrong)');

      assert.ok(getCaptured().crmBody, 'the CRM save must still have been attempted, not skipped');
      assert.ok(
        logCalls.some(line => line.includes('CRM lead save failed')),
        'the failure must be logged server-side for later diagnosis'
      );
    });
  });
});

// C. Qualification/validation behavior is unchanged -- these gates still
//    run, and still run BEFORE the CRM is ever contacted, regardless of
//    whether the CRM would have succeeded or failed.
test('C: Turnstile verification still blocks the request before the CRM is ever called, even though CRM failure is now non-blocking', async () => {
  await withMockedFetch({ turnstileOk: false, crmOk: false }, async (getCaptured) => {
    const body = { email: 'bot@example.com', lead_type: 'contact', turnstile_token: 'bad-token' };
    const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    assert.equal(res.status, 400, 'the fail-safe only affects CRM-save failures, never weakens Turnstile verification');
    const json = await res.json();
    assert.match(json.error, /Verification failed/);
    assert.equal(getCaptured().crmBody, undefined, 'the CRM must still never be called when Turnstile fails');
  });
});

test('C: missing email and phone -> still 400, never reaches the CRM, unaffected by the fail-safe', async () => {
  await withMockedFetch({ crmOk: false }, async (getCaptured) => {
    const body = { first_name: 'No Contact Info', turnstile_token: 'fake-token' };
    const res = await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    assert.equal(res.status, 400);
    assert.equal(getCaptured().crmBody, undefined);
  });
});

// D. No CRM/database/schema behavior changed -- the payload/headers sent to
//    the CRM are byte-identical whether the CRM is about to succeed or
//    fail; only the RESPONSE TO THE BROWSER differs.
test('D: the payload and headers sent to the CRM are unchanged regardless of whether the CRM call is about to fail', async () => {
  const body = {
    first_name: 'Pat', last_name: 'Retiree', email: 'pat@example.com', phone: '+14144411177',
    lead_type: 'Retirement Lead', retirement_timeline: 'Already retired', assets: '$100,000–$250,000',
    turnstile_token: 'fake-token',
  };

  let okBody, okHeaders, failBody, failHeaders;
  await withMockedFetch({ crmOk: true }, async (getCaptured) => {
    await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    ({ crmBody: okBody, crmHeaders: okHeaders } = getCaptured());
  });
  await withMockedFetch({ crmOk: false }, async (getCaptured) => {
    await onRequestPost({ request: fakeRequest(body), env: FAKE_ENV });
    ({ crmBody: failBody, crmHeaders: failHeaders } = getCaptured());
  });

  assert.deepEqual(okBody, failBody, 'the lead payload forwarded to the CRM must be identical either way -- no weakening/altering of what is captured');
  assert.equal(okHeaders['x-api-key'], failHeaders['x-api-key']);
  assert.equal(okHeaders['x-internal-key'], failHeaders['x-internal-key']);
});
