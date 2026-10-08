// Case create/edit/archive/restore for the redesigned CRM. Every function
// takes an explicit better-sqlite3 `db` handle — never opens a connection
// itself, never imports crm/db/database.js.
//
// A case always inherits the client's existing, already-resolved
// contact_brand relationship — this module never accepts a brand/company
// parameter and never creates a contact_brands row, so "creating a case
// must never create a second company assignment" is true by construction,
// not by a runtime check.

const { createCase, findCaseByExternalRef, attachExternalRef } = require('./caseMatching');
const { toStringOrNull } = require('./leadNormalize');

function activeContactBrand(db, contactId) {
  return db.prepare(`SELECT * FROM contact_brands WHERE contact_id = ? AND status = 'Active'`).get(contactId);
}

// Separate opportunities remain separate cases: this simply creates a new
// case row every time it's called (no "reuse an open case" behavior — that
// convenience belongs to automatic intake's matchOrCreateCase, not a
// deliberate manual "New Case" action). Duplicate external references are
// still blocked exactly like automatic intake.
function createCaseForClient(db, { contactId, productId, title, externalRef, refType }, actor) {
  if (!actor) throw new Error('createCaseForClient: actor is required for the audit trail');
  const link = activeContactBrand(db, contactId);
  if (!link) throw new Error('createCaseForClient: this client has no active company assignment to create a case under');

  const ref = toStringOrNull(externalRef);
  if (ref) {
    const existingCaseForRef = findCaseByExternalRef(db, refType || 'manual_case_ref', ref);
    if (existingCaseForRef) {
      throw new Error(`createCaseForClient: external reference '${ref}' already belongs to case ${existingCaseForRef.id} — refusing to create a duplicate`);
    }
  }

  const newCase = createCase(db, { contactBrandId: link.id, productId: productId || null, title: toStringOrNull(title) });
  if (ref) attachExternalRef(db, newCase.id, refType || 'manual_case_ref', ref);
  return newCase;
}

// Never accepts contactBrandId — a case cannot be moved to a different
// client or company through this function.
function updateCase(db, caseId, { productId, status, title }) {
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!existing) throw new Error(`updateCase: case ${caseId} does not exist`);
  db.prepare(`
    UPDATE cases SET
      product_id = COALESCE(@product_id, product_id),
      status     = COALESCE(@status, status),
      title      = COALESCE(@title, title),
      closed_at  = CASE WHEN @status = 'Archived' THEN CURRENT_TIMESTAMP ELSE closed_at END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ product_id: productId || null, status: status || null, title: toStringOrNull(title), id: caseId });
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
}

// Archiving affects only this one case row -- never the contact, the
// contact_brands relationship, or any other case.
function archiveCaseForClient(db, caseId, actor) {
  if (!actor) throw new Error('archiveCaseForClient: actor is required');
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!existing) throw new Error(`archiveCaseForClient: case ${caseId} does not exist`);
  db.prepare("UPDATE cases SET status = 'Archived', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(caseId);
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
}

function restoreCase(db, caseId, actor) {
  if (!actor) throw new Error('restoreCase: actor is required');
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!existing) throw new Error(`restoreCase: case ${caseId} does not exist`);
  db.prepare("UPDATE cases SET status = 'Open', closed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(caseId);
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// Permanent case delete (2026-10-07). A case can hold one or more policies
// (crm/lib/policyService.js), and deleting a case must NEVER take a real
// policy down with it — this is the one hard rule the whole feature exists
// to enforce, checked here in code, not just suggested by a frontend
// confirmation dialog.
//
// A policy counts as carrying real information (and therefore blocks
// deletion) if ANY of these fields is populated, OR its status was ever
// moved off the bare schema default. premium_frequency is deliberately
// excluded -- a frequency with no premium amount carries no information on
// its own. policy_status needs its own comparison (not blank/empty) since
// it is NOT NULL with a 'Pending' default (crm/lib/policyService.js) --
// every policy row has SOME status from the moment it's created, so
// "blank" never applies to it the way it does to every other field; only
// a status that is still exactly the untouched default, with every other
// field also untouched, counts as "no meaningful information."
const MEANINGFUL_POLICY_FIELDS = [
  'carrier', 'policy_number', 'policy_type', 'effective_date', 'premium',
  'coverage_amount', 'beneficiary', 'renewal_date', 'application_date', 'notes',
];

function isPolicyMeaningless(policy) {
  const fieldsBlank = MEANINGFUL_POLICY_FIELDS.every(f => {
    const v = policy[f];
    return v === null || v === undefined || v === '';
  });
  const statusIsUntouchedDefault = !policy.policy_status || policy.policy_status === 'Pending';
  return fieldsBlank && statusIsUntouchedDefault;
}

// Read-only: what a Delete confirmation should show, and whether deletion
// is actually allowed. Never writes anything -- safe to call as many times
// as the UI needs (e.g. to render the confirmation dialog) without any
// side effect, and reused by deleteCaseForClient below as the single source
// of truth for eligibility so the UI's preview and the backend's actual
// enforcement can never disagree.
function getCaseDeletionPreview(db, caseId) {
  const kase = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!kase) throw new Error(`getCaseDeletionPreview: case ${caseId} does not exist`);
  const product = kase.product_id ? db.prepare('SELECT name FROM products WHERE id = ?').get(kase.product_id) : null;
  const policies = db.prepare('SELECT * FROM policies WHERE case_id = ?').all(caseId);
  const blockingPolicies = policies.filter(p => !isPolicyMeaningless(p));

  return {
    caseId: kase.id,
    caseTitle: kase.title || (product && product.name) || `Case #${kase.id}`,
    policyCount: policies.length,
    policyNumbers: policies.map(p => p.policy_number).filter(Boolean),
    carriers: [...new Set(policies.map(p => p.carrier).filter(Boolean))],
    eligible: blockingPolicies.length === 0,
    blockingPolicies: blockingPolicies.map(p => ({
      id: p.id, policyNumber: p.policy_number, carrier: p.carrier, status: p.policy_status,
    })),
  };
}

