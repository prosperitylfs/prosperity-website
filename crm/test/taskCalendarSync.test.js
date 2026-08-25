// Tests for crm/lib/taskCalendarSync.js. Every test injects a fully mocked
// Google Calendar client via deps.getCalendarClient -- the real
// 'googleapis' client is NEVER constructed or contacted, mirroring the
// exact pattern already proven in crm/test/liveTwilioAdapter.test.js. All
// data fake, in-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createClient } = require('../lib/clientService');
const { createTask, updateTask, completeTask, reopenTask, archiveTask } = require('../lib/taskService');
const {
  syncTaskToCalendar, eventTitle, eventTimeRange, isEligible, resolveTaskBrand, TASKS_CALENDAR_ID,
} = require('../lib/taskCalendarSync');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

function mockCalendar({ throwOn } = {}) {
  const calls = { insert: [], update: [], delete: [] };
  let nextId = 1;
  const client = {
    events: {
      insert: async (params) => {
        if (throwOn === 'insert') throw Object.assign(new Error('Simulated Calendar API failure'), { code: 500 });
        calls.insert.push(params);
        return { data: { id: `evt_${nextId++}` } };
      },
      update: async (params) => {
        if (throwOn === 'update') throw Object.assign(new Error('Simulated Calendar API failure'), { code: 500 });
        calls.update.push(params);
        return { data: { id: params.eventId } };
      },
      delete: async (params) => {
        if (throwOn === 'delete') throw Object.assign(new Error('Simulated Calendar API failure'), { code: 500 });
        calls.delete.push(params);
        return {};
      },
    },
  };
  return { calls, deps: { getCalendarClient: () => client } };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

test('isEligible requires BOTH due_date and due_time', () => {
  assert.equal(isEligible({ due_date: '2026-08-24', due_time: '14:30' }), true);
  assert.equal(isEligible({ due_date: '2026-08-24', due_time: null }), false);
  assert.equal(isEligible({ due_date: null, due_time: '14:30' }), false);
  assert.equal(isEligible({ due_date: null, due_time: null }), false);
});

test('eventTitle: Prosperity branding', () => {
  const title = eventTitle({ status: 'Pending', notes: 'Call about renewal', task_type: 'Call' }, 'Janet Jackson', 'prosperity');
  assert.match(title, /^\[PROSPERITY\]/);
  assert.match(title, /TASK: Call about renewal — Janet Jackson/);
});

test('eventTitle: Insurance Lady branding', () => {
  const title = eventTitle({ status: 'Pending', notes: 'Send policy docs', task_type: 'Follow-up' }, 'Mary Smith', 'insurance-lady');
  assert.match(title, /^\[INSURANCE LADY\]/);
  assert.match(title, /TASK: Send policy docs — Mary Smith/);
});

test('eventTitle: completed tasks get the checkmark marker, active tasks do not', () => {
  const active = eventTitle({ status: 'Pending', notes: 'Call back', task_type: 'Call' }, 'Amy Chen', 'prosperity');
  const completed = eventTitle({ status: 'Completed', notes: 'Call back', task_type: 'Call' }, 'Amy Chen', 'prosperity');
  assert.doesNotMatch(active, /COMPLETED/);
  assert.match(completed, /✓ COMPLETED: TASK: Call back/);
});

test('eventTimeRange handles ordinary times correctly', () => {
  const { start, end } = eventTimeRange('2026-08-24', '14:30', 30);
  assert.equal(start.dateTime, '2026-08-24T14:30:00');
  assert.equal(end.dateTime, '2026-08-24T15:00:00');
  assert.equal(start.timeZone, 'America/Chicago');
});

test('eventTimeRange correctly rolls over to the next day near midnight', () => {
  const { start, end } = eventTimeRange('2026-08-24', '23:50', 30);
  assert.equal(start.dateTime, '2026-08-24T23:50:00');
  assert.equal(end.dateTime, '2026-08-25T00:20:00');
});

test('resolveTaskBrand returns null when the contact has no active brand relationship', () => {
  const { db } = setup();
  assert.equal(resolveTaskBrand(db, 999999), null);
});

// ── Integration: syncTaskToCalendar against a mocked client ────────────────

test('a new task WITH both due date and due time creates exactly one calendar event', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Janet', lastName: 'Jackson', phone: '4145551301', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '14:30', notes: 'Call Janet Jackson' }, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  const result = await syncTaskToCalendar(db, task.id, deps);

  assert.equal(result.status, 'synced');
  assert.equal(calls.insert.length, 1);
  assert.equal(calls.insert[0].calendarId, TASKS_CALENDAR_ID);
  assert.match(calls.insert[0].requestBody.summary, /\[PROSPERITY\] TASK: Call Janet Jackson/);
  const stored = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(task.id);
  assert.equal(stored.calendar_event_id, 'evt_1');
  assert.equal(stored.calendar_sync_status, 'synced');
});

