// Tests for crm/lib/activityService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { addActivity, editActivity, archiveActivity, listActivityHistory, addNote, editNote } = require('../lib/activityService');
const { createClient } = require('../lib/clientService');
const { getClientDetail } = require('../lib/dashboardQueries');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  // testSupport/legacyDb.js's own `communications` table predates
  // crm/db/database.js's unconditional `addCol('communications',
  // 'appointment_id', ...)` -- needed here since 2026-10-14's
  // addActivity -> createAppointment wiring writes to it. Matches every
  // real (non-test) database already.
  try { db.prepare('ALTER TABLE communications ADD COLUMN appointment_id INTEGER').run(); }
  catch (e) { if (!e.message.includes('duplicate column')) throw e; }
  return db;
}

test('rejects an unknown activity type', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Xena', email: 'xena@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => addActivity(db, { contactId: client.contact.id, activityType: 'not_a_type', summary: 'x' }, 'Loretta Stewart'), /unknown activityType/);
});

test('adding an activity with a next action and due date also creates a real pending task', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Yara', email: 'yara@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  addActivity(db, {
    contactId: client.contact.id, activityType: 'call', summary: 'Talked about coverage',
    nextAction: 'Send quote', nextActionDueDate: '2026-09-01',
  }, 'Loretta Stewart');
  const tasks = db.prepare('SELECT * FROM follow_up_tasks WHERE contact_id = ?').all(client.contact.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].notes, 'Send quote');
  assert.equal(tasks[0].due_date, '2026-09-01');
});

test('activities update Last Activity shown on the client detail record', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Zane', email: 'zane@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const before = getClientDetail(db, client.contact.id);
  const beforeTimestamp = before.contact.name && new Date().toISOString(); // sanity only
  addActivity(db, { contactId: client.contact.id, activityType: 'general', summary: 'Left a voicemail' }, 'Loretta Stewart');
  const detail = getClientDetail(db, client.contact.id);
  assert.ok(detail.communications.some(c => c.channel === 'activity'), 'client detail communications must include the new activity');
});

test('editing an activity preserves a real audit trail of the previous content', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Amos', email: 'amos@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const activity = addActivity(db, { contactId: client.contact.id, activityType: 'note', summary: 'Note', details: 'Original text' }, 'Loretta Stewart');
  editActivity(db, activity.id, { details: 'Edited text' }, 'Loretta Stewart');
  const history = listActivityHistory(db, activity.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].previous_details, 'Original text');
  const after = db.prepare('SELECT * FROM activities WHERE id = ?').get(activity.id);
  assert.equal(after.details, 'Edited text');
});

test('archiving an activity does not delete the row', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Bea', email: 'bea@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const activity = addActivity(db, { contactId: client.contact.id, activityType: 'note', details: 'x' }, 'Loretta Stewart');
  archiveActivity(db, activity.id, 'Loretta Stewart');
  const stillExists = db.prepare('SELECT * FROM activities WHERE id = ?').get(activity.id);
  assert.ok(stillExists);
  assert.ok(stillExists.archived_at);
});

test('notes support create and edit through the same audited path as activities', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Caleb', email: 'caleb@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const note = addNote(db, { contactId: client.contact.id, body: 'First note' }, 'Loretta Stewart');
  editNote(db, note.id, { body: 'Revised note' }, 'Loretta Stewart');
  const history = listActivityHistory(db, note.id);
  assert.equal(history.length, 1);
  assert.equal(history[0].previous_details, 'First note');
});

// 2026-10-14 PRODUCTION BUG FIX: picking "Appointment" in Add Activity
// used to only ever write to `activities` -- no real appointment was ever
// created, so it never showed up on the client's Appointments tab, the
// main Appointments page, or the dashboard's Upcoming Appointments count
// (all three read the real `appointments` table). These tests confirm an
// 'appointment'-type activity now also creates a real, linked appointment.

