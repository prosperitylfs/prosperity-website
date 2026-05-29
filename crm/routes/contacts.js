const express = require('express');
const router = express.Router();
const db = require('../db/database');

function normalizePhone(raw) {
  if (!raw) return { display: null, e164: null };
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 10 ? digits
    : (digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : null);
  const e164    = ten ? `+1${ten}` : null;
  const display = ten ? `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}` : raw.trim();
  return { display, e164 };
}

// GET /api/contacts — list all, newest first
router.get('/', (req, res) => {
  const { q, lead_type, lead_status, sms_consent, appointment_booked, limit = 200, offset = 0 } = req.query;

  let sql = 'SELECT * FROM contacts';
  const params = [];
  const conditions = [];

  if (q) {
    conditions.push(`(first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR phone LIKE ?)`);
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  if (lead_type) {
    conditions.push('lead_type = ?');
    params.push(lead_type);
  }
  if (lead_status) {
    conditions.push('lead_status = ?');
    params.push(lead_status);
  }
  if (sms_consent !== undefined && sms_consent !== '') {
    conditions.push('sms_consent = ?');
    params.push(Number(sms_consent));
  }
  if (appointment_booked !== undefined && appointment_booked !== '') {
    conditions.push('appointment_booked = ?');
    params.push(Number(appointment_booked));
  }

  if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
  sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));

  const contacts = db.prepare(sql).all(...params);

  // Attach pending task badge counts for list/pipeline display
  if (contacts.length) {
    const today   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const nd = new Date(); nd.setDate(nd.getDate() + 1);
    const tomorrow = nd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const ids     = contacts.map(c => c.id);
    const holders = ids.map(() => '?').join(',');
    const taskRows = db.prepare(`
      SELECT contact_id,
        SUM(CASE WHEN due_date < ?  THEN 1 ELSE 0 END) AS tasks_overdue,
        SUM(CASE WHEN due_date = ?  THEN 1 ELSE 0 END) AS tasks_today,
        SUM(CASE WHEN due_date = ?  THEN 1 ELSE 0 END) AS tasks_tomorrow,
        SUM(CASE WHEN due_date > ?  THEN 1 ELSE 0 END) AS tasks_upcoming
      FROM follow_up_tasks
      WHERE status = 'Pending' AND contact_id IN (${holders})
      GROUP BY contact_id
    `).all(today, today, tomorrow, tomorrow, ...ids);
    const taskMap = Object.fromEntries(taskRows.map(r => [r.contact_id, r]));
    for (const c of contacts) {
      const t = taskMap[c.id] || {};
      c.tasks_overdue  = t.tasks_overdue  || 0;
      c.tasks_today    = t.tasks_today    || 0;
      c.tasks_tomorrow = t.tasks_tomorrow || 0;
      c.tasks_upcoming = t.tasks_upcoming || 0;
    }
  }

  res.json(contacts);
});

// GET /api/contacts/:id/activity — dedicated activity feed (never returns emails)
// Uses a whitelist of allowed comm_types so email records cannot leak through.
router.get('/:id/activity', (req, res) => {
  const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });

  const ALLOWED_TYPES = ['form', 'appointment', 'sms', 'call'];

  const activity = db.prepare(`
    SELECT * FROM communications
    WHERE contact_id = ?
      AND comm_type IN ('form', 'appointment', 'sms', 'call')
    ORDER BY created_at DESC
  `).all(contact.id);

  const emailCount = db.prepare(
    "SELECT COUNT(*) AS n FROM communications WHERE contact_id = ? AND comm_type = 'email'"
  ).get(contact.id).n;

  console.log(`[activity] contact #${contact.id}: returning ${activity.length} record(s), excluded ${emailCount} email record(s)`);

  res.setHeader('Cache-Control', 'no-store');
  res.json(activity);
});

