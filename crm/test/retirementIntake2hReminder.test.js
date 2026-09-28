// Tests for the Insurance Lady "Retirement Intake - 2 Hour Reminder"
// workflow (2026-10-09) -- the new 115-125 minute polling window in
// crm/lib/appointmentReminderScheduler.js's REMINDER_SPECS, gated entirely
// by the seeded crm/lib/workflowService.js row (brand=insurance-lady,
// appointmentType='Safe Money & Retirement Consultation',
// messageType='retirement_intake_2h_reminder',
// conditionType='retirement_intake_not_completed'). Uses the REAL
// sendLegacySms (via a fake Twilio client), matching
// crm/test/appointmentReminderScheduler.test.js's own pattern, so dedup is
// exercised against real sms_messages rows, not a mock.
//
// The critical thing under test: this new window matches EVERY eligible
// appointment (any brand, any type) that happens to be ~2 hours out, since
// crm/lib/appointmentReminderScheduler.js has no brand/type filtering of
// its own -- appointmentConfirmationSms.js's buildConfirmationSmsBody
// returning null for an unrecognized messageType (rather than silently
// defaulting to the confirmation template) is what keeps every OTHER
// appointment in that window from getting a wrong message sent at all.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { runMigrations: runBrandsMigrations } = require('../db/migrateBrands');
const { runReminderCheck } = require('../lib/appointmentReminderScheduler');
const { seedDefaultWorkflows } = require('../lib/workflowService');
const { createIntakeForAppointment, submitIntakeResponses } = require('../lib/retirementIntakeService');

function setup() {
  const db = createLegacyDb();
  runRevenueMvpMigrations(db);
  runBrandsMigrations(db);
  seedDefaultWorkflows(db);
  // legacyDb.js's communications table predates the appointment_id column
  // crm/db/database.js adds via addCol() -- needed for submitIntakeResponses'
  // own communications insert (test (c), intake completion), matching
  // test/retirementIntakeService.test.js's own setup().
  db.exec('ALTER TABLE communications ADD COLUMN appointment_id INTEGER');
  db.exec(`
    CREATE TABLE retirement_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL,
      token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Not Sent', sent_at DATETIME, completed_at DATETIME,
      responses_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    first_name: 'Janet', last_name: 'Jackson', phone: '(414) 367-6486', phone_e164: '+14143676486',
    sms_consent: 1, sms_opted_out_at: null, ...overrides,
  }).lastInsertRowid;
}

function seedAppointment(db, contactId, overrides = {}) {
  return db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status, booking_brand)
    VALUES (@contact_id, @appt_type, @appt_datetime, @status, @booking_brand)
  `).run({
    contact_id: contactId, appt_type: 'Safe Money & Retirement Consultation',
    appt_datetime: '2026-09-01T18:00:00.000Z', status: 'Scheduled', booking_brand: 'insurance-lady',
    ...overrides,
  }).lastInsertRowid;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

const TWILIO_ENV = { TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tokenfake', TWILIO_FROM_NUMBER: '+14144411177' };
const INSURANCE_LADY_ENV = { ...TWILIO_ENV, INSURANCE_LADY_TWILIO_PHONE_NUMBER: '+18559305239' };

function fakeClient() {
  return () => ({
    messages: { create: async (params) => ({ sid: 'SMfake-' + Math.random().toString(36).slice(2), status: 'sent', ...params }) },
  });
}

const NOW = new Date('2026-08-31T18:00:00.000Z');
function minutesFromNow(mins) { return new Date(NOW.getTime() + mins * 60000).toISOString(); }
function smsRowsFor(db, contactId, messageType) {
  const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ? ORDER BY id').all(contactId);
  return messageType ? rows.filter(r => r.message_type === messageType) : rows;
}

// ── (b) sends when intake is NOT completed ──────────────────────────────

test('(b) the 2-hour reminder sends, with the real unique intake link, when the retirement intake has NOT been completed (status still "Not Sent")', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(120) });
  // Realistic setup: an intake row already exists by the 2-hour mark, just
  // as lib/retirementIntakeSms.js's booking-time send would have created
  // hours or days earlier -- see the separate "no intake row at all" test
  // below for the defensive (unusual) fallback case.
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 1);
  const rows = smsRowsFor(db, contactId, 'retirement_intake_2h_reminder');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, `Hi Janet,

Your Safe Money & Retirement Consultation with Loretta Stewart of Insurance Lady LLC is coming up in 2 hours.

We have not yet received your Retirement Intake Form. Please complete it now so we have time to review your information and prepare for your consultation:

https://insuranceladyllc.com/i/${intake.token.slice(0, 16)}

If you have already completed the form, no further action is needed.

– Loretta`);
}));

test('(b) also sends when an intake row exists but is still "Sent" (opened/not yet completed)', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(120) });
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  db.prepare(`UPDATE retirement_intakes SET status = 'Sent' WHERE id = ?`).run(intake.id);

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 1);
  assert.equal(smsRowsFor(db, contactId, 'retirement_intake_2h_reminder').length, 1);
}));

test('defensive edge case: if no retirement_intakes row exists at all (intake creation somehow never happened), the condition still evaluates "not completed" and the reminder still sends, but with a blank link -- documented, not silently swallowed', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(120) }); // no createIntakeForAppointment call at all

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 1, 'evaluateCondition fails conservative (no row = not completed), so the send still goes out');
  const body = smsRowsFor(db, contactId, 'retirement_intake_2h_reminder')[0].body;
  assert.match(body, /prepare for your consultation:\n\n\n\nIf you have already completed/, 'the {{intake_link}} placeholder renders empty (no token to link to) rather than throwing -- this is a real, narrow gap if intake creation ever fails at booking time, not a crash');
}));

