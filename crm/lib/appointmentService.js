// Single, shared appointment-creation path for the whole CRM. Both
// crm/routes/appointments.js's manual "Add Appointment" page AND
// crm/lib/activityService.js's "Add Activity -> Appointment Scheduled"
// flow call createAppointment() here -- there is only ever one place that
// inserts into `appointments`, so the two can never drift into different
// behavior (e.g. one having duplicate protection and the other not).
//
// Every function takes an explicit better-sqlite3 `db` handle supplied by
// the caller -- never opens a connection itself, never imports
// crm/db/database.js.

function fmtCT(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' CT';
}

// 2026-10-14 PRODUCTION BUG FIX: POST /api/appointments had no duplicate
// protection at all -- a double form submit, or a retried request after a
// network blip, created two identical appointment rows. Guards on an
// EXACT match (same contact, same minute, not already cancelled) -- a
// genuinely different appointment for the same contact at a different
// time is never blocked; only a true repeat of the same booking is.
function findDuplicateAppointment(db, { contactId, apptDatetime }) {
  return db.prepare(`
    SELECT * FROM appointments
    WHERE contact_id = ? AND appt_datetime = ? AND status != 'Cancelled'
    ORDER BY id DESC LIMIT 1
  `).get(contactId, apptDatetime);
}

// Returns { outcome: 'existing', appointment } without writing anything if
// an identical appointment already exists (see findDuplicateAppointment),
// or { outcome: 'created', appointment } for a genuinely new one. Also
// writes the same `communications` row the appointment booking has always
// produced (comm_type='appointment', linked via appointment_id) -- moved
// here unchanged from crm/routes/appointments.js's own original inline
// INSERT, not a new behavior.
function createAppointment(db, { contactId, apptType, apptDatetime, durationMin, status, location, notes }) {
  if (!contactId) throw new Error('createAppointment: contactId is required');
  if (!apptDatetime) throw new Error('createAppointment: apptDatetime is required');
  if (!apptType) throw new Error('createAppointment: apptType is required');
  if (!db.prepare('SELECT id FROM contacts WHERE id = ?').get(contactId)) {
    throw new Error('createAppointment: contact not found');
  }

  const existing = findDuplicateAppointment(db, { contactId, apptDatetime });
  if (existing) return { outcome: 'existing', appointment: existing };

  const finalStatus = status || 'Scheduled';
  const r = db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, duration_min, status, location, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(Number(contactId), apptType, apptDatetime, durationMin ? Number(durationMin) : 60, finalStatus, location || null, notes || null);

  db.prepare(`
    INSERT INTO communications (contact_id, comm_type, direction, subject, body, appointment_id)
    VALUES (?, 'appointment', 'internal', ?, ?, ?)
  `).run(Number(contactId), `Appointment ${finalStatus}`, `${apptType} — ${fmtCT(apptDatetime)}`, r.lastInsertRowid);

  return { outcome: 'created', appointment: db.prepare('SELECT * FROM appointments WHERE id = ?').get(r.lastInsertRowid) };
}

module.exports = { createAppointment, findDuplicateAppointment, fmtCT };
