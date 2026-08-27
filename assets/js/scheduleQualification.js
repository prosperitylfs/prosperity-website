// Pure, dependency-free validation/formatting logic for schedule.html's
// Safe Money & Retirement asset-amount question. Extracted into its own
// file (rather than left inline in schedule.html) specifically so it can
// be unit tested with Node's test runner -- this codebase has no
// browser/DOM test harness, and this is the one piece of that page's logic
// where a subtle bug could incorrectly qualify or disqualify a real
// prospect, so it gets dedicated coverage (crm-style test files elsewhere
// in this repo already follow this "extract for testability" pattern for
// similarly important logic).
//
// Works as a plain browser <script> (functions attach to window, matching
// assets/js/main.v2.js's own convention) and as a CommonJS module for
// Node's test runner -- no build step, no bundler.

var RETIREMENT_MIN_AMOUNT = 15000;

// Accepts "15000", "15,000", "$15,000", "$100,000.00", etc. Returns null
// (never a guess) for anything non-numeric, negative, or malformed --
// callers must treat null as "invalid, do not proceed down either path",
// so bad input can never accidentally qualify (or disqualify) someone.
function parseDollarAmount(raw) {
  if (raw === null || raw === undefined) return null;
  var cleaned = String(raw).trim().replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  var n = parseFloat(cleaned);
  if (!isFinite(n) || n < 0) return null;
  return n;
}

function formatDollar(n) {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function isRetirementEligibleAmount(amount) {
  return typeof amount === 'number' && isFinite(amount) && amount >= RETIREMENT_MIN_AMOUNT;
}

// Builds the query string appended to a Cal.com event URL for the
// name/email/phone prefill schedule.html uses on every redirect (Life
// Insurance and both Safe Money & Retirement outcomes alike).
//
// Phone is passed via the `location` parameter, not `attendeePhoneNumber`:
// both Prosperity Cal.com events use "Attendee phone number" as the event
// LOCATION (confirmed identical to the working Insurance Lady reference),
// not the separate, toggled-off "Phone number" booking question --
// attendeePhoneNumber only prefills the latter, so it silently did nothing
// on this page. Cal.com's documented mechanism for a phone-type location
// (cal.com/help/bookings/prefill-fields) is a single JSON-encoded
// `location` parameter: {"value":"phone","optionValue":"<E.164 number>"}.
//
// `phone` must already be a normalized +1E.164 string (see toE164() in
// assets/js/main.v2.js) -- this function does not validate or reformat it.
function buildCalcomPrefillQuery(fields) {
  return new URLSearchParams({
    name: fields.firstName + ' ' + fields.lastName,
    email: fields.email,
    location: JSON.stringify({ value: 'phone', optionValue: fields.phone }),
  }).toString();
}

if (typeof window !== 'undefined') {
  window.parseDollarAmount = parseDollarAmount;
  window.formatDollar = formatDollar;
  window.isRetirementEligibleAmount = isRetirementEligibleAmount;
  window.RETIREMENT_MIN_AMOUNT = RETIREMENT_MIN_AMOUNT;
  window.buildCalcomPrefillQuery = buildCalcomPrefillQuery;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseDollarAmount, formatDollar, isRetirementEligibleAmount, RETIREMENT_MIN_AMOUNT,
    buildCalcomPrefillQuery,
  };
}
