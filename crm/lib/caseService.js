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
const { createPolicy, updatePolicy } = require('./policyService');

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

// Which seeded product name (crm/db/migrateBrands.js) represents "Annuity"
// for whichever brand a contact's ACTIVE contact_brands relationship
// actually resolves to -- never guessed/hardcoded to one brand slug, so
// this works correctly for either company without this module needing to
// know brand slugs at all. Both brands seed exactly one of these two names
// (Prosperity: 'Annuities'; Insurance Lady: 'Annuities and safe-money
// solutions') -- crm/public/app/client.html's own ANNUITY_PRODUCT_BY_BRAND
// constant must stay in sync with this exact list.
const ANNUITY_PRODUCT_NAMES = ['Annuities', 'Annuities and safe-money solutions'];

function getAnnuityProductForContactBrand(db, contactBrandId) {
  const link = db.prepare('SELECT * FROM contact_brands WHERE id = ?').get(contactBrandId);
  if (!link) return null;
  const placeholders = ANNUITY_PRODUCT_NAMES.map(() => '?').join(',');
  return db.prepare(`SELECT * FROM products WHERE brand_id = ? AND name IN (${placeholders})`).get(link.brand_id, ...ANNUITY_PRODUCT_NAMES);
}

// New Case -> Annuity workflow (2026-10-08). Creates (or, when caseId is
// supplied, updates) ONE case + its ONE annuity contract/policy together,
// in a single transaction -- the case and the policy always save together
// or neither does. Reuses createCaseForClient/updateCase (this file) and
// createPolicy/updatePolicy (crm/lib/policyService.js) completely
// unchanged; no parallel/duplicate case or policy write path is
// introduced. Each distinct annuity contract gets its OWN case (the same
// "separate opportunities remain separate cases" rule createCaseForClient
// already documents above) -- a client's SECOND annuity contract is a
// second, independent New Case -> Annuity call, never attached to the
// first one's case.
//
// Double-submission (e.g. an impatient double-click on Save Annuity) is
// guarded the same way every other create-with-policy flow in this app
// already is -- crm/public/app/client.html disables the Save button
// immediately on click, exactly like addLifeInsurancePolicyModal's own
// submit handler already does; this function itself has no separate
// idempotency key, matching that same established, accepted pattern
// rather than inventing a new one.
//
// fields: carrier, contractNumber, annuityType, contractStatus,
// initialPremium, currentAccountValue, effectiveDate, applicationDate,
// surrenderPeriodYears, beneficiary, notes. currentAccountValue is
// deliberately optional throughout -- never defaulted, never required.
function saveAnnuityCase(db, { contactId, caseId, fields }, actor) {
  if (!actor) throw new Error('saveAnnuityCase: actor is required for the audit trail');
  const f = fields || {};
  const policyFields = {
    carrier: f.carrier,
    policyNumber: f.contractNumber,
    policyType: f.annuityType,
    policyStatus: f.contractStatus || 'Pending',
    premium: f.initialPremium,
    coverageAmount: f.currentAccountValue,
    effectiveDate: f.effectiveDate,
    applicationDate: f.applicationDate,
    surrenderPeriodYears: f.surrenderPeriodYears,
    beneficiary: f.beneficiary,
    notes: f.notes,
  };
  const title = toStringOrNull(f.carrier) ? `${f.carrier} — Annuity` : 'Annuity';

  const run = db.transaction(() => {
    if (caseId) {
      // EDIT: update the existing case + its existing policy in place --
      // never creates a second case or a second policy for this contract.
      const existingCase = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
      if (!existingCase) throw new Error(`saveAnnuityCase: case ${caseId} does not exist`);
      const updatedCase = updateCase(db, caseId, { title });
      const existingPolicy = db.prepare('SELECT * FROM policies WHERE case_id = ? ORDER BY id ASC').get(caseId);
      const policy = existingPolicy
        ? updatePolicy(db, existingPolicy.id, policyFields)
        : createPolicy(db, { ...policyFields, caseId }, actor);
      return { case: updatedCase, policy, outcome: 'updated' };
    }

    // CREATE: resolve the brand's annuity product from the contact's own
    // active relationship (never guessed, never client-supplied) and
    // create the case + policy together.
    const link = activeContactBrand(db, contactId);
    if (!link) throw new Error('saveAnnuityCase: this client has no active company assignment to create a case under');
    const product = getAnnuityProductForContactBrand(db, link.id);
    if (!product) throw new Error('saveAnnuityCase: no Annuity product is configured for this client\'s company — has crm/db/migrateBrands.js been run?');

    const newCase = createCaseForClient(db, { contactId, productId: product.id, title }, actor);
    const policy = createPolicy(db, { ...policyFields, caseId: newCase.id }, actor);
    return { case: newCase, policy, outcome: 'created' };
  });
  return run();
}

// Life & Annuities tab (2026-10-10): permanently deletes ONE annuity case
// together with its one contract/policy -- unlike deleteCaseForClient
// above, this is NEVER blocked by "the policy has real information on
// file." That restriction exists to stop a case delete from taking a real
// policy down as collateral damage when the case itself might hold
// several policies of unclear importance; here the user is looking
// directly at this one named annuity contract and deliberately deleting
// it, the same single-record, individually-confirmed action
// crm/lib/policyService.js's deletePolicy already is for a life insurance
// policy (see its own comment: "not subject to deleteCaseForClient's
// restriction -- that protects against deleting a WHOLE CASE as
// collateral damage, not against this explicit, single-record action").
// `policies.case_id` is ON DELETE CASCADE (crm/db/migrateBrands.js), so
// deleting the case row removes its one policy with it in the same
// statement -- no separate policy delete call needed.
function deleteAnnuityCase(db, caseId, actor, { confirmDelete } = {}) {
  if (!actor) throw new Error('deleteAnnuityCase: actor is required for the audit trail');
  if (!confirmDelete) throw new Error('deleteAnnuityCase: explicit confirmation is required to permanently delete an annuity');
  const kase = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!kase) throw new Error(`deleteAnnuityCase: case ${caseId} does not exist`);
  const annuityProduct = getAnnuityProductForContactBrand(db, kase.contact_brand_id);
  if (!annuityProduct || kase.product_id !== annuityProduct.id) {
    throw new Error(`deleteAnnuityCase: case ${caseId} is not an annuity case -- refusing to delete`);
  }
  const policiesRemoved = db.prepare('SELECT COUNT(*) AS n FROM policies WHERE case_id = ?').get(caseId).n;

  const run = db.transaction(() => {
    for (const table of TABLES_WITH_PLAIN_CASE_REF) {
      if (!tableExists(db, table)) continue;
      db.prepare(`UPDATE ${table} SET case_id = NULL WHERE case_id = ?`).run(caseId);
    }
    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);
  });
  run();

  return { deleted: true, caseId, policiesRemoved };
}

module.exports = {
  createCaseForClient, updateCase, archiveCaseForClient, restoreCase,
  getCaseDeletionPreview, deleteCaseForClient,
  saveAnnuityCase, deleteAnnuityCase, ANNUITY_PRODUCT_NAMES,
};
