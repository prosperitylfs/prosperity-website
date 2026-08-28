// Retirement Intake Form business logic. Same convention as every other
// crm/lib module (caseMatching.js, leadIntake.js, etc.): pure functions that
// take an explicit better-sqlite3 `db` handle, never import
// crm/db/database.js, never read an environment variable or credential.
//
// One retirement_intakes row per Safe Money & Retirement appointment
// (crm/db/database.js's schema comment explains the table). The row is
// created automatically by crm/routes/calcom.js when a new such appointment
// is booked (see createIntakeForAppointment below) — this module never
// decides WHICH appointments are retirement appointments; that
// classification stays single-sourced in crm/routes/calcom.js's existing
// inferLeadType(), passed in by the caller.
//
// Status is one of 'Not Sent' | 'Sent' | 'Completed' in the database.
// 'Overdue' is a fourth, DISPLAY-ONLY value computed here at read time
// (status is 'Sent' and the linked appointment's CURRENT appt_datetime
// minus 2 hours has already passed) — never written to the database, and
// nothing here or anywhere else acts on it automatically. Automatic
// reminders/rescheduling are explicitly a later phase.
//
// The token is the ONLY identifier the public form/browser ever sees —
// crm/routes/retirementIntake.js (the public API) resolves contact_id/
// appointment_id from the token server-side and never accepts or returns
// either raw ID to the browser.

const crypto = require('crypto');

const INTAKE_DEADLINE_HOURS_BEFORE = 2;

function generateIntakeToken() {
  return crypto.randomBytes(32).toString('hex');
}

// appointmentDatetimeIso: an ISO datetime string (appointments.appt_datetime
// is stored as ISO text). Returns an ISO string, or null if the input is
// missing/unparseable.
function computeIntakeDeadline(appointmentDatetimeIso) {
  if (!appointmentDatetimeIso) return null;
  const apptMs = new Date(appointmentDatetimeIso).getTime();
  if (!Number.isFinite(apptMs)) return null;
  return new Date(apptMs - INTAKE_DEADLINE_HOURS_BEFORE * 60 * 60 * 1000).toISOString();
}

// status: the raw stored value ('Not Sent' | 'Sent' | 'Completed').
// appointmentDatetimeIso: the linked appointment's CURRENT appt_datetime
// (read live, not frozen at intake-creation time, so a Cal.com reschedule
// automatically shifts the effective deadline).
// now: injectable for tests; defaults to the real current time.
function computeDisplayStatus(status, appointmentDatetimeIso, now = new Date()) {
  if (status === 'Completed') return 'Completed';
  if (status === 'Sent') {
    const deadline = computeIntakeDeadline(appointmentDatetimeIso);
    if (deadline && now.getTime() > new Date(deadline).getTime()) return 'Overdue';
    return 'Sent';
  }
  return 'Not Sent';
}

// Idempotent by appointment_id — if an intake record already exists for
// this appointment (e.g. a duplicate/retried Cal.com webhook delivery for
// the same BOOKING_CREATED event), returns the existing row instead of
// creating a second one. A reschedule never calls this again (see
// crm/routes/calcom.js — appointments are updated in place on reschedule,
// keeping the same appointments.id, so the existing intake row's
// appointment_id FK stays valid and its live-computed deadline naturally
// follows the new time).
function createIntakeForAppointment(db, { contactId, appointmentId }) {
  const existing = db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(appointmentId);
  if (existing) return existing;

  const token = generateIntakeToken();
  const r = db.prepare(`
    INSERT INTO retirement_intakes (contact_id, appointment_id, token, status)
    VALUES (@contact_id, @appointment_id, @token, 'Not Sent')
  `).run({ contact_id: contactId, appointment_id: appointmentId, token });

  return db.prepare('SELECT * FROM retirement_intakes WHERE id = ?').get(r.lastInsertRowid);
}

function getIntakeByToken(db, token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM retirement_intakes WHERE token = ?').get(token);
}

// Everything the public retirement-intake.html page needs to render its
// header ("Hi Jane, your appointment is ...") and pre-play its own
// completed-state message — nothing else. No contact_id, appointment_id, or
// intake row id is included.
function buildPublicIntakeView(db, token) {
  const intake = getIntakeByToken(db, token);
  if (!intake) return null;

  const contact = db.prepare('SELECT first_name, last_name FROM contacts WHERE id = ?').get(intake.contact_id);
  const appt = db.prepare('SELECT appt_datetime FROM appointments WHERE id = ?').get(intake.appointment_id);
  if (!appt) return null;

  return {
    firstName: contact ? contact.first_name : null,
    lastName: contact ? contact.last_name : null,
    appointmentDatetime: appt.appt_datetime,
    deadline: computeIntakeDeadline(appt.appt_datetime),
    status: computeDisplayStatus(intake.status, appt.appt_datetime),
  };
}

