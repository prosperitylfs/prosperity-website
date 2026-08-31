// Integration tests for the RESCHEDULE workflow through the REAL shared
// entry point, crm/lib/inboundSmsService.js's handleInboundSmsUnified --
// exercising the actual contact-matching rules (unchanged: Prosperity-
// number-strict / legacy-broad, see that file's own header), STOP/HELP
// coexistence, and SMS History. Mirrors crm/test/inboundSmsUnified.test.js's
// setup exactly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { handleInboundSmsUnified } = require('../lib/inboundSmsService');
const { createClient } = require('../lib/clientService');
const { getClientDetail } = require('../lib/dashboardQueries');
const { BRANDS } = require('../config/brands');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db); runRevenueMvpMigrations(db);
  return db;
}

const PROSPERITY_NUMBER = BRANDS.prosperity.phone.e164; // +14144411177
const INSURANCE_LADY_NUMBER = BRANDS['insurance-lady'].phone.e164; // +18559305239

function seedAppointment(db, contactId, overrides = {}) {
  return db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status, booking_brand)
    VALUES (@contact_id, @appt_type, @appt_datetime, @status, @booking_brand)
  `).run({
    contact_id: contactId, appt_type: 'Life Insurance Consultation',
    appt_datetime: '2026-09-05T18:00:00.000Z', status: 'Scheduled', booking_brand: 'prosperity',
    ...overrides,
  }).lastInsertRowid;
}

const OK_DEPS = { sendLegacySms: async (db, { contactId, body, fromNumber, appointmentId, messageType }) => {
  const twilioSid = 'SMfake-' + Math.random().toString(36).slice(2);
  const ins = db.prepare(`
    INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid, appointment_id, message_type)
    VALUES (?, 'outbound', ?, ?, ?, 'sent', ?, ?, ?)
  `).run(contactId, fromNumber, contactId, body, twilioSid, appointmentId, messageType);
  return { ok: true, sms: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(ins.lastInsertRowid) };
}};

// ── Prosperity example flow (known active Prosperity client) ─────────────

test('Prosperity: a known client texting RESCHEDULE gets the single-appointment reply, sent from the Prosperity number', async () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Janet', lastName: 'Jackson', phone: '4143676486', brandSlug: 'prosperity' }, 'Loretta Stewart');
  seedAppointment(db, client.contact.id, { booking_brand: 'prosperity' });

  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'RESCHEDULE', MessageSid: 'SM_prosperity_reschedule_1',
  }, OK_DEPS);

  assert.equal(result.outcome, 'processed');
  assert.equal(result.rescheduleRequested, true);
  const sendOutcome = await result.rescheduleRequestPromise;
  assert.equal(sendOutcome.sent, true);

  const detail = getClientDetail(db, client.contact.id);
  const inbound = detail.smsThread.find(m => m.body === 'RESCHEDULE');
  const outbound = detail.smsThread.find(m => m.direction === 'outbound');
  assert.ok(inbound, 'the inbound RESCHEDULE text must appear in SMS History');
  assert.ok(outbound, 'the automated reply must appear in SMS History');
  assert.match(outbound.body, /Absolutely\. What day and time/);
  assert.doesNotMatch(outbound.body, /has been rescheduled/i);

  const row = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ? AND direction = ?').get(client.contact.id, 'outbound');
  assert.equal(row.from_number, PROSPERITY_NUMBER);
});

// ── Insurance Lady example flow ───────────────────────────────────────────
//
// The shared handler only special-cases the Prosperity number today (see
// crm/lib/inboundSmsService.js's own header comment: a second, Insurance-
// Lady-specific number-level webhook is not configured in production yet,
// so a reply to an Insurance Lady number currently falls through to the
// same broad/legacy contact-matching branch any non-Prosperity number
// does). This test still demonstrates the actual production number and
// confirms the reply correctly threads back on it.

test('Insurance Lady: a known contact texting RESCHEDULE to the Insurance Lady number gets a reply sent FROM that same number', async () => {
  const db = setup();
  const contactId = db.prepare(`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164, sms_consent)
    VALUES ('Renee', 'Jones', '(414) 555-0177', '+14145550177', 1)
  `).run().lastInsertRowid;
  seedAppointment(db, contactId, { booking_brand: 'insurance-lady' });

  const result = handleInboundSmsUnified(db, {
    From: '+14145550177', To: INSURANCE_LADY_NUMBER, Body: 'Reschedule', MessageSid: 'SM_il_reschedule_1',
  }, OK_DEPS);

  assert.equal(result.outcome, 'processed');
  assert.equal(result.rescheduleRequested, true);
  const sendOutcome = await result.rescheduleRequestPromise;
  assert.equal(sendOutcome.sent, true);

  const row = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ? AND direction = ?').get(contactId, 'outbound');
  assert.equal(row.from_number, INSURANCE_LADY_NUMBER, 'the reply must stay in the SAME conversation thread as the Insurance Lady number the client texted');
  assert.match(row.body, /Absolutely\. What day and time/);
});

// ── Ambiguity / no-appointment via the real entry point ───────────────────

test('a Prosperity client with two upcoming appointments gets the ambiguity reply', async () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Multi', lastName: 'Appt', phone: '4145550188', brandSlug: 'prosperity' }, 'Loretta Stewart');
  seedAppointment(db, client.contact.id, { appt_datetime: '2026-09-05T18:00:00.000Z' });
  seedAppointment(db, client.contact.id, { appt_datetime: '2026-09-10T18:00:00.000Z', appt_type: 'Safe Money & Retirement Consultation' });

  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'reschedule', MessageSid: 'SM_prosperity_multi_1',
  }, OK_DEPS);
  const sendOutcome = await result.rescheduleRequestPromise;
  assert.equal(sendOutcome.appointmentCount, 2);

  const row = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ? AND direction = ?').get(client.contact.id, 'outbound');
  assert.match(row.body, /more than one upcoming appointment/);
});

test('a Prosperity client with no upcoming appointment gets the fallback reply', async () => {
  const db = setup();
  const client = createClient(db, { firstName: 'No', lastName: 'Appt', phone: '4145550199', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'RESCHEDULE', MessageSid: 'SM_prosperity_none_1',
  }, OK_DEPS);
  const sendOutcome = await result.rescheduleRequestPromise;
  assert.equal(sendOutcome.appointmentCount, 0);

  const row = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ? AND direction = ?').get(client.contact.id, 'outbound');
  assert.match(row.body, /couldn't locate an upcoming appointment/);
});

// ── Unrelated messages don't trigger the workflow ─────────────────────────

test('an unrelated inbound message does not trigger the reschedule workflow -- the ordinary reply task fires instead', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Ordinary', lastName: 'Reply', phone: '4145550200', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'Sounds good, see you then!', MessageSid: 'SM_ordinary_1',
  }, OK_DEPS);

  assert.equal(result.rescheduleRequested, undefined);
  assert.ok(result.autoTaskId, 'the generic reply-to-this-lead task must still fire for an ordinary message');
});

test('a message that merely mentions "reschedule" in passing does not trigger the automated workflow', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Passing', lastName: 'Mention', phone: '4145550201', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER,
    Body: 'I might need to reschedule at some point but not today', MessageSid: 'SM_passing_1',
  }, OK_DEPS);

  assert.equal(result.rescheduleRequested, undefined);
  assert.ok(result.autoTaskId);
});

// ── STOP/HELP compliance preserved ────────────────────────────────────────

test('STOP still opts a contact out and creates no follow-up task, unaffected by the new RESCHEDULE handling', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Stop', lastName: 'Test', phone: '4145550202', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'STOP', MessageSid: 'SM_stop_1',
  }, OK_DEPS);

  assert.equal(result.consentAction, 'opted_out');
  assert.equal(result.autoTaskId, null);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 0);
  assert.ok(contact.sms_opted_out_at);
});

test('HELP is still recognized and creates no follow-up task, unaffected by the new RESCHEDULE handling', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Help', lastName: 'Test', phone: '4145550203', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'HELP', MessageSid: 'SM_help_1',
  }, OK_DEPS);

  assert.equal(result.consentAction, 'help_requested');
  assert.equal(result.autoTaskId, null);
});

test('an opted-out contact texting RESCHEDULE receives no automated reply (existing opt-out rule is authoritative)', async () => {
  const db = setup();
  const client = createClient(db, { firstName: 'OptedOut', lastName: 'Reschedule', phone: '4145550204', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`UPDATE contacts SET sms_consent = 0, sms_opted_out_at = CURRENT_TIMESTAMP WHERE id = ?`).run(client.contact.id);
  seedAppointment(db, client.contact.id);

  // No deps override -- the consent/opt-out gate lives inside the REAL
  // sendLegacySms (crm/lib/legacySmsSend.js), so this must exercise that
  // real gate rather than a fake that would just bypass it. It returns
  // before ever constructing a Twilio client, so this makes no real
  // network call.
  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'RESCHEDULE', MessageSid: 'SM_optedout_reschedule_1',
  });

  assert.equal(result.rescheduleRequested, true, 'the inbound text is still logged and the request still recorded internally');
  const sendOutcome = await result.rescheduleRequestPromise;
  assert.equal(sendOutcome.sent, false, 'but no automated SMS reply is sent, per the existing opt-out rule');

  const outboundCount = db.prepare(`SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ? AND direction = 'outbound'`).get(client.contact.id).n;
  assert.equal(outboundCount, 0);
});

// ── Existing safety behavior (Insurance-Lady-only sender on the Prosperity
//    number) is unaffected even when the message is RESCHEDULE ───────────

test('an Insurance-Lady-only contact texting RESCHEDULE to the Prosperity number is still staged for review, not auto-processed', () => {
  const db = setup();
  const ilClient = createClient(db, { firstName: 'IL', lastName: 'Only', phone: '4145550205', brandSlug: 'insurance-lady' }, 'Loretta Stewart');

  const result = handleInboundSmsUnified(db, {
    From: ilClient.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'RESCHEDULE', MessageSid: 'SM_il_only_reschedule_1',
  }, OK_DEPS);

  assert.equal(result.outcome, 'staged_for_review', 'the existing cross-brand safety rule must not be bypassed just because the message says RESCHEDULE');
  assert.equal(result.rescheduleRequested, undefined);
});
