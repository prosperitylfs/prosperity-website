// One-way sync: crm follow_up_tasks -> the shared "CRM Tasks & Follow-Ups"
// Google Calendar. The CRM database is always the system of record --
// every exported entry point (syncTaskToCalendar) catches its own errors
// internally and never throws/rejects, so a Calendar API problem (auth,
// network, quota) can NEVER prevent a task from being created, updated,
// completed, reopened, or archived. Callers invoke this AFTER their own
// task write has already committed, purely as a best-effort side effect.
//
// Deliberately independent of crm/routes/googleCalendarAuth.js (the OAuth
// SETUP flow for obtaining GOOGLE_CALENDAR_REFRESH_TOKEN in the first
// place) -- this module only ever uses an already-issued refresh token to
// make API calls. The redirect_uri that setup flow needs is irrelevant
// here. Keeping these separate means nothing in this file can ever risk
// the already-verified OAuth setup route, and vice versa.
//
// Brand is resolved FRESH from the contact's current active contact_brands
// row at sync time -- never trusted from follow_up_tasks.contact_brand_id,
// which (per the Revenue MVP task-system audit) is not reliably populated
// by every task-creation code path (crm/lib/taskService.js's createTask
// and crm/lib/activityService.js's addActivity both currently leave it
// NULL; only crm/lib/callLogService.js sets it). A task with no resolvable
// brand at all is skipped rather than guessed.

const { google } = require('googleapis');
const { BRANDS } = require('../config/brands');

// The "CRM Tasks & Follow-Ups" shared calendar (created manually in Google
// Calendar; same ID already verified working via
// crm/routes/googleCalendarAuth.js's /verify route). Not a secret -- a
// calendar ID is an address, not a credential.
const TASKS_CALENDAR_ID = 'c_15317c7b5e7d42313e006440677940859b268810ed008c2c6b69152bfe7c059e@group.calendar.google.com';

const BRAND_LABELS = {
  prosperity: '[PROSPERITY]',
  'insurance-lady': '[INSURANCE LADY]',
};

const TIMEZONE = 'America/Chicago'; // matches crm/routes/calcom.js's existing convention for this business

function isConfigured() {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET && process.env.GOOGLE_CALENDAR_REFRESH_TOKEN);
}

