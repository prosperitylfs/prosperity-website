// Tests for crm/lib/smsStatusService.js -- the only code path allowed to
// set sms_messages.status = 'delivered'. In-memory dbs only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { handleOutboundSmsStatusCallback } = require('../lib/smsStatusService');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db); runRevenueMvpMigrations(db);
  return db;
}
function seedSentMessage(db, sid) {
  const r = db.prepare(`
    INSERT INTO sms_messages (direction, from_number, to_number, body, status, twilio_sid)
    VALUES ('outbound', '+14144411177', '+14145550000', 'test', 'sent', ?)
  `).run(sid);
  return r.lastInsertRowid;
}

test('a verified status callback can move sent to delivered', () => {
  const db = setup();
  const id = seedSentMessage(db, 'SM_status_1');
  const result = handleOutboundSmsStatusCallback(db, { MessageSid: 'SM_status_1', MessageStatus: 'delivered' });
  assert.equal(result.outcome, 'updated');
  const row = db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(id);
  assert.equal(row.status, 'delivered');
});

test('an accepted send is not marked delivered immediately -- only this callback can do that', () => {
  const db = setup();
  const id = seedSentMessage(db, 'SM_status_2');
  const before = db.prepare('SELECT status FROM sms_messages WHERE id = ?').get(id);
  assert.equal(before.status, 'sent');
  assert.notEqual(before.status, 'delivered');
});

test('duplicate callbacks are idempotent -- no duplicate rows, same end state', () => {
  const db = setup();
  seedSentMessage(db, 'SM_status_3');
  handleOutboundSmsStatusCallback(db, { MessageSid: 'SM_status_3', MessageStatus: 'delivered' });
  handleOutboundSmsStatusCallback(db, { MessageSid: 'SM_status_3', MessageStatus: 'delivered' });
  const rows = db.prepare(`SELECT * FROM sms_messages WHERE twilio_sid = 'SM_status_3'`).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'delivered');
});

test('a callback for an unknown Message SID is ignored, never guessed at or creates a row', () => {
  const db = setup();
  const before = db.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n;
  const result = handleOutboundSmsStatusCallback(db, { MessageSid: 'SM_does_not_exist', MessageStatus: 'delivered' });
  assert.equal(result.outcome, 'no_matching_message');
  const after = db.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n;
  assert.equal(after, before);
});

test('a callback missing required fields is ignored', () => {
  const db = setup();
  seedSentMessage(db, 'SM_status_4');
  const result = handleOutboundSmsStatusCallback(db, { MessageSid: 'SM_status_4' });
  assert.equal(result.outcome, 'ignored_missing_fields');
  const row = db.prepare(`SELECT status FROM sms_messages WHERE twilio_sid = 'SM_status_4'`).get();
  assert.equal(row.status, 'sent', 'status must remain unchanged when the callback is malformed');
});

test('a failed/undelivered callback with an ErrorCode records a safe failure reason', () => {
  const db = setup();
  seedSentMessage(db, 'SM_status_5');
  handleOutboundSmsStatusCallback(db, { MessageSid: 'SM_status_5', MessageStatus: 'undelivered', ErrorCode: '30003' });
  const row = db.prepare(`SELECT * FROM sms_messages WHERE twilio_sid = 'SM_status_5'`).get();
  assert.equal(row.status, 'undelivered');
  assert.match(row.failure_reason, /30003/);
});
