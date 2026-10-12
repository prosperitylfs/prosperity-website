// PUBLIC (no CRM_API_KEY/dashboard auth possible -- BackNine's own servers
// call this directly) -- protected instead by the X-BACKNINE-AUTHENTICATION
// shared-secret header, the only authentication mechanism BackNine's own
// documentation describes for these webhooks. Same "external service, own
// trust model" placement as crm/routes/calcom.js.
//
// Phase 1 only, by design -- see crm/lib/backNineWebhook.js's header comment
// for exactly why. This route:
//   - Verifies the request is genuinely from BackNine.
//   - Logs ONLY the confirmed, non-sensitive-beyond-name fields (uuid/id,
//     applicant name, product, face amount, premium, status/step) -- never
//     health, financial-detail, or other application content.
//   - Acknowledges receipt (200) so BackNine does not retry.
//   - Creates or updates NOTHING in the CRM database yet.
// Two separate secrets (one per BOSS webhook field) rather than one shared
// value, since BackNine's docs describe the secret as configured "per
// endpoint" without saying whether BOSS allows the same value for both --
// this works correctly either way (set both env vars to the same value if
// BOSS only offers one secret for the account).

const express = require('express');
const router = express.Router();
const { verifyBackNineAuth, extractConfirmedEappSummary } = require('../lib/backNineWebhook');

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
    console.warn('BackNine eApp webhook: verified request had no recognizable payload/uuid -- nothing logged or processed');
  } else {
    const applicantName = `${summary.firstName || ''} ${summary.lastName || ''}`.trim();
    console.log(
      `BackNine eApp webhook received: uuid=${summary.backNineUuid} id=${summary.backNineId} ` +
      `applicant="${applicantName}" ` +
      `product=${summary.productCategory} faceAmount=${summary.faceAmount} premium=${summary.premium} ` +
      `status=${summary.eappStatus} step=${summary.step} (${summary.namedStep}) ` +
      `caseStatus=${summary.caseStatus} -- not yet processed (Phase 1: receive + verify only)`
    );
  }

  res.status(200).json({ ok: true, received: true, processed: false });
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
