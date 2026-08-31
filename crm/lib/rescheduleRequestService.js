// SMS-based reschedule-REQUEST workflow. Triggered when a contact already
// resolved by crm/lib/inboundSmsService.js's existing matching rules
// (Prosperity-strict or legacy-broad -- see that file's own header) replies
// with the exact keyword RESCHEDULE to an appointment-related SMS. This
// module does NOT do its own contact matching and does NOT relax either of
// the existing matching rules -- it only acts on whichever contact_id the
// caller already resolved.
//
// Does NOT touch Cal.com and does NOT change any appointment's date/time.
// Purely: identify (or fail to identify) an upcoming appointment, reply
// with one of three fixed messages, and record the request internally
// (a follow-up task, the smallest existing mechanism that fits) for staff
// to actually reschedule.
//
// Reuses:
//   - sending: crm/lib/legacySmsSend.js's sendLegacySms -- the SAME
//     consent gate (STOP/opt-out authoritative, missing consent blocks),
//     the SAME sms_messages logging, the SAME Twilio call path as every
//     other automated SMS in this codebase (appointment confirmation,
//     reschedule notice, reminders).
//   - the reply's FROM number is the SAME number the inbound RESCHEDULE
//     text arrived TO -- keeps the reply in the SAME conversation thread
//     on the client's phone (critical: a reply from an unrelated number
//     would look broken), and needs no separate brand lookup, since the
//     number a reminder was sent from is necessarily the number the client
//     texted back.
//
// Idempotency note: unlike appointment SMS (confirmation/reschedule/
// reminders), this is triggered by a human's own inbound message, not a
// webhook that can be redelivered by Cal.com -- the existing MessageSid
// dedup already in crm/lib/inboundSmsService.js (INSERT OR IGNORE on the
// inbound row) already prevents processing the SAME inbound RESCHEDULE
// text twice; nothing further is needed here.

const { sendLegacySms } = require('./legacySmsSend');

const RESCHEDULE_KEYWORDS = new Set(['reschedule']);

// Exact match only (after trim + lowercase) -- deliberately NOT a substring
// search, so "I might need to reschedule at some point" does not trigger
// this workflow. Mirrors the exact-match style STOP_KEYWORDS/START_KEYWORDS/
// HELP_KEYWORDS already use in crm/lib/inboundSmsService.js.
function isRescheduleRequest(body) {
  return RESCHEDULE_KEYWORDS.has((body || '').trim().toLowerCase());
}

const SINGLE_APPT_REPLY = 'Absolutely. What day and time would you prefer for your appointment? Please reply with your preferred day and time. Your appointment is not changed until you receive a confirmation.';
const MULTIPLE_APPT_REPLY = 'I found more than one upcoming appointment. Please reply with the appointment type you want to reschedule and your preferred new day and time. Your appointment is not changed until you receive a confirmation.';
const NO_APPT_REPLY = "I couldn't locate an upcoming appointment to reschedule. Please reply with your name, appointment type, and preferred day and time so we can assist you.";

function findUpcomingAppointments(db, contactId, nowIso) {
  return db.prepare(`
    SELECT * FROM appointments
    WHERE contact_id = ? AND status IN ('Scheduled', 'Rescheduled') AND datetime(appt_datetime) > datetime(?)
    ORDER BY appt_datetime ASC
  `).all(contactId, nowIso);
}

function fmtApptForNote(appt) {
  const formatted = new Date(appt.appt_datetime).toLocaleString('en-US', {
    timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' CT';
  return `${appt.appt_type} on ${formatted}`;
}

const RESCHEDULE_TASK_DEDUP_KEYWORD = 'Reschedule request via SMS';

// Mirrors crm/lib/inboundSmsService.js's ctDueDateAndTimeLocal()/
// createLegacySmsReplyTask() conventions exactly (same due-in-15-minutes-CT
// computation, same dedup-by-notes-substring approach, same follow_up_tasks
// table -- the smallest existing mechanism that fits, not a new subsystem),
// with its own distinct dedup keyword so this never collides with, or gets
// suppressed by, the generic "reply to this lead" task.
function createRescheduleTask(db, { contactId, appointments, now = new Date() }) {
  const existing = db.prepare(`
    SELECT id FROM follow_up_tasks WHERE contact_id = ? AND task_type = 'SMS' AND status = 'Pending' AND notes LIKE ?
  `).get(contactId, `%${RESCHEDULE_TASK_DEDUP_KEYWORD}%`);
  if (existing) return existing.id;

  let detail;
  if (appointments.length === 1) {
    detail = `Appointment: ${fmtApptForNote(appointments[0])}.`;
  } else if (appointments.length > 1) {
    detail = `Multiple upcoming appointments -- awaiting reply to identify which one: ${appointments.map(fmtApptForNote).join('; ')}.`;
  } else {
    detail = 'No upcoming appointment on file -- awaiting reply with details.';
  }
  const notes = `Client requested to reschedule by SMS (${RESCHEDULE_TASK_DEDUP_KEYWORD}). ${detail}`;

  const dt = new Date(now.getTime() + 15 * 60 * 1000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(dt).map(({ type, value }) => [type, value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const dueDate = `${parts.year}-${parts.month}-${parts.day}`;
  const dueTime = `${hour}:${parts.minute}`;

  const result = db.prepare(`
    INSERT INTO follow_up_tasks (contact_id, task_type, due_date, due_time, notes, priority)
    VALUES (?, 'SMS', ?, ?, ?, 'High')
  `).run(contactId, dueDate, dueTime, notes);
  return result.lastInsertRowid;
}

// The task is created synchronously (a DB write, no network call) BEFORE
// the async send -- so even when the caller doesn't await this function
// (crm/lib/inboundSmsService.js fires it in the background, see that
// file's own comment for why), the task already exists by the time this
// function's first `await` is reached, since a JS async function body runs
// synchronously up to its first await.
//
// Returns { attempted: true, sent: boolean, appointmentCount, taskId, reason? }
async function processRescheduleRequest(db, { contactId, inboundToNumber, now = new Date() }, deps = {}) {
  const nowIso = now.toISOString();
  const appointments = findUpcomingAppointments(db, contactId, nowIso);
  const appointmentId = appointments.length === 1 ? appointments[0].id : null;

  let replyBody;
  if (appointments.length === 1) replyBody = SINGLE_APPT_REPLY;
  else if (appointments.length > 1) replyBody = MULTIPLE_APPT_REPLY;
  else replyBody = NO_APPT_REPLY;

  const taskId = createRescheduleTask(db, { contactId, appointments, now });

  const send = deps.sendLegacySms || sendLegacySms;
  const result = await send(db, {
    contactId, body: replyBody, fromNumber: inboundToNumber || undefined,
    appointmentId, messageType: 'reschedule_request_reply',
  }, deps);

  if (result.ok) return { attempted: true, sent: true, appointmentCount: appointments.length, taskId };
  return { attempted: true, sent: false, appointmentCount: appointments.length, taskId, reason: result.error };
}

module.exports = {
  isRescheduleRequest, processRescheduleRequest, findUpcomingAppointments,
  SINGLE_APPT_REPLY, MULTIPLE_APPT_REPLY, NO_APPT_REPLY, RESCHEDULE_TASK_DEDUP_KEYWORD,
};
