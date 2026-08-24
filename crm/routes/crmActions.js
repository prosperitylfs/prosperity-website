// Mutation endpoints for the redesigned CRM interface (crm/public/app/).
// This file owns only the live database handle and Express plumbing —
// every actual rule lives in the crm/lib/*Service.js modules it delegates
// to. Mounted at the same /api/app prefix and behind the same
// dashboardAuth + requireApiKey protection as crm/routes/crmApp.js (see
// crm/server.js).
//
// ACTOR: this is a single-operator local CRM with no per-request session
// user yet — every action is attributed to a fixed actor string here at the
// route layer (never trusted from the request body, which would let a
// client spoof the audit trail).

const express = require('express');
const router = express.Router();
const db = require('../db/database');

const ACTOR = 'Loretta Stewart';

const clientService = require('../lib/clientService');
const caseService = require('../lib/caseService');
const policyService = require('../lib/policyService');
const taskService = require('../lib/taskService');
const activityService = require('../lib/activityService');
const importService = require('../lib/importService');
const draftService = require('../lib/communicationDraftService');
const reviewResolution = require('../lib/reviewResolution');
const callLogService = require('../lib/callLogService');

function handle(fn) {
  return (req, res) => {
    try {
      const result = fn(req, res);
      if (result && typeof result.then === 'function') {
        result.then(value => res.status(res.__status || 200).json(value)).catch(err => sendError(res, err));
      } else {
        res.status(res.__status || 200).json(result);
      }
    } catch (err) {
      sendError(res, err);
    }
  };
}
function sendError(res, err) {
  console.error('[crmActions] error:', err.message);
  res.status(400).json({ error: err.message });
}
function created(res) { res.__status = 201; return res; }

// ── Clients ──────────────────────────────────────────────────────────────
router.post('/clients', handle((req, res) => { created(res); return clientService.createClient(db, req.body, ACTOR); }));
router.patch('/clients/:id', handle(req => clientService.updateClient(db, Number(req.params.id), req.body)));
router.post('/clients/:id/archive', handle(req => clientService.archiveClient(db, Number(req.params.id), ACTOR)));
router.post('/clients/:id/restore', handle(req => clientService.restoreClient(db, Number(req.params.id), ACTOR)));
router.post('/clients/:id/request-company-change', handle(req => clientService.requestCompanyChange(db, {
  contactId: Number(req.params.id), requestedBrandSlug: req.body.requestedBrandSlug, reason: req.body.reason, actor: ACTOR,
})));

// ── Cases ────────────────────────────────────────────────────────────────
// productName -> productId is resolved here, scoped to the CLIENT'S OWN
// active brand (never a client-supplied brand) — this is a display-name
// convenience for the frontend only; it never influences which company the
// case belongs to (that's already fixed by createCaseForClient inheriting
// the client's existing relationship).
function resolveProductId(req) {
  if (req.body.productId) return req.body.productId;
  if (!req.body.productName) return null;
  const link = db.prepare(`SELECT b.id AS brand_row_id FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.contact_id = ? AND cb.status = 'Active'`).get(req.body.contactId);
  if (!link) return null;
  const product = db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(link.brand_row_id, req.body.productName);
  return product ? product.id : null;
}
router.post('/cases', handle((req, res) => { created(res); return caseService.createCaseForClient(db, { ...req.body, productId: resolveProductId(req) }, ACTOR); }));
router.patch('/cases/:id', handle(req => caseService.updateCase(db, Number(req.params.id), req.body)));
router.post('/cases/:id/archive', handle(req => caseService.archiveCaseForClient(db, Number(req.params.id), ACTOR)));
router.post('/cases/:id/restore', handle(req => caseService.restoreCase(db, Number(req.params.id), ACTOR)));

// ── Policies ─────────────────────────────────────────────────────────────
router.post('/policies', handle((req, res) => { created(res); return policyService.createPolicy(db, req.body, ACTOR); }));
router.patch('/policies/:id', handle(req => policyService.updatePolicy(db, Number(req.params.id), req.body)));
router.post('/policies/:id/archive', handle(req => policyService.archivePolicy(db, Number(req.params.id), ACTOR)));
router.post('/policies/:id/restore', handle(req => policyService.restorePolicy(db, Number(req.params.id), ACTOR)));

// ── Tasks ────────────────────────────────────────────────────────────────
router.post('/tasks', handle((req, res) => { created(res); return taskService.createTask(db, req.body, ACTOR); }));
router.patch('/tasks/:id', handle(req => taskService.updateTask(db, Number(req.params.id), req.body)));
router.post('/tasks/:id/complete', handle(req => taskService.completeTask(db, Number(req.params.id), ACTOR)));
router.post('/tasks/:id/reopen', handle(req => taskService.reopenTask(db, Number(req.params.id), ACTOR)));
router.post('/tasks/:id/archive', handle(req => taskService.archiveTask(db, Number(req.params.id), ACTOR)));

