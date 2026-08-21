// Read-only JSON API for the redesigned CRM interface (crm/public/app/).
// Every handler delegates to crm/lib/dashboardQueries.js — this file owns
// only the live database handle and Express plumbing, exactly like every
// other route (crm/routes/twilio.js, crm/routes/leads.js). Mounted behind
// the same dashboardAuth + requireApiKey protection as every other private
// CRM data route (see crm/server.js) — this exposes private client data,
// never public lead intake.
//
// Every route here is READ-ONLY. Nothing in this file selects a sender,
// sends a message, or resolves a company for any purpose other than
// display/filtering. Company filtering is a viewing control only.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const {
  getCaseList,
  getClientDetail,
  getDashboardSummary,
  getWorkList,
  getUpcomingAppointments,
  getRecentlyActiveClients,
  getBrandReviewQueue,
  getCaseReviewQueue,
  getCompanyConflictQueue,
  getUnknownSmsReviewQueue,
  getMessageDeliveryStatus,
  getPoliciesList,
  getReportsSummary,
} = require('../lib/dashboardQueries');
const { BRANDS } = require('../config/brands');
const { getSenderGuardrailForCase, getSenderGuardrailForManualSelection } = require('../lib/senderGuardrail');
const { listTasks } = require('../lib/taskService');

// Normalizes the ?company= query param used throughout this API to a valid
// brandId value for crm/lib/dashboardQueries.js: null/'all' pass through as
// "no filter"; anything else must be a real, known brand slug — an unknown
// value is treated as "all" rather than silently matching nothing or
// throwing, since this only ever controls a VIEW, never a write.
function parseCompanyParam(raw) {
  if (!raw || raw === 'all') return null;
  return Object.prototype.hasOwnProperty.call(BRANDS, raw) ? raw : null;
}

router.get('/dashboard', (req, res) => {
  const brandId = parseCompanyParam(req.query.company);
  const summary = getDashboardSummary(db, { brandId });
  const workList = getWorkList(db, { brandId });
  const upcomingAppointments = getUpcomingAppointments(db, {});
  const recentlyActive = getRecentlyActiveClients(db, {});
  res.json({ summary, workList, upcomingAppointments, recentlyActive });
});

router.get('/clients', (req, res) => {
  const brandId = parseCompanyParam(req.query.company);
  const statusFilter = ['active', 'archived', 'all'].includes(req.query.status) ? req.query.status : 'active';
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const sort = ['name', 'dueDate', 'nextAction', 'lastActivity'].includes(req.query.sort) ? req.query.sort : 'name';

  const result = getCaseList(db, { brandId, statusFilter, search, page, pageSize, sort });
  res.json(result);
});

router.get('/clients/:id', (req, res) => {
  const contactId = parseInt(req.params.id, 10);
  if (!Number.isInteger(contactId)) return res.status(400).json({ error: 'Invalid client id' });
  const detail = getClientDetail(db, contactId);
  if (!detail) return res.status(404).json({ error: 'Client not found' });
  res.json(detail);
});

// Sender PREVIEW only — never sends anything, never activates a channel.
// Shows exactly what Call/Text/Email would use if the (still-disabled)
// action button were ever wired to a real send in a future checkpoint.
router.get('/clients/:id/sender-preview', (req, res) => {
  const caseId = req.query.caseId ? parseInt(req.query.caseId, 10) : null;
  const manualBrand = req.query.manualBrand || null;
  const result = caseId
    ? getSenderGuardrailForCase(db, { caseId })
    : getSenderGuardrailForManualSelection(db, { manualBrandSelection: manualBrand });
  res.json(result);
});

router.get('/review', (req, res) => {
  // Test/Archive: records a human already resolved with decision
  // 'test_archive' (see crm/lib/reviewResolution.js) — a real, read-only log,
  // empty until that resolution action has actually been used.
  const testArchiveLog = db.prepare(`
    SELECT id, source, reason, review_type, resolved_at, resolved_by
    FROM unresolved_intake WHERE decision = 'test_archive'
    ORDER BY resolved_at DESC
  `).all();

  res.json({
    brandReview: getBrandReviewQueue(db),
    caseReview: getCaseReviewQueue(db),
    companyConflicts: getCompanyConflictQueue(db),
    unknownSmsReview: getUnknownSmsReviewQueue(db),
    testArchive: testArchiveLog,
  });
});

router.get('/communications', (req, res) => {
  const brandId = parseCompanyParam(req.query.company);
  const status = ['Queued', 'Sent', 'Delivered', 'Failed'].includes(req.query.status) ? req.query.status : null;
  let items = getMessageDeliveryStatus(db, { brandId });
  if (status) items = items.filter(i => i.status === status);
  res.json({ items });
});

// Real listing for the Tasks screen — overdue|today|upcoming|completed|all.
// crm/routes/tasks.js (legacy) has no generic "all tasks" endpoint (only
// /stats and /contact/:id), so this is added here rather than touching that
// already-tested route file.
router.get('/tasks', (req, res) => {
  const filter = ['overdue', 'today', 'upcoming', 'completed', 'all'].includes(req.query.filter) ? req.query.filter : 'all';
  res.json({ items: listTasks(db, { filter }) });
});

router.get('/policies', (req, res) => {
  const brandId = parseCompanyParam(req.query.company);
  res.json({ items: getPoliciesList(db, { brandId }) });
});

router.get('/reports', (req, res) => {
  res.json(getReportsSummary(db));
});

module.exports = router;
