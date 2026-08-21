// Task create/edit/complete/reopen/archive for the redesigned CRM. Every
// function takes an explicit better-sqlite3 `db` handle — never opens a
// connection itself, never imports crm/db/database.js.
//
// Every mutation here touches exactly the one follow_up_tasks row it's
// given — completing or archiving one task never updates the client, case,
// or any other task.

const { toStringOrNull } = require('./leadNormalize');

function createTask(db, fields, actor) {
  if (!actor) throw new Error('createTask: actor is required for the audit trail');
  if (!fields.contactId) throw new Error('createTask: contactId is required');
  if (!fields.dueDate) throw new Error('createTask: dueDate is required');
  if (!fields.taskType) throw new Error('createTask: taskType is required');
  const result = db.prepare(`
    INSERT INTO follow_up_tasks (contact_id, case_id, task_type, due_date, due_time, notes, priority, status)
    VALUES (@contact_id, @case_id, @task_type, @due_date, @due_time, @notes, @priority, 'Pending')
  `).run({
    contact_id: fields.contactId, case_id: fields.caseId || null,
    task_type: fields.taskType, due_date: fields.dueDate, due_time: fields.dueTime || null,
    notes: toStringOrNull(fields.notes), priority: fields.priority || 'Medium',
  });
  return db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(result.lastInsertRowid);
}

// case_id can only be added/changed here (associating a task with a case);
// contact_id is never editable -- a task cannot be moved to a different
// client.
function updateTask(db, taskId, fields) {
  const existing = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
  if (!existing) throw new Error(`updateTask: task ${taskId} does not exist`);
  db.prepare(`
    UPDATE follow_up_tasks SET
      case_id   = COALESCE(@case_id, case_id),
      task_type = COALESCE(@task_type, task_type),
      due_date  = COALESCE(@due_date, due_date),
      due_time  = COALESCE(@due_time, due_time),
      notes     = COALESCE(@notes, notes),
      priority  = COALESCE(@priority, priority)
    WHERE id = @id
  `).run({
    case_id: fields.caseId || null, task_type: fields.taskType || null,
    due_date: fields.dueDate || null, due_time: fields.dueTime || null,
    notes: toStringOrNull(fields.notes), priority: fields.priority || null, id: taskId,
  });
  return db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
}

function completeTask(db, taskId, actor) {
  if (!actor) throw new Error('completeTask: actor is required');
  const existing = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
  if (!existing) throw new Error(`completeTask: task ${taskId} does not exist`);
  db.prepare("UPDATE follow_up_tasks SET status = 'Completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?").run(taskId);
  return db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
}

function reopenTask(db, taskId, actor) {
  if (!actor) throw new Error('reopenTask: actor is required');
  const existing = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
  if (!existing) throw new Error(`reopenTask: task ${taskId} does not exist`);
  db.prepare("UPDATE follow_up_tasks SET status = 'Pending', completed_at = NULL WHERE id = ?").run(taskId);
  return db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
}

function archiveTask(db, taskId, actor) {
  if (!actor) throw new Error('archiveTask: actor is required');
  const existing = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
  if (!existing) throw new Error(`archiveTask: task ${taskId} does not exist`);
  db.prepare("UPDATE follow_up_tasks SET status = 'Archived' WHERE id = ?").run(taskId);
  return db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(taskId);
}

// due|today|upcoming|completed|all
function listTasks(db, { filter = 'all', limit = 200 } = {}) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const base = `SELECT t.*, ct.first_name, ct.last_name FROM follow_up_tasks t JOIN contacts ct ON ct.id = t.contact_id`;
  const queries = {
    overdue:   `${base} WHERE t.status = 'Pending' AND t.due_date < ? ORDER BY t.due_date ASC`,
    today:     `${base} WHERE t.status = 'Pending' AND t.due_date = ? ORDER BY t.due_time ASC`,
    upcoming:  `${base} WHERE t.status = 'Pending' AND t.due_date > ? ORDER BY t.due_date ASC`,
    completed: `${base} WHERE t.status = 'Completed' ORDER BY t.completed_at DESC`,
    all:       `${base} WHERE t.status != 'Archived' ORDER BY (t.status = 'Pending') DESC, t.due_date ASC`,
  };
  const sql = queries[filter] || queries.all;
  const needsDate = ['overdue', 'today', 'upcoming'].includes(filter);
  return db.prepare(sql + ' LIMIT ?').all(...(needsDate ? [todayStr, limit] : [limit]));
}

module.exports = { createTask, updateTask, completeTask, reopenTask, archiveTask, listTasks };