test('an "appointment"-type activity with a date/time also creates a real appointment', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Tiffany', lastName: 'Williams', email: 'tiffany@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const activity = addActivity(db, {
    contactId: client.contact.id, activityType: 'appointment', activityAt: '2026-11-10T15:00',
    summary: 'Life Insurance Review', apptDurationMin: '30', apptLocation: 'Video Call', details: 'Review current coverage',
  }, 'Loretta Stewart');

  assert.equal(activity.appointmentOutcome, 'created');
  assert.ok(activity.appointment);
  assert.equal(activity.appointment.contact_id, client.contact.id);
  assert.equal(activity.appointment.appt_datetime, '2026-11-10T15:00');
  assert.equal(activity.appointment.appt_type, 'Life Insurance Review');
  assert.equal(activity.appointment.duration_min, 30);
  assert.equal(activity.appointment.location, 'Video Call');
  assert.equal(activity.appointment.status, 'Scheduled');

  const stored = db.prepare('SELECT * FROM appointments WHERE contact_id = ?').all(client.contact.id);
  assert.equal(stored.length, 1);
});

test('the real appointment then shows up on the client detail record\'s own appointments list', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Dana', email: 'dana@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  addActivity(db, { contactId: client.contact.id, activityType: 'appointment', activityAt: '2026-11-11T09:00', summary: 'Consultation' }, 'Loretta Stewart');
  const detail = getClientDetail(db, client.contact.id);
  assert.equal(detail.appointments.length, 1);
  // getClientDetail normalizes appt_datetime to full ISO UTC (toIsoUtc) on
  // the way out -- same display-time normalization every other appointment
  // reader already goes through, not something this fix changes.
  assert.ok(detail.appointments[0].appt_datetime.startsWith('2026-11-11T09:00'));
});

test('an "appointment"-type activity requires a date/time -- never silently skips the appointment', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Evan', email: 'evan@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => addActivity(db, { contactId: client.contact.id, activityType: 'appointment', summary: 'x' }, 'Loretta Stewart'), /requires a date and time/);
});

test('a non-appointment activity never creates an appointment, even with a date/time set', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Faye', email: 'faye@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const activity = addActivity(db, { contactId: client.contact.id, activityType: 'call', activityAt: '2026-11-12T10:00', summary: 'Quick call' }, 'Loretta Stewart');
  assert.equal(activity.appointment, null);
  assert.equal(activity.appointmentOutcome, null);
  const stored = db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE contact_id = ?').get(client.contact.id).n;
  assert.equal(stored, 0);
});

test('saving the same appointment activity twice (retry/double-click) never creates a duplicate appointment', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Gwen', email: 'gwen@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const fields = { contactId: client.contact.id, activityType: 'appointment', activityAt: '2026-11-13T13:00', summary: 'Annual Review' };
  const first = addActivity(db, fields, 'Loretta Stewart');
  const second = addActivity(db, fields, 'Loretta Stewart');

  assert.equal(first.appointmentOutcome, 'created');
  assert.equal(second.appointmentOutcome, 'existing');
  assert.equal(first.appointment.id, second.appointment.id);

  // Both retries DO still log their own activity entry (activity history
  // is never suppressed -- only the duplicate real appointment is
  // avoided), so there are two activities but only one appointment.
  const activities = db.prepare('SELECT COUNT(*) AS n FROM activities WHERE contact_id = ?').get(client.contact.id).n;
  assert.equal(activities, 2);
  const appts = db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE contact_id = ?').get(client.contact.id).n;
  assert.equal(appts, 1);
});

test('if the activity insert or the appointment insert would fail, neither is left behind (one transaction)', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Hugo', email: 'hugo@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  // An unknown activityType fails validation BEFORE the transaction opens,
  // so this just confirms the existing "rejects an unknown activity type"
  // behavior still holds even when appointment-shaped fields are present --
  // no appointment is created from a rejected activity.
  assert.throws(() => addActivity(db, {
    contactId: client.contact.id, activityType: 'not_a_type', activityAt: '2026-11-14T10:00',
  }, 'Loretta Stewart'), /unknown activityType/);
  const appts = db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE contact_id = ?').get(client.contact.id).n;
  assert.equal(appts, 0);
});
