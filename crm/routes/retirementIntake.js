/**
 * GET  /api/retirement-intake/:token  — PUBLIC. Validates a Retirement
 *   Intake link and returns just enough to render the form header (name,
 *   appointment time, deadline, current status). No contact_id/
 *   appointment_id/intake-row id is ever included in the response — the
 *   token is the only identifier the browser holds.
 *
 * POST /api/retirement-intake/:token  — PUBLIC. Accepts the completed
 *   intake answers, validates required fields, and marks the intake
 *   Completed. Mounted in the public block of crm/server.js (same tier as
 *   /api/leads and /api/calcom) because a prospect filling this out has no
 *   CRM login — the unguessable token is what limits who can read or write
 *   any one record, exactly like a password-reset link.
 *
 * Turnstile verification happens upstream, in the website's own
 * functions/retirement-intake-submit.js Cloudflare Pages Function (mirrors
 * functions/submit-lead.js) — not here, so this route needs no new secret
 * configured on the CRM/Render side.
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const {
  buildPublicIntakeView,
  submitIntakeResponses,
} = require('../lib/retirementIntakeService');

router.get('/:token', (req, res) => {
  const view = buildPublicIntakeView(db, req.params.token);
  if (!view) return res.status(404).json({ error: 'This link is invalid or has expired.' });
  res.json(view);
});

router.post('/:token', (req, res) => {
  const result = submitIntakeResponses(db, { token: req.params.token, responses: req.body?.responses });

  if (!result.ok && result.reason === 'invalid_token') {
    return res.status(404).json({ error: 'This link is invalid or has expired.' });
  }
  if (!result.ok && result.reason === 'validation') {
    return res.status(400).json({ error: 'Please complete the required fields.', details: result.errors });
  }

  res.json({ ok: true });
});

module.exports = router;