// Tables that gained a plain, nullable case_id column with NO explicit
// ON DELETE action (crm/db/migrateBrands.js's addDownstreamReferences) --
// under SQLite's foreign_keys=ON (crm/db/database.js), deleting a case
// that one of these still points to would otherwise throw a foreign key
// constraint error, not silently cascade. Clearing the pointer (never the
// row itself -- the task/communication/appointment/etc. stays, it just
// loses its case association) mirrors exactly what
// crm/lib/clientService.js's deleteClientPermanently already does for the
// same columns when deleting a whole client.
//
// Every OTHER case_id reference in the schema already has an explicit
// ON DELETE action and needs no manual handling here:
//   policies, case_external_refs, case_brand_transfers -> ON DELETE CASCADE
//   activities, communication_drafts                   -> ON DELETE SET NULL
const TABLES_WITH_PLAIN_CASE_REF = [
  'comm_calls', 'sms_messages', 'emails', 'appointments', 'follow_up_tasks', 'contact_notes', 'communications',
];

// Permanently deletes ONE case and its (confirmed empty) policies -- never
// the client, never the contact_brands relationship, never any other case.
// Refuses outright if the case holds any policy with real information on
// file (see isPolicyMeaningless above) -- there is no override/force flag;
// the only way to remove a case like that is to first fix/clear the
// incorrect policy information through the existing policy-edit workflow,
// or to Archive the case instead (reversible, and already exists).
function deleteCaseForClient(db, caseId, actor, { confirmDelete } = {}) {
  if (!actor) throw new Error('deleteCaseForClient: actor is required for the audit trail');
  if (!confirmDelete) throw new Error('deleteCaseForClient: explicit confirmation is required to permanently delete a case');

  const preview = getCaseDeletionPreview(db, caseId); // throws if the case does not exist
  if (!preview.eligible) {
    const examples = preview.blockingPolicies
      .map(p => p.policyNumber || p.carrier || `policy #${p.id}`)
      .join(', ');
    throw new Error(
      `deleteCaseForClient: case ${caseId} has ${preview.blockingPolicies.length} ` +
      `polic${preview.blockingPolicies.length === 1 ? 'y' : 'ies'} with real information on file ` +
      `(${examples}) -- refusing to delete. Archive the case instead to hide it without losing data, ` +
      `or correct/clear the policy information first if it is genuinely a mistaken duplicate.`
    );
  }

  const run = db.transaction(() => {
    for (const table of TABLES_WITH_PLAIN_CASE_REF) {
      if (!tableExists(db, table)) continue;
      db.prepare(`UPDATE ${table} SET case_id = NULL WHERE case_id = ?`).run(caseId);
    }
    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);
  });
  run();

  return { deleted: true, caseId, policiesRemoved: preview.policyCount };
}

module.exports = {
  createCaseForClient, updateCase, archiveCaseForClient, restoreCase,
  getCaseDeletionPreview, deleteCaseForClient,
};