// GET /api/contacts/:id/timeline — unified activity feed, newest first
router.get('/:id/timeline', (req, res) => {
  const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });
  const cid = contact.id;

  const items = db.prepare(`
    SELECT 'call_' || c.id AS id,
      CASE
        WHEN c.direction = 'inbound' AND c.status = 'voicemail' THEN 'voicemail'
        WHEN c.direction = 'outbound' AND c.notes = 'voicemail_left' THEN 'voicemail'
        ELSE 'call'
      END AS type,
      c.direction,
      CASE
        WHEN c.direction = 'inbound' AND c.status = 'voicemail' THEN 'Voicemail Received'
        WHEN c.direction = 'outbound' AND c.notes = 'voicemail_left' THEN 'Left Voicemail'
        WHEN c.direction = 'inbound' THEN 'Inbound Call'
        WHEN c.direction = 'outbound' THEN 'Outbound Call'
        ELSE 'Call'
      END AS title,
      CASE
        WHEN c.duration_sec IS NOT NULL AND c.duration_sec >= 60 THEN (c.duration_sec/60 || 'm ' || (c.duration_sec%60) || 's')
        WHEN c.duration_sec IS NOT NULL AND c.duration_sec > 0  THEN (c.duration_sec || 's')
        WHEN c.direction = 'inbound' AND c.status = 'voicemail' AND c.transcription IS NOT NULL AND c.transcription != '' THEN substr(c.transcription, 1, 120)
        WHEN c.status IS NOT NULL AND c.status != 'completed' AND c.status != 'voicemail' THEN c.status
        ELSE NULL
      END AS description,
      COALESCE(c.started_at, c.created_at) AS timestamp,
      c.status, 'comm_calls' AS source_table, c.id AS source_id
    FROM comm_calls c WHERE c.contact_id = ?

    UNION ALL
    SELECT 'sms_' || s.id, 'sms', s.direction,
      CASE s.direction WHEN 'inbound' THEN 'Inbound Text' ELSE 'Outbound Text' END,
      substr(s.body, 1, 120),
      COALESCE(s.sent_at, s.created_at), s.status, 'sms_messages', s.id
    FROM sms_messages s WHERE s.contact_id = ?

    UNION ALL
    SELECT 'email_' || e.id, 'email',
      COALESCE(e.direction, 'outbound'),
      CASE COALESCE(e.direction, 'outbound') WHEN 'inbound' THEN 'Inbound Email' ELSE 'Outbound Email' END,
      e.subject,
      COALESCE(e.sent_at, e.created_at), e.status, 'emails', e.id
    FROM emails e WHERE e.contact_id = ?

    UNION ALL
    SELECT 'note_' || n.id, 'note', 'internal', 'Note Added',
      substr(n.body, 1, 120),
      n.created_at, NULL, 'contact_notes', n.id
    FROM contact_notes n WHERE n.contact_id = ?

    UNION ALL
    SELECT 'task_' || t.id, 'task', 'internal',
      'Task Scheduled: ' || t.task_type,
      CASE WHEN t.notes IS NOT NULL AND t.notes != '' THEN t.notes ELSE NULL END,
      t.created_at, t.status, 'follow_up_tasks', t.id
    FROM follow_up_tasks t WHERE t.contact_id = ?

    UNION ALL
    SELECT 'taskdone_' || t.id, 'task_completed', 'internal',
      'Task Completed: ' || t.task_type,
      CASE WHEN t.notes IS NOT NULL AND t.notes != '' THEN t.notes ELSE NULL END,
      t.completed_at, 'Completed', 'follow_up_tasks', t.id
    FROM follow_up_tasks t WHERE t.contact_id = ? AND t.completed_at IS NOT NULL

    UNION ALL
    SELECT 'appt_' || c.id, 'appointment', 'outbound',
      CASE
        WHEN c.body LIKE 'Booked%' OR c.body LIKE 'Scheduled%' THEN 'Appointment Booked'
        WHEN c.body LIKE 'Completed%' THEN 'Appointment Completed'
        WHEN c.body LIKE 'Cancelled%' OR c.body LIKE 'Canceled%' THEN 'Appointment Cancelled'
        WHEN c.body LIKE 'Rescheduled%' THEN 'Appointment Rescheduled'
        ELSE 'Appointment Update'
      END,
      c.body, c.created_at, NULL, 'communications', c.id
    FROM communications c WHERE c.contact_id = ? AND c.comm_type = 'appointment'

    UNION ALL
    SELECT 'form_' || c.id, 'form', 'inbound', 'Form Submitted',
      c.body, c.created_at, NULL, 'communications', c.id
    FROM communications c WHERE c.contact_id = ? AND c.comm_type = 'form'

    ORDER BY timestamp DESC LIMIT 200
  `).all(cid, cid, cid, cid, cid, cid, cid, cid);

  res.setHeader('Cache-Control', 'no-store');
  res.json(items);
});