test('a task with a due date but NO due time is never synced', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Louis', lastName: 'Williams', phone: '4145551302', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24', notes: 'Follow up' }, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  const result = await syncTaskToCalendar(db, task.id, deps);

  assert.equal(result.status, 'not_applicable');
  assert.equal(calls.insert.length, 0);
  const stored = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(task.id);
  assert.equal(stored.calendar_event_id, null);
});

test('editing/rescheduling an already-synced task updates the SAME event, never creates a second one', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Peggy', lastName: 'Johnson', phone: '4145551303', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '14:30' }, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  const first = await syncTaskToCalendar(db, task.id, deps);
  updateTask(db, task.id, { dueDate: '2026-08-26', dueTime: '09:00' });
  const second = await syncTaskToCalendar(db, task.id, deps);

  assert.equal(calls.insert.length, 1, 'only ever inserted once');
  assert.equal(calls.update.length, 1, 'the reschedule is an update');
  assert.equal(calls.update[0].eventId, first.task.calendar_event_id);
  assert.equal(calls.update[0].requestBody.start.dateTime, '2026-08-26T09:00:00');
  assert.equal(second.task.calendar_event_id, first.task.calendar_event_id, 'same event ID preserved');
});

test('duplicate prevention: syncing an unchanged eligible task twice never creates a second event', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Lawrence', lastName: 'Doe', phone: '4145551304', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '14:30' }, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  await syncTaskToCalendar(db, task.id, deps);
  await syncTaskToCalendar(db, task.id, deps);
  await syncTaskToCalendar(db, task.id, deps);

  assert.equal(calls.insert.length, 1);
  assert.equal(calls.update.length, 2);
});

test('completing a task keeps the SAME event, marks it done, and preserves the original scheduled time', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Belinda', lastName: 'Brooks', phone: '4145551305', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '14:30', notes: 'Renewal call' }, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  const created = await syncTaskToCalendar(db, task.id, deps);
  completeTask(db, task.id, 'Loretta Stewart');
  const afterComplete = await syncTaskToCalendar(db, task.id, deps);

  assert.equal(calls.insert.length, 1, 'no new event created on completion');
  assert.equal(calls.delete.length, 0, 'the event is never deleted on completion');
  assert.equal(afterComplete.task.calendar_event_id, created.task.calendar_event_id, 'same event');
  assert.match(calls.update[0].requestBody.summary, /✓ COMPLETED: TASK: Renewal call/);
  assert.equal(calls.update[0].requestBody.start.dateTime, '2026-08-24T14:30:00', 'original scheduled time preserved');
});

test('reopening a completed task restores the active title on the SAME event', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Nora', lastName: 'Alston', phone: '4145551306', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '14:30', notes: 'Callback' }, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  const created = await syncTaskToCalendar(db, task.id, deps);
  completeTask(db, task.id, 'Loretta Stewart');
  await syncTaskToCalendar(db, task.id, deps);
  reopenTask(db, task.id, 'Loretta Stewart');
  const afterReopen = await syncTaskToCalendar(db, task.id, deps);

  assert.equal(calls.insert.length, 1, 'still the one original event');
  assert.equal(afterReopen.task.calendar_event_id, created.task.calendar_event_id);
  const lastUpdate = calls.update[calls.update.length - 1];
  assert.doesNotMatch(lastUpdate.requestBody.summary, /COMPLETED/, 'checkmark removed on reopen');
  assert.match(lastUpdate.requestBody.summary, /TASK: Callback/);
});

test('archiving a task removes its calendar event and clears the stored reference', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Otis', lastName: 'Reed', phone: '4145551307', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '14:30' }, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  await syncTaskToCalendar(db, task.id, deps);
  archiveTask(db, task.id, 'Loretta Stewart');
  const result = await syncTaskToCalendar(db, task.id, deps);

  assert.equal(result.status, 'removed');
  assert.equal(calls.delete.length, 1);
  assert.equal(calls.delete[0].eventId, 'evt_1');
  assert.equal(result.task.calendar_event_id, null);
  assert.equal(result.task.calendar_sync_status, 'removed');
});

