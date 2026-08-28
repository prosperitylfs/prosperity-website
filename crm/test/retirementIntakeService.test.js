// Tests for crm/lib/retirementIntakeService.js — token generation, deadline
// computation (appointment time minus 2 hours), the Not Sent/Sent/Completed/
// Overdue status logic, idempotent intake creation, and the submit/validate
// flow. Uses createLegacyDb() + inline retirement_intakes table creation
// (mirroring crm/db/database.js's schema) so this file never imports
// crm/db/database.js itself, matching every other crm/lib test in this repo.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const {
  generateIntakeToken,
  computeIntakeDeadline,
  computeDisplayStatus,
  createIntakeForAppointment,
  getIntakeByToken,
  buildPublicIntakeView,
  validateIntakeSubmission,
  submitIntakeResponses,
  markIntakeSent,
  listIntakesForContact,
} = require('../lib/retirementIntakeService');

function setup() {
  const db = createLegacyDb();
  // legacyDb.js's communications table predates the appointment_id column
  // crm/db/database.js adds via addCol() — added here so
  // submitIntakeResponses' communications insert (which sets it) works
  // against this test database exactly as it does against the real one.
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
  const r = db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, phone, phone_e164)
    VALUES (@first_name, @last_name, @email, @phone, @phone_e164)
  `).run({
    first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com',
    phone: '(414) 555-0100', phone_e164: '+14145550100',
    ...overrides,
  });
  return r.lastInsertRowid;
}

function seedAppointment(db, contactId, apptDatetime, overrides = {}) {
  const r = db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status)
    VALUES (@contact_id, @appt_type, @appt_datetime, @status)
  `).run({
    contact_id: contactId, appt_type: 'Safe Money & Retirement Consultation',
    appt_datetime: apptDatetime, status: 'Scheduled', ...overrides,
  });
  return r.lastInsertRowid;
}

const validAbout = { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '4145550100' };

// ── Token generation ────────────────────────────────────────────────────

test('generateIntakeToken returns a long, unguessable, unique string', () => {
  const a = generateIntakeToken();
  const b = generateIntakeToken();
  assert.equal(typeof a, 'string');
  assert.ok(a.length >= 32);
  assert.notEqual(a, b);
});

// ── Deadline computation ────────────────────────────────────────────────

test('computeIntakeDeadline is exactly 2 hours before the appointment', () => {
  const deadline = computeIntakeDeadline('2026-09-10T18:00:00.000Z');
  assert.equal(deadline, '2026-09-10T16:00:00.000Z');
});

test('computeIntakeDeadline returns null for missing/invalid input', () => {
  assert.equal(computeIntakeDeadline(null), null);
  assert.equal(computeIntakeDeadline(''), null);
  assert.equal(computeIntakeDeadline('not-a-date'), null);
});

// ── Display status ──────────────────────────────────────────────────────

test('computeDisplayStatus: Not Sent stays Not Sent regardless of appointment time', () => {
  assert.equal(computeDisplayStatus('Not Sent', '2020-01-01T00:00:00.000Z'), 'Not Sent');
});

test('computeDisplayStatus: Completed always wins', () => {
  assert.equal(computeDisplayStatus('Completed', '2020-01-01T00:00:00.000Z'), 'Completed');
});

test('computeDisplayStatus: Sent before the deadline stays Sent', () => {
  const now = new Date('2026-09-10T10:00:00.000Z');
  const status = computeDisplayStatus('Sent', '2026-09-10T18:00:00.000Z', now); // deadline 16:00
  assert.equal(status, 'Sent');
});

test('computeDisplayStatus: Sent past the deadline becomes Overdue (display-only)', () => {
  const now = new Date('2026-09-10T17:00:00.000Z'); // past the 16:00 deadline
  const status = computeDisplayStatus('Sent', '2026-09-10T18:00:00.000Z', now);
  assert.equal(status, 'Overdue');
});

// ── Idempotent creation ──────────────────────────────────────────────────

test('createIntakeForAppointment creates a Not Sent record with a token', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');

  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  assert.equal(intake.status, 'Not Sent');
  assert.equal(intake.contact_id, contactId);
  assert.equal(intake.appointment_id, apptId);
  assert.ok(intake.token && intake.token.length >= 32);
  assert.equal(intake.sent_at, null);
  assert.equal(intake.completed_at, null);
});

test('createIntakeForAppointment is idempotent per appointment_id — no duplicate row on a second call', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');

  const first = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  const second = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  assert.equal(first.id, second.id);
  assert.equal(first.token, second.token);
  const count = db.prepare('SELECT COUNT(*) AS n FROM retirement_intakes WHERE appointment_id = ?').get(apptId).n;
  assert.equal(count, 1);
});

// ── Public view (no raw IDs) ─────────────────────────────────────────────

test('buildPublicIntakeView returns name/appointment/deadline/status but no contact_id/appointment_id/intake id', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  const view = buildPublicIntakeView(db, intake.token);
  assert.equal(view.firstName, 'Jane');
  assert.equal(view.lastName, 'Doe');
  assert.equal(view.appointmentDatetime, '2026-09-10T18:00:00.000Z');
  assert.equal(view.deadline, '2026-09-10T16:00:00.000Z');
  assert.equal(view.status, 'Not Sent');
  assert.equal(view.contact_id, undefined);
  assert.equal(view.appointment_id, undefined);
  assert.equal(view.id, undefined);
  assert.equal(view.token, undefined);
});