// Structural + required-field validation only. Deliberately does NOT
// enforce a $15,000 (or any) minimum-asset requirement — eligibility was
// already handled by the pre-booking qualification flow (book.html/
// schedule.html); this form exists to gather preparation detail for an
// appointment that is already booked.
function validateIntakeSubmission(responses) {
  const errors = [];
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) {
    return { valid: false, errors: ['responses must be an object'] };
  }

  const about = responses.about;
  if (!about || typeof about !== 'object') {
    errors.push('about section is required');
  } else {
    if (!about.firstName || !String(about.firstName).trim()) errors.push('First name is required');
    if (!about.lastName || !String(about.lastName).trim()) errors.push('Last name is required');
    if (!about.email || !String(about.email).trim()) errors.push('Email address is required');
    if (!about.phone || !String(about.phone).trim()) errors.push('Phone number is required');
  }

  // Every other section is optional structurally, but if present must be an
  // object (accounts) or array (accounts list) — never a bare string/number
  // that would silently fail to render on Contact Detail.
  const SECTION_KEYS = [
    'helpWith', 'accounts', 'income', 'risk', 'timeHorizon',
    'existingProducts', 'beneficiaries', 'advisor', 'additional',
  ];
  for (const key of SECTION_KEYS) {
    const val = responses[key];
    if (val !== undefined && val !== null && typeof val !== 'object') {
      errors.push(`${key} must be an object or array if provided`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// Returns one of:
//   { ok: false, reason: 'invalid_token' }
//   { ok: false, reason: 'validation', errors }
//   { ok: true, contactId, appointmentId }
function submitIntakeResponses(db, { token, responses }) {
  const intake = getIntakeByToken(db, token);
  if (!intake) return { ok: false, reason: 'invalid_token' };

  const { valid, errors } = validateIntakeSubmission(responses);
  if (!valid) return { ok: false, reason: 'validation', errors };

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE retirement_intakes SET
      responses_json = @responses_json,
      status         = 'Completed',
      completed_at   = @now,
      updated_at     = @now
    WHERE id = @id
  `).run({ responses_json: JSON.stringify(responses), now, id: intake.id });

  const appt = db.prepare('SELECT appt_type, appt_datetime FROM appointments WHERE id = ?').get(intake.appointment_id);
  const goal = responses.helpWith && responses.helpWith.mainConcern ? String(responses.helpWith.mainConcern).slice(0, 300) : null;
  const body = [
    appt ? `${appt.appt_type} — ${appt.appt_datetime}` : null,
    goal ? `Main concern: ${goal}` : null,
  ].filter(Boolean).join('\n');

  db.prepare(`
    INSERT INTO communications (contact_id, comm_type, direction, subject, body, appointment_id)
    VALUES (?, 'form', 'inbound', 'Retirement Intake Form Completed', ?, ?)
  `).run(intake.contact_id, body || null, intake.appointment_id);

  db.prepare('UPDATE contacts SET updated_at = ? WHERE id = ?').run(now, intake.contact_id);

  return { ok: true, contactId: intake.contact_id, appointmentId: intake.appointment_id };
}

// Staff-only action (Contact Detail): marks an intake as sent once Loretta
// has actually copied/sent the link herself. No automatic email/SMS
// dispatch happens anywhere in this module — see the file-level comment.
// A no-op (returns the row unchanged) if the intake is already Sent or
// Completed, so a repeated click can't overwrite completed_at/sent_at.
function markIntakeSent(db, intakeId) {
  const intake = db.prepare('SELECT * FROM retirement_intakes WHERE id = ?').get(intakeId);
  if (!intake || intake.status !== 'Not Sent') return intake || null;

  const now = new Date().toISOString();
  db.prepare(`UPDATE retirement_intakes SET status = 'Sent', sent_at = @now, updated_at = @now WHERE id = @id`)
    .run({ now, id: intakeId });

  return db.prepare('SELECT * FROM retirement_intakes WHERE id = ?').get(intakeId);
}

// For Contact Detail's "Retirement Intake" card — one row per retirement
// appointment this contact has, newest first, each with its live-computed
// display status and deadline attached (never stored).
function listIntakesForContact(db, contactId) {
  const rows = db.prepare(`
    SELECT ri.*, a.appt_type, a.appt_datetime, a.status AS appt_status
    FROM retirement_intakes ri
    JOIN appointments a ON a.id = ri.appointment_id
    WHERE ri.contact_id = ?
    ORDER BY a.appt_datetime DESC
  `).all(contactId);

  return rows.map(row => ({
    ...row,
    responses: row.responses_json ? JSON.parse(row.responses_json) : null,
    deadline: computeIntakeDeadline(row.appt_datetime),
    displayStatus: computeDisplayStatus(row.status, row.appt_datetime),
  }));
}

module.exports = {
  INTAKE_DEADLINE_HOURS_BEFORE,
  generateIntakeToken,
  computeIntakeDeadline,
  computeDisplayStatus,
  createIntakeForAppointment,
  getIntakeByToken,
  buildPublicIntakeView,
  validateIntakeSubmission,
  submitIntakeResponses,
  markIntakeSent,
  listIntakesForContact,
};
