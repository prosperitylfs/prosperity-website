// Tests for crm/lib/callLogService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { logCall, attachCallOutcome, CALL_OUTCOMES } = require('../lib/callLogService');
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

// ── attachCallOutcome (Revenue MVP: automatic call logging for CRM-placed
//    calls) — mirrors exactly what crm/routes/calls.js POST /outbound
//    inserts automatically when the CRM itself places a live call. ───────

function insertAutoLoggedCall(db, { contactId, contactBrandId }) {
  const result = db.prepare(`
    INSERT INTO comm_calls
      (contact_id, contact_name, contact_brand_id, direction, from_number, to_number, status, started_at, provider_call_uuid)
    VALUES (?, 'Auto Test', ?, 'outbound', '+14144411177', '+14145559999', 'initiated', '2026-08-24T10:00:00.000Z', 'CA_fake_test_sid')
  `).run(contactId, contactBrandId || null);
  return result.lastInsertRowid;
}

test('attachCallOutcome updates the EXISTING auto-logged call, never inserting a second row', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Yara', lastName: 'Solis', phone: '4145551208', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const link = db.prepare(`SELECT id FROM contact_brands WHERE contact_id = ?`).get(client.contact.id);
  const callId = insertAutoLoggedCall(db, { contactId: client.contact.id, contactBrandId: link.id });

  const before = db.prepare('SELECT COUNT(*) AS n FROM comm_calls WHERE contact_id = ?').get(client.contact.id).n;
  const { call } = attachCallOutcome(db, callId, { outcome: 'Spoke with client', summary: 'Went over options' }, 'Loretta Stewart');
  const after = db.prepare('SELECT COUNT(*) AS n FROM comm_calls WHERE contact_id = ?').get(client.contact.id).n;

  assert.equal(after, before, 'no new comm_calls row was created');
  assert.equal(call.id, callId);
  assert.equal(call.outcome, 'Spoke with client');
  assert.equal(call.summary, 'Went over options');
});

test('attachCallOutcome never overwrites direction, start time, or the Twilio Call SID that were captured automatically', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Zane', lastName: 'Ruiz', phone: '4145551209', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const callId = insertAutoLoggedCall(db, { contactId: client.contact.id });
  const { call } = attachCallOutcome(db, callId, { outcome: 'No answer' }, 'Loretta Stewart');
  assert.equal(call.direction, 'outbound');
  assert.equal(call.started_at, '2026-08-24T10:00:00.000Z');
  assert.equal(call.provider_call_uuid, 'CA_fake_test_sid');
});

test('attachCallOutcome sets the related case chosen from the client\'s actual open cases, not a fixed list', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Amara', lastName: 'Kim', phone: '4145551210', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const lifeCase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const rolloverCase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Rollovers and safe-money solutions') }, 'Loretta Stewart');
  const callId = insertAutoLoggedCall(db, { contactId: client.contact.id });

  const { call } = attachCallOutcome(db, callId, { outcome: 'Spoke with client', caseId: rolloverCase.id }, 'Loretta Stewart');
  assert.equal(call.case_id, rolloverCase.id);
  assert.notEqual(call.case_id, lifeCase.id);
});

test('attachCallOutcome with a next action and due date creates a follow-up task attached to the call\'s client', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Ben', lastName: 'Ito', phone: '4145551211', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const callId = insertAutoLoggedCall(db, { contactId: client.contact.id });
  const { call, followUpTask } = attachCallOutcome(db, callId, {
    outcome: 'Follow-up needed', nextAction: 'Send illustration', nextActionDueDate: '2026-09-01',
  }, 'Loretta Stewart');
  assert.ok(followUpTask);
  assert.equal(followUpTask.contact_id, client.contact.id);
  assert.equal(followUpTask.due_date, '2026-09-01');
  assert.equal(call.follow_up_task_id, followUpTask.id);
});

test('attachCallOutcome rejects an outcome not in the fixed list', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Cora', lastName: 'Diaz', phone: '4145551212', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const callId = insertAutoLoggedCall(db, { contactId: client.contact.id });
  assert.throws(() => attachCallOutcome(db, callId, { outcome: 'Had a nice chat' }, 'Loretta Stewart'), /outcome/);
});

test('attachCallOutcome throws for a call id that does not exist', () => {
  const { db } = setup();
  assert.throws(() => attachCallOutcome(db, 999999, { outcome: 'No answer' }, 'Loretta Stewart'), /does not exist/);
});

test('attachCallOutcome called twice on the same call updates it in place, still never creating a duplicate', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Drew', lastName: 'Voss', phone: '4145551213', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const callId = insertAutoLoggedCall(db, { contactId: client.contact.id });

  attachCallOutcome(db, callId, { outcome: 'No answer' }, 'Loretta Stewart');
  const { call } = attachCallOutcome(db, callId, { outcome: 'Spoke with client', summary: 'Reached them on retry' }, 'Loretta Stewart');

  const rows = db.prepare('SELECT * FROM comm_calls WHERE contact_id = ?').all(client.contact.id);
  assert.equal(rows.length, 1, 'still exactly one call record after two outcome edits');
  assert.equal(call.outcome, 'Spoke with client');
  assert.equal(call.summary, 'Reached them on retry');
});
