// Tests for crm/lib/oauthStateStore.js -- the CSRF `state` guard for the
// Microsoft OAuth authorize/callback round-trip (crm/routes/msEmail.js).
// Pure unit tests, no Express/MSAL/network involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createState, consumeState, _clearAllForTests } = require('../lib/oauthStateStore');

test.beforeEach(() => _clearAllForTests());

test('createState returns a non-empty, sufficiently random-looking string', () => {
  const a = createState();
  const b = createState();
  assert.ok(a && typeof a === 'string' && a.length >= 32);
  assert.notEqual(a, b, 'two calls must not coincidentally collide');
});

test('consumeState returns true for a state createState just issued', () => {
  const state = createState();
  assert.equal(consumeState(state), true);
});

test('consumeState is single-use -- the same state cannot be consumed twice (replay protection)', () => {
  const state = createState();
  assert.equal(consumeState(state), true);
  assert.equal(consumeState(state), false, 'a replayed callback URL must never be accepted a second time');
});

test('consumeState returns false for a value this store never issued', () => {
  assert.equal(consumeState('not-a-real-state-value'), false);
});

test('consumeState returns false for missing/empty/non-string input, and never throws', () => {
  assert.equal(consumeState(undefined), false);
  assert.equal(consumeState(''), false);
  assert.equal(consumeState(null), false);
  assert.equal(consumeState(42), false);
});

test('a state does not leak into acceptance for a DIFFERENT, unrelated state value', () => {
  createState();
  const other = 'attacker-guessed-value';
  assert.equal(consumeState(other), false);
});
