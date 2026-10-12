// Private CRM routes (mounted under /api/app, behind the same
// requireApiKey + dashboardAuth tier as every other crmApp/crmActions
// route) for BackNine application manual matching -- see
// crm/lib/backNineApplications.js's header comment for why matching is
// always a human action here, never automatic.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { listNeedsReviewApplications, matchApplicationToContact, getApplicationById } = require('../lib/backNineApplications');

const ACTOR = 'Loretta Stewart';

router.get('/backnine-applications/needs-review', (_req, res) => {
  res.json({ applications: listNeedsReviewApplications(db) });
});

// Detail view -- same structured fields as the list endpoints (never
// raw_payload; see getApplicationById's own comment).
router.get('/backnine-applications/:id', (req, res) => {
  const applicationId = Number(req.params.id);
  if (!Number.isInteger(applicationId)) return res.status(400).json({ error: 'invalid application id' });
  const application = getApplicationById(db, applicationId);
  if (!application) return res.status(404).json({ error: 'not found' });
  res.json({ application });
});

router.post('/backnine-applications/:id/match', (req, res) => {
  const applicationId = Number(req.params.id);
  const contactId = Number(req.body && req.body.contactId);
  if (!Number.isInteger(applicationId) || !Number.isInteger(contactId)) {
    return res.status(400).json({ error: 'applicationId and contactId are required' });
  }
  try {
    const application = matchApplicationToContact(db, { applicationId, contactId, actor: ACTOR });
    res.json({ application });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
