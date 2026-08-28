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
