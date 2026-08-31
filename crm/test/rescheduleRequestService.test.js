// Tests for crm/lib/rescheduleRequestService.js -- the SMS RESCHEDULE
// keyword workflow: keyword recognition, the three reply variants (one /
// multiple / zero upcoming appointments), that the appointment itself is
// never modified, the follow-up task record, SMS History logging, consent
// enforcement, and that a Twilio failure isn't marked sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const {
  isRescheduleRequest, processRescheduleRequest, findUpcomingAppointments,
  SINGLE_APPT_REPLY, MULTIPLE_APPT_REPLY, NO_APPT_REPLY, RESCHEDULE_TASK_DEDUP_KEYWORD,
} = require('../lib/rescheduleRequestService');

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
    appt_datetime: '2026-09-05T18:00:00.000Z', status: 'Scheduled', booking_brand: 'prosperity',
    ...overrides,
  }).lastInsertRowid;
}

const NOW = new Date('2026-08-31T18:00:00.000Z');

const OK_DEPS = { sendLegacySms: async (db, { contactId, body, fromNumber, appointmentId, messageType }) => {
  const twilioSid = 'SMfake-' + Math.random().toString(36).slice(2);
  const ins = db.prepare(`
    INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid, appointment_id, message_type)
    VALUES (?, 'outbound', ?, '+14143676486', ?, 'sent', ?, ?, ?)
  `).run(contactId, fromNumber || '+14144411177', body, twilioSid, appointmentId, messageType);
  return { ok: true, sms: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(ins.lastInsertRowid) };
}};

function outboundRowsFor(db, contactId) {
  return db.prepare(`SELECT * FROM sms_messages WHERE contact_id = ? AND direction = 'outbound' ORDER BY id`).all(contactId);
}

// ── Keyword recognition ─────────────────────────────────────────────────

test('isRescheduleRequest recognizes case-insensitive exact-match variations', () => {
  for (const body of ['reschedule', 'RESCHEDULE', 'Reschedule', '  reschedule  ', 'ReScHeDuLe']) {
    assert.equal(isRescheduleRequest(body), true, `expected "${body}" to be recognized`);
  }
});

test('isRescheduleRequest does NOT trigger merely because the word appears inside a longer, unrelated message', () => {
  for (const body of [
    'I might need to reschedule at some point, not sure yet',
    'Can we reschedule? Also what is your address',
    'please reschedule my appointment for next week sometime',
    '',
    'Yes',
    'RESCHEDULING',
  ]) {
    assert.equal(isRescheduleRequest(body), false, `expected "${body}" NOT to be recognized`);
  }
});

// ── One / multiple / zero upcoming appointments ─────────────────────────

test('a contact with exactly one upcoming appointment gets the single-appointment reply', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z' });

  const result = await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW }, OK_DEPS);
  assert.equal(result.sent, true);
  assert.equal(result.appointmentCount, 1);
  const rows = outboundRowsFor(db, contactId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].body, SINGLE_APPT_REPLY);
  assert.equal(rows[0].appointment_id, apptId);
  assert.equal(rows[0].message_type, 'reschedule_request_reply');
  assert.doesNotMatch(rows[0].body, /rescheduled/i, 'must never say the appointment HAS been rescheduled');
});

test('a contact with more than one upcoming appointment gets the ambiguity reply', async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z' });
  seedAppointment(db, contactId, { appt_datetime: '2026-09-10T18:00:00.000Z', appt_type: 'Safe Money & Retirement Consultation' });

  const result = await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW }, OK_DEPS);
  assert.equal(result.appointmentCount, 2);
  const rows = outboundRowsFor(db, contactId);
  assert.equal(rows[0].body, MULTIPLE_APPT_REPLY);
  assert.equal(rows[0].appointment_id, null, 'ambiguous case must not guess which appointment');
});

test('a contact with no upcoming appointment gets the fallback reply', async () => {
  const db = setup();
  const contactId = seedContact(db);
  // Only a PAST appointment on file.
  seedAppointment(db, contactId, { appt_datetime: '2026-08-01T18:00:00.000Z' });

  const result = await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW }, OK_DEPS);
  assert.equal(result.appointmentCount, 0);
  const rows = outboundRowsFor(db, contactId);
  assert.equal(rows[0].body, NO_APPT_REPLY);
});

