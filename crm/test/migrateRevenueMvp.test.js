// Tests for crm/db/migrateRevenueMvp.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  return db;
}

test('is safe to run twice against the same db (idempotent)', () => {
  const db = setup();
  assert.doesNotThrow(() => { runRevenueMvpMigrations(db); runRevenueMvpMigrations(db); });
});

test('adds contacts.sms_opted_out_at, nullable, defaulting to NULL', () => {
  const db = setup();
  runRevenueMvpMigrations(db);
  db.prepare('INSERT INTO contacts (first_name) VALUES (?)').run('Test');
  const row = db.prepare('SELECT sms_opted_out_at FROM contacts ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.sms_opted_out_at, null);
});

test('adds comm_calls.outcome/summary/manual_entry/follow_up_task_id', () => {
  const db = setup();
  runRevenueMvpMigrations(db);
  const result = db.prepare(`
    INSERT INTO comm_calls (contact_id, direction, outcome, summary, manual_entry) VALUES (NULL, 'outbound', 'No answer', 'test', 1)
  `).run();
  const row = db.prepare('SELECT * FROM comm_calls WHERE id = ?').get(result.lastInsertRowid);
  assert.equal(row.outcome, 'No answer');
  assert.equal(row.manual_entry, 1);
  assert.equal(row.follow_up_task_id, null);
});

test('adds sms_messages.failure_reason and the twilio_sid unique index (idempotent insert-or-ignore works)', () => {
  const db = setup();
  runRevenueMvpMigrations(db);
  db.prepare(`INSERT INTO sms_messages (direction, body, twilio_sid) VALUES ('inbound', 'hi', 'SM_DUP_TEST')`).run();
  const ignored = db.prepare(`INSERT OR IGNORE INTO sms_messages (direction, body, twilio_sid) VALUES ('inbound', 'hi again', 'SM_DUP_TEST')`).run();
  assert.equal(ignored.changes, 0, 'duplicate twilio_sid must be ignored, not inserted twice');
  const count = db.prepare(`SELECT COUNT(*) AS n FROM sms_messages WHERE twilio_sid = 'SM_DUP_TEST'`).get().n;
  assert.equal(count, 1);
});
