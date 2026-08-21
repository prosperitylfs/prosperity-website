// Static checks on the actual browser-delivered files — proves the
// Checkpoint E1 Phase 1 correction (removing the client-side CRM_API_KEY
// and routing every Prosperity form through the same-origin /submit-lead
// function) is really reflected in the shipped source, not just in the CRM
// backend. Reads real files from disk (read-only) — never modifies
// anything, never touches a database or the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

const OLD_HARDCODED_API_KEY = 'prosperity-crm-2025';

const BROWSER_FILES = [
  'assets/js/main.v2.js',
  'life-insurance-qualifier.html',
  'contact.html',
  'book.html',
  'life-insurance.html',
];

test('no browser-delivered file contains the CRM_API_KEY literal value', () => {
  for (const file of BROWSER_FILES) {
    const contents = read(file);
    assert.ok(!contents.includes(OLD_HARDCODED_API_KEY), `${file} must not contain the CRM API key literal`);
  }
});

test('assets/js/main.v2.js declares no CRM credential and no direct CRM endpoint', () => {
  const contents = read('assets/js/main.v2.js');
  assert.ok(!/CRM_API_KEY/.test(contents), 'CRM_API_KEY must not be declared in browser code');
  assert.ok(!/x-api-key/.test(contents), 'x-api-key must not be sent from browser code');
  assert.ok(!contents.includes('prosperity-crm.onrender.com'), 'the CRM origin must not be called directly from the browser');
  assert.ok(!/function\s+postToCRM/.test(contents), 'postToCRM() must be removed, not just unused');
  assert.ok(!/function\s+sendBookingLead/.test(contents), 'sendBookingLead() must be removed, not just unused');
});

test('life-insurance-qualifier.html and contact.html submit through /submit-lead, not postToCRM() or /api/leads', () => {
  for (const file of ['life-insurance-qualifier.html', 'contact.html']) {
    const contents = read(file);
    assert.ok(contents.includes("fetch('/submit-lead'"), `${file} must submit via /submit-lead`);
    assert.ok(!/postToCRM\(\{/.test(contents), `${file} must not call postToCRM()`); // matches only a real invocation (always called with an object literal); explanatory comments may still mention the removed function by name
    assert.ok(!contents.includes('/api/leads'), `${file} must never reference /api/leads directly`);
    assert.ok(!/x-api-key/i.test(contents), `${file} must never send an x-api-key header`);
  }
});

test('book.html and life-insurance.html already submit through /submit-lead (unaffected by this correction)', () => {
  for (const file of ['book.html', 'life-insurance.html']) {
    const contents = read(file);
    assert.ok(contents.includes("fetch('/submit-lead'"), `${file} must submit via /submit-lead`);
    assert.ok(!/postToCRM\(\{/.test(contents), `${file} must not call postToCRM()`); // matches only a real invocation (always called with an object literal); explanatory comments may still mention the removed function by name
  }
});

test('both migrated forms still collect a Turnstile token before submitting (spam-control signal, not a credential)', () => {
  for (const file of ['life-insurance-qualifier.html', 'contact.html']) {
    const contents = read(file);
    assert.ok(contents.includes('data-turnstile'), `${file} must still render a Turnstile widget`);
    assert.ok(contents.includes('turnstile_token'), `${file} must still send its collected Turnstile token to /submit-lead`);
  }
});

test('both migrated forms preserve their previously-sent fields (nothing dropped)', () => {
  const qualifier = read('life-insurance-qualifier.html');
  for (const field of ['first_name', 'last_name', 'phone', 'email', 'lead_type', 'state', 'age_range', 'coverage_type', 'coverage_for', 'tobacco', 'health_concerns', 'sms_consent', 'terms_accepted']) {
    assert.ok(qualifier.includes(field), `life-insurance-qualifier.html must still send '${field}'`);
  }

  const contact = read('contact.html');
  for (const field of ['first_name', 'last_name', 'email', 'phone', 'message', 'terms_accepted', 'lead_type']) {
    assert.ok(contact.includes(field), `contact.html must still send '${field}'`);
  }
});
