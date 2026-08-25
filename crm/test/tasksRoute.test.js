// Tests for crm/routes/tasks.js — the LEGACY /api/tasks route used by the
// old interface (public/contact.html's "+ Add Task" button / saveTask()).
// This is what created task #15 without ever triggering Google Calendar
// sync: crm/routes/crmActions.js's /api/app/tasks route was wired with
// taskCalendarSync in an earlier change, but this older, separate route
// (a completely independent Express router, mounted at /api/tasks, that
// writes to follow_up_tasks with its own inline SQL) was never touched.
// This file proves the fix: POST/PATCH/DELETE here now call
// taskCalendarSync, and — just as important — that a Calendar sync
// failure NEVER blocks the underlying CRM task write.
//
// Requires the live crm/db/database.js module (this route imports it
// directly at module scope, by design — it predates the injectable-db
// pattern used elsewhere). To avoid ever touching data/crm.db, DB_PATH is
// pointed at an in-memory database BEFORE database.js is first required
// anywhere in this process.
//
// GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GOOGLE_CALENDAR_REFRESH_TOKEN are
// explicitly cleared for the duration of this file so
// taskCalendarSync.isConfigured() is deterministically false — every sync
// attempt then short-circuits to a 'failed' (or 'not_applicable') status
// WITHOUT ever constructing a real Google client or making a network call.
// This is the same "unconfigured" branch a production deploy would hit if
// credentials were ever missing, and it's sufficient to prove the wiring:
// the full create/update/complete/reopen/archive mechanics against a real
// (mocked) Calendar client are already exhaustively covered by
// crm/test/taskCalendarSync.test.js and are unchanged by this fix.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const savedEnv = {};
for (const k of ['DB_PATH', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GOOGLE_CALENDAR_REFRESH_TOKEN']) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}
process.env.DB_PATH = ':memory:';

const db = require('../db/database');
const tasksRouter = require('../routes/tasks');

let server, baseUrl, contactId;

before(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/tasks`;

  contactId = db.prepare(
    `INSERT INTO contacts (first_name, last_name) VALUES ('Test', 'Caller')`
  ).run().lastInsertRowid;
});

after(() => {
  server.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function taskRow(id) {
  return db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(id);
}

test('POST / (create, eligible: has due_date AND due_time) -> 201, task saved, sync attempted (calendar_sync_status no longer null)', async () => {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contact_id: contactId, task_type: 'Call', due_date: '2026-08-25', due_time: '10:30', notes: 'Google Calendar sync test',
    }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.due_date, '2026-08-25');
  assert.equal(body.due_time, '10:30');
  assert.equal(body.notes, 'Google Calendar sync test');

  // This is the exact regression from task #15: previously calendar_event_id
  // and calendar_sync_status stayed NULL forever because syncTaskToCalendar
  // was never called at all. Now, even with Calendar unconfigured, the
  // status column proves the route DID invoke the sync module.
  assert.equal(body.calendar_sync_status, 'failed', 'sync was attempted and safely failed (no credentials in test env), not silently skipped');
  assert.equal(body.calendar_event_id, null, 'no real event id without a real Calendar client');

  const row = taskRow(body.id);
  assert.equal(row.calendar_sync_status, 'failed');
});

test('POST / (create, ineligible: due_date only, no due_time) -> 201, task saved, sync marks not_applicable', async () => {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, task_type: 'Call', due_date: '2026-09-01' }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.due_time, null);
  assert.equal(body.calendar_sync_status, 'not_applicable', 'a date-only task must never attempt a real sync, per the approved eligibility rule');
});

test('a Calendar sync failure never blocks task creation (CRM save always wins)', async () => {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, task_type: 'Call', due_date: '2026-08-26', due_time: '09:00' }),
  });
  assert.equal(res.status, 201, 'the task must still save successfully even though Calendar sync cannot succeed in this test environment');
  const body = await res.json();
  assert.ok(Number.isInteger(body.id));
  assert.equal(taskRow(body.id).status, 'Pending');
});

test('PATCH /:id (edit/reschedule) -> 200, due_date/due_time updated, sync re-attempted', async () => {
  const created = await (await fetch(baseUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, task_type: 'Call', due_date: '2026-08-25', due_time: '10:30' }),
  })).json();

  const res = await fetch(`${baseUrl}/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ due_date: '2026-08-27', due_time: '15:00' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.due_date, '2026-08-27');
  assert.equal(body.due_time, '15:00');
  assert.equal(body.calendar_sync_status, 'failed', 'reschedule must re-attempt sync, not leave the previous status stale');
});

test('PATCH /:id status=Completed (complete) -> 200, completed_at set, sync re-attempted', async () => {
  const created = await (await fetch(baseUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, task_type: 'Call', due_date: '2026-08-25', due_time: '10:30' }),
  })).json();

  const res = await fetch(`${baseUrl}/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'Completed' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'Completed');
  assert.ok(body.completed_at, 'completed_at must be stamped, exactly as before this fix');
  assert.equal(body.calendar_sync_status, 'failed', 'completing a task must also re-attempt sync');
});

test('PATCH /:id status=Pending (reopen) -> 200, completed_at cleared, sync re-attempted', async () => {
  const created = await (await fetch(baseUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, task_type: 'Call', due_date: '2026-08-25', due_time: '10:30' }),
  })).json();
  await fetch(`${baseUrl}/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Completed' }),
  });

  const res = await fetch(`${baseUrl}/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Pending' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'Pending');
  assert.equal(body.completed_at, null, 'reopen must clear completed_at, exactly as before this fix');
  assert.equal(body.calendar_sync_status, 'failed', 'reopening a task must also re-attempt sync');
});

test('DELETE /:id (hard delete, no prior calendar_event_id) -> removeCalendarEvent invoked (no-op/not_applicable, no network call) before the row is removed', async () => {
  const created = await (await fetch(baseUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, task_type: 'Call', due_date: '2026-08-28' }),
  })).json();
  assert.ok(taskRow(created.id), 'sanity check: task exists before delete');

  const res = await fetch(`${baseUrl}/${created.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true });
  assert.equal(taskRow(created.id), undefined, 'the row must be hard-deleted, exactly as before this fix');
});

test('DELETE /:id on a non-existent task still returns 404 (unrelated legacy behavior preserved)', async () => {
  const res = await fetch(`${baseUrl}/999999`, { method: 'DELETE' });
  assert.equal(res.status, 404);
});

test('POST / with a missing contact_id still returns 400 (unrelated legacy validation preserved)', async () => {
  const res = await fetch(baseUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_type: 'Call', due_date: '2026-08-25' }),
  });
  assert.equal(res.status, 400);
});
