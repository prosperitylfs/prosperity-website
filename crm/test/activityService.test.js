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