test('buildPublicIntakeView returns null for an unknown/invalid token', () => {
  const db = setup();
  assert.equal(buildPublicIntakeView(db, 'not-a-real-token'), null);
});

// ── Validation ───────────────────────────────────────────────────────────

test('validateIntakeSubmission requires first name, last name, email, phone', () => {
  const { valid, errors } = validateIntakeSubmission({ about: {} });
  assert.equal(valid, false);
  assert.ok(errors.some(e => /first name/i.test(e)));
  assert.ok(errors.some(e => /last name/i.test(e)));
  assert.ok(errors.some(e => /email/i.test(e)));
  assert.ok(errors.some(e => /phone/i.test(e)));
});

test('validateIntakeSubmission passes with only the required "about" fields — no $15,000 or other minimum enforced', () => {
  const { valid, errors } = validateIntakeSubmission({ about: validAbout });
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateIntakeSubmission rejects a non-object payload', () => {
  assert.equal(validateIntakeSubmission(null).valid, false);
  assert.equal(validateIntakeSubmission('a string').valid, false);
  assert.equal(validateIntakeSubmission([]).valid, false);
});

test('validateIntakeSubmission rejects a section that is not an object/array', () => {
  const { valid, errors } = validateIntakeSubmission({ about: validAbout, accounts: 'not an object' });
  assert.equal(valid, false);
  assert.ok(errors.some(e => /accounts/i.test(e)));
});

// ── Submit flow ──────────────────────────────────────────────────────────

test('submitIntakeResponses rejects an invalid token', () => {
  const db = setup();
  const result = submitIntakeResponses(db, { token: 'bogus', responses: { about: validAbout } });
  assert.deepEqual(result, { ok: false, reason: 'invalid_token' });
});

test('submitIntakeResponses rejects missing required fields without marking Completed', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  const result = submitIntakeResponses(db, { token: intake.token, responses: { about: { firstName: 'Jane' } } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'validation');

  const row = getIntakeByToken(db, intake.token);
  assert.equal(row.status, 'Not Sent');
  assert.equal(row.completed_at, null);
});

test('submitIntakeResponses stores responses, sets status Completed, and stamps completed_at', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  const responses = { about: validAbout, helpWith: { selections: ['Rollover'], mainConcern: 'Protect principal' } };
  const result = submitIntakeResponses(db, { token: intake.token, responses });
  assert.equal(result.ok, true);
  assert.equal(result.contactId, contactId);
  assert.equal(result.appointmentId, apptId);

  const row = getIntakeByToken(db, intake.token);
  assert.equal(row.status, 'Completed');
  assert.ok(row.completed_at);
  assert.deepEqual(JSON.parse(row.responses_json), responses);
});

test('submitIntakeResponses logs a communications row linked to the appointment', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  submitIntakeResponses(db, { token: intake.token, responses: { about: validAbout } });

  const comm = db.prepare(
    "SELECT * FROM communications WHERE contact_id = ? AND subject = 'Retirement Intake Form Completed'"
  ).get(contactId);
  assert.ok(comm);
  assert.equal(comm.appointment_id, apptId);
});

test('submitIntakeResponses does not create a duplicate/second contact', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  submitIntakeResponses(db, { token: intake.token, responses: { about: validAbout } });

  const count = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  assert.equal(count, 1);
});

// ── Mark sent ────────────────────────────────────────────────────────────

test('markIntakeSent flips Not Sent to Sent and stamps sent_at', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  const updated = markIntakeSent(db, intake.id);
  assert.equal(updated.status, 'Sent');
  assert.ok(updated.sent_at);
});

test('markIntakeSent is a no-op once already Completed (never reverts a completed intake)', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  submitIntakeResponses(db, { token: intake.token, responses: { about: validAbout } });

  const before = getIntakeByToken(db, intake.token);
  const after = markIntakeSent(db, intake.id);
  assert.equal(after.status, 'Completed');
  assert.equal(after.completed_at, before.completed_at);
});

// ── Contact Detail listing ───────────────────────────────────────────────

test('listIntakesForContact returns parsed responses and computed deadline/displayStatus', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z');
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  submitIntakeResponses(db, { token: intake.token, responses: { about: validAbout } });

  const list = listIntakesForContact(db, contactId);
  assert.equal(list.length, 1);
  assert.equal(list[0].displayStatus, 'Completed');
  assert.equal(list[0].deadline, '2026-09-10T16:00:00.000Z');
  assert.deepEqual(list[0].responses.about, validAbout);
  assert.equal(list[0].appt_datetime, '2026-09-10T18:00:00.000Z');
});

test('listIntakesForContact returns an empty array for a contact with no retirement appointments', () => {
  const db = setup();
  const contactId = seedContact(db);
  assert.deepEqual(listIntakesForContact(db, contactId), []);
});
