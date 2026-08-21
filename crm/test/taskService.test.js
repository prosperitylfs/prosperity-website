// Tests for crm/lib/taskService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createTask, updateTask, completeTask, reopenTask, archiveTask, listTasks } = require('../lib/taskService');
const { createClient } = require('../lib/clientService');
const { getDashboardSummary } = require('../lib/dashboardQueries');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  return db;
}
function isoDate(daysFromNow) {
  const d = new Date(); d.setDate(d.getDate() + daysFromNow); return d.toISOString().slice(0, 10);
}

test('completing one task never modifies another task, the client, or a case', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Ren', email: 'ren@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const t1 = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(0), notes: 'A' }, 'Loretta Stewart');
  const t2 = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(1), notes: 'B' }, 'Loretta Stewart');
  completeTask(db, t1.id, 'Loretta Stewart');
  const t1After = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(t1.id);
  const t2After = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(t2.id);
  assert.equal(t1After.status, 'Completed');
  assert.equal(t2After.status, 'Pending');
  const clientAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(clientAfter.archived_at, null);
});

test('reopen restores a completed task to Pending', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Sana', email: 'sana2@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const t = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(0) }, 'Loretta Stewart');
  completeTask(db, t.id, 'Loretta Stewart');
  const reopened = reopenTask(db, t.id, 'Loretta Stewart');
  assert.equal(reopened.status, 'Pending');
  assert.equal(reopened.completed_at, null);
});

test('archiving a task removes it from the default list without deleting the row', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Tariq', email: 'tariq@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const t = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(0) }, 'Loretta Stewart');
  archiveTask(db, t.id, 'Loretta Stewart');
  const stillExists = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(t.id);
  assert.ok(stillExists);
  assert.equal(stillExists.status, 'Archived');
  const all = listTasks(db, { filter: 'all' });
  assert.ok(!all.some(x => x.id === t.id));
});

test('listTasks filters: overdue, today, upcoming, completed', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Uma', email: 'uma2@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(-2), notes: 'overdue' }, 'Loretta Stewart');
  createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(0), notes: 'today' }, 'Loretta Stewart');
  const upcoming = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(5), notes: 'upcoming' }, 'Loretta Stewart');
  completeTask(db, upcoming.id, 'Loretta Stewart');
  // upcoming was completed above -- add a real pending upcoming one
  createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(5), notes: 'upcoming2' }, 'Loretta Stewart');

  assert.equal(listTasks(db, { filter: 'overdue' }).length, 1);
  assert.equal(listTasks(db, { filter: 'today' }).length, 1);
  assert.equal(listTasks(db, { filter: 'upcoming' }).length, 1);
  assert.equal(listTasks(db, { filter: 'completed' }).length, 1);
});

test("the Dashboard's overdue and due-today counts update from real task data", () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Vic', email: 'vic@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const before = getDashboardSummary(db, {});
  assert.equal(before.overdueTasks, 0);
  assert.equal(before.followUpsDue, 0);
  createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(-1) }, 'Loretta Stewart');
  createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(0) }, 'Loretta Stewart');
  const after = getDashboardSummary(db, {});
  assert.equal(after.overdueTasks, 1);
  assert.equal(after.followUpsDue, 1);
});

test('updateTask edits fields but never moves the task to a different client', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Wes', email: 'wes@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const t = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: isoDate(0) }, 'Loretta Stewart');
  const updated = updateTask(db, t.id, { notes: 'Updated notes', priority: 'High', contactId: 999999 });
  assert.equal(updated.notes, 'Updated notes');
  assert.equal(updated.priority, 'High');
  assert.equal(updated.contact_id, client.contact.id);
});
