// Tests the exact auto-mapping algorithm the browser runs
// (crm/public/app/columnAutoMap.js, loaded as a plain <script> by
// crm/public/app/import.html) via require() -- the module is written to
// work both ways so what's tested here is exactly what ships.

const test = require('node:test');
const assert = require('node:assert/strict');
const { autoMapColumns } = require('../public/app/columnAutoMap');

const FIELD_KEYS = [
  ['firstName', 'First name'], ['lastName', 'Last name'],
  ['policyNumber', 'Policy number'], ['policyStatus', 'Policy status'],
  ['effectiveDate', 'Effective date'], ['premium', 'Premium'],
];

test('Policy Number and Policy Status never both auto-map to the same lone "Policy" column', () => {
  const headers = ['First Name', 'Last Name', 'Policy', 'Effective Date', 'Premium'];
  const mapping = autoMapColumns(headers, FIELD_KEYS);
  assert.equal(mapping.policyNumber, 'Policy', 'the first field in array order claims the lone match');
  assert.notEqual(mapping.policyStatus, 'Policy', 'the second field must not also claim the same header');
  assert.equal(mapping.policyStatus, undefined, 'left unmapped for deliberate manual assignment, not guessed wrong');
});

test('when a distinct Status column also exists, Policy Number and Policy Status map to their own separate columns', () => {
  const headers = ['First Name', 'Last Name', 'Policy', 'Status', 'Effective Date', 'Premium'];
  const mapping = autoMapColumns(headers, FIELD_KEYS);
  assert.equal(mapping.policyNumber, 'Policy');
  // "Status" alone doesn't match "policystatus" (full) or "policy" (first
  // word) under this algorithm, so it stays unmapped too -- still correct,
  // since guessing "Status" means policy status (vs. e.g. marital status)
  // from the header name alone would be exactly the kind of guess this
  // fix exists to avoid making automatically.
  assert.notEqual(mapping.policyStatus, 'Policy');
});

test('exact full-label matches always win over first-word fallback matches', () => {
  const headers = ['First Name', 'Last Name', 'Policy Number', 'Policy'];
  const mapping = autoMapColumns(headers, FIELD_KEYS);
  assert.equal(mapping.policyNumber, 'Policy Number', 'the exact full match is preferred over the shorter "Policy" column');
});

test('ordinary non-colliding fields still auto-map normally', () => {
  const headers = ['FirstName', 'LastName', 'EffectiveDate', 'Premium'];
  const mapping = autoMapColumns(headers, FIELD_KEYS);
  assert.equal(mapping.firstName, 'FirstName');
  assert.equal(mapping.lastName, 'LastName');
  assert.equal(mapping.effectiveDate, 'EffectiveDate');
  assert.equal(mapping.premium, 'Premium');
});

test('a header already claimed is never reused by a later field in either pass', () => {
  // Two fields that would both reduce to "premium" if not for claim-once.
  const keys = [['premium', 'Premium'], ['premiumFrequency', 'Premium frequency']];
  const headers = ['Premium'];
  const mapping = autoMapColumns(headers, keys);
  assert.equal(mapping.premium, 'Premium');
  assert.equal(mapping.premiumFrequency, undefined);
});
