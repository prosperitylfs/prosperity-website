// Manual phone-call logging (Prosperity Revenue MVP, Requirement 5). Every
// function takes an explicit better-sqlite3 `db` handle — never opens a
// connection itself, never imports crm/db/database.js.
//
// This never records audio and never transcribes anything — it is purely a
// structured note about a call that already happened, told to the CRM by
// the person who made/received it. Writes to the SAME comm_calls table the
// real Twilio-tracked call flow (crm/routes/twilio.js) already uses,
// flagged manual_entry=1 so it's clearly distinguishable, and reuses the
// existing follow_up_tasks table for the optional follow-up — no parallel
// "manual call log" table.

const { toStringOrNull } = require('./leadNormalize');

const CALL_OUTCOMES = [
  'No answer',
  'Left voicemail',
  'Spoke with client',
  'Appointment scheduled',
  'Follow-up needed',
  'Not interested',
  'Wrong number',
];

function contactBrandIdFor(db, contactId) {
  const link = db.prepare(`SELECT id FROM contact_brands WHERE contact_id = ? AND status = 'Active'`).get(contactId);
  return link ? link.id : null;
}

function logCall(db, fields, actor) {
  if (!actor) throw new Error('logCall: actor is required for the audit trail');
  if (!fields.contactId) throw new Error('logCall: contactId is required');
  if (!['inbound', 'outbound'].includes(fields.direction)) {
    throw new Error(`logCall: direction must be 'inbound' or 'outbound' (got '${fields.direction}')`);
  }
  if (!CALL_OUTCOMES.includes(fields.outcome)) {
    throw new Error(`logCall: outcome must be one of ${CALL_OUTCOMES.join(', ')}`);
  }
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(fields.contactId);
  if (!contact) throw new Error(`logCall: contact ${fields.contactId} does not exist`);
  if (!fields.date) throw new Error('logCall: date is required');

  const contactBrandId = contactBrandIdFor(db, fields.contactId);
  const startedAt = fields.startTime ? `${fields.date}T${fields.startTime}:00` : fields.date;
  const durationSec = fields.durationMinutes != null && fields.durationMinutes !== ''
    ? Math.round(Number(fields.durationMinutes) * 60) : null;

  const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || null;

  const result = db.prepare(`
    INSERT INTO comm_calls
      (contact_id, contact_name, contact_brand_id, case_id, direction, status,
       outcome, summary, notes, started_at, duration_sec, manual_entry)
    VALUES
      (@contact_id, @contact_name, @contact_brand_id, @case_id, @direction, 'logged',
       @outcome, @summary, @notes, @started_at, @duration_sec, 1)
  `).run({
    contact_id: fields.contactId,
    contact_name: contactName,
    contact_brand_id: contactBrandId,
    case_id: fields.caseId || null,
    direction: fields.direction,
    outcome: fields.outcome,
    summary: toStringOrNull(fields.summary),
    notes: toStringOrNull(fields.detailedNotes),
    started_at: startedAt,
    duration_sec: durationSec,
  });
  const callId = result.lastInsertRowid;

  let followUpTaskId = null;
  if (toStringOrNull(fields.nextAction) && toStringOrNull(fields.nextActionDueDate)) {
    const taskResult = db.prepare(`
      INSERT INTO follow_up_tasks (contact_id, case_id, contact_brand_id, task_type, due_date, due_time, notes, priority, status)
      VALUES (?, ?, ?, 'Follow-up', ?, ?, ?, 'Medium', 'Pending')
    `).run(fields.contactId, fields.caseId || null, contactBrandId, fields.nextActionDueDate, toStringOrNull(fields.nextActionDueTime), fields.nextAction);
    followUpTaskId = taskResult.lastInsertRowid;
    db.prepare('UPDATE comm_calls SET follow_up_task_id = ? WHERE id = ?').run(followUpTaskId, callId);
  }

  return {
    call: db.prepare('SELECT * FROM comm_calls WHERE id = ?').get(callId),
    followUpTask: followUpTaskId ? db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(followUpTaskId) : null,
  };
}