test('archiving a task that was never eligible (no event ever created) is a safe no-op', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Pia', lastName: 'Nunez', phone: '4145551308', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24' }, 'Loretta Stewart'); // no due_time
  archiveTask(db, task.id, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  const result = await syncTaskToCalendar(db, task.id, deps);
  assert.equal(calls.delete.length, 0);
  assert.equal(result.status, 'not_applicable');
});

test('a Google Calendar API failure on create never throws, and the CRM task remains fully intact', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Quentin', lastName: 'Ford', phone: '4145551309', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '14:30', notes: 'Important call' }, 'Loretta Stewart');

  const { deps } = mockCalendar({ throwOn: 'insert' });
  let result;
  await assert.doesNotReject(async () => { result = await syncTaskToCalendar(db, task.id, deps); });

  assert.equal(result.status, 'failed');
  const stored = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(task.id);
  assert.equal(stored.calendar_sync_status, 'failed');
  assert.equal(stored.calendar_event_id, null);
  // The CRM task itself is completely unaffected by the calendar failure.
  assert.equal(stored.contact_id, client.contact.id);
  assert.equal(stored.due_date, '2026-08-24');
  assert.equal(stored.due_time, '14:30');
  assert.equal(stored.notes, 'Important call');
  assert.equal(stored.status, 'Pending');
});

test('a Google Calendar API failure on update never throws and never loses the previously-stored event ID', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Rosa', lastName: 'Klein', phone: '4145551310', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const task = createTask(db, { contactId: client.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '14:30' }, 'Loretta Stewart');

  const ok = mockCalendar();
  const created = await syncTaskToCalendar(db, task.id, ok.deps);

  updateTask(db, task.id, { dueTime: '15:00' });
  const failing = mockCalendar({ throwOn: 'update' });
  let result;
  await assert.doesNotReject(async () => { result = await syncTaskToCalendar(db, task.id, failing.deps); });

  assert.equal(result.status, 'failed');
  const stored = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(task.id);
  assert.equal(stored.calendar_event_id, created.task.calendar_event_id, 'the known-good event ID is not discarded on a failed update');
});

test('Prosperity and Insurance Lady tasks land on the SAME shared calendar with their own brand label', async () => {
  const { db, insuranceLadyId } = setup();
  const prClient = createClient(db, { firstName: 'John', lastName: 'Doe', phone: '4145551311', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const ilClient = createClient(db, { firstName: 'Mary', lastName: 'Smith', phone: '4145551312', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  const prTask = createTask(db, { contactId: prClient.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '10:00', notes: 'Prosperity task' }, 'Loretta Stewart');
  const ilTask = createTask(db, { contactId: ilClient.contact.id, taskType: 'Call', dueDate: '2026-08-24', dueTime: '11:00', notes: 'IL task' }, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  await syncTaskToCalendar(db, prTask.id, deps);
  await syncTaskToCalendar(db, ilTask.id, deps);

  assert.equal(calls.insert.length, 2);
  assert.equal(calls.insert[0].calendarId, TASKS_CALENDAR_ID);
  assert.equal(calls.insert[1].calendarId, TASKS_CALENDAR_ID);
  assert.match(calls.insert[0].requestBody.summary, /^\[PROSPERITY\]/);
  assert.match(calls.insert[1].requestBody.summary, /^\[INSURANCE LADY\]/);
});

test('a task for a contact with no resolvable brand still syncs, with no brand label rather than a guess', async () => {
  const { db } = setup();
  // A contact created directly with no contact_brands row at all -- not a
  // normal path through the app, but exercises the "no brand resolvable"
  // case explicitly rather than assuming it can't happen.
  const contactId = db.prepare(`INSERT INTO contacts (first_name, last_name, phone, phone_e164) VALUES ('No', 'Brand', '414-555-1313', '+14145551313')`).run().lastInsertRowid;
  const task = createTask(db, { contactId, taskType: 'Call', dueDate: '2026-08-24', dueTime: '10:00', notes: 'Unbranded' }, 'Loretta Stewart');

  const { calls, deps } = mockCalendar();
  const result = await syncTaskToCalendar(db, task.id, deps);

  assert.equal(result.status, 'synced', 'still syncs -- brand is only used for the label, never a hard requirement');
  assert.doesNotMatch(calls.insert[0].requestBody.summary, /\[PROSPERITY\]|\[INSURANCE LADY\]/);
});
