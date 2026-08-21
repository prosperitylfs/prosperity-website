// Tests for crm/lib/leadNormalize.js. Pure functions only — no database, no
// environment, no network.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePhone,
  normalizeEmail,
  formatLeadTypeLabel,
  isTruthyConsent,
  toStringOrNull,
  buildFormNote,
} = require('../lib/leadNormalize');

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  Test@Foo.COM  '), 'test@foo.com');
  assert.equal(normalizeEmail('already@lower.com'), 'already@lower.com');
});

test('normalizeEmail returns null for missing/non-string/blank input', () => {
  assert.equal(normalizeEmail(undefined), null);
  assert.equal(normalizeEmail(null), null);
  assert.equal(normalizeEmail(''), null);
  assert.equal(normalizeEmail('   '), null);
  assert.equal(normalizeEmail({ nested: 'object' }), null);
});

test('normalizePhone formats a 10-digit US number', () => {
  const { display, e164 } = normalizePhone('4144411177');
  assert.equal(display, '(414) 441-1177');
  assert.equal(e164, '+14144411177');
});

test('normalizePhone strips a leading US country code', () => {
  const { display, e164 } = normalizePhone('14144411177');
  assert.equal(display, '(414) 441-1177');
  assert.equal(e164, '+14144411177');
});

test('normalizePhone falls back to trimmed raw value for unparseable input', () => {
  const { display, e164 } = normalizePhone('  not-a-phone  ');
  assert.equal(display, 'not-a-phone');
  assert.equal(e164, null);
});

test('formatLeadTypeLabel maps known keys regardless of case/spacing', () => {
  assert.equal(formatLeadTypeLabel('life_insurance'), 'Life Insurance Lead');
  assert.equal(formatLeadTypeLabel('Life Insurance'), 'Life Insurance Lead');
  assert.equal(formatLeadTypeLabel('CONTACT'), 'Contact Form Lead');
});

test('formatLeadTypeLabel passes through an unknown string verbatim', () => {
  assert.equal(formatLeadTypeLabel('Some Custom Label'), 'Some Custom Label');
});

test('formatLeadTypeLabel never throws on a non-string value', () => {
  assert.equal(formatLeadTypeLabel({ malicious: 'object' }), 'Website Lead');
  assert.equal(formatLeadTypeLabel(['array']), 'Website Lead');
  assert.equal(formatLeadTypeLabel(undefined), 'Website Lead');
});

test('isTruthyConsent accepts the documented truthy forms only', () => {
  for (const v of [true, 1, 'true', 'yes', 'on', '1']) {
    assert.equal(isTruthyConsent(v), true, `expected ${JSON.stringify(v)} to be truthy`);
  }
  for (const v of [false, 0, 'false', 'no', 'off', '0', undefined, null, '']) {
    assert.equal(isTruthyConsent(v), false, `expected ${JSON.stringify(v)} to be falsy`);
  }
});

test('toStringOrNull coerces primitives and rejects objects/arrays', () => {
  assert.equal(toStringOrNull('hello'), 'hello');
  assert.equal(toStringOrNull(42), '42');
  assert.equal(toStringOrNull(true), 'true');
  assert.equal(toStringOrNull(null), null);
  assert.equal(toStringOrNull(undefined), null);
  assert.equal(toStringOrNull({ a: 1 }), null);
  assert.equal(toStringOrNull(['a']), null);
});

test('buildFormNote skips identity/consent/routing fields and includes extras', () => {
  const note = buildFormNote({
    first_name: 'Dana', last_name: 'Furst', email: 'd@example.com', phone: '4144411177',
    lead_type: 'life_insurance', lead_source: 'test', honeypot: '', sms_consent: 'yes',
    terms_accepted: 'yes', turnstile_token: 'abc', brand: 'prosperity', external_ref: 'x',
    coverage_type: 'Term', health_concerns: 'None',
  });
  assert.ok(note.includes('coverage type: Term'));
  assert.ok(note.includes('health concerns: None'));
  assert.ok(!note.includes('first_name'));
  assert.ok(!note.includes('turnstile'));
});

test('buildFormNote returns null when there are no extra fields', () => {
  assert.equal(buildFormNote({ first_name: 'Dana', lead_type: 'contact' }), null);
});
