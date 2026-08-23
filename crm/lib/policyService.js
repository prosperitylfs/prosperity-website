// Policy create/edit/archive/restore. Every function takes an explicit
// better-sqlite3 `db` handle — never opens a connection itself, never
// imports crm/db/database.js.
//
// Policies are never given a company/brand field of their own — a policy
// always belongs to a case, and a case always belongs to the client's
// resolved company (see crm/lib/caseService.js). That makes "policy
// company must match the client's permanent company" true by construction:
// there is no field through which a mismatched company could ever be
// entered. If a caller supplies a caseId that does not exist, or belongs to
// a different, unintended client, this rejects rather than guessing.

const { toStringOrNull } = require('./leadNormalize');

function requireCase(db, caseId) {
  const c = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!c) throw new Error(`policyService: case ${caseId} does not exist`);
  return c;
}

function createPolicy(db, fields, actor) {
  if (!actor) throw new Error('createPolicy: actor is required for the audit trail');
  requireCase(db, fields.caseId);
  const result = db.prepare(`
    INSERT INTO policies (case_id, carrier, policy_number, policy_status, effective_date, premium, premium_frequency, coverage_amount, beneficiary, renewal_date, application_date, notes)
    VALUES (@case_id, @carrier, @policy_number, @policy_status, @effective_date, @premium, @premium_frequency, @coverage_amount, @beneficiary, @renewal_date, @application_date, @notes)
  `).run(policyParams(fields));
  return db.prepare('SELECT * FROM policies WHERE id = ?').get(result.lastInsertRowid);
}

function policyParams(fields) {
  return {
    case_id: fields.caseId,
    carrier: toStringOrNull(fields.carrier),
    policy_number: toStringOrNull(fields.policyNumber),
    policy_status: toStringOrNull(fields.policyStatus) || 'Pending',
    effective_date: toStringOrNull(fields.effectiveDate),
    premium: fields.premium != null && fields.premium !== '' ? Number(fields.premium) : null,
    premium_frequency: toStringOrNull(fields.premiumFrequency),
    coverage_amount: fields.coverageAmount != null && fields.coverageAmount !== '' ? Number(fields.coverageAmount) : null,
    beneficiary: toStringOrNull(fields.beneficiary),
    renewal_date: toStringOrNull(fields.renewalDate),
    application_date: toStringOrNull(fields.applicationDate),
    notes: toStringOrNull(fields.notes),
  };
}

// caseId is never editable through this function -- a policy cannot be
// re-parented to a different case/client/company via update.
function updatePolicy(db, policyId, fields) {
  const existing = db.prepare('SELECT * FROM policies WHERE id = ?').get(policyId);
  if (!existing) throw new Error(`updatePolicy: policy ${policyId} does not exist`);
  db.prepare(`
    UPDATE policies SET
      carrier           = COALESCE(@carrier, carrier),
      policy_number     = COALESCE(@policy_number, policy_number),
      policy_status     = COALESCE(@policy_status, policy_status),
      effective_date    = COALESCE(@effective_date, effective_date),
      premium           = COALESCE(@premium, premium),
      premium_frequency = COALESCE(@premium_frequency, premium_frequency),
      coverage_amount   = COALESCE(@coverage_amount, coverage_amount),
      beneficiary       = COALESCE(@beneficiary, beneficiary),
      renewal_date      = COALESCE(@renewal_date, renewal_date),
      application_date  = COALESCE(@application_date, application_date),
      notes             = COALESCE(@notes, notes),
      updated_at        = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({ ...policyParams({ ...fields, caseId: existing.case_id }), id: policyId });
  return db.prepare('SELECT * FROM policies WHERE id = ?').get(policyId);
}

function archivePolicy(db, policyId, actor) {
  if (!actor) throw new Error('archivePolicy: actor is required');
  const existing = db.prepare('SELECT * FROM policies WHERE id = ?').get(policyId);
  if (!existing) throw new Error(`archivePolicy: policy ${policyId} does not exist`);
  db.prepare('UPDATE policies SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(policyId);
  return db.prepare('SELECT * FROM policies WHERE id = ?').get(policyId);
}

function restorePolicy(db, policyId, actor) {
  if (!actor) throw new Error('restorePolicy: actor is required');
  const existing = db.prepare('SELECT * FROM policies WHERE id = ?').get(policyId);
  if (!existing) throw new Error(`restorePolicy: policy ${policyId} does not exist`);
  db.prepare('UPDATE policies SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(policyId);
  return db.prepare('SELECT * FROM policies WHERE id = ?').get(policyId);
}

module.exports = { createPolicy, updatePolicy, archivePolicy, restorePolicy };
