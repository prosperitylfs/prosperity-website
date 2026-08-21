// Tests for crm/lib/providers/liveTwilioAdapter.js. Every test injects a
// fully mocked Twilio client via the deps.getTwilioClient parameter — the
// real 'twilio' package is NEVER required or constructed by any test here,
// so this file makes zero network requests under any circumstance.

const test = require('node:test');
const assert = require('node:assert/strict');
const { sendText, placeCall, sendEmail } = require('../lib/providers/liveTwilioAdapter');
const { BRANDS } = require('../config/brands');

const PROSPERITY_NUMBER = BRANDS.prosperity.phone.e164; // +14144411177
const VALID_CONFIG = {
  TWILIO_ACCOUNT_SID: 'AC_fake_test_sid_never_real',
  TWILIO_AUTH_TOKEN: 'fake_test_auth_token_never_real',
  TWILIO_FROM_NUMBER_PROSPERITY: PROSPERITY_NUMBER,
};
const VALID_PARAMS = {
  toNumber: '+14145551234', fromNumber: PROSPERITY_NUMBER, brandId: 'prosperity',
  body: 'Hi, this is a test message.', hasConsent: true, isOptedOut: false,
};

function withEnv(vars, fn) {
  const keys = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER_PROSPERITY', 'TWILIO_FROM_NUMBER', 'CRM_PUBLIC_URL'];
  const originals = {};
  for (const k of keys) originals[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, vars);
  return Promise.resolve(fn()).finally(() => {
    for (const k of keys) {
      if (originals[k] === undefined) delete process.env[k]; else process.env[k] = originals[k];
    }
  });
}

// A mock Twilio client -- never a real network call. Records what it was
// called with so tests can assert on it.
function mockClient({ throws } = {}) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        if (throws) throw throws;
        return { sid: 'SM_fake_success_0000000000000001', status: 'queued' };
      },
    },
  };
}

test('missing Account SID blocks sending', async () => {
  await withEnv({ TWILIO_AUTH_TOKEN: 'x', TWILIO_FROM_NUMBER_PROSPERITY: PROSPERITY_NUMBER }, async () => {
    const result = await sendText(VALID_PARAMS);
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /TWILIO_ACCOUNT_SID/);
  });
});

test('missing Auth Token blocks sending', async () => {
  await withEnv({ TWILIO_ACCOUNT_SID: 'AC_x', TWILIO_FROM_NUMBER_PROSPERITY: PROSPERITY_NUMBER }, async () => {
    const result = await sendText(VALID_PARAMS);
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /TWILIO_AUTH_TOKEN/);
  });
});

test('missing Prosperity FROM number blocks sending', async () => {
  await withEnv({ TWILIO_ACCOUNT_SID: 'AC_x', TWILIO_AUTH_TOKEN: 'x' }, async () => {
    const result = await sendText(VALID_PARAMS);
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /TWILIO_FROM_NUMBER_PROSPERITY/);
  });
});

test('legacy TWILIO_FROM_NUMBER is never used as a fallback -- still blocked without the Prosperity-specific var', async () => {
  const { TWILIO_FROM_NUMBER_PROSPERITY, ...configWithoutProsperityNumber } = VALID_CONFIG;
  await withEnv({ ...configWithoutProsperityNumber, TWILIO_FROM_NUMBER: '+18005551234' }, async () => {
    const client = mockClient();
    const result = await sendText(VALID_PARAMS, { getTwilioClient: () => client });
    assert.equal(result.status, 'blocked');
    assert.equal(client.calls.length, 0, 'must never attempt a send when the Prosperity-specific var is absent, even if the legacy var is set');
  });
});

test('Insurance Lady sender cannot be used through this adapter', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const result = await sendText({ ...VALID_PARAMS, brandId: 'insurance-lady', fromNumber: BRANDS['insurance-lady'].phone.e164 }, { getTwilioClient: () => client });
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /Insurance Lady|insurance-lady/i);
    assert.equal(client.calls.length, 0);
  });
});

test('unresolved sender context (no brand at all) blocks sending', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const result = await sendText({ ...VALID_PARAMS, brandId: null, fromNumber: null }, { getTwilioClient: () => client });
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /could not be resolved/i);
    assert.equal(client.calls.length, 0);
  });
});

test('non-Prosperity client cannot send through the Prosperity adapter even with a matching fromNumber', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const result = await sendText({ ...VALID_PARAMS, brandId: 'insurance-lady' }, { getTwilioClient: () => client });
    assert.equal(result.status, 'blocked');
    assert.equal(client.calls.length, 0);
  });
});

test('absent consent blocks sending', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const result = await sendText({ ...VALID_PARAMS, hasConsent: false }, { getTwilioClient: () => client });
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /consent/i);
    assert.equal(client.calls.length, 0);
  });
});

test('STOP/opt-out blocks sending', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const result = await sendText({ ...VALID_PARAMS, isOptedOut: true }, { getTwilioClient: () => client });
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /STOP/);
    assert.equal(client.calls.length, 0);
  });
});

test('invalid recipient number blocks sending', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const badNumbers = [null, '', '5551234', 'not-a-number', '+44123456789'];
    for (const toNumber of badNumbers) {
      const result = await sendText({ ...VALID_PARAMS, toNumber }, { getTwilioClient: () => client });
      assert.equal(result.status, 'blocked', `expected blocked for toNumber=${toNumber}`);
    }
    assert.equal(client.calls.length, 0);
  });
});

test('a requested sender that differs from the configured Prosperity number is refused', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const result = await sendText({ ...VALID_PARAMS, fromNumber: '+14145550000' }, { getTwilioClient: () => client });
    assert.equal(result.status, 'blocked');
    assert.match(result.message, /does not match the configured/i);
    assert.equal(client.calls.length, 0);
  });
});

test('a valid Prosperity send uses exactly the 414 sender and makes exactly one mocked call', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const result = await sendText(VALID_PARAMS, { getTwilioClient: () => client });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'sent');
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].from, '+14144411177');
    assert.notEqual(client.calls[0].from, BRANDS['insurance-lady'].phone.e164);
  });
});

test('an accepted Twilio request records the Message SID and status sent', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const result = await sendText(VALID_PARAMS, { getTwilioClient: () => client });
    assert.equal(result.status, 'sent');
    assert.equal(result.sid, 'SM_fake_success_0000000000000001');
  });
});

test('a rejected Twilio request records status failed and a safe reason with no credential leakage', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const twilioError = new Error('The number +14145551234 is not a valid phone number');
    twilioError.code = 21211;
    const client = mockClient({ throws: twilioError });
    const result = await sendText(VALID_PARAMS, { getTwilioClient: () => client });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /21211/);
    assert.doesNotMatch(result.message, /fake_test_auth_token_never_real/);
    assert.doesNotMatch(result.message, /AC_fake_test_sid_never_real/);
  });
});

test('an accepted send is never marked delivered by this adapter', async () => {
  await withEnv(VALID_CONFIG, async () => {
    const client = mockClient();
    const result = await sendText(VALID_PARAMS, { getTwilioClient: () => client });
    assert.notEqual(result.status, 'delivered');
  });
});

test('placeCall and sendEmail stay hard-blocked and never touch a network, even when this adapter is selected', async () => {
  const callResult = await placeCall({});
  const emailResult = await sendEmail({});
  assert.equal(callResult.status, 'blocked');
  assert.equal(emailResult.status, 'blocked');
});
