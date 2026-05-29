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
    newLeads,
    inboundSms,
    inboundEmail,
  });
});

module.exports = router;
