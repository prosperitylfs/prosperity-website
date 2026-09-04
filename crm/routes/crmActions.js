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
const taskCalendarSync = require('../lib/taskCalendarSync');
const existingClientOutreach = require('../lib/existingClientOutreach');
const templateManagerService = require('../lib/templateManagerService');

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
// Permanent delete — distinct from archive above. Requires an explicit
// confirmDelete:true in the body (the UI only sends this after its own
// type-DELETE-to-confirm modal) as a second, backend-enforced guard against
// an accidental or scripted call — never inferred, never optional.
router.post('/clients/:id/delete', handle(req => clientService.deleteClientPermanently(db, Number(req.params.id), ACTOR, {
  confirmDelete: req.body.confirmDelete === true,
})));
router.post('/clients/:id/request-company-change', handle(req => clientService.requestCompanyChange(db, {
  contactId: Number(req.params.id), requestedBrandSlug: req.body.requestedBrandSlug, reason: req.body.reason, actor: ACTOR,
})));

// ── Existing Client Reconnection outreach (Revenue MVP) ─────────────────
// See crm/lib/existingClientOutreach.js's own header comment: this is the
// ONLY place in the app that can trigger its narrow consent-gate exception,
// and only for the fixed templates in its EXISTING_CLIENT_SMS_TEMPLATES
// registry -- `templateKey` selects which one; the lib function itself
// rejects anything not in that registry.
router.post('/clients/:id/existing-client-sms', handle(req => existingClientOutreach.sendReconnectionSms(db, {
  contactId: Number(req.params.id), message: req.body.message, confirmResend: !!req.body.confirmResend,
  templateKey: req.body.templateKey,
})));
router.post('/clients/:id/existing-client-email', handle(req => existingClientOutreach.sendReconnectionEmail(db, {
  contactId: Number(req.params.id), subject: req.body.subject, body: req.body.body,
})));
router.post('/existing-client-outreach/bulk', handle(req => existingClientOutreach.bulkSendReconnectionOutreach(db, {
  contactIds: Array.isArray(req.body.contactIds) ? req.body.contactIds.map(Number) : [],
  channel: req.body.channel, message: req.body.message, subject: req.body.subject, body: req.body.body,
  confirmResend: !!req.body.confirmResend,
  templateKey: req.body.templateKey,
}).then(results => ({ results }))));

// ── Template Manager ─────────────────────────────────────────────────────
// Edits an EXISTING template's name/body(/subject) -- never its
// templateKey, never which channel it is. See
// crm/lib/templateManagerService.js's own header comment.
router.patch('/templates/:templateKey', handle(req => templateManagerService.updateTemplate(db, {
  templateKey: req.params.templateKey, channel: req.body.channel,
  label: req.body.label, subject: req.body.subject, body: req.body.body,
})));
// Creates a genuinely new template with its own fresh, stable templateKey
// (never client-supplied) -- appears in the appropriate Existing Client
// Outreach dropdown immediately, without ever overwriting an existing one.
router.post('/templates', handle((req, res) => {
  created(res);
  return templateManagerService.createTemplate(db, {
    channel: req.body.channel, label: req.body.label, subject: req.body.subject, body: req.body.body,
  });
}));

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
// Every mutation here is followed by a best-effort Google Calendar sync
// (crm/lib/taskCalendarSync.js) -- the underlying taskService call is
// unchanged and already fully committed by the time sync is even
// attempted, and syncTaskToCalendar() itself never throws, so a Calendar
// API problem can never affect the task response below it.
router.post('/tasks', handle(async (req, res) => {
  created(res);
  const task = taskService.createTask(db, req.body, ACTOR);
  const synced = await taskCalendarSync.syncTaskToCalendar(db, task.id);
  return synced.task || task;
}));
router.patch('/tasks/:id', handle(async req => {
  const task = taskService.updateTask(db, Number(req.params.id), req.body);
  const synced = await taskCalendarSync.syncTaskToCalendar(db, task.id);
  return synced.task || task;
}));
router.post('/tasks/:id/complete', handle(async req => {
  const task = taskService.completeTask(db, Number(req.params.id), ACTOR);
  const synced = await taskCalendarSync.syncTaskToCalendar(db, task.id);
  return synced.task || task;
}));
router.post('/tasks/:id/reopen', handle(async req => {
  const task = taskService.reopenTask(db, Number(req.params.id), ACTOR);
  const synced = await taskCalendarSync.syncTaskToCalendar(db, task.id);
  return synced.task || task;
}));
router.post('/tasks/:id/archive', handle(async req => {
  const task = taskService.archiveTask(db, Number(req.params.id), ACTOR);
  const synced = await taskCalendarSync.syncTaskToCalendar(db, task.id);
  return synced.task || task;
}));

// ── Activities / notes ───────────────────────────────────────────────────
// addActivity itself is unchanged and still fully synchronous -- it only
// additionally returns followUpTaskId (null when no task was created) so
// this route can trigger calendar sync without a second lookup.
router.post('/activities', handle(async (req, res) => {
  created(res);
  const activity = activityService.addActivity(db, req.body, ACTOR);
  if (activity.followUpTaskId) await taskCalendarSync.syncTaskToCalendar(db, activity.followUpTaskId);
  return activity;
}));
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
router.post('/review/contact/:intakeId/resolve', handle(req => reviewResolution.resolveContactConflict(db, {
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
// logCall/attachCallOutcome are unchanged -- both already return
// { call, followUpTask }, so the follow-up task's own calendar sync just
// hooks on here, same best-effort/never-blocking pattern as Tasks above.
router.post('/calls', handle(async (req, res) => {
  created(res);
  const result = callLogService.logCall(db, req.body, ACTOR);
  if (result.followUpTask) await taskCalendarSync.syncTaskToCalendar(db, result.followUpTask.id);
  return result;
}));
// Attaches outcome/notes/related case/follow-up to an EXISTING call record
// (one the CRM itself placed via /api/calls/outbound, auto-logged with
// direction/contact/brand/start-time/Twilio SID already captured, and kept
// updated by Twilio's own status webhooks) -- never creates a new row.
router.patch('/calls/:id', handle(async req => {
  const result = callLogService.attachCallOutcome(db, Number(req.params.id), req.body, ACTOR);
  if (result.followUpTask) await taskCalendarSync.syncTaskToCalendar(db, result.followUpTask.id);
  return result;
}));

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
