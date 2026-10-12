// PUBLIC (no CRM_API_KEY/dashboard auth possible -- BackNine's own servers
// call this directly) -- protected instead by the X-BACKNINE-AUTHENTICATION
// shared-secret header, the only authentication mechanism BackNine's own
// documentation describes for these webhooks. Same "external service, own
// trust model" placement as crm/routes/calcom.js.
//
// Phase 2: the eApp endpoint now stores/updates a backnine_applications row
// (crm/lib/backNineApplications.js) using only the confirmed fields --
// never health, financial-detail, or other application content beyond
// what's logged. Contact matching is never automatic here (see that
// file's header comment for why); every new application lands as
// match_status='needs_review' until a human matches it. The Case endpoint
// remains receive-and-log only -- see its own handler below for why.
// Two separate secrets (one per BOSS webhook field) rather than one shared
// value, since BackNine's docs describe the secret as configured "per
// endpoint" without saying whether BOSS allows the same value for both --
// this works correctly either way (set both env vars to the same value if
// BOSS only offers one secret for the account).

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { verifyBackNineAuth, extractConfirmedEappSummary } = require('../lib/backNineWebhook');
const { upsertApplicationFromEapp } = require('../lib/backNineApplications');

router.get('/eapp', (_req, res) => {
  res.json({ ok: true, message: 'BackNine eApp webhook endpoint is active' });
});

router.get('/case', (_req, res) => {
  res.json({ ok: true, message: 'BackNine Case webhook endpoint is active' });
});

router.post('/eapp', (req, res) => {
  if (!verifyBackNineAuth(req, process.env.BACKNINE_EAPP_WEBHOOK_SECRET)) {
    console.warn('BackNine eApp webhook: missing/invalid X-BACKNINE-AUTHENTICATION header -- request rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const summary = extractConfirmedEappSummary(req.body);
  if (!summary || !summary.backNineUuid) {
    console.warn('BackNine eApp webhook: verified request had no recognizable payload/uuid -- nothing stored');
    return res.status(200).json({ ok: true, received: true, processed: false });
  }

  const applicantName = `${summary.firstName || ''} ${summary.lastName || ''}`.trim();
  console.log(
    `BackNine eApp webhook received: uuid=${summary.backNineUuid} id=${summary.backNineId} ` +
    `applicant="${applicantName}" ` +
    `product=${summary.productCategory} faceAmount=${summary.faceAmount} premium=${summary.premium} ` +
    `status=${summary.eappStatus} step=${summary.step} (${summary.namedStep}) caseStatus=${summary.caseStatus}`
  );

  let result;
  try {
    result = upsertApplicationFromEapp(db, summary, req.body);
  } catch (err) {
    console.error(`BackNine eApp webhook: failed to store application uuid=${summary.backNineUuid}:`, err.message);
    return res.status(200).json({ ok: true, received: true, processed: false });
  }

  if (!result.ok) {
    if (result.reason === 'migration_not_run') {
      console.error('BackNine eApp webhook: backnine_applications table does not exist -- run crm/scripts/migrateProduction.js (migrateBackNine step) against production before this can store applications.');
    }
    return res.status(200).json({ ok: true, received: true, processed: false });
  }

  console.log(`BackNine eApp webhook: application ${result.outcome} (id=${result.application.id}, match_status=${result.application.match_status})`);
  res.status(200).json({ ok: true, received: true, processed: true, outcome: result.outcome });
});

router.post('/case', (req, res) => {
  if (!verifyBackNineAuth(req, process.env.BACKNINE_CASE_WEBHOOK_SECRET)) {
    console.warn('BackNine Case webhook: missing/invalid X-BACKNINE-AUTHENTICATION header -- request rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // The Case webhook's payload shape is not documented anywhere this
  // session could confirm -- logging only the top-level key names (never
  // values, which could include applicant PII) so the real shape is visible
  // in Render's logs the first time BOSS actually sends one, without this
  // route ever having guessed at or exposed its content.
  const topLevelKeys = req.body && typeof req.body === 'object'
    ? Object.keys(Array.isArray(req.body) ? (req.body[0] || {}) : req.body)
    : [];
  console.log(`BackNine Case webhook received -- top-level keys: [${topLevelKeys.join(', ')}] -- not yet processed (Phase 1: receive + verify only)`);

  res.status(200).json({ ok: true, received: true, processed: false });
});

module.exports = router;
