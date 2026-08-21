// Tests for crm/lib/providers/index.js's getAdapter() selection logic.
// No network calls -- these only check WHICH module reference comes back.

const test = require('node:test');
const assert = require('node:assert/strict');

function freshGetAdapter() {
  // getAdapter() reads process.env at call time, but require() caches the
  // module -- re-requiring after clearing the cache isn't necessary since
  // getAdapter() itself re-reads process.env on every call (no
  // module-load-time caching of the env var). A single require is enough.
  delete require.cache[require.resolve('../lib/providers')];
  return require('../lib/providers').getAdapter;
}

function withProvider(value, fn) {
  const original = process.env.COMMUNICATION_PROVIDER;
  if (value === undefined) delete process.env.COMMUNICATION_PROVIDER;
  else process.env.COMMUNICATION_PROVIDER = value;
  try { return fn(); }
  finally {
    if (original === undefined) delete process.env.COMMUNICATION_PROVIDER;
    else process.env.COMMUNICATION_PROVIDER = original;
  }
}

test('the fake adapter remains the default with no COMMUNICATION_PROVIDER set', () => {
  withProvider(undefined, () => {
    const getAdapter = freshGetAdapter();
    const adapter = getAdapter();
    assert.equal(adapter, require('../lib/providers/fakeAdapter'));
  });
});

test('an explicit server-side COMMUNICATION_PROVIDER=twilio selects the live Twilio adapter', () => {
  withProvider('twilio', () => {
    const getAdapter = freshGetAdapter();
    const adapter = getAdapter();
    assert.equal(adapter, require('../lib/providers/liveTwilioAdapter'));
  });
});

test('an empty COMMUNICATION_PROVIDER stays on the fake adapter', () => {
  withProvider('', () => {
    const getAdapter = freshGetAdapter();
    assert.equal(getAdapter(), require('../lib/providers/fakeAdapter'));
  });
});

test('a misspelled or wrong-case COMMUNICATION_PROVIDER stays on the fake adapter', () => {
  for (const bad of ['Twilio', 'TWILIO', 'twillio', 'live', 'sms']) {
    withProvider(bad, () => {
      const getAdapter = freshGetAdapter();
      assert.equal(getAdapter(), require('../lib/providers/fakeAdapter'), `expected fake adapter for COMMUNICATION_PROVIDER='${bad}'`);
    });
  }
});

test('browser input cannot select the live adapter -- getAdapter() ignores any argument and only reads server env', () => {
  withProvider(undefined, () => {
    const getAdapter = freshGetAdapter();
    // Simulates a hypothetical caller trying to pass a client-influenced
    // selection straight into getAdapter() -- it takes no parameters, so
    // this has no effect at all.
    const adapter = getAdapter({ provider: 'twilio' }, 'twilio');
    assert.equal(adapter, require('../lib/providers/fakeAdapter'));
  });
});

test('setting COMMUNICATION_PROVIDER=twilio does not change the exported function\'s arity (still takes no arguments)', () => {
  const { getAdapter } = require('../lib/providers');
  assert.equal(getAdapter.length, 0);
});