function listCallsForContact(db, contactId) {
  return db.prepare('SELECT * FROM comm_calls WHERE contact_id = ? ORDER BY COALESCE(started_at, created_at) DESC').all(contactId);
}

// Attaches business outcome/disposition, notes, related case, and an
// optional follow-up task to an EXISTING comm_calls row — never creates a
// new one. Used for a call the CRM itself placed (crm/routes/calls.js POST
// /outbound already created the row automatically, with direction/contact/
// brand/start-time/Twilio SID captured at initiation, and Twilio's own
// status webhooks keep it updated as the call progresses) — this is only
// ever the "what happened, what's next" step afterward. date/startTime/
// duration/direction are deliberately NOT accepted here; those came from
// the CRM-initiated call itself (or, for a call logged via logCall() above,
// were already entered once at creation) — never re-enterable.
function attachCallOutcome(db, callId, fields, actor) {
  if (!actor) throw new Error('attachCallOutcome: actor is required for the audit trail');
  const call = db.prepare('SELECT * FROM comm_calls WHERE id = ?').get(callId);
  if (!call) throw new Error(`attachCallOutcome: call ${callId} does not exist`);
  if (fields.outcome && !CALL_OUTCOMES.includes(fields.outcome)) {
    throw new Error(`attachCallOutcome: outcome must be one of ${CALL_OUTCOMES.join(', ')}`);
  }

  db.prepare(`
    UPDATE comm_calls SET
      outcome = COALESCE(@outcome, outcome),
      summary = COALESCE(@summary, summary),
      notes   = COALESCE(@notes, notes),
      case_id = COALESCE(@case_id, case_id)
    WHERE id = @id
  `).run({
    outcome: toStringOrNull(fields.outcome),
    summary: toStringOrNull(fields.summary),
    notes: toStringOrNull(fields.detailedNotes),
    case_id: fields.caseId || null,
    id: callId,
  });

  // Follow-up: if this call already has a linked task (call.follow_up_task_id,
  // set the first time an outcome was saved), an edit that supplies new
  // follow-up details UPDATES that same task in place -- it never creates a
  // second one. Only a call with NO linked task yet gets a new task
  // inserted. An edit that doesn't mention a follow-up at all (e.g. only
  // Summary/Notes changed) leaves any existing linked task completely
  // untouched -- including its status, so completing a task later never
  // erases what the call originally asked for, and this path never
  // silently deletes a task just because these fields came back empty.
  let followUpTaskId = call.follow_up_task_id || null;
  const wantsFollowUp = toStringOrNull(fields.nextAction) && toStringOrNull(fields.nextActionDueDate);

  if (wantsFollowUp) {
    if (followUpTaskId) {
      db.prepare(`
        UPDATE follow_up_tasks SET
          due_date = @due_date, due_time = @due_time, notes = @notes
        WHERE id = @id
      `).run({
        due_date: fields.nextActionDueDate,
        due_time: toStringOrNull(fields.nextActionDueTime),
        notes: fields.nextAction,
        id: followUpTaskId,
      });
    } else {
      const taskResult = db.prepare(`
        INSERT INTO follow_up_tasks (contact_id, case_id, contact_brand_id, task_type, due_date, due_time, notes, priority, status)
        VALUES (?, ?, ?, 'Follow-up', ?, ?, ?, 'Medium', 'Pending')
      `).run(
        call.contact_id, fields.caseId || call.case_id || null, call.contact_brand_id,
        fields.nextActionDueDate, toStringOrNull(fields.nextActionDueTime), fields.nextAction
      );
      followUpTaskId = taskResult.lastInsertRowid;
    }
    if (followUpTaskId !== call.follow_up_task_id) {
      db.prepare('UPDATE comm_calls SET follow_up_task_id = ? WHERE id = ?').run(followUpTaskId, callId);
    }
  }

  return {
    call: db.prepare('SELECT * FROM comm_calls WHERE id = ?').get(callId),
    followUpTask: followUpTaskId ? db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(followUpTaskId) : null,
  };
}

module.exports = { CALL_OUTCOMES, logCall, attachCallOutcome, listCallsForContact };
