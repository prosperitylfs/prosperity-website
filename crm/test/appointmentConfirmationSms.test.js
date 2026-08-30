// Tests for crm/lib/appointmentConfirmationSms.js — the automatic
// appointment-confirmation SMS sent for a NEW, non-Retirement Cal.com
// booking: correct body content, consent/opt-out enforcement, Mobile-only
// phone resolution (a landline-only contact must not be texted), and that a
// failed/blocked send never throws.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { buildConfirmationSmsBody, fillTemplate, sendAppointmentConfirmationSms } = require('../lib/appointmentConfirmationSms');

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
    first_name: 'Janet', last_name: 'Jackson', phone: '(414) 367-6486', phone_e164: '+14143676486',
    sms_consent: 1, sms_opted_out_at: null, ...overrides,
  }).lastInsertRowid;
}

const OK_DEPS = { sendLegacySms: async (db, { contactId, body }) => {
  const ins = db.prepare(`INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid) VALUES (?, 'outbound', '+14144411177', '+14143676486', ?, 'sent', 'SMfake')`).run(contactId, body);
  return { ok: true, sms: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(ins.lastInsertRowid) };
}};

// ── Body building ────────────────────────────────────────────────────────

test('fillTemplate substitutes every {{placeholder}} and leaves no braces behind', () => {
  const out = fillTemplate('Hi {{name}}, your {{thing}} is at {{time}}.', { name: 'Janet', thing: 'appointment', time: '2:00 PM' });
  assert.equal(out, 'Hi Janet, your appointment is at 2:00 PM.');
  assert.doesNotMatch(out, /\{\{|\}\}/);
});

test('buildConfirmationSmsBody includes the name, appointment type, date/time, and STOP language, with no marketing language', () => {
  const body = buildConfirmationSmsBody({
    attendeeName: 'Janet Jackson', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  });
  assert.match(body, /Janet Jackson/);
  assert.match(body, /Life Insurance Consultation/);
  assert.match(body, /confirmed for/);
  assert.match(body, /Reply HELP for help or STOP to opt out/);
  assert.doesNotMatch(body, /% off|discount|limited time|act now/i);
});

// ── Send behavior ────────────────────────────────────────────────────────

test('a consenting contact with a valid mobile phone gets exactly one SMS logged in sms_messages', async () => {
  const db = setup();
  const contactId = seedContact(db);

  const result = await sendAppointmentConfirmationSms(db, {
    contactId, attendeeName: 'Janet Jackson', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  }, OK_DEPS);

  assert.equal(result.attempted, true);
  assert.equal(result.sent, true);
  const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').all(contactId);
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /Janet Jackson/);
});

test('a contact with SMS Consent = No is never texted', async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_consent: 0 });

  // No deps override -- the consent gate lives INSIDE the real
  // sendLegacySms (crm/lib/legacySmsSend.js), so this must exercise that
  // real gate, not a fake that would just bypass it. checkConsentGate
  // returns before ever constructing a Twilio client, so this makes no
  // real network call.
  const result = await sendAppointmentConfirmationSms(db, {
    contactId, attendeeName: 'Janet Jackson', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  });

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'This contact does not have SMS consent on file. Add a consent source on the Contact Detail page before texting.');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contactId).n, 0);
});

test('a landline-only contact (no phone/phone_e164, only Landline Phone stored elsewhere) is never texted', async () => {
  const db = setup();
  // Mirrors what crm/routes/calcom.js writes for a Landline-answered booking:
  // phone/phone_e164 stay null; the number lives only in home_phone, which
  // sendLegacySms's resolveToNumber() never reads.
  const contactId = seedContact(db, { phone: null, phone_e164: null, sms_consent: 1 });

  const result = await sendAppointmentConfirmationSms(db, {
    contactId, attendeeName: 'Janet Jackson', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  });

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'Contact has no valid phone number for SMS');
});

test('an opted-out contact (STOP) is never texted even if sms_consent is still 1', async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_opted_out_at: '2026-08-01 12:00:00' });

  // No deps override -- same reasoning as the SMS-Consent=No test above:
  // opt-out is checked inside the real sendLegacySms, before any network call.
  const result = await sendAppointmentConfirmationSms(db, {
    contactId, attendeeName: 'Janet Jackson', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  });

  assert.equal(result.sent, false);
  assert.match(result.reason, /opted out/);
  const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').all(contactId);
  assert.equal(rows.length, 0);
});

test('a Twilio failure is reported, not thrown', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const FAIL_DEPS = { sendLegacySms: async () => ({ ok: false, status: 500, error: 'The number is unreachable' }) };

  const result = await sendAppointmentConfirmationSms(db, {
    contactId, attendeeName: 'Janet Jackson', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  }, FAIL_DEPS);

  assert.equal(result.attempted, true);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'The number is unreachable');
});
