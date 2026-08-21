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

module.exports = { createCaseForClient, updateCase, archiveCaseForClient, restoreCase };
