// Tests for the fail-closed CRM credential behavior in submit-lead.js and
// send-guide.js. global.fetch is mocked in every test so no real network
// call is ever made — these must never touch the live CRM, Turnstile, or
// Resend.

import test from 'node:test';
import assert from 'node:assert/strict';
import { saveLeadToCRM as saveLeadSubmitLead } from '../submit-lead.js';
import { saveLeadToCRM as saveLeadSendGuide } from '../send-guide.js';

const FAKE_ENV_WITH_CREDS = { CRM_API_KEY: 'unit-test-fake-api-key', CRM_INTERNAL_KEY: 'unit-test-fake-internal-key' };
const OLD_HARDCODED_FALLBACK = 'prosperity-crm-2025';

function withMockedFetch(implementation, fn) {
  const original = global.fetch;
  let callCount = 0;
  global.fetch = async (...args) => {
    callCount++;
    return implementation(...args);
  };
  return fn(() => callCount).finally(() => {
    global.fetch = original;
  });
}

for (const [label, saveLeadToCRM] of [
  ['submit-lead.js', saveLeadSubmitLead],
  ['send-guide.js', saveLeadSendGuide],
]) {
  test(`${label}: fails closed and never calls fetch when CRM_API_KEY is missing`, async () => {
    await withMockedFetch(
      () => { throw new Error('fetch should not have been called'); },
      async (getCallCount) => {
        const result = await saveLeadToCRM({ CRM_INTERNAL_KEY: 'present' }, { email: 'test@example.com' });
        assert.equal(result, false);
        assert.equal(getCallCount(), 0);
      }
    );
  });

  test(`${label}: fails closed and never calls fetch when CRM_INTERNAL_KEY is missing`, async () => {
    await withMockedFetch(
      () => { throw new Error('fetch should not have been called'); },
      async (getCallCount) => {
        const result = await saveLeadToCRM({ CRM_API_KEY: 'present' }, { email: 'test@example.com' });
        assert.equal(result, false);
        assert.equal(getCallCount(), 0);
      }
    );
  });

  test(`${label}: fails closed and never calls fetch when both credentials are missing`, async () => {
    await withMockedFetch(
      () => { throw new Error('fetch should not have been called'); },
      async (getCallCount) => {
        const result = await saveLeadToCRM({}, { email: 'test@example.com' });
        assert.equal(result, false);
        assert.equal(getCallCount(), 0);
      }
    );
  });

  test(`${label}: sends the configured credentials as headers and never the old hardcoded fallback`, async () => {
    let capturedHeaders;
    await withMockedFetch(
      (url, options) => {
        capturedHeaders = options.headers;
        return { ok: true, status: 200, text: async () => 'ok' };
      },
      async (getCallCount) => {
        const result = await saveLeadToCRM(FAKE_ENV_WITH_CREDS, { email: 'test@example.com' });
        assert.equal(result, true);
        assert.equal(getCallCount(), 1);
        assert.equal(capturedHeaders['x-api-key'], FAKE_ENV_WITH_CREDS.CRM_API_KEY);
        assert.equal(capturedHeaders['x-internal-key'], FAKE_ENV_WITH_CREDS.CRM_INTERNAL_KEY);
        assert.notEqual(capturedHeaders['x-api-key'], OLD_HARDCODED_FALLBACK);
      }
    );
  });

  test(`${label}: returns false when the CRM responds with a non-OK status`, async () => {
    await withMockedFetch(
      () => ({ ok: false, status: 500, text: async () => 'server error' }),
      async () => {
        const result = await saveLeadToCRM(FAKE_ENV_WITH_CREDS, { email: 'test@example.com' });
        assert.equal(result, false);
      }
    );
  });

  test(`${label}: returns false (does not throw) when fetch itself rejects`, async () => {
    await withMockedFetch(
      () => { throw new Error('network down'); },
      async () => {
        const result = await saveLeadToCRM(FAKE_ENV_WITH_CREDS, { email: 'test@example.com' });
        assert.equal(result, false);
      }
    );
  });
}
