// Tests for crm/lib/appointmentReminderScheduler.js -- the 24h/1h/15m
// automated appointment reminder SMS. Uses the REAL sendLegacySms (via a
// fake Twilio client, mirroring crm/test/legacySmsSend.test.js's own
// pattern) rather than a fake sendLegacySms, so the dedup logic is
// exercised against the actual sms_messages rows the real send path
// writes -- this is the part most worth getting right end-to-end.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { runReminderCheck } = require('../lib/appointmentReminderScheduler');

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

function seedAppointment(db, contactId, overrides = {}) {
  return db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status, booking_brand)
    VALUES (@contact_id, @appt_type, @appt_datetime, @status, @booking_brand)
  `).run({
    contact_id: contactId, appt_type: 'Life Insurance Consultation',
    appt_datetime: '2026-09-01T18:00:00.000Z', status: 'Scheduled', booking_brand: 'prosperity',
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

function fakeClient(behavior = 'ok') {
  return () => ({
    messages: {
      create: async (params) => {
        if (behavior === 'fail') {
          const err = new Error('The number is unreachable');
          err.code = 21211;
          throw err;
        }
        return { sid: 'SMfake-' + Math.random().toString(36).slice(2), status: 'sent', ...params };
      },
    },
  });
}

const NOW = new Date('2026-08-31T18:00:00.000Z'); // fixed reference instant for every test

function minutesFromNow(mins) {
  return new Date(NOW.getTime() + mins * 60000).toISOString();
}

function smsRowsFor(db, contactId) {
  return db.prepare('SELECT * FROM sms_messages WHERE contact_id = ? ORDER BY id').all(contactId);
}

// ── 1-3: each reminder type sends ──────────────────────────────────────────

test('24-hour reminder sends to an SMS-consented contact within the 24h window', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(23 * 60 + 50) }); // 23h50m away

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_type, 'reminder_24h');
  assert.match(rows[0].body, /^Hi Janet, reminder:/);
}));

test('1-hour reminder sends within the 1h window', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(45) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows[0].message_type, 'reminder_1h');
  assert.match(rows[0].body, /is in 1 hour/);
}));

test('15-minute reminder sends within the 15m window', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows[0].message_type, 'reminder_15m');
  assert.match(rows[0].body, /is in 15 minutes/);
}));

test('an appointment more than 24 hours away receives no reminder yet', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(25 * 60) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

test('only the single most-imminent due reminder fires for a same-day/last-minute booking, never a cascade of all three', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  // Booked with only 10 minutes' notice -- technically within the 24h, 1h,
  // AND 15m windows simultaneously on its very first ever poll.
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1, 'must send exactly one reminder, not three');
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_type, 'reminder_15m', 'the most-imminent applicable type wins');
}));

// ── 4-7: consent eligibility ────────────────────────────────────────────────

test('SMS Consent = Yes (representing "Text and email" or "Text only") qualifies for reminders', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_consent: 1 });
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
}));

test('SMS Consent = No (representing "Email only") never receives a reminder', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_consent: 0 });
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

test('missing/unknown SMS consent (schema default 0) never receives a reminder', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  // sms_consent omitted entirely -- relies on the contacts table's own DEFAULT 0.
  const contactId = db.prepare(`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164) VALUES ('No', 'Consent', '(414) 555-0199', '+14145550199')
  `).run().lastInsertRowid;
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

// ── 8: cancelled appointments ───────────────────────────────────────────────

test('a cancelled appointment receives no reminders even though it is inside the window', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), status: 'Cancelled' });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

// ── 9-10, 12: reschedule handling ───────────────────────────────────────────

test('a rescheduled appointment uses the NEW appointment time for reminders', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(25 * 60), status: 'Rescheduled' });

  // Not due yet at the original (25h-away) time.
  let summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);

  // Rescheduled to 10 minutes away -- same appointment row, new time.
  db.prepare('UPDATE appointments SET appt_datetime = ? WHERE id = ?').run(minutesFromNow(10), apptId);

  summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows[0].message_type, 'reminder_15m');
  assert.equal(rows[0].appointment_occurrence_at, minutesFromNow(10), 'must be stamped with the NEW time, not the old one');
}));

test('the old appointment time never triggers a reminder after a reschedule moves it out of every window', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  // Reschedule far into the future, well outside all three windows, BEFORE
  // any poll ever ran against the original (imminent) time.
  db.prepare('UPDATE appointments SET appt_datetime = ? WHERE id = ?').run(minutesFromNow(48 * 60), apptId);

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0, 'the appointment is now 48h away -- no reminder is due for the new time, and none should fire for the old one either');
}));

test('rescheduling AFTER a reminder was already sent for the old time still sends fresh reminders for the new time', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  let summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  assert.equal(smsRowsFor(db, contactId)[0].message_type, 'reminder_15m');

  // Reschedule to 50 minutes away (now inside the 1h window instead).
  db.prepare('UPDATE appointments SET appt_datetime = ? WHERE id = ?').run(minutesFromNow(50), apptId);

  summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1, 'the 1h reminder for the NEW time must still send, despite a 15m reminder already having been sent for the old time');
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].message_type, 'reminder_1h');
}));

// ── 11: no duplicate for the same occurrence ────────────────────────────────

test('each reminder type sends only once for the same appointment occurrence, even across repeated polls', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });

  assert.equal(smsRowsFor(db, contactId).length, 1, 'three polls of the same unchanged appointment must still log exactly one SMS');
}));

// ── 13-14: brand routing ────────────────────────────────────────────────────

test('Insurance Lady appointment uses Insurance Lady branding and sender', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { first_name: 'Renee' });
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), booking_brand: 'insurance-lady' });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.match(row.body, /- Insurance Lady LLC\./);
  assert.equal(row.from_number, '+18559305239');
}));

test('Prosperity appointment retains Prosperity branding and sender', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), booking_brand: 'prosperity' });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.match(row.body, /- Prosperity Life & Financial Solutions\./);
  assert.notEqual(row.from_number, '+18559305239');
}));

test('an appointment with no booking_brand (created before that column existed) defaults to Prosperity', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), booking_brand: null });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.match(row.body, /Prosperity Life & Financial Solutions/);
}));

// ── 15: Twilio failure ──────────────────────────────────────────────────────

test('a Twilio failure does not mark the reminder as sent, and does not block a later retry', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const failSummary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('fail') } });
  assert.equal(failSummary.sent, 0);
  const failedRows = smsRowsFor(db, contactId);
  assert.equal(failedRows.length, 1);
  assert.equal(failedRows[0].status, 'failed');

  // Next poll (e.g. 5 minutes later, Twilio recovered) retries successfully.
  const okSummary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(okSummary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].status, 'sent');
}));

// ── 16: one appointment's failure doesn't block others ──────────────────────

test('an unexpected error while processing one appointment does not prevent reminders for other eligible appointments', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const badContactId = seedContact(db, { first_name: 'Broken' });
  seedAppointment(db, badContactId, { appt_datetime: minutesFromNow(10) });
  const goodContactId = seedContact(db, { first_name: 'Fine', phone: '(414) 555-0177', phone_e164: '+14145550177' });
  seedAppointment(db, goodContactId, { appt_datetime: minutesFromNow(11) });

  let callCount = 0;
  const throwingClientFactory = () => ({
    messages: {
      create: async (params) => {
        callCount += 1;
        if (params.to === '+14143676486') throw new Error('Simulated unexpected failure');
        return { sid: 'SMfake-good', status: 'sent', ...params };
      },
    },
  });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: throwingClientFactory } });
  assert.equal(summary.sent, 1, 'the good appointment must still succeed');
  assert.equal(smsRowsFor(db, goodContactId).length, 1);
  // The "bad" one fails via the normal Twilio-error path (caught inside
  // sendLegacySms itself, not an uncaught throw) -- still logged as failed,
  // not silently dropped, and does not abort the batch either way.
  assert.equal(smsRowsFor(db, badContactId)[0].status, 'failed');
}));

// ── 17: SMS History ──────────────────────────────────────────────────────

test('a successfully sent reminder is recorded in SMS History (sms_messages) with the correct classification', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.equal(row.appointment_id, apptId);
  assert.equal(row.message_type, 'reminder_15m');
  assert.equal(row.status, 'sent');
  assert.ok(row.twilio_sid);
}));