// GET /api/contacts/:id — single contact with notes + comms
router.get('/:id', (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });

  const notes = db.prepare(
    'SELECT * FROM contact_notes WHERE contact_id = ? ORDER BY created_at DESC'
  ).all(contact.id);

  // Exclude email comm_type — emails are served separately via /api/email/contact/:id
  // and displayed in their own Email History section. Including them here would
  // cause every sent email to appear twice on the contact detail page.
  const communications = db.prepare(
    "SELECT * FROM communications WHERE contact_id = ? AND comm_type != 'email' ORDER BY created_at DESC"
  ).all(contact.id);

  // Temporary: log how many email records were excluded so it's visible in server logs
  const emailExcluded = db.prepare(
    "SELECT COUNT(*) AS n FROM communications WHERE contact_id = ? AND comm_type = 'email'"
  ).get(contact.id).n;
  if (emailExcluded > 0) {
    console.log(`[contacts/:id] contact #${contact.id}: excluded ${emailExcluded} email record(s) from activity feed`);
  }

  // Exclude the legacy contacts.notes TEXT column so it never collides with
  // the contact_notes array. Old records may have "[object Object]" stored there.
  const { notes: _legacyNotes, ...contactFields } = contact;
  res.json({ ...contactFields, notes, communications });
});

// PATCH /api/contacts/:id — update contact fields
router.patch('/:id', (req, res) => {
  const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });

  const allowed = [
    'first_name', 'last_name', 'phone', 'alt_phone', 'email',
    'role', 'tags', 'notes', 'lead_type', 'lead_source', 'phone_e164',
    'lead_status', 'sms_consent', 'appointment_booked', 'appointment_date', 'last_contacted',
    'retirement_assets', 'account_types', 'retirement_timeline', 'interested_in', 'existing_advisor',
    'coverage_goal', 'existing_coverage', 'mortgage_protection', 'final_expense', 'children_grandchildren',
    'retirement_account_type', 'current_institution', 'estimated_rollover_amount',
    'has_current_advisor', 'interested_in_roth_conversion',
    'insurance_company', 'policy_type', 'face_amount', 'monthly_premium', 'annual_premium',
    'policy_status', 'application_date', 'policy_issue_date',
    'annuity_carrier', 'annuity_type', 'annuity_premium', 'income_rider', 'estimated_income', 'surrender_period',
    'next_follow_up_date', 'last_contact_date', 'commission_estimate',
  ];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  if (updates.phone !== undefined) {
    const { display, e164 } = normalizePhone(updates.phone);
    updates.phone = display;
    if (e164) updates.phone_e164 = e164;
  }
  if (updates.alt_phone !== undefined) {
    updates.alt_phone = normalizePhone(updates.alt_phone).display;
  }

  updates.updated_at = new Date().toISOString();
  updates.id = contact.id;

  const setClauses = Object.keys(updates).filter(k => k !== 'id').map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE contacts SET ${setClauses} WHERE id = @id`).run(updates);

  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id));
});

// DELETE /api/contacts/:id — deletes contact and all associated records
router.delete('/:id', (req, res) => {
  const contact = db.prepare('SELECT id, first_name, last_name FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Not found' });

  try {
    // Tables with ON DELETE SET NULL must be cleaned up explicitly first
    db.prepare('DELETE FROM emails     WHERE contact_id = ?').run(contact.id);
    db.prepare('DELETE FROM comm_calls WHERE contact_id = ?').run(contact.id);
    // Deleting the contact cascades to: communications, contact_notes, appointments
    db.prepare('DELETE FROM contacts WHERE id = ?').run(contact.id);

    const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || `#${contact.id}`;
    console.log(`[contacts] Deleted contact "${name}" (id=${contact.id}) and all associated records`);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[contacts] Delete failed for id=${contact.id}:`, err.message);
    res.status(500).json({ error: err.message || 'Delete failed' });
  }
});

// POST /api/contacts/:id/notes — add a note
router.post('/:id/notes', (req, res) => {
  const { body } = req.body;
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });

  const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const result = db.prepare(
    'INSERT INTO contact_notes (contact_id, body) VALUES (?, ?)'
  ).run(contact.id, body.trim());

  res.status(201).json(db.prepare('SELECT * FROM contact_notes WHERE id = ?').get(result.lastInsertRowid));
});

module.exports = router;