// deps.getCalendarClient lets tests inject a fully mocked calendar client
// object directly, bypassing process.env-based auth entirely -- this
// module's own tests never touch the real Google API or real credentials,
// mirroring the exact pattern already proven in
// crm/lib/providers/liveTwilioAdapter.js's deps.getTwilioClient.
function getCalendarClient() {
  const auth = new google.auth.OAuth2(process.env.GMAIL_CLIENT_ID, process.env.GMAIL_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

// Fresh lookup, not a stored/possibly-stale value -- see file header.
function resolveTaskBrand(db, contactId) {
  const row = db.prepare(`
    SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id
    WHERE cb.contact_id = ? AND cb.status = 'Active'
  `).get(contactId);
  return row ? row.slug : null;
}

// A task syncs only when it has BOTH a due date and a due time (approved
// rule) -- a date-only task has no natural single moment for a calendar
// reminder and is intentionally never synced.
function isEligible(task) {
  return !!(task.due_date && task.due_time);
}

// "[PROSPERITY] TASK: Send beneficiary change form — Mary Smith", or with
// the completed marker: "[PROSPERITY] ✓ COMPLETED: TASK: ...". Falls back
// to task_type if notes is empty (notes is usually the specific
// description; task_type is the more generic category).
function eventTitle(task, contactName, brandSlug) {
  const label = BRAND_LABELS[brandSlug] || '';
  const completedTag = task.status === 'Completed' ? '✓ COMPLETED: ' : '';
  const description = (task.notes && task.notes.trim()) || task.task_type || 'Task';
  const namePart = contactName ? ` — ${contactName}` : '';
  return [label, `${completedTag}TASK: ${description}${namePart}`].filter(Boolean).join(' ').trim();
}

// Pure date/time arithmetic using Date.UTC purely as a neutral calculator
// (never as an actual UTC-zoned instant) so day/month/year rollover (e.g.
// 23:50 + 30 minutes) is computed correctly regardless of the server
// process's own timezone. The resulting wall-clock numbers are paired with
// an explicit timeZone field so Google interprets them as this business's
// actual local time, not UTC.
function eventTimeRange(dueDate, dueTime, durationMinutes = 30) {
  const [year, month, day] = dueDate.split('-').map(Number);
  const [hour, minute] = dueTime.split(':').map(Number);
  const startMs = Date.UTC(year, month - 1, day, hour, minute);
  const endMs = startMs + durationMinutes * 60000;
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 19);
  return {
    start: { dateTime: fmt(startMs), timeZone: TIMEZONE },
    end:   { dateTime: fmt(endMs),   timeZone: TIMEZONE },
  };
}

function markStatus(db, taskId, status) {
  db.prepare('UPDATE follow_up_tasks SET calendar_sync_status = ? WHERE id = ?').run(status, taskId);
  return db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
}

// Removes the task's calendar event (if it has one) and clears the stored
// reference. Used for archived tasks and for a task that becomes
// ineligible after previously being synced (e.g. its due time was cleared
// on an edit). A 404/410 from Google (the event is already gone) is
// treated as success, not an error -- the goal is achieved either way.
async function removeCalendarEvent(db, task, deps = {}) {
  if (!task.calendar_event_id) {
    return { status: 'not_applicable', task: markStatus(db, task.id, 'not_applicable') };
  }
  try {
    const calendar = deps.getCalendarClient ? deps.getCalendarClient() : getCalendarClient();
    await calendar.events.delete({ calendarId: TASKS_CALENDAR_ID, eventId: task.calendar_event_id });
  } catch (err) {
    const alreadyGone = err && (err.code === 404 || err.code === 410);
    if (!alreadyGone) {
      console.warn(`[taskCalendarSync] delete failed for task ${task.id}: ${err.message}`);
    }
  }
  db.prepare('UPDATE follow_up_tasks SET calendar_event_id = NULL, calendar_sync_status = ? WHERE id = ?')
    .run('removed', task.id);
  return { status: 'removed', task: db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(task.id) };
}

// Main entry point. Reads the task's CURRENT state fresh from the db
// (never a caller-supplied snapshot, since this always runs after some
// other write already committed) and creates, updates, or removes its
// calendar event accordingly. Returns { status, task } where task is the
// task row's latest state (including any calendar_event_id/status this
// call set) -- NEVER throws or rejects, regardless of what goes wrong.
async function syncTaskToCalendar(db, taskId, deps = {}) {
  let task;
  try {
    task = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
    if (!task) return { status: 'not_applicable', task: null };

    if (task.status === 'Archived') {
      return await removeCalendarEvent(db, task, deps);
    }

    if (!isEligible(task)) {
      // Not (or no longer) eligible for a reminder. If it previously had
      // one (e.g. due_time was cleared on an edit), remove the stale event.
      if (task.calendar_event_id) return await removeCalendarEvent(db, task, deps);
      return { status: 'not_applicable', task: markStatus(db, taskId, 'not_applicable') };
    }

    if (!isConfigured() && !deps.getCalendarClient) {
      return { status: 'failed', task: markStatus(db, taskId, 'failed') };
    }

    const contact = db.prepare('SELECT first_name, last_name FROM contacts WHERE id = ?').get(task.contact_id);
    const contactName = contact ? [contact.first_name, contact.last_name].filter(Boolean).join(' ') : '';
    const brandSlug = resolveTaskBrand(db, task.contact_id);
    const title = eventTitle(task, contactName, brandSlug);
    const { start, end } = eventTimeRange(task.due_date, task.due_time);
    const eventBody = {
      summary: title,
      description: `CRM internal task reminder. Not a client appointment.${task.notes ? `\n\nNotes: ${task.notes}` : ''}`,
      start, end,
    };

    const calendar = deps.getCalendarClient ? deps.getCalendarClient() : getCalendarClient();

    if (task.calendar_event_id) {
      await calendar.events.update({ calendarId: TASKS_CALENDAR_ID, eventId: task.calendar_event_id, requestBody: eventBody });
      return { status: 'synced', task: markStatus(db, taskId, 'synced') };
    }

    const result = await calendar.events.insert({ calendarId: TASKS_CALENDAR_ID, requestBody: eventBody });
    db.prepare('UPDATE follow_up_tasks SET calendar_event_id = ?, calendar_sync_status = ? WHERE id = ?')
      .run(result.data.id, 'synced', taskId);
    return { status: 'synced', task: db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId) };
  } catch (err) {
    console.warn(`[taskCalendarSync] sync failed for task ${taskId}: ${err.message}`);
    try {
      return { status: 'failed', task: markStatus(db, taskId, 'failed'), error: err.message };
    } catch (_) {
      // Even the status-marking UPDATE failed (e.g. bad taskId) -- still
      // never throw; the caller's own task write already succeeded and
      // must not be affected by this module in any way.
      return { status: 'failed', task: task || null, error: err.message };
    }
  }
}

module.exports = {
  TASKS_CALENDAR_ID,
  BRAND_LABELS,
  isConfigured,
  getCalendarClient,
  resolveTaskBrand,
  isEligible,
  eventTitle,
  eventTimeRange,
  removeCalendarEvent,
  syncTaskToCalendar,
};
