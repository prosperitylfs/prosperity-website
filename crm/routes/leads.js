/**
 * POST /api/leads
 *
 * Accepts form submissions from the website. Routes every submission
 * through the brand-aware intake pipeline (crm/lib/leadSubmission.js →
 * crm/lib/leadIntake.js): dedupe/create one master contact, resolve a
 * brand ONLY from a verified caller/source mapping
 * (crm/config/leadSources.js — never from a client-supplied field), confirm
 * the contact_brand relationship, and match/create/stage a case.
 *
 * This file stays a thin wrapper — it owns only the live database handle
 * and the Express plumbing. All request-handling logic (and the tests for
 * it) live in crm/lib/leadSubmission.js, which never imports
 * crm/db/database.js, so it can be exercised against a fake in-memory
 * database in crm/test/leadsRoute.test.js.
 *
 * Supported lead_type values:
 *   "guide"           → Guide Lead (free guide form)
 *   "retirement"      → Retirement Lead
 *   "life_insurance"  → Life Insurance Lead
 *   "contact"         → General contact form
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { handleLeadSubmission } = require('../lib/leadSubmission');

router.post('/', async (req, res) => {
  const result = await handleLeadSubmission(db, { headers: req.headers, body: req.body, ip: req.ip });
  res.status(result.status).json(result.body);
});

module.exports = router;
