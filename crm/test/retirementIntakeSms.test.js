// Tests for crm/lib/retirementIntakeSms.js — the automatic Retirement
// Intake SMS: correct URL/body, the Sent/sent_at transition on success, no
// false-Sent on failure, and the idempotency guard (never sends unless the
// intake is currently 'Not Sent').

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { createIntakeForAppointment, getIntakeByToken, submitIntakeResponses, markIntakeSent } = require('../lib/retirementIntakeService');
const { buildIntakeUrl, buildIntakeSmsBody, sendRetirementIntakeSms } = require('../lib/retirementIntakeSms');

function setup() {
  const db = createLegacyDb();
  runRevenueMvpMigrations(db); // adds sms_opted_out_at
  db.exec('ALTER TABLE communications ADD COLUMN appointment_id INTEGER');
  db.exec(`
    CREATE TABLE retirement_intakes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id     INTEGER NOT NULL,
      appointment_id INTEGER NOT NULL,
      token          TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'Not Sent',
      sent_at        DATETIME,
      completed_at   DATETIME,
      responses_json TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id)     REFERENCES contacts(id)     ON DELETE CASCADE,
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_retirement_intakes_token ON retirement_intakes(token);
  `);
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

function seedAppointment(db, contactId, apptDatetime = '2026-09-15T18:00:00.000Z') {
  return db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status)
    VALUES (?, 'Safe Money & Retirement Consultation', ?, 'Scheduled')
  `).run(contactId, apptDatetime).lastInsertRowid;
}

const OK_DEPS = { sendLegacySms: async (db, { contactId, body }) => {
  const ins = db.prepare(`INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid) VALUES (?, 'outbound', '+14144411177', '+14145550100', ?, 'sent', 'SMfake')`).run(contactId, body);
  return { ok: true, sms: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(ins.lastInsertRowid) };
}};

const FAIL_DEPS = { sendLegacySms: async () => ({ ok: false, status: 500, error: 'The number is unreachable' }) };

// ── URL / body building ──────────────────────────────────────────────────

test('buildIntakeUrl builds the public retirement-intake URL with the token as a query param', () => {
  assert.equal(buildIntakeUrl('abc123'), 'https://www.prosperitylfs.com/retirement-intake?token=abc123');
});

test('buildIntakeSmsBody includes the date, time, secure link, and deadline warning, with no marketing language', () => {
  const body = buildIntakeSmsBody({ appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', token: 'tok-1' });
  assert.match(body, /Safe Money & Retirement consultation with Loretta Stewart/);
  assert.match(body, /https:\/\/www\.prosperitylfs\.com\/retirement-intake\?token=tok-1/);
  assert.match(body, /at least 2 hours before/);
  assert.match(body, /may need to be rescheduled/);
  assert.match(body, /Prosperity Life & Financial Solutions/);
  assert.doesNotMatch(body, /% off|discount|limited time|act now/i);
});

// ── SMS personalization, Prosperity only (2026-09-17) ────────────────────

test('buildIntakeSmsBody prepends "Hi {firstName}," followed by a blank line, then the exact unchanged message, when firstName is given', () => {
  const withName = buildIntakeSmsBody({ appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', token: 'tok-1', firstName: 'Janet' });
  const withoutName = buildIntakeSmsBody({ appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', token: 'tok-1' });
  assert.equal(withName, `Hi Janet,\n\n${withoutName}`);
});

test('buildIntakeSmsBody omits the greeting entirely (no "Hi ,") when firstName is missing, matching the pre-2026-09-17 message exactly', () => {
  const body = buildIntakeSmsBody({ appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', token: 'tok-1', firstName: null });
  assert.doesNotMatch(body, /^Hi/);
  assert.doesNotMatch(body, /Hi\s*,/);
  assert.match(body, /^Your Safe Money & Retirement consultation/);
});

test('buildIntakeSmsBody does NOT add a greeting for insurance-lady even when firstName is given -- Prosperity-only for now', () => {
  const body = buildIntakeSmsBody({ appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', token: 'tok-1', brandId: 'insurance-lady', firstName: 'Janet' });
  assert.doesNotMatch(body, /^Hi Janet/);
  assert.match(body, /^Your Safe Money & Retirement consultation with Insurance Lady LLC/);
});

test('sendRetirementIntakeSms passes the contact\'s first name through to a personalized Prosperity message', async () => {
  const db = setup();
  const contactId = seedContact(db, { first_name: 'Janet', last_name: 'Jackson' });
  const apptId = seedAppointment(db, contactId);
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  let capturedBody = null;
  const deps = { sendLegacySms: async (db2, { body }) => { capturedBody = body; return OK_DEPS.sendLegacySms(db2, { contactId, body }); } };
  await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', firstName: 'Janet' }, deps);
  assert.match(capturedBody, /^Hi Janet,/);
});

// ── Brand separation (2026-09-17) ────────────────────────────────────────
// The default (omitted brandId) path above is the already-tested-in-
// production Prosperity message -- byte-identical, unaffected by any of
// this. These confirm the new insurance-lady branch is fully separate and
// never leaks Prosperity's domain/wording.

test('buildIntakeUrl defaults to the Prosperity domain when brandId is omitted (unchanged existing behavior)', () => {
  assert.equal(buildIntakeUrl('abc123'), buildIntakeUrl('abc123', 'prosperity'));
});

test('buildIntakeUrl uses Insurance Lady\'s own domain (crm/config/brands.js), not prosperitylfs.com, for brandId=insurance-lady', () => {
  assert.equal(buildIntakeUrl('abc123', 'insurance-lady'), 'https://insuranceladyllc.com/retirement-intake?token=abc123');
});

test('buildIntakeSmsBody for insurance-lady never mentions Prosperity or Loretta Stewart, and uses the Insurance Lady domain', () => {
  const body = buildIntakeSmsBody({ appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', token: 'tok-1', brandId: 'insurance-lady' });
  assert.match(body, /Safe Money & Retirement consultation with Insurance Lady LLC/);
  assert.match(body, /https:\/\/insuranceladyllc\.com\/retirement-intake\?token=tok-1/);
  assert.match(body, /at least 2 hours before/);
  assert.match(body, /may need to be rescheduled/);
  assert.match(body, /Insurance Lady LLC/);
  assert.doesNotMatch(body, /Prosperity/);
  assert.doesNotMatch(body, /Loretta/);
  assert.doesNotMatch(body, /prosperitylfs\.com/);
});

// ── Send / status transition ─────────────────────────────────────────────

test('a successful send marks the intake Sent, stamps sent_at, and includes the correct token in the message', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId);
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  let capturedBody = null;
  const deps = { sendLegacySms: async (db2, { body }) => { capturedBody = body; return OK_DEPS.sendLegacySms(db2, { contactId, body }); } };

  const result = await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z' }, deps);
  assert.equal(result.attempted, true);
  assert.equal(result.sent, true);
  assert.match(capturedBody, new RegExp(`token=${intake.token}`));

  const row = getIntakeByToken(db, intake.token);
  assert.equal(row.status, 'Sent');
  assert.ok(row.sent_at);
});

// ── Brand-aware sending (2026-09-17) ─────────────────────────────────────

test('sendRetirementIntakeSms fails closed for insurance-lady when INSURANCE_LADY_TWILIO_PHONE_NUMBER is not configured -- never falls back to Prosperity\'s number', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId);
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  const saved = process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER;
  delete process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER;

  let callCount = 0;
  const countingDeps = { sendLegacySms: async (...args) => { callCount++; return OK_DEPS.sendLegacySms(...args); } };
  try {
    const result = await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'insurance-lady' }, countingDeps);
    assert.equal(result.attempted, true);
    assert.equal(result.sent, false);
    assert.match(result.reason, /INSURANCE_LADY_TWILIO_PHONE_NUMBER is not configured/);
    assert.equal(callCount, 0, 'must never attempt to send at all, not even from Prosperity\'s number');

    const row = getIntakeByToken(db, intake.token);
    assert.equal(row.status, 'Not Sent');
  } finally {
    if (saved === undefined) delete process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER; else process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER = saved;
  }
});

test('sendRetirementIntakeSms sends from Insurance Lady\'s own Twilio number when configured, with Insurance Lady-branded wording', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId);
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  const saved = process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER;
  process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER = '+18559305239';

  let capturedFromNumber = null, capturedBody = null;
  const deps = { sendLegacySms: async (db2, { fromNumber, body }) => {
    capturedFromNumber = fromNumber; capturedBody = body;
    return OK_DEPS.sendLegacySms(db2, { contactId, body });
  } };
  try {
    const result = await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'insurance-lady' }, deps);
    assert.equal(result.sent, true);
    assert.equal(capturedFromNumber, '+18559305239');
    assert.match(capturedBody, /Insurance Lady LLC/);
    assert.match(capturedBody, /insuranceladyllc\.com/);
    assert.doesNotMatch(capturedBody, /Prosperity/);
  } finally {
    if (saved === undefined) delete process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER; else process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER = saved;
  }
});

test('sendRetirementIntakeSms with no brandId (omitted) is completely unaffected -- still uses Prosperity\'s default number/wording', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId);
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  let capturedFromNumber = 'UNSET', capturedBody = null;
  const deps = { sendLegacySms: async (db2, { fromNumber, body }) => {
    capturedFromNumber = fromNumber; capturedBody = body;
    return OK_DEPS.sendLegacySms(db2, { contactId, body });
  } };
  const result = await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z' }, deps);
  assert.equal(result.sent, true);
  assert.equal(capturedFromNumber, undefined, 'no override -- sendLegacySms falls back to its own TWILIO_FROM_NUMBER default, exactly as before');
  assert.match(capturedBody, /Prosperity Life & Financial Solutions/);
});

test('a failed send does NOT mark the intake Sent', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId);
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  const result = await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z' }, FAIL_DEPS);
  assert.equal(result.attempted, true);
  assert.equal(result.sent, false);

  const row = getIntakeByToken(db, intake.token);
  assert.equal(row.status, 'Not Sent');
  assert.equal(row.sent_at, null);
});

// ── Idempotency ──────────────────────────────────────────────────────────

test('an intake that is already Sent is never sent again', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId);
  let intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  intake = markIntakeSent(db, intake.id);
  assert.equal(intake.status, 'Sent');

  let callCount = 0;
  const countingDeps = { sendLegacySms: async (...args) => { callCount++; return OK_DEPS.sendLegacySms(...args); } };

  const result = await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z' }, countingDeps);
  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'not_eligible');
  assert.equal(callCount, 0, 'sendLegacySms must never be called for an already-Sent intake');
});

test('a completed intake is never resent as a new intake request', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId);
  const created = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  submitIntakeResponses(db, {
    token: created.token,
    responses: { about: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '4145550100' } },
  });
  const completedIntake = getIntakeByToken(db, created.token);
  assert.equal(completedIntake.status, 'Completed');

  let callCount = 0;
  const countingDeps = { sendLegacySms: async (...args) => { callCount++; return OK_DEPS.sendLegacySms(...args); } };

  const result = await sendRetirementIntakeSms(db, { intake: completedIntake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z' }, countingDeps);
  assert.equal(result.attempted, false);
  assert.equal(callCount, 0);

  const row = getIntakeByToken(db, created.token);
  assert.equal(row.status, 'Completed', 'must remain Completed, never revert to Sent');
});

test('a missing intake is a safe no-op', async () => {
  const db = setup();
  const result = await sendRetirementIntakeSms(db, { intake: null, contactId: 1, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z' });
  assert.equal(result.attempted, false);
});
