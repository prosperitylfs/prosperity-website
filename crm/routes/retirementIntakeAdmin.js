/**
 * Staff-only Retirement Intake endpoints for Contact Detail. Mounted behind
 * dashboardAuth + requireApiKey in crm/server.js, same protection tier as
 * /api/appointments and /api/contacts.
 *
 * GET   /api/retirement-intake-admin/contact/:id — list this contact's
 *   retirement intake record(s) (one per Safe Money & Retirement
 *   appointment), each with live-computed displayStatus/deadline and the
 *   full parsed responses for Contact Detail's expandable view.
 *
 * PATCH /api/retirement-intake-admin/:id — currently supports
 *   { action: 'mark_sent' } only: staff has copied/sent the link
 *   themselves and is recording that. No email/SMS is ever sent by this
 *   route — see crm/lib/retirementIntakeService.js's file-level comment.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { listIntakesForContact, markIntakeSent } = require('../lib/retirementIntakeService');

router.get('/contact/:id', (req, res) => {
  const intakes = listIntakesForContact(db, req.params.id);
  res.json(intakes);
});

router.patch('/:id', (req, res) => {
  if (req.body?.action !== 'mark_sent') {
    return res.status(400).json({ error: "Unsupported action. Only 'mark_sent' is supported." });
  }
  const intake = db.prepare('SELECT id FROM retirement_intakes WHERE id = ?').get(req.params.id);
  if (!intake) return res.status(404).json({ error: 'Not found' });

  const updated = markIntakeSent(db, req.params.id);
  res.json(updated);
});

module.exports = router;