// ── (c) does NOT send when intake IS completed ───────────────────────────

test('(c) the 2-hour reminder does NOT send when the retirement intake has been completed', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { first_name: 'Renee', last_name: 'Jones' });
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(120) });
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  submitIntakeResponses(db, { token: intake.token, responses: { about: { firstName: 'Renee', lastName: 'Jones', email: 'renee@example.com', phone: '4145550100' } } });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 0, 'nothing must be sent once the intake is Completed');
  assert.equal(smsRowsFor(db, contactId).length, 0, 'no SMS of any kind for this appointment -- not the 2h reminder, and no fallback message either');
}));

// ── (d) wrong appointment / lead type never affected ─────────────────────

test('(d) does NOT send for a Life Insurance Consultation appointment at the same brand and same time offset', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_type: 'Life Insurance Consultation', appt_datetime: minutesFromNow(120) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0, 'a Life Insurance appointment 2 hours out must get NOTHING -- not the 2h reminder, and critically not a wrong fallback confirmation message either');
}));

test('(d) does NOT send for a Policy Review appointment at the same brand and same time offset', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_type: 'Policy Review', appt_datetime: minutesFromNow(120) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

// ── (e) Insurance Lady / Prosperity isolation ────────────────────────────

test('(e) does NOT send for a Prosperity appointment, even with the identical appointment type string and timing', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { booking_brand: 'prosperity', appt_datetime: minutesFromNow(120) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0, 'Prosperity has no retirement_intake_2h_reminder workflow row -- must get nothing, never Insurance Lady\'s wording or a fallback');
}));

test('(e) Insurance Lady and Prosperity appointments in the SAME poll each get only their own correct treatment', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const ilContactId = seedContact(db, { first_name: 'Janet', phone_e164: '+14143676486' });
  seedAppointment(db, ilContactId, { booking_brand: 'insurance-lady', appt_datetime: minutesFromNow(120) });
  const prContactId = seedContact(db, { first_name: 'Sam', phone_e164: '+14145550199' });
  seedAppointment(db, prContactId, { booking_brand: 'prosperity', appt_datetime: minutesFromNow(120) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 1, 'only the Insurance Lady appointment gets a message');
  assert.equal(smsRowsFor(db, ilContactId, 'retirement_intake_2h_reminder').length, 1);
  assert.equal(smsRowsFor(db, prContactId).length, 0);
}));

// ── (f) existing reminders/workflows remain unchanged ────────────────────

test('(f) the existing 1-hour and 24-hour reminders still fire correctly for appointments in THEIR own windows, unaffected by the new 2h window existing', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contact1h = seedContact(db, { first_name: 'OneHour', phone_e164: '+14145550001' });
  seedAppointment(db, contact1h, { appt_type: 'Life Insurance Consultation', appt_datetime: minutesFromNow(60) });
  const contact24h = seedContact(db, { first_name: 'TwentyFourHour', phone_e164: '+14145550002' });
  seedAppointment(db, contact24h, { appt_type: 'Life Insurance Consultation', appt_datetime: minutesFromNow(24 * 60) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 2);
  assert.equal(smsRowsFor(db, contact1h, 'reminder_1h').length, 1);
  assert.equal(smsRowsFor(db, contact24h, 'reminder_24h').length, 1);
}));

test('(f) an appointment exactly between the 1h and 2h windows (e.g. 90 minutes out) still gets nothing, exactly as before this change', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(90) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

// ── Duplicate-send protection ─────────────────────────────────────────────

test('duplicate-send protection: running the poll twice for the same eligible appointment sends only once', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(120) });
  createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  const first = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  const second = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(first.sent, 1);
  assert.equal(second.sent, 0, 'the second poll must see the dedup row and skip');
  assert.equal(smsRowsFor(db, contactId, 'retirement_intake_2h_reminder').length, 1);
}));

// ── Missing first name safety (requirement #9) ───────────────────────────

test('a missing first name renders "Hi there," in the 2-hour reminder -- never "Hi undefined," or "Hi null,"', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { first_name: null });
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(120) });
  createIntakeForAppointment(db, { contactId, appointmentId: apptId });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient() } });
  assert.equal(summary.sent, 1);
  const body = smsRowsFor(db, contactId, 'retirement_intake_2h_reminder')[0].body;
  assert.match(body, /^Hi there,/);
  assert.doesNotMatch(body, /Hi undefined,/);
  assert.doesNotMatch(body, /Hi null,/);
}));

// ── Booking-time link (requirement a, cross-check with the scheduler-level change) ──

test('(a) the booking-time Retirement Intake Link workflow is unaffected by the new scheduler window/message type -- still selected by its own distinct messageType', () => {
  const { selectWorkflowForOccurrence } = require('../lib/workflowService');
  const db = setup();
  const bookingTimeRow = selectWorkflowForOccurrence(db, { brandId: 'insurance-lady', appointmentType: 'Safe Money & Retirement Consultation', messageType: 'retirement_intake' });
  const twoHourRow = selectWorkflowForOccurrence(db, { brandId: 'insurance-lady', appointmentType: 'Safe Money & Retirement Consultation', messageType: 'retirement_intake_2h_reminder' });
  assert.ok(bookingTimeRow);
  assert.ok(twoHourRow);
  assert.notEqual(bookingTimeRow.id, twoHourRow.id, 'the two must be genuinely separate rows, never resolving to the same one');
  assert.equal(bookingTimeRow.triggerType, 'appointment_booked');
  assert.equal(twoHourRow.triggerType, 'time_before_appointment');
});
