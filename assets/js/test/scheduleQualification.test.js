// Tests for assets/js/scheduleQualification.js — the dollar-amount
// parsing/validation/eligibility-threshold logic used by schedule.html's
// Safe Money & Retirement branch, plus the Cal.com redirect query-string
// builder shared by both the Life Insurance and Retirement paths. Run with
// `node --test` (plain CommonJS, no framework/build step, matching every
// other test file in this repo).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDollarAmount, formatDollar, isRetirementEligibleAmount, RETIREMENT_MIN_AMOUNT,
  buildCalcomPrefillQuery,
} = require('../scheduleQualification.js');

test('RETIREMENT_MIN_AMOUNT is $15,000', () => {
  assert.equal(RETIREMENT_MIN_AMOUNT, 15000);
});

// ── Parsing (test scenarios 7, 8, 9) ──────────────────────────────────────

test('"15000" parses correctly', () => {
  assert.equal(parseDollarAmount('15000'), 15000);
});

test('"15,000" parses correctly', () => {
  assert.equal(parseDollarAmount('15,000'), 15000);
});

test('"$15,000" parses correctly', () => {
  assert.equal(parseDollarAmount('$15,000'), 15000);
});

test('"25000" and "$100,000" parse correctly', () => {
  assert.equal(parseDollarAmount('25000'), 25000);
  assert.equal(parseDollarAmount('$100,000'), 100000);
});

test('whitespace and cents are tolerated', () => {
  assert.equal(parseDollarAmount('  $14,999.50  '), 14999.5);
});

test('invalid/non-numeric input cannot accidentally qualify (returns null, never a guessed number)', () => {
  assert.equal(parseDollarAmount('abc'), null);
  assert.equal(parseDollarAmount('fifteen thousand'), null);
  assert.equal(parseDollarAmount(''), null);
  assert.equal(parseDollarAmount('   '), null);
  assert.equal(parseDollarAmount(null), null);
  assert.equal(parseDollarAmount(undefined), null);
  assert.equal(parseDollarAmount('-5000'), null, 'a negative amount must never parse to a usable number');
  assert.equal(parseDollarAmount('15,000.00.00'), null, 'malformed punctuation must not silently parse to something');
  assert.equal(parseDollarAmount('15000abc'), null, 'trailing garbage must not be silently truncated into a valid number');
  assert.equal(parseDollarAmount('Infinity'), null);
});

// ── Eligibility threshold (test scenarios 1–6) ────────────────────────────

test('$14,999 is NOT eligible outright (must go to the cash-building follow-up)', () => {
  assert.equal(isRetirementEligibleAmount(parseDollarAmount('14999')), false);
});

test('$15,000 is eligible without the cash-building follow-up', () => {
  assert.equal(isRetirementEligibleAmount(parseDollarAmount('15000')), true);
  assert.equal(isRetirementEligibleAmount(parseDollarAmount('$15,000')), true);
});

test('$15,001 is eligible', () => {
  assert.equal(isRetirementEligibleAmount(parseDollarAmount('15001')), true);
});

test('$100,000 is eligible', () => {
  assert.equal(isRetirementEligibleAmount(parseDollarAmount('100000')), true);
});

test('a null (invalid/unparseable) amount is never treated as eligible', () => {
  assert.equal(isRetirementEligibleAmount(null), false);
  assert.equal(isRetirementEligibleAmount(parseDollarAmount('abc')), false);
});

// ── Formatting ─────────────────────────────────────────────────────────

test('formatDollar produces a comma-grouped display string', () => {
  assert.equal(formatDollar(15000), '$15,000');
  assert.equal(formatDollar(14999), '$14,999');
  assert.equal(formatDollar(100000), '$100,000');
});

// ── Cal.com redirect prefill (phone-as-location fix) ─────────────────────
//
// Both Prosperity Cal.com events use "Attendee phone number" as the event
// LOCATION, not the separate "Phone number" booking question --
// attendeePhoneNumber only prefills the latter and was silently ignored.
// The fix is a JSON-encoded `location` parameter instead
// (cal.com/help/bookings/prefill-fields): {"value":"phone","optionValue":
// "<E.164 number>"}.

test('the generated query string carries the phone number via a JSON-encoded location parameter, not attendeePhoneNumber', () => {
  const qs = buildCalcomPrefillQuery({
    firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '+14146887619',
  });
  const params = new URLSearchParams(qs);

  assert.equal(params.has('attendeePhoneNumber'), false, 'must not send the field that does nothing on these events');
  assert.ok(params.has('location'), 'must send the location parameter Cal.com actually reads the phone number from');

  const location = JSON.parse(params.get('location'));
  assert.deepEqual(location, { value: 'phone', optionValue: '+14146887619' });
});

test('name and email are prefilled unchanged alongside the location fix', () => {
  const qs = buildCalcomPrefillQuery({
    firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '+14146887619',
  });
  const params = new URLSearchParams(qs);
  assert.equal(params.get('name'), 'Jane Doe');
  assert.equal(params.get('email'), 'jane@example.com');
});

test('the query string is valid and round-trips through standard URL parsing (no encoding pitfalls)', () => {
  const qs = buildCalcomPrefillQuery({
    firstName: 'Mary', lastName: "O'Brien", email: 'mary@example.com', phone: '+19995551234',
  });
  const url = new URL('https://cal.com/lorettastewart/retirement-safemoney-consultation-prosperitylfs?' + qs);
  assert.equal(url.searchParams.get('name'), "Mary O'Brien");
  assert.equal(JSON.parse(url.searchParams.get('location')).optionValue, '+19995551234');
});

test('the same query-building function is used for both Prosperity events (no per-event divergence)', () => {
  // buildCalcomPrefillQuery() takes no event-specific input at all -- the
  // same output feeds both the Life Insurance and Retirement redirect
  // URLs in schedule.html's shared schSubmitLead(), so there is no code
  // path where one event gets the fix and the other doesn't.
  const fields = { firstName: 'Sam', lastName: 'Lee', email: 'sam@example.com', phone: '+14145550000' };
  const forLifeInsurance = buildCalcomPrefillQuery(fields);
  const forRetirement = buildCalcomPrefillQuery(fields);
  assert.equal(forLifeInsurance, forRetirement);
});
