// Client activity timeline (Add Activity) and notes. Every function takes
// an explicit better-sqlite3 `db` handle — never opens a connection itself,
// never imports crm/db/database.js.
//
// activity_type: note | call | text | email | appointment | follow_up |
//   document_received | policy_update | general
//
// Edits are never destructive: editActivity() writes the PREVIOUS
// summary/details into activity_edits before applying the change, so the
// audit trail is append-only. archiveActivity() is the only removal path —
// there is no permanent-delete function in this module.

const ACTIVITY_TYPES = ['note', 'call', 'text', 'email', 'appointment', 'follow_up', 'document_received', 'policy_update', 'general'];
const { toStringOrNull } = require('./leadNormalize');

function contactBrandIdFor(db, contactId) {
  const link = db.prepare(`SELECT id FROM contact_brands WHERE contact_id = ? AND status = 'Active'`).get(contactId);
  return link ? link.id : null;
}

function addActivity(db, fields, actor) {
  if (!actor) throw new Error('addActivity: actor (created_by) is required');
  if (!fields.contactId) throw new Error('addActivity: contactId is required');
  if (!ACTIVITY_TYPES.includes(fields.activityType)) {
    throw new Error(`addActivity: unknown activityType '${fields.activityType}' — must be one of ${ACTIVITY_TYPES.join(', ')}`);
  }
  const result = db.prepare(`
    INSERT INTO activities (contact_id, contact_brand_id, case_id, activity_type, activity_at, summary, details, next_action, next_action_due_date, created_by)
    VALUES (@contact_id, @contact_brand_id, @case_id, @activity_type, COALESCE(@activity_at, CURRENT_TIMESTAMP), @summary, @details, @next_action, @next_action_due_date, @created_by)
  `).run({
    contact_id: fields.contactId,
    contact_brand_id: contactBrandIdFor(db, fields.contactId),
    case_id: fields.caseId || null,
    activity_type: fields.activityType,
    activity_at: fields.activityAt || null,
    summary: toStringOrNull(fields.summary),
    details: toStringOrNull(fields.details),
    next_action: toStringOrNull(fields.nextAction),
    next_action_due_date: toStringOrNull(fields.nextActionDueDate),
    created_by: actor,
  });
  const activity = db.prepare('SELECT * FROM activities WHERE id = ?').get(result.lastInsertRowid);
  // Follow-through: an activity with a next action + due date creates a
  // real pending task, so it surfaces on the Dashboard/Tasks screen instead
  // of being buried in the timeline.
  let followUpTaskId = null;
  if (fields.nextAction && fields.nextActionDueDate) {
    const taskResult = db.prepare(`
      INSERT INTO follow_up_tasks (contact_id, case_id, task_type, due_date, notes, priority, status)
      VALUES (?, ?, 'Follow-up', ?, ?, 'Medium', 'Pending')
    `).run(fields.contactId, fields.caseId || null, fields.nextActionDueDate, fields.nextAction);
    followUpTaskId = taskResult.lastInsertRowid;
  }
  // Additive only -- every existing field on `activity` is unchanged, so
  // this is backward compatible with any caller that only reads the
  // activity's own fields. followUpTaskId lets the route layer trigger
  // calendar sync (crm/lib/taskCalendarSync.js) without a second query.
  return { ...activity, followUpTaskId };
}

function editActivity(db, activityId, fields, actor) {
  if (!actor) throw new Error('editActivity: actor (edited_by) is required');
  const existing = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!existing) throw new Error(`editActivity: activity ${activityId} does not exist`);

  db.prepare(`
    INSERT INTO activity_edits (activity_id, previous_summary, previous_details, edited_by)
    VALUES (?, ?, ?, ?)
  `).run(activityId, existing.summary, existing.details, actor);

  db.prepare(`
    UPDATE activities SET
      summary               = COALESCE(@summary, summary),
      details                = COALESCE(@details, details),
      next_action            = COALESCE(@next_action, next_action),
      next_action_due_date   = COALESCE(@next_action_due_date, next_action_due_date),
      updated_at             = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    summary: toStringOrNull(fields.summary), details: toStringOrNull(fields.details),
    next_action: toStringOrNull(fields.nextAction), next_action_due_date: toStringOrNull(fields.nextActionDueDate),
    id: activityId,
  });
  return db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
}

function archiveActivity(db, activityId, actor) {
  if (!actor) throw new Error('archiveActivity: actor is required');
  const existing = db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
  if (!existing) throw new Error(`archiveActivity: activity ${activityId} does not exist`);
  db.prepare('UPDATE activities SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(activityId);
  return db.prepare('SELECT * FROM activities WHERE id = ?').get(activityId);
}

function listActivityHistory(db, activityId) {
  return db.prepare('SELECT * FROM activity_edits WHERE activity_id = ? ORDER BY edited_at ASC').all(activityId);
}

// ── Notes (thin convenience wrappers over activityType='note') ─────────────

function addNote(db, { contactId, body }, actor) {
  return addActivity(db, { contactId, activityType: 'note', summary: 'Note', details: body }, actor);
}

function editNote(db, activityId, { body }, actor) {
  return editActivity(db, activityId, { details: body }, actor);
}

module.exports = { ACTIVITY_TYPES, addActivity, editActivity, archiveActivity, listActivityHistory, addNote, editNote };
