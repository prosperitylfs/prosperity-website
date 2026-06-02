const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

const APPT_STATUS_TO_LEAD = {
  'Scheduled':   'Appointment Scheduled',
  'Completed':   'Appointment Completed',
  'No-Show':     'No Show',
  'Cancelled':   'Cancelled',
  'Rescheduled': 'Appointment Rescheduled',
};

const OUTCOME_SUBJECTS = [
  'Appointment Completed',
  'Appointment No-Show',
  'Appointment Cancelled',
  'Appointment Rescheduled',
];

function fmtCT(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' CT';
}

// Startup backfill: legacy outcome records created before the appointment_id
// migration have appointment_id = NULL and cannot be targeted by the
// appointment_id-based DELETE.  Re-generate each appointment's body string
// (same fmtCT call, same format) and link matching unlinked records.
// Runs once on server start; safe to run on every restart (no-op once done).
;(function backfillApptId() {
  try {
    const appts = db.prepare(`
      SELECT a.id, a.contact_id, a.appt_type, a.appt_datetime
      FROM appointments a
      WHERE EXISTS (
        SELECT 1 FROM communications c
        WHERE c.contact_id   = a.contact_id
          AND c.comm_type    = 'appointment'
          AND c.appointment_id IS NULL
          AND c.subject IN (${OUTCOME_SUBJECTS.map(() => '?').join(',')})
      )
    `).all(...OUTCOME_SUBJECTS);

    let total = 0;
    for (const appt of appts) {
      const body = `${appt.appt_type} — ${fmtCT(appt.appt_datetime)}`;
      const { changes } = db.prepare(`
        UPDATE communications
        SET appointment_id = ?
        WHERE contact_id      = ?
          AND comm_type       = 'appointment'
          AND appointment_id  IS NULL
          AND subject IN (${OUTCOME_SUBJECTS.map(() => '?').join(',')})
          AND body            = ?
      `).run(appt.id, appt.contact_id, ...OUTCOME_SUBJECTS, body);
      total += changes;
    }
    if (total > 0) console.log(`[appointments] backfilled appointment_id for ${total} legacy record(s)`);
  } catch (e) {
    console.warn('[appointments] backfill skipped:', e.message);
  }
})();

// GET /api/appointments?view=upcoming|past
router.get('/', (req, res) => {
  const { view, contact_id } = req.query;
  const now = new Date().toISOString();
  let sql = `
    SELECT a.*, c.first_name, c.last_name, c.phone, c.email
    FROM appointments a
    LEFT JOIN contacts c ON a.contact_id = c.id`;
  const params = [];
  const conds  = [];
  if (view === 'upcoming') { conds.push('a.appt_datetime >= ?'); params.push(now); }
  if (view === 'past')     { conds.push('a.appt_datetime < ?');  params.push(now); }
  if (contact_id)          { conds.push('a.contact_id = ?');     params.push(Number(contact_id)); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += view === 'upcoming' ? ' ORDER BY a.appt_datetime ASC' : ' ORDER BY a.appt_datetime DESC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/appointments/contact/:id
router.get('/contact/:id', (req, res) => {
  res.json(db.prepare(
    'SELECT * FROM appointments WHERE contact_id = ? ORDER BY appt_datetime DESC'
  ).all(req.params.id));
});

// POST /api/appointments
router.post('/', (req, res) => {
  const { contact_id, appt_type, appt_datetime, duration_min, status, location, notes } = req.body;
  if (!contact_id)    return res.status(400).json({ error: 'contact_id required' });
  if (!appt_datetime) return res.status(400).json({ error: 'appt_datetime required' });
  if (!appt_type)     return res.status(400).json({ error: 'appt_type required' });

  if (!db.prepare('SELECT id FROM contacts WHERE id = ?').get(contact_id))
    return res.status(404).json({ error: 'Contact not found' });

  const finalStatus = status || 'Scheduled';
  const r = db.prepare(
    `INSERT INTO appointments (contact_id, appt_type, appt_datetime, duration_min, status, location, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(Number(contact_id), appt_type, appt_datetime,
        duration_min ? Number(duration_min) : 60,
        finalStatus, location || null, notes || null);

  db.prepare(
    `INSERT INTO communications (contact_id, comm_type, direction, subject, body, appointment_id)
     VALUES (?, 'appointment', 'internal', ?, ?, ?)`
  ).run(Number(contact_id),
        `Appointment ${finalStatus}`,
        `${appt_type} — ${fmtCT(appt_datetime)}`,
        r.lastInsertRowid);

  res.status(201).json(db.prepare('SELECT * FROM appointments WHERE id = ?').get(r.lastInsertRowid));
});

// PATCH /api/appointments/:id
router.patch('/:id', (req, res) => {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });

  const allowed = ['appt_type', 'appt_datetime', 'duration_min', 'status', 'location', 'notes'];
  const updates = { id: appt.id, updated_at: new Date().toISOString() };
  for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
  if (Object.keys(updates).length <= 2) return res.status(400).json({ error: 'Nothing to update' });

  const set = Object.keys(updates).filter(k => k !== 'id').map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE appointments SET ${set} WHERE id = @id`).run(updates);

  if (updates.status && updates.status !== appt.status) {
    const subjectList = OUTCOME_SUBJECTS.map(() => '?').join(',');
    const outcomeBody = `${appt.appt_type} — ${fmtCT(updates.appt_datetime || appt.appt_datetime)}`;

    // Delete previous outcome records linked by appointment_id (post-migration records)
    db.prepare(`
      DELETE FROM communications
      WHERE appointment_id = ?
        AND subject IN (${subjectList})
    `).run(appt.id, ...OUTCOME_SUBJECTS);

    // Belt-and-suspenders: also delete pre-migration records (appointment_id IS NULL)
    // matched by the body string, in case backfill didn't cover them.
    db.prepare(`
      DELETE FROM communications
      WHERE contact_id     = ?
        AND comm_type      = 'appointment'
        AND appointment_id IS NULL
        AND subject IN (${subjectList})
        AND body           = ?
    `).run(appt.contact_id, ...OUTCOME_SUBJECTS, outcomeBody);

    // Insert new outcome record (skip for reset-to-Scheduled — booking record already exists)
    if (updates.status !== 'Scheduled') {
      db.prepare(
        `INSERT INTO communications (contact_id, comm_type, direction, subject, body, appointment_id)
         VALUES (?, 'appointment', 'internal', ?, ?, ?)`
      ).run(appt.contact_id,
            `Appointment ${updates.status}`,
            `${appt.appt_type} — ${fmtCT(updates.appt_datetime || appt.appt_datetime)}`,
            appt.id);
    }

    const newLeadStatus = APPT_STATUS_TO_LEAD[updates.status];
    if (newLeadStatus) {
      db.prepare('UPDATE contacts SET lead_status = ?, updated_at = ? WHERE id = ?')
        .run(newLeadStatus, new Date().toISOString(), appt.contact_id);
    }
  }

  res.json(db.prepare('SELECT * FROM appointments WHERE id = ?').get(appt.id));
});

// DELETE /api/appointments/:id
router.delete('/:id', (req, res) => {
  const appt = db.prepare('SELECT id FROM appointments WHERE id = ?').get(req.params.id);
  if (!appt) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM appointments WHERE id = ?').run(appt.id);
  res.json({ ok: true });
});

module.exports = router;
