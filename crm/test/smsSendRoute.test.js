// Tests for the SMS consent/opt-out gate added to POST /api/sms/send
// (crm/routes/sms.js) — the legacy outbound-SMS route used by the Contact
// Detail page's SMS composer (crm/public/contact.js's sendManualSms()).
//
// Twilio credentials are explicitly cleared for this file so a
// consent-VALID request deterministically reaches the existing "Twilio is
// not configured" 503 response rather than ever attempting a real network
// call — this is what proves the consent gate did NOT block it (requirement
// A) without needing a live Twilio account or refactoring the route's
// inline `require('twilio')` call for dependency injection, which is out of
// scope for this narrowly-scoped correction.
//
// Mirrors crm/test/tasksRoute.test.js's approach: DB_PATH is pointed at an
// in-memory database BEFORE crm/db/database.js is first required anywhere
// in this process (routes/sms.js requires it directly at module scope),
// then a real Express app is spun up on an ephemeral port and exercised
// with real HTTP requests (global fetch) — every request here goes straight
// at the route, exactly like a direct API caller bypassing the browser UI
// entirely (requirement D).

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const savedEnv = {
  DB_PATH: process.env.DB_PATH,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
};
process.env.DB_PATH = ':memory:';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;

const db = require('../db/database');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const smsRouter = require('../routes/sms');

let server, baseUrl;

before(() => {
  // sms_opted_out_at is added by this migration, not by db/database.js's
  // own self-healing addCol list -- must run explicitly against this
  // in-memory db before any test references the column.
  runRevenueMvpMigrations(db);

  const app = express();
  app.use(express.json());
  app.use('/api/sms', smsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/sms`;
});

after(() => {
  server.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function insertContact({ phone_e164 = '+14145550100', sms_consent = 0, sms_opted_out_at = null } = {}) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164, sms_consent, sms_opted_out_at)
    VALUES ('Test', 'Contact', '(414) 555-0100', ?, ?, ?)
  `).run(phone_e164, sms_consent, sms_opted_out_at).lastInsertRowid;
}

async function send(contactId, message = 'Hello from the CRM') {
  const res = await fetch(`${baseUrl}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, message }),
  });
  return { status: res.status, body: await res.json() };
}

function smsMessageCount(contactId) {
  return db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contactId).n;
}

// ── A. Consent valid, not opted out -> existing send path is allowed ─────

test('sms_consent=1 and not opted out is NOT blocked by the consent gate (reaches the existing Twilio-not-configured check, proving it passed)', async () => {
  const cid = insertContact({ sms_consent: 1, sms_opted_out_at: null });
  const { status, body } = await send(cid);
  // No Twilio credentials are configured in this test file (by design) --
  // a request that gets PAST the consent gate hits that pre-existing 503,
  // never the new 403 consent error. If the gate had wrongly blocked this
  // request, it would be 403 with the consent-specific message instead.
  assert.equal(status, 503);
  assert.match(body.error, /Twilio is not configured/);
});

// ── B. sms_consent=0 -> rejected before Twilio is ever touched ──────────

test('sms_consent=0 is rejected with 403 before any sms_messages row is created', async () => {
  const cid = insertContact({ sms_consent: 0, sms_opted_out_at: null });
  const { status, body } = await send(cid);
  assert.equal(status, 403);
  assert.match(body.error, /consent/i);
  assert.equal(smsMessageCount(cid), 0, 'no message row means Twilio was never reached — the pre-insert step never ran');
});

// ── C. Opted-out contact -> rejected before Twilio is ever touched ──────

test('an opted-out contact (sms_opted_out_at set) is rejected with 403, even if sms_consent is still 1 on the record', async () => {
  const cid = insertContact({ sms_consent: 1, sms_opted_out_at: '2026-08-20 10:00:00' });
  const { status, body } = await send(cid);
  assert.equal(status, 403);
  assert.match(body.error, /stop/i);
  assert.equal(smsMessageCount(cid), 0);
});

test('opt-out is checked before the general consent check, and produces the STOP-specific message', async () => {
  const cid = insertContact({ sms_consent: 0, sms_opted_out_at: '2026-08-20 10:00:00' });
  const { body } = await send(cid);
  assert.match(body.error, /stop/i, 'a contact who is both un-consented AND opted out should get the STOP message, since STOP is authoritative');
});

// ── D. Cannot be bypassed by calling the route directly ──────────────────

test('the consent gate applies identically to a direct API call with no browser/UI involved', async () => {
  // Every test in this file already calls POST /api/sms/send directly via
  // fetch, with no browser, no contact.html, no contact.js in the loop at
  // all -- this test just makes that guarantee explicit: a consent-invalid
  // contact is blocked purely by virtue of the request reaching this route,
  // regardless of what called it.
  const cid = insertContact({ sms_consent: 0 });
  const { status } = await send(cid);
  assert.equal(status, 403, 'the route itself refuses the send — there is no client-side-only gate to bypass');
});

test('a contact with no phone number is still rejected before reaching the consent gate\'s Twilio work (unrelated existing validation preserved)', async () => {
  const cid = db.prepare(`
    INSERT INTO contacts (first_name, last_name, sms_consent) VALUES ('No', 'Phone', 1)
  `).run().lastInsertRowid;
  const { status, body } = await send(cid);
  assert.equal(status, 400);
  assert.match(body.error, /no valid phone number/i);
});

test('a nonexistent contact still 404s exactly as before', async () => {
  const { status } = await send(999999);
  assert.equal(status, 404);
});
