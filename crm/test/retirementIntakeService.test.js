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
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status, booking_brand)
    VALUES (@contact_id, @appt_type, @appt_datetime, @status, @booking_brand)
  `).run({
    contact_id: contactId, appt_type: 'Safe Money & Retirement Consultation',
    appt_datetime: apptDatetime, status: 'Scheduled', booking_brand: null, ...overrides,
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
  // 2026-09-17: must be 'received', not the schema's raw 'logged' default,
  // which dashboardQueries.js's normalizeMessageStatus mislabels "Queued"
  // even though this is a completed, inbound record.
  assert.equal(comm.status, 'received');
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

// ── Completed Retirement Intake section (2026-10-16) ──────────────────────
// crm/public/app/client.html's new Retirement & Annuity Planning card reads
// listIntakesForContact directly -- these tests cover the exact guarantees
// that section depends on: every completed intake is returned (never just
// the newest), newest-first, each with its own correct appointment_id and
// brand_id, and brand isolation holds with no cross-brand fallback.

test('listIntakesForContact includes brand_id, taken from the appointment\'s own booking_brand', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z', { booking_brand: 'prosperity' });
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  submitIntakeResponses(db, { token: intake.token, responses: { about: validAbout } });

  const list = listIntakesForContact(db, contactId);
  assert.equal(list[0].brand_id, 'prosperity');
});

test('an Insurance Lady intake reports brand_id="insurance-lady", never falling back to or being confused with Prosperity', () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z', { booking_brand: 'insurance-lady' });
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  submitIntakeResponses(db, { token: intake.token, responses: { about: validAbout } });

  const list = listIntakesForContact(db, contactId);
  assert.equal(list[0].brand_id, 'insurance-lady');
  assert.notEqual(list[0].brand_id, 'prosperity');
});

test('multiple completed intakes for the same contact are ALL returned, newest appointment first -- never silently collapsed to just one', () => {
  const db = setup();
  const contactId = seedContact(db);

  const olderApptId = seedAppointment(db, contactId, '2026-01-10T18:00:00.000Z', { booking_brand: 'prosperity' });
  const olderIntake = createIntakeForAppointment(db, { contactId, appointmentId: olderApptId });
  submitIntakeResponses(db, { token: olderIntake.token, responses: { about: { ...validAbout, firstName: 'OlderSubmission' } } });

  const newerApptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z', { booking_brand: 'prosperity' });
  const newerIntake = createIntakeForAppointment(db, { contactId, appointmentId: newerApptId });
  submitIntakeResponses(db, { token: newerIntake.token, responses: { about: { ...validAbout, firstName: 'NewerSubmission' } } });

  const list = listIntakesForContact(db, contactId);
  assert.equal(list.length, 2, 'both completed intakes must be returned, not just the most recent');
  assert.equal(list[0].responses.about.firstName, 'NewerSubmission', 'newest appointment must be first');
  assert.equal(list[1].responses.about.firstName, 'OlderSubmission');
  assert.notEqual(list[0].id, list[1].id, 'each retains its own distinct retirement_intakes id');
  assert.notEqual(list[0].appointment_id, list[1].appointment_id, 'each retains its own distinct appointment');
});

test('a Prosperity intake and an Insurance Lady intake for the SAME contact each keep their own correct, isolated brand -- no cross-brand fallback', () => {
  const db = setup();
  const contactId = seedContact(db);

  const prosperityApptId = seedAppointment(db, contactId, '2026-01-10T18:00:00.000Z', { booking_brand: 'prosperity' });
  const prosperityIntake = createIntakeForAppointment(db, { contactId, appointmentId: prosperityApptId });
  submitIntakeResponses(db, { token: prosperityIntake.token, responses: { about: validAbout } });

  const ilApptId = seedAppointment(db, contactId, '2026-09-10T18:00:00.000Z', { booking_brand: 'insurance-lady' });
  const ilIntake = createIntakeForAppointment(db, { contactId, appointmentId: ilApptId });
  submitIntakeResponses(db, { token: ilIntake.token, responses: { about: validAbout } });

  const list = listIntakesForContact(db, contactId);
  const byBrand = Object.fromEntries(list.map(i => [i.brand_id, i]));
  assert.equal(byBrand.prosperity.appointment_id, prosperityApptId);
  assert.equal(byBrand['insurance-lady'].appointment_id, ilApptId);
});
