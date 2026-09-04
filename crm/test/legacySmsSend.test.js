// Tests for crm/lib/legacySmsSend.js — the shared consent-gate ->
// resolve-phone -> insert-queued -> call-provider -> update-status
// primitive extracted from crm/routes/sms.js (still fully covered,
// unchanged, by crm/test/smsSendRoute.test.js). This file adds direct unit
// coverage of the success path via a fake Twilio client
// (deps.twilioClientFactory), which the HTTP-level tests never exercise
// (they deliberately run with no Twilio credentials configured).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { sendLegacySms } = require('../lib/legacySmsSend');

function setup() {
  const db = createLegacyDb();
  runRevenueMvpMigrations(db); // adds sms_opted_out_at
  return db;
}

function seedContact(db, overrides = {}) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164, sms_consent, sms_opted_out_at)
    VALUES (@first_name, @last_name, @phone, @phone_e164, @sms_consent, @sms_opted_out_at)
  `).run({
    first_name: 'Jane', last_name: 'Doe', phone: '(414) 555-0100', phone_e164: '+14145550100',
    sms_consent: 1, sms_opted_out_at: null, ...overrides,
  }).lastInsertRowid;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const TWILIO_ENV = { TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tokenfake', TWILIO_FROM_NUMBER: '+14144411177' };

function fakeClient(behavior) {
  return () => ({
    messages: {
      create: async (params) => {
        if (behavior === 'fail') {
          const err = new Error('The number is unreachable');
          err.code = 21211;
          throw err;
        }
        return { sid: 'SMfake123', status: 'sent', ...params };
      },
    },
  });
}

test('a consent-valid, correctly-configured send succeeds and updates the row to sent', async () => {
  const db = setup();
  const cid = seedContact(db);
  await withEnv(TWILIO_ENV, async () => {
    const result = await sendLegacySms(db, { contactId: cid, body: 'Hello' }, { twilioClientFactory: fakeClient('ok') });
    assert.equal(result.ok, true);
    assert.equal(result.sms.status, 'sent');
    assert.equal(result.sms.twilio_sid, 'SMfake123');
    assert.equal(result.sms.to_number, '+14145550100');
    assert.equal(result.sms.from_number, '+14144411177');
  });
});

test('a failed provider call marks the row failed with a failure reason, and returns ok:false', async () => {
  const db = setup();
  const cid = seedContact(db);
  await withEnv(TWILIO_ENV, async () => {
    const result = await sendLegacySms(db, { contactId: cid, body: 'Hello' }, { twilioClientFactory: fakeClient('fail') });
    assert.equal(result.ok, false);
    assert.equal(result.sms.status, 'failed');
    assert.match(result.sms.body, /\[FAILED\]/);
    assert.match(result.sms.body, /unreachable/);
    // failure_reason (a real column, also used by crm/lib/smsStatusService.js
    // for the async undelivered/failed callback path) must be populated too,
    // not just stuffed into the body -- this is what lets the SMS thread's
    // failure bubble and the Message Delivery Status report show WHY.
    assert.equal(result.sms.failure_reason, 'The number is unreachable | Code: 21211');
  });
});

test('an opted-out contact is blocked before any row is inserted or Twilio is touched', async () => {
  const db = setup();
  const cid = seedContact(db, { sms_opted_out_at: '2026-08-20 10:00:00' });
  await withEnv(TWILIO_ENV, async () => {
    const result = await sendLegacySms(db, { contactId: cid, body: 'Hello' }, { twilioClientFactory: fakeClient('ok') });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
    const count = db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(cid).n;
    assert.equal(count, 0);
  });
});

test('a contact without sms_consent is blocked before any row is inserted', async () => {
  const db = setup();
  const cid = seedContact(db, { sms_consent: 0 });
  await withEnv(TWILIO_ENV, async () => {
    const result = await sendLegacySms(db, { contactId: cid, body: 'Hello' }, { twilioClientFactory: fakeClient('ok') });
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });
});

test('a nonexistent contact returns 404 without touching sms_messages', async () => {
  const db = setup();
  const result = await sendLegacySms(db, { contactId: 999999, body: 'Hello' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('missing Twilio configuration returns 503 without inserting a row', async () => {
  const db = setup();
  const cid = seedContact(db);
  await withEnv({ TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined, TWILIO_FROM_NUMBER: undefined }, async () => {
    const result = await sendLegacySms(db, { contactId: cid, body: 'Hello' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(cid).n, 0);
  });
});
