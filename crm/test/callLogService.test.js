// Tests for crm/lib/callLogService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { logCall, CALL_OUTCOMES } = require('../lib/callLogService');
const { createClient } = require('../lib/clientService');
const { createCaseForClient } = require('../lib/caseService');

function setup() {
  const db = createLegacyDb();
  const { prosperityId } = runMigrations(db);
  runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db); runRevenueMvpMigrations(db);
  return { db, prosperityId };
}
function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

test('logCall attaches a call log to the correct client', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Rosa', lastName: 'Lin', phone: '4145551201', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const { call } = logCall(db, {
    contactId: client.contact.id, direction: 'outbound', date: '2026-08-20', startTime: '14:00',
    durationMinutes: 8, outcome: 'Spoke with client', summary: 'Discussed policy options', detailedNotes: 'Client wants a follow-up quote.',
  }, 'Loretta Stewart');
  assert.equal(call.contact_id, client.contact.id);
  assert.equal(call.outcome, 'Spoke with client');
  assert.equal(call.direction, 'outbound');
  assert.equal(call.duration_sec, 480);
  assert.equal(call.manual_entry, 1);
});

test('logCall rejects an outcome not in the fixed list', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Ora', lastName: 'Diaz', phone: '4145551202', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => logCall(db, { contactId: client.contact.id, direction: 'outbound', date: '2026-08-20', outcome: 'Chatted amicably' }, 'Loretta Stewart'), /outcome/);
});

test('every required outcome value is accepted', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Theo', lastName: 'Nash', phone: '4145551203', brandSlug: 'prosperity' }, 'Loretta Stewart');
  for (const outcome of CALL_OUTCOMES) {
    assert.doesNotThrow(() => logCall(db, { contactId: client.contact.id, direction: 'inbound', date: '2026-08-20', outcome }, 'Loretta Stewart'));
  }
});

test('a call log with a next action and due date creates a real follow-up task attached to the same client', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Uma', lastName: 'Ferro', phone: '4145551204', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const kase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const { call, followUpTask } = logCall(db, {
    contactId: client.contact.id, caseId: kase.id, direction: 'outbound', date: '2026-08-20', outcome: 'Follow-up needed',
    nextAction: 'Send updated illustration', nextActionDueDate: '2026-08-25', nextActionDueTime: '10:30',
  }, 'Loretta Stewart');
  assert.ok(followUpTask);
  assert.equal(followUpTask.contact_id, client.contact.id);
  assert.equal(followUpTask.case_id, kase.id);
  assert.equal(followUpTask.due_date, '2026-08-25');
  assert.equal(followUpTask.due_time, '10:30');
  assert.equal(followUpTask.status, 'Pending');
  assert.equal(call.follow_up_task_id, followUpTask.id);
});

test('a call log without a next action creates no follow-up task', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Vince', lastName: 'Ott', phone: '4145551205', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const { followUpTask } = logCall(db, { contactId: client.contact.id, direction: 'outbound', date: '2026-08-20', outcome: 'No answer' }, 'Loretta Stewart');
  assert.equal(followUpTask, null);
});

test('logging one client\'s call never affects another client\'s tasks', () => {
  const { db } = setup();
  const a = createClient(db, { firstName: 'Wendy', lastName: 'Poe', phone: '4145551206', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const b = createClient(db, { firstName: 'Xavier', lastName: 'Reid', phone: '4145551207', brandSlug: 'prosperity' }, 'Loretta Stewart');
  logCall(db, { contactId: a.contact.id, direction: 'outbound', date: '2026-08-20', outcome: 'Follow-up needed', nextAction: 'Call back', nextActionDueDate: '2026-08-22' }, 'Loretta Stewart');
  const bTasks = db.prepare('SELECT * FROM follow_up_tasks WHERE contact_id = ?').all(b.contact.id);
  assert.equal(bTasks.length, 0);
});
