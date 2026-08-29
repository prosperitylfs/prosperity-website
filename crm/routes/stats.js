const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

// ─── GET /api/stats ──────────────────────────────────────────────────────────
// Dashboard summary: tasks + appointments + leads + recent inbound comms.
router.get('/', (req, res) => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const nd = new Date(); nd.setDate(nd.getDate() + 1);
  const tomorrow = nd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  const taskOverdue   = db.prepare("SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status='Pending' AND due_date < ?").get(today).n;
  const taskToday     = db.prepare("SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status='Pending' AND due_date = ?").get(today).n;
  const taskTomorrow  = db.prepare("SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status='Pending' AND due_date = ?").get(tomorrow).n;
  const taskUpcoming  = db.prepare("SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status='Pending' AND due_date > ?").get(tomorrow).n;

  const apptsToday = db.prepare(
    "SELECT COUNT(*) AS n FROM appointments WHERE status='Scheduled' AND substr(appt_datetime,1,10) = ?"
  ).get(today).n;

  // "Upcoming Appointments" — any appointment with a start time still in
  // the future, regardless of whether it also falls today (an appointment
  // later today legitimately counts in BOTH cards). Cancelled appointments
  // never count. Uses the actual current instant (not the CT calendar day
  // used above) so "future" means "hasn't happened yet", not "today or
  // later". appt_datetime is stored as an ISO string ("...T...Z"); wrapping
  // both sides in datetime() normalizes to SQLite's own "YYYY-MM-DD
  // HH:MM:SS" form before comparing -- a raw string compare against
  // datetime('now') (which never contains "T") would sort every
  // same-day appointment as "greater" regardless of its actual time, since
  // 'T' > ' ' lexicographically.
  const apptsUpcoming = db.prepare(
    "SELECT COUNT(*) AS n FROM appointments WHERE status != 'Cancelled' AND datetime(appt_datetime) > datetime('now')"
  ).get().n;

  const newLeads = db.prepare(
    "SELECT COUNT(*) AS n FROM contacts WHERE lead_status = 'New Lead'"
  ).get().n;

  const inboundSms = db.prepare(
    "SELECT COUNT(*) AS n FROM sms_messages WHERE direction='inbound' AND sent_at > datetime('now','-30 days')"
  ).get().n;

  const inboundEmail = db.prepare(
    "SELECT COUNT(*) AS n FROM emails WHERE direction='inbound' AND sent_at > datetime('now','-30 days')"
  ).get().n;

  res.json({
    tasks: { overdue: taskOverdue, today: taskToday, tomorrow: taskTomorrow, upcoming: taskUpcoming },
    apptsToday,
    apptsUpcoming,
    newLeads,
    inboundSms,
    inboundEmail,
  });
});

module.exports = router;