// ── Activities / notes ───────────────────────────────────────────────────
router.post('/activities', handle((req, res) => { created(res); return activityService.addActivity(db, req.body, ACTOR); }));
router.patch('/activities/:id', handle(req => activityService.editActivity(db, Number(req.params.id), req.body, ACTOR)));
router.post('/activities/:id/archive', handle(req => activityService.archiveActivity(db, Number(req.params.id), ACTOR)));
router.get('/activities/:id/history', handle(req => activityService.listActivityHistory(db, Number(req.params.id))));
router.post('/notes', handle((req, res) => { created(res); return activityService.addNote(db, req.body, ACTOR); }));
router.patch('/notes/:id', handle(req => activityService.editNote(db, Number(req.params.id), req.body, ACTOR)));

// ── Review Required actions ─────────────────────────────────────────────
router.post('/review/brand/:intakeId/resolve', handle(req => reviewResolution.resolveBrandReviewItem(db, {
  intakeId: Number(req.params.intakeId), decision: req.body.decision, actor: ACTOR,
})));
// productName -> productId is resolved here, scoped to the INTAKE'S OWN
// contact_brand_id (never a client-supplied brand) — matches the same
// narrow display-name convenience used for /cases above.
function resolveProductIdForIntake(intakeId, body) {
  if (body.productId) return body.productId;
  if (!body.productName) return null;
  const intake = db.prepare('SELECT contact_brand_id FROM unresolved_intake WHERE id = ?').get(intakeId);
  if (!intake || !intake.contact_brand_id) return null;
  const link = db.prepare('SELECT brand_id FROM contact_brands WHERE id = ?').get(intake.contact_brand_id);
  if (!link) return null;
  const product = db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(link.brand_id, body.productName);
  return product ? product.id : null;
}
router.post('/review/case/:intakeId/resolve', handle(req => reviewResolution.resolveCaseReviewItem(db, {
  intakeId: Number(req.params.intakeId), action: req.body.action, targetCaseId: req.body.targetCaseId,
  productId: resolveProductIdForIntake(Number(req.params.intakeId), req.body), actor: ACTOR,
})));
router.post('/review/company/:intakeId/resolve', handle(req => reviewResolution.resolveCompanyConflict(db, {
  intakeId: Number(req.params.intakeId), action: req.body.action, actor: ACTOR,
})));
router.post('/review/unknown-sms/:intakeId/resolve', handle(req => reviewResolution.resolveUnknownSmsReview(db, {
  intakeId: Number(req.params.intakeId), action: req.body.action,
  contactId: req.body.contactId ? Number(req.body.contactId) : null,
  firstName: req.body.firstName, lastName: req.body.lastName,
  actor: ACTOR,
})));
router.post('/review/:intakeId/archive', handle(req => reviewResolution.archiveReviewItem(db, {
  intakeId: Number(req.params.intakeId), actor: ACTOR,
})));

// ── Manual call logging (Prosperity Revenue MVP, Requirement 5) ────────
router.post('/calls', handle((req, res) => { created(res); return callLogService.logCall(db, req.body, ACTOR); }));
// Attaches outcome/notes/related case/follow-up to an EXISTING call record
// (one the CRM itself placed via /api/calls/outbound, auto-logged with
// direction/contact/brand/start-time/Twilio SID already captured, and kept
// updated by Twilio's own status webhooks) -- never creates a new row.
router.patch('/calls/:id', handle(req => callLogService.attachCallOutcome(db, Number(req.params.id), req.body, ACTOR)));

// ── Communications (draft-and-confirm; sending is always blocked) ──────
router.post('/communications/draft', handle((req, res) => { created(res); return draftService.createDraft(db, req.body, ACTOR); }));
router.post('/communications/draft/:id/confirm-send', handle(req => draftService.confirmSend(db, Number(req.params.id), ACTOR)));
router.post('/communications/call-preview', handle(req => draftService.previewCall(db, req.body)));

// ── CSV import ───────────────────────────────────────────────────────────
router.get('/import/sample-csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sample-clients.csv"');
  res.send(importService.generateSampleCsv());
});
router.get('/import/client-policy-sample-csv', (req, res) => {
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sample-client-policy-import.csv"');
  res.send(importService.generateClientPolicySampleCsv());
});
router.post('/import/parse', handle(req => importService.parseCsv(req.body.csvText || '')));
router.post('/import/preview', handle(req => importService.runImport(db, { ...req.body, dryRun: true, actor: ACTOR })));
router.post('/import/commit', handle(req => importService.runImport(db, { ...req.body, dryRun: false, actor: ACTOR })));
router.get('/import/:batchId', handle(req => importService.getImportBatch(db, Number(req.params.batchId))));

module.exports = router;