test('a cancelled appointment is not counted as upcoming', async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z', status: 'Cancelled' });

  const result = await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW }, OK_DEPS);
  assert.equal(result.appointmentCount, 0);
});

// ── The appointment itself is never modified ────────────────────────────

test('processing a reschedule request never changes the appointment date/time or status', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z', status: 'Scheduled' });

  await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW }, OK_DEPS);

  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId);
  assert.equal(appt.appt_datetime, '2026-09-05T18:00:00.000Z');
  assert.equal(appt.status, 'Scheduled');
});

// ── Internal record (follow-up task) ────────────────────────────────────

test('a follow-up task records the reschedule request, identifying the appointment and that it came in by SMS', async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z', appt_type: 'Life Insurance Consultation' });

  const result = await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW }, OK_DEPS);
  const task = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(result.taskId);
  assert.ok(task);
  assert.equal(task.contact_id, contactId);
  assert.match(task.notes, /reschedule by SMS/i);
  assert.match(task.notes, new RegExp(RESCHEDULE_TASK_DEDUP_KEYWORD));
  assert.match(task.notes, /Life Insurance Consultation/);
  assert.match(task.notes, /2026/); // original date/time referenced
  assert.ok(task.created_at, 'timestamp is recorded automatically');
});

test('a second reschedule request from the same contact does not create a duplicate task', async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z' });

  await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW }, OK_DEPS);
  await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW }, OK_DEPS);

  const taskCount = db.prepare(`SELECT COUNT(*) AS n FROM follow_up_tasks WHERE contact_id = ?`).get(contactId).n;
  assert.equal(taskCount, 1);
});

test('a task is still recorded even when the automated reply is blocked by consent', async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_consent: 0 });
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z' });

  const result = await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW });
  assert.equal(result.sent, false);
  assert.ok(result.taskId, 'the internal record must still be created even when the SMS is blocked');
  const task = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(result.taskId);
  assert.ok(task);
});

// ── Consent / opt-out enforcement ───────────────────────────────────────

test('SMS Consent = No blocks the automated reply (no deps override -- exercises the real consent gate)', async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_consent: 0 });
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z' });

  const result = await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW });
  assert.equal(result.sent, false);
  assert.equal(outboundRowsFor(db, contactId).length, 0);
});

test('an opted-out contact (STOP) never receives the automated reply', async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_opted_out_at: '2026-08-01 12:00:00' });
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z' });

  const result = await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW });
  assert.equal(result.sent, false);
  assert.match(result.reason, /opted out/);
  assert.equal(outboundRowsFor(db, contactId).length, 0);
});

// ── Twilio failure ───────────────────────────────────────────────────────

test('a Twilio failure is reported, not marked sent', async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z' });
  const FAIL_DEPS = { sendLegacySms: async () => ({ ok: false, status: 500, error: 'The number is unreachable' }) };

  const result = await processRescheduleRequest(db, { contactId, inboundToNumber: '+14144411177', now: NOW }, FAIL_DEPS);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'The number is unreachable');
});

// ── Sender number (thread continuity / brand) ───────────────────────────

test('the automated reply is sent FROM the same number the inbound RESCHEDULE text arrived TO', async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z' });

  await processRescheduleRequest(db, { contactId, inboundToNumber: '+18559305239', now: NOW }, OK_DEPS);
  const rows = outboundRowsFor(db, contactId);
  assert.equal(rows[0].from_number, '+18559305239');
});

// ── findUpcomingAppointments ordering ───────────────────────────────────

test('findUpcomingAppointments returns soonest-first', () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: '2026-09-10T18:00:00.000Z' });
  seedAppointment(db, contactId, { appt_datetime: '2026-09-05T18:00:00.000Z' });

  const appts = findUpcomingAppointments(db, contactId, NOW.toISOString());
  assert.equal(appts.length, 2);
  assert.equal(appts[0].appt_datetime, '2026-09-05T18:00:00.000Z');
});
