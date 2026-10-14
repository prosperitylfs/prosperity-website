// Tests for crm/lib/appointmentService.js -- the single shared
// appointment-creation path used by both crm/routes/appointments.js's
// manual "Add Appointment" page and crm/lib/activityService.js's
// "Add Activity -> Appointment Scheduled" flow.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createClient } = require('../lib/clientService');
const { createAppointment, findDuplicateAppointment } = require('../lib/appointmentService');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  // testSupport/legacyDb.js's own `communications` table predates
  // crm/db/database.js's unconditional `addCol('communications',
  // 'appointment_id', ...)` -- add it here so this test's schema matches
  // what every real (non-test) database already has.
  try { db.prepare('ALTER TABLE communications ADD COLUMN appointment_id INTEGER').run(); }
  catch (e) { if (!e.message.includes('duplicate column')) throw e; }
  return db;
}

function makeClient(db, overrides = {}) {
  return createClient(db, { firstName: 'Test', lastName: 'Client', email: `t${Date.now()}${Math.random()}@example.com`, brandSlug: 'prosperity', ...overrides }, 'Loretta Stewart').contact;
}

test('creates a real appointment with the given fields', () => {
  const db = setup();
  const client = makeClient(db);
  const result = createAppointment(db, {
    contactId: client.id, apptType: 'Life Insurance Consultation', apptDatetime: '2026-11-02T14:00',
    durationMin: 45, location: 'Video Call', notes: 'Discuss term vs. whole life',
  });
  assert.equal(result.outcome, 'created');
  assert.equal(result.appointment.contact_id, client.id);
  assert.equal(result.appointment.appt_type, 'Life Insurance Consultation');
  assert.equal(result.appointment.appt_datetime, '2026-11-02T14:00');
  assert.equal(result.appointment.duration_min, 45);
  assert.equal(result.appointment.location, 'Video Call');
  assert.equal(result.appointment.status, 'Scheduled');
});

test('defaults duration to 60 and status to Scheduled when not provided', () => {
  const db = setup();
  const client = makeClient(db);
  const result = createAppointment(db, { contactId: client.id, apptType: 'Phone Call', apptDatetime: '2026-11-03T09:00' });
  assert.equal(result.appointment.duration_min, 60);
  assert.equal(result.appointment.status, 'Scheduled');
});

test('also writes a linked communications row', () => {
  const db = setup();
  const client = makeClient(db);
  const result = createAppointment(db, { contactId: client.id, apptType: 'Phone Call', apptDatetime: '2026-11-04T10:00' });
  const comm = db.prepare('SELECT * FROM communications WHERE appointment_id = ?').get(result.appointment.id);
  assert.ok(comm);
  assert.equal(comm.comm_type, 'appointment');
});

test('requires contactId, apptDatetime, and apptType', () => {
  const db = setup();
  const client = makeClient(db);
  assert.throws(() => createAppointment(db, { apptType: 'x', apptDatetime: '2026-11-01T10:00' }), /contactId is required/);
  assert.throws(() => createAppointment(db, { contactId: client.id, apptType: 'x' }), /apptDatetime is required/);
  assert.throws(() => createAppointment(db, { contactId: client.id, apptDatetime: '2026-11-01T10:00' }), /apptType is required/);
});

test('throws for an unknown contact', () => {
  const db = setup();
  assert.throws(() => createAppointment(db, { contactId: 999999, apptType: 'x', apptDatetime: '2026-11-01T10:00' }), /contact not found/);
});

test('2026-10-14 PRODUCTION BUG FIX: a second identical booking (same contact, same minute, retry/double-submit) returns the existing appointment instead of creating a duplicate', () => {
  const db = setup();
  const client = makeClient(db);
  const first = createAppointment(db, { contactId: client.id, apptType: 'Phone Call', apptDatetime: '2026-11-05T11:00' });
  const second = createAppointment(db, { contactId: client.id, apptType: 'Phone Call', apptDatetime: '2026-11-05T11:00' });

  assert.equal(first.outcome, 'created');
  assert.equal(second.outcome, 'existing');
  assert.equal(first.appointment.id, second.appointment.id);

  const all = db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE contact_id = ?').get(client.id).n;
  assert.equal(all, 1);
});

test('a genuinely different appointment for the same contact at a different time is never blocked', () => {
  const db = setup();
  const client = makeClient(db);
  createAppointment(db, { contactId: client.id, apptType: 'Phone Call', apptDatetime: '2026-11-06T11:00' });
  const second = createAppointment(db, { contactId: client.id, apptType: 'Follow-up Call', apptDatetime: '2026-11-06T15:00' });
  assert.equal(second.outcome, 'created');

  const all = db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE contact_id = ?').get(client.id).n;
  assert.equal(all, 2);
});

test('a cancelled appointment at the same time does not block a new one from being created', () => {
  const db = setup();
  const client = makeClient(db);
  const first = createAppointment(db, { contactId: client.id, apptType: 'Phone Call', apptDatetime: '2026-11-07T11:00' });
  db.prepare("UPDATE appointments SET status = 'Cancelled' WHERE id = ?").run(first.appointment.id);

  const second = createAppointment(db, { contactId: client.id, apptType: 'Phone Call', apptDatetime: '2026-11-07T11:00' });
  assert.equal(second.outcome, 'created');
  assert.notEqual(second.appointment.id, first.appointment.id);
});

test('findDuplicateAppointment: returns undefined when nothing matches', () => {
  const db = setup();
  const client = makeClient(db);
  assert.equal(findDuplicateAppointment(db, { contactId: client.id, apptDatetime: '2026-11-08T11:00' }), undefined);
});
