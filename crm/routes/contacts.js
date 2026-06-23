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

// Computes whole-years age as of today from a YYYY-MM-DD (or any Date-parsable)
// date of birth. Used so Age stays in sync whenever date_of_birth is set,
// rather than relying on it being entered/maintained separately.
function calcAge(dobStr) {
  if (!dobStr) return null;
  const dob = new Date(dobStr);
  if (isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const monthDiff = now.getMonth() - dob.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age--;
  return age;
}

// Normalizes the optional numeric fields on a create/update payload — blank
// string or null both mean "unknown", not zero.
function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

// GET /api/contacts — list all, newest first
router.get('/', (req, res) => {
  const { q, lead_type, lead_status, sms_consent, appointment_booked,
          task_due, appt_today, has_inbound_sms, limit = 200, offset = 0 } = req.query;

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
  if (task_due) {
    const today    = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const nd = new Date(); nd.setDate(nd.getDate() + 1);
    const tomorrow = nd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    if (task_due === 'overdue') {
      conditions.push(`EXISTS (SELECT 1 FROM follow_up_tasks WHERE contact_id = contacts.id AND status = 'Pending' AND due_date < ?)`);
      params.push(today);
    } else if (task_due === 'today') {
      conditions.push(`EXISTS (SELECT 1 FROM follow_up_tasks WHERE contact_id = contacts.id AND status = 'Pending' AND due_date = ?)`);
      params.push(today);
    } else if (task_due === 'tomorrow') {
      conditions.push(`EXISTS (SELECT 1 FROM follow_up_tasks WHERE contact_id = contacts.id AND status = 'Pending' AND due_date = ?)`);
      params.push(tomorrow);
    } else if (task_due === 'upcoming') {
      conditions.push(`EXISTS (SELECT 1 FROM follow_up_tasks WHERE contact_id = contacts.id AND status = 'Pending' AND due_date > ?)`);
      params.push(tomorrow);
    }
  }
  if (appt_today === '1') {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    conditions.push(`EXISTS (SELECT 1 FROM appointments WHERE contact_id = contacts.id AND status = 'Scheduled' AND substr(appt_datetime,1,10) = ?)`);
    params.push(today);
  }
  if (has_inbound_sms === '1') {
    conditions.push(`EXISTS (SELECT 1 FROM sms_messages WHERE contact_id = contacts.id AND direction = 'inbound' AND sent_at > datetime('now','-30 days'))`);
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

    // Next pending task per contact (earliest due date, then earliest time)
    const nextRows = db.prepare(`
      SELECT contact_id, task_type, due_date, due_time
      FROM follow_up_tasks
      WHERE status = 'Pending' AND contact_id IN (${holders})
      ORDER BY due_date ASC, COALESCE(due_time, '23:59') ASC
    `).all(...ids);
    const nextMap = {};
    for (const r of nextRows) {
      if (!nextMap[r.contact_id]) nextMap[r.contact_id] = r;
    }

    for (const c of contacts) {
      const t = taskMap[c.id] || {};
      c.tasks_overdue  = t.tasks_overdue  || 0;
      c.tasks_today    = t.tasks_today    || 0;
      c.tasks_tomorrow = t.tasks_tomorrow || 0;
      c.tasks_upcoming = t.tasks_upcoming || 0;
      const n = nextMap[c.id];
      c.next_task_type = n ? n.task_type : null;
      c.next_task_date = n ? n.due_date  : null;
      c.next_task_time = n ? n.due_time  : null;
    }
  }

  res.json(contacts);
});

// POST /api/contacts — manually create a new contact (Add Contact form).
// Distinct from the public POST /api/leads endpoint: this is for the CRM
// dashboard user explicitly adding someone, so a clash on email/phone is
// reported back as an error rather than silently merged.
router.post('/', (req, res) => {
  try {
    const body = req.body || {};
    const { first_name, last_name, email, phone } = body;

    if (!first_name && !last_name && !email && !phone) {
      return res.status(400).json({ error: 'At least a name, email, or phone number is required.' });
    }

    if (email) {
      const existing = db.prepare('SELECT id FROM contacts WHERE email = ?').get(email);
      if (existing) {
        return res.status(409).json({ error: 'A contact with this email already exists.', contact_id: existing.id });
      }
    }

    const { display: phoneDisplay, e164: phoneE164 } = normalizePhone(phone);
    if (phoneE164) {
      const existing = db.prepare('SELECT id FROM contacts WHERE phone_e164 = ?').get(phoneE164);
      if (existing) {
        return res.status(409).json({ error: 'A contact with this phone number already exists.', contact_id: existing.id });
      }
    }

    // Age is derived from DOB whenever DOB is provided; otherwise it falls
    // back to whatever was typed directly into the Age field.
    const age = body.date_of_birth ? calcAge(body.date_of_birth) : toIntOrNull(body.age);

    const fields = {
      first_name:               first_name || null,
      last_name:                last_name  || null,
      email:                    email      || null,
      phone:                    phoneDisplay,
      phone_e164:               phoneE164,
      home_phone:               normalizePhone(body.home_phone).display,
      preferred_contact_method: body.preferred_contact_method || null,
      street_address:           body.street_address || null,
      city:                     body.city            || null,
      state:                    body.state            || null,
      zip_code:                 body.zip_code         || null,
      date_of_birth:            body.date_of_birth    || null,
      age,
      marital_status:           body.marital_status   || null,
      spouse_name:              body.spouse_name      || null,
      spouse_date_of_birth:     body.spouse_date_of_birth || null,
      number_of_children:       toIntOrNull(body.number_of_children),
      number_of_grandchildren:  toIntOrNull(body.number_of_grandchildren),
      family_notes:             body.family_notes  || null,
      occupation:               body.occupation    || null,
      employer:                 body.employer      || null,
      retirement_date_goal:     body.retirement_date_goal || null,
      lead_type:                body.lead_type     || null,
      lead_source:              body.lead_source   || null,
      referred_by:              body.referred_by   || null,
      best_time_to_contact:     body.best_time_to_contact || null,
      lead_status:              body.lead_status   || 'New Lead',
      sms_consent:              body.sms_consent   ? 1 : 0,
      email_consent:            body.email_consent ? 1 : 0,
      general_notes:            body.general_notes || null,
    };

    const cols = Object.keys(fields);
    const insert = db.prepare(
      `INSERT INTO contacts (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`
    );
    const result = insert.run(fields);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
    console.log(`[contacts] Created contact #${contact.id}: ${[first_name, last_name].filter(Boolean).join(' ') || '(no name)'}`);
    res.status(201).json(contact);
  } catch (err) {
    console.error('[contacts] create failed:', err.message);
    res.status(500).json({ error: err.message || 'Could not create contact' });
  }
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
  try {
    const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(req.params.id);
    if (!contact) return res.status(404).json({ error: 'Not found' });
    const cid = contact.id;
    console.log(`[timeline] contact #${cid}: building timeline`);

    // NOTE: sms_messages and emails have sent_at but NO created_at column.
    //       All COALESCE fallbacks must only reference columns that exist.
    const items = db.prepare(`
      SELECT 'call_' || c.id AS id,
        CASE
          WHEN c.direction = 'inbound'  AND c.status = 'voicemail' THEN 'voicemail'
          WHEN c.direction = 'outbound' AND c.notes  = 'voicemail_left' THEN 'voicemail'
          WHEN c.status IN ('missed', 'no-answer', 'busy', 'canceled', 'failed') THEN 'missed_call'
          ELSE 'call'
        END AS type,
        c.direction,
        CASE
          WHEN c.direction = 'inbound'  AND c.status = 'voicemail' THEN 'Voicemail Received'
          WHEN c.direction = 'outbound' AND c.notes  = 'voicemail_left' THEN 'Left Voicemail'
          WHEN c.status IN ('missed', 'no-answer', 'busy', 'canceled', 'failed') THEN 'Missed Call'
          WHEN c.direction = 'inbound'  THEN 'Incoming Call'
          WHEN c.direction = 'outbound' THEN 'Outbound Call'
          ELSE 'Call'
        END AS title,
        CASE
          WHEN c.duration_sec IS NOT NULL AND c.duration_sec >= 60 THEN ('Duration: ' || (c.duration_sec/60) || 'm ' || (c.duration_sec%60) || 's')
          WHEN c.duration_sec IS NOT NULL AND c.duration_sec > 0   THEN ('Duration: ' || c.duration_sec || ' sec')
          WHEN c.direction = 'inbound' AND c.status = 'voicemail'
               AND c.transcription IS NOT NULL AND c.transcription != '' THEN substr(c.transcription, 1, 120)
          ELSE NULL
        END AS description,
        COALESCE(c.started_at, c.created_at) AS timestamp,
        c.status, 'comm_calls' AS source_table, c.id AS source_id
      FROM comm_calls c WHERE c.contact_id = ?

      UNION ALL
      -- sms_messages has sent_at; no created_at column
      SELECT 'sms_' || s.id, 'sms', s.direction,
        CASE s.direction WHEN 'inbound' THEN 'SMS Received' ELSE 'SMS Sent' END,
        CASE WHEN s.body IS NOT NULL AND s.body != ''
             THEN ('"' || substr(s.body, 1, 120) || '"') ELSE NULL END,
        s.sent_at, s.status, 'sms_messages', s.id
      FROM sms_messages s WHERE s.contact_id = ?

      UNION ALL
      -- emails has sent_at; no created_at column
      SELECT 'email_' || e.id, 'email',
        COALESCE(e.direction, 'outbound'),
        CASE COALESCE(e.direction, 'outbound') WHEN 'inbound' THEN 'Email Received' ELSE 'Email Sent' END,
        CASE WHEN e.subject IS NOT NULL AND e.subject != ''
             THEN ('Subject: ' || e.subject) ELSE NULL END,
        e.sent_at, e.status, 'emails', e.id
      FROM emails e WHERE e.contact_id = ?

      UNION ALL
      SELECT 'note_' || n.id, 'note', 'internal', 'Note Added',
        substr(n.body, 1, 120),
        n.created_at, NULL, 'contact_notes', n.id
      FROM contact_notes n WHERE n.contact_id = ?

      UNION ALL
      SELECT 'task_' || t.id, 'task', 'internal',
        t.task_type || ' Task Scheduled',
        CASE WHEN t.notes IS NOT NULL AND t.notes != '' THEN t.notes ELSE NULL END,
        t.created_at, t.status, 'follow_up_tasks', t.id
      FROM follow_up_tasks t WHERE t.contact_id = ?

      UNION ALL
      SELECT 'taskdone_' || t.id, 'task_completed', 'internal',
        t.task_type || ' Task Completed',
        CASE WHEN t.notes IS NOT NULL AND t.notes != '' THEN t.notes ELSE NULL END,
        t.completed_at, 'Completed', 'follow_up_tasks', t.id
      FROM follow_up_tasks t WHERE t.contact_id = ? AND t.completed_at IS NOT NULL

      UNION ALL
      SELECT 'appt_' || c.id, 'appointment', 'outbound',
        CASE
          WHEN c.subject LIKE '%Scheduled%' OR c.subject LIKE '%Booked%' THEN 'Appointment Booked'
          WHEN c.subject LIKE '%Completed%'                               THEN 'Appointment Completed'
          WHEN c.subject LIKE '%Cancelled%' OR c.subject LIKE '%Canceled%' THEN 'Appointment Cancelled'
          WHEN c.subject LIKE '%Rescheduled%'                             THEN 'Appointment Rescheduled'
          WHEN c.subject LIKE '%No-Show%' OR c.subject LIKE '%No Show%'   THEN 'Appointment No-Show'
          ELSE 'Appointment'
        END,
        c.body, c.created_at, NULL, 'communications', c.id
      FROM communications c WHERE c.contact_id = ? AND c.comm_type = 'appointment'

      UNION ALL
      SELECT 'form_' || c.id, 'form', 'inbound', 'Form Submitted',
        substr(c.body, 1, 120), c.created_at, NULL, 'communications', c.id
      FROM communications c WHERE c.contact_id = ? AND c.comm_type = 'form'

      ORDER BY timestamp DESC LIMIT 200
    `).all(cid, cid, cid, cid, cid, cid, cid, cid);

    console.log(`[timeline] contact #${cid}: returned ${items.length} item(s)`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(items);
  } catch (err) {
    console.error(`[timeline] ERROR for contact #${req.params.id}:`, err.message);
    res.status(500).json({ error: 'Timeline query failed', detail: err.message });
  }
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
    'lead_status', 'sms_consent', 'email_consent', 'appointment_booked', 'appointment_date', 'last_contacted',
    'retirement_assets', 'account_types', 'retirement_timeline', 'interested_in', 'existing_advisor',
    'coverage_goal', 'existing_coverage', 'mortgage_protection', 'final_expense', 'children_grandchildren',
    'retirement_account_type', 'current_institution', 'estimated_rollover_amount',
    'has_current_advisor', 'interested_in_roth_conversion',
    'insurance_company', 'policy_type', 'face_amount', 'monthly_premium', 'annual_premium',
    'policy_status', 'application_date', 'policy_issue_date',
    'annuity_carrier', 'annuity_type', 'annuity_premium', 'income_rider', 'estimated_income', 'surrender_period',
    'next_follow_up_date', 'last_contact_date', 'commission_estimate',
    // Complete contact profile fields
    'home_phone', 'preferred_contact_method',
    'street_address', 'city', 'state', 'zip_code',
    'date_of_birth', 'age', 'marital_status', 'spouse_name', 'spouse_date_of_birth',
    'number_of_children', 'number_of_grandchildren', 'family_notes',
    'occupation', 'employer', 'retirement_date_goal',
    'referred_by', 'best_time_to_contact', 'general_notes',
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
  if (updates.home_phone !== undefined) {
    updates.home_phone = normalizePhone(updates.home_phone).display;
  }
  if (updates.number_of_children !== undefined) {
    updates.number_of_children = toIntOrNull(updates.number_of_children);
  }
  if (updates.number_of_grandchildren !== undefined) {
    updates.number_of_grandchildren = toIntOrNull(updates.number_of_grandchildren);
  }
  // Age always follows date_of_birth when DOB is part of this update, even if
  // an age value was also sent in the same request — DOB is authoritative.
  if (updates.date_of_birth !== undefined) {
    updates.age = calcAge(updates.date_of_birth);
  } else if (updates.age !== undefined) {
    updates.age = toIntOrNull(updates.age);
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
