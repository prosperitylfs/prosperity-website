// Tests for crm/lib/classification.js — pure function, no database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyContact } = require('../lib/classification');

test('evidence-based classification: known Prosperity-only lead_type proposes Prosperity with evidence', () => {
  const contact = { id: 1, first_name: 'Carol', last_name: 'Meyers', lead_type: 'Retirement Guide Lead', lead_source: '13 Retirement & Rollover Mistakes to Avoid' };
  const result = classifyContact(contact);
  assert.equal(result.proposedBrand, 'Prosperity');
  assert.ok(result.evidence.length > 0);
  assert.match(result.reason, /Prosperity-only channel/);
});

test('evidence-based classification: known Prosperity-only lead_source (no lead_type) proposes Prosperity', () => {
  const contact = { id: 2, first_name: 'Hank', last_name: 'Ostrowski', lead_type: null, lead_source: 'Inbound SMS' };
  const result = classifyContact(contact);
  assert.equal(result.proposedBrand, 'Prosperity');
});

test('ambiguous record staging: no recognized signal proposes Review Required, not Prosperity', () => {
  const contact = { id: 3, first_name: 'Jordan', last_name: 'Blake', lead_type: null, lead_source: null };
  const result = classifyContact(contact);
  assert.equal(result.proposedBrand, 'Review Required');
  assert.equal(result.evidence.length, 0);
  assert.match(result.reason, /insufficient evidence/);
});

test('does not assume every existing record belongs to Prosperity: recognized Insurance Lady evidence overrides', () => {
  const contact = { id: 4, first_name: 'Pat', last_name: 'Nowak', lead_type: 'Contact Form', lead_source: null, notes: 'Interested in Insurance Lady final expense coverage' };
  const result = classifyContact(contact);
  // Insurance Lady evidence is checked before falling back to the
  // Prosperity-legacy-channel match on lead_type, and must win when present.
  assert.equal(result.proposedBrand, 'Insurance Lady');
  assert.match(result.reason, /Insurance Lady signal/);
});

test('test/archive classification: lead_status explicitly Archived', () => {
  const contact = { id: 5, first_name: 'Old', last_name: 'Record', lead_status: 'Archived', lead_type: 'Contact Form' };
  const result = classifyContact(contact);
  assert.equal(result.proposedBrand, 'Test/Archived');
});

test('test/archive classification: email contains a test marker', () => {
  const contact = { id: 6, first_name: 'Test', last_name: 'User', email: 'test.user@example.com', lead_type: 'Contact Form' };
  const result = classifyContact(contact);
  assert.equal(result.proposedBrand, 'Test/Archived');
  assert.match(result.evidence[0], /test-data pattern/);
});

test('test/archive classification: phone in the reserved 555-01xx fictional range', () => {
  const contact = { id: 7, first_name: 'Fictional', last_name: 'Number', phone_e164: '+12025550173', lead_type: 'Contact Form' };
  const result = classifyContact(contact);
  assert.equal(result.proposedBrand, 'Test/Archived');
});

test('test/archive check runs before Prosperity-channel evidence (test markers take precedence)', () => {
  const contact = { id: 8, first_name: 'Demo', last_name: 'Account', lead_type: 'Retirement Guide Lead', email: 'demo@example.com' };
  const result = classifyContact(contact);
  assert.equal(result.proposedBrand, 'Test/Archived');
});
