// Tests for crm/lib/caseService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createCaseForClient, updateCase, archiveCaseForClient, restoreCase, getCaseDeletionPreview, deleteCaseForClient, saveAnnuityCase, deleteAnnuityCase } = require('../lib/caseService');
const { createClient } = require('../lib/clientService');
const { createPolicy } = require('../lib/policyService');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  runCrmCoreMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}
function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

test('a new case inherits the client permanent company and never creates a second company assignment', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Wren', email: 'wren2@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const productId = getProductId(db, prosperityId, 'Life insurance');
  const newCase = createCaseForClient(db, { contactId: client.contact.id, productId, title: 'Life insurance' }, 'Loretta Stewart');
  assert.equal(newCase.contact_brand_id, client.contactBrand.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_brands WHERE contact_id = ?').get(client.contact.id).n, 1);
});

test('separate opportunities remain separate cases', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Ivy', email: 'ivy@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const life = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const annuity = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Annuities') }, 'Loretta Stewart');
  assert.notEqual(life.id, annuity.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(client.contactBrand.id).n, 2);
});

test('duplicate external references remain blocked for manual case creation', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Kian', email: 'kian@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), externalRef: 'ref-001' }, 'Loretta Stewart');
  assert.throws(() => createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Annuities'), externalRef: 'ref-001' }, 'Loretta Stewart'), /already belongs to case/);
});

test('archiving one case affects only that case', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Lior', email: 'lior@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const life = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const annuity = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Annuities') }, 'Loretta Stewart');
  archiveCaseForClient(db, life.id, 'Loretta Stewart');
  const lifeAfter = db.prepare('SELECT * FROM cases WHERE id = ?').get(life.id);
  const annuityAfter = db.prepare('SELECT * FROM cases WHERE id = ?').get(annuity.id);
  assert.equal(lifeAfter.status, 'Archived');
  assert.equal(annuityAfter.status, 'Open');
  const clientAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(clientAfter.archived_at, null, 'archiving a case must never archive the client');
});

test('restoring a case sets it back to Open', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Mira', email: 'mira@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  archiveCaseForClient(db, c.id, 'Loretta Stewart');
  const restored = restoreCase(db, c.id, 'Loretta Stewart');
  assert.equal(restored.status, 'Open');
  assert.equal(restored.closed_at, null);
});

test('updateCase edits product/status/title but never the contact_brand_id', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Noor', email: 'noor@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const updated = updateCase(db, c.id, { title: 'Updated title', contactBrandId: 999999 });
  assert.equal(updated.title, 'Updated title');
  assert.equal(updated.contact_brand_id, client.contactBrand.id);
});

// ── Permanent case delete (2026-10-07) ──────────────────────────────────
// A case can hold one or more policies (crm/lib/policyService.js) --
// deleting a case must never take a real policy down with it. These tests
// exist specifically to prove a valid/meaningful policy can never be
// deleted this way, no matter how the case is reached.

test('getCaseDeletionPreview reports an empty case (no policies at all) as eligible', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Empty', lastName: 'Case', email: 'empty-case@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');

  const preview = getCaseDeletionPreview(db, c.id);
  assert.equal(preview.eligible, true);
  assert.equal(preview.policyCount, 0);
  assert.deepEqual(preview.policyNumbers, []);
  assert.deepEqual(preview.blockingPolicies, []);
});

test('getCaseDeletionPreview reports a case whose ONLY policy is a blank placeholder row (no carrier, no number, default Pending status) as eligible', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Blank', lastName: 'Policy', email: 'blank-policy@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id }, 'Loretta Stewart'); // every field omitted -- the exact Mae-Bell-style bug shape, minus the carrier/number

  const preview = getCaseDeletionPreview(db, c.id);
  assert.equal(preview.eligible, true);
  assert.equal(preview.policyCount, 1);
});

test('getCaseDeletionPreview blocks a case with a carrier+policy number on file, even if status is still the default Pending', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Mae', lastName: 'Example', email: 'mae-preview@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id, carrier: 'Occidental Life', policyNumber: '005178887E' }, 'Loretta Stewart');

  const preview = getCaseDeletionPreview(db, c.id);
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockingPolicies.length, 1);
  assert.equal(preview.blockingPolicies[0].policyNumber, '005178887E');
  assert.deepEqual(preview.policyNumbers, ['005178887E']);
  assert.deepEqual(preview.carriers, ['Occidental Life']);
});

test('getCaseDeletionPreview blocks a case whose policy has an explicit In Force status, even if every other field happens to be blank', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'InForce', lastName: 'Only', email: 'inforce-only@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id, policyStatus: 'In Force' }, 'Loretta Stewart');

  const preview = getCaseDeletionPreview(db, c.id);
  assert.equal(preview.eligible, false, 'a deliberately-set non-default status must still block deletion');
});

test('deleteCaseForClient requires actor and explicit confirmDelete', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Guard', lastName: 'Rails', email: 'guard-rails@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  assert.throws(() => deleteCaseForClient(db, c.id, null, { confirmDelete: true }));
  assert.throws(() => deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: false }));
  assert.throws(() => deleteCaseForClient(db, c.id, 'Loretta Stewart', {}));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 1, 'none of the rejected calls above may have deleted anything');
});

test('deleteCaseForClient deletes a genuinely empty case', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Delete', lastName: 'Me', email: 'delete-me@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  const result = deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 0);
  // The client and its company relationship must survive untouched.
  const contactAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contactAfter.archived_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_brands WHERE contact_id = ?').get(client.contact.id).n, 1);
});

test('deleteCaseForClient deletes a case whose only policy is a blank placeholder row, removing that policy along with it', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Blank', lastName: 'Delete', email: 'blank-delete@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id }, 'Loretta Stewart');

  const result = deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.policiesRemoved, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(policy.id).n, 0, 'the blank policy row is gone along with its case');
});

test('deleteCaseForClient REFUSES to delete a case with a real policy on file (Mae Bell shape) -- the policy and case both survive untouched', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Mae', lastName: 'Example', email: 'mae-delete@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'Occidental Life', policyNumber: '005178887E', policyStatus: 'In Force' }, 'Loretta Stewart');

  assert.throws(
    () => deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true }),
    /005178887E/,
    'the error must name the specific blocking policy'
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 1, 'the case must still exist');
  const policyAfter = db.prepare('SELECT * FROM policies WHERE id = ?').get(policy.id);
  assert.equal(policyAfter.carrier, 'Occidental Life');
  assert.equal(policyAfter.policy_number, '005178887E');
  assert.equal(policyAfter.policy_status, 'In Force');
});

test('deleteCaseForClient REFUSES to delete a case with even ONE meaningful policy among several (mixed case)', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Mixed', lastName: 'Policies', email: 'mixed-policies@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id }, 'Loretta Stewart'); // blank
  const realPolicy = createPolicy(db, { caseId: c.id, carrier: 'Real Carrier', policyNumber: 'REAL-1' }, 'Loretta Stewart');

  assert.throws(() => deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(realPolicy.id).n, 1, 'the real policy must survive');
});

test('deleteCaseForClient only deletes the ONE selected case, never a different case under the same client', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Two', lastName: 'Cases', email: 'two-cases@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const emptyCase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Empty one' }, 'Loretta Stewart');
  const otherCase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Annuities'), title: 'Keep me' }, 'Loretta Stewart');
  createPolicy(db, { caseId: otherCase.id, carrier: 'Keep Carrier', policyNumber: 'KEEP-1' }, 'Loretta Stewart');

  deleteCaseForClient(db, emptyCase.id, 'Loretta Stewart', { confirmDelete: true });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(emptyCase.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(otherCase.id).n, 1, 'the unrelated case must be completely unaffected');
});

test('deleteCaseForClient never deletes the client itself -- only the case and its policies', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Client', lastName: 'Survives', email: 'client-survives@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE id = ?').get(client.contact.id).n, 1, 'the client contact row must still exist');
});

test('deleteCaseForClient clears (not deletes) stray case_id references in downstream tables that have no ON DELETE action, instead of throwing a foreign key error', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'FkRef', lastName: 'Test', email: 'fk-ref-test@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  const note = db.prepare('INSERT INTO contact_notes (contact_id, body, case_id) VALUES (?, ?, ?)').run(client.contact.id, 'A note tied to this case', c.id);
  const task = db.prepare("INSERT INTO follow_up_tasks (contact_id, task_type, due_date, case_id) VALUES (?, 'Call', '2026-10-10', ?)").run(client.contact.id, c.id);

  deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true });

  const noteAfter = db.prepare('SELECT * FROM contact_notes WHERE id = ?').get(note.lastInsertRowid);
  const taskAfter = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(task.lastInsertRowid);
  assert.ok(noteAfter, 'the note itself must survive, only losing its case association');
  assert.equal(noteAfter.case_id, null);
  assert.ok(taskAfter, 'the task itself must survive, only losing its case association');
  assert.equal(taskAfter.case_id, null);
});

test('deleteCaseForClient rejects a nonexistent case id', () => {
  const { db } = setup();
  assert.throws(() => deleteCaseForClient(db, 999999, 'Loretta Stewart', { confirmDelete: true }));
});

// ── New Case -> Annuity workflow (2026-10-08) ───────────────────────────

test('1. saveAnnuityCase creates the case and its contract/policy together, in one operation', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Anna', lastName: 'Nuity', email: 'anna-nuity@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const result = saveAnnuityCase(db, {
    contactId: client.contact.id,
    fields: {
      carrier: 'Athene', contractNumber: 'ATH-1001', annuityType: 'Fixed Indexed Annuity (FIA)',
      contractStatus: 'In Force', initialPremium: '100000', currentAccountValue: '104500',
      effectiveDate: '2026-01-15', applicationDate: '2025-12-20', surrenderPeriodYears: '7',
      beneficiary: 'Spouse', notes: '7% bonus credit; income rider attached',
    },
  }, 'Loretta Stewart');

  assert.equal(result.outcome, 'created');
  assert.ok(result.case);
  assert.ok(result.policy);
  assert.equal(result.case.contact_brand_id, client.contactBrand.id);

  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.case.product_id);
  assert.equal(product.name, 'Annuities', 'must file under the real Annuities product, not a null-product case');

  assert.equal(result.policy.case_id, result.case.id);
  assert.equal(result.policy.carrier, 'Athene');
  assert.equal(result.policy.policy_number, 'ATH-1001');
  assert.equal(result.policy.policy_type, 'Fixed Indexed Annuity (FIA)');
  assert.equal(result.policy.policy_status, 'In Force');
  assert.equal(result.policy.premium, 100000);
  assert.equal(result.policy.coverage_amount, 104500);
  assert.equal(result.policy.effective_date, '2026-01-15');
  assert.equal(result.policy.application_date, '2025-12-20');
  assert.equal(result.policy.surrender_period_years, 7);
  assert.equal(result.policy.beneficiary, 'Spouse');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(client.contactBrand.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE case_id = ?').get(result.case.id).n, 1);
});

test('2. saveAnnuityCase creates a Pending annuity with no contract number and no current account value -- neither is required', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Pending', lastName: 'App', email: 'pending-app@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const result = saveAnnuityCase(db, {
    contactId: client.contact.id,
    fields: { carrier: 'Nationwide', annuityType: 'MYGA', initialPremium: '50000' },
  }, 'Loretta Stewart');

  assert.equal(result.outcome, 'created');
  assert.equal(result.policy.policy_status, 'Pending', 'defaults to Pending when no status is supplied');
  assert.equal(result.policy.policy_number, null);
  assert.equal(result.policy.coverage_amount, null);
  assert.equal(result.policy.effective_date, null);
});

test('3. Current Account Value can be entered later via an edit, after being left blank at creation', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Later', lastName: 'Value', email: 'later-value@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const created = saveAnnuityCase(db, {
    contactId: client.contact.id,
    fields: { carrier: 'Allianz', initialPremium: '75000' },
  }, 'Loretta Stewart');
  assert.equal(created.policy.coverage_amount, null);

  const updated = saveAnnuityCase(db, {
    contactId: client.contact.id,
    caseId: created.case.id,
    fields: { currentAccountValue: '79800' },
  }, 'Loretta Stewart');
  assert.equal(updated.outcome, 'updated');
  assert.equal(updated.policy.coverage_amount, 79800);
  // Everything entered earlier must survive the update untouched.
  assert.equal(updated.policy.carrier, 'Allianz');
  assert.equal(updated.policy.premium, 75000);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(created.case.id).n, 1, 'still exactly one case');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE case_id = ?').get(created.case.id).n, 1, 'still exactly one policy');
});

test('4. editing an existing annuity updates the SAME case and policy -- never creates a duplicate', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Edit', lastName: 'Annuity', email: 'edit-annuity@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const created = saveAnnuityCase(db, {
    contactId: client.contact.id,
    fields: { carrier: 'Athene', contractNumber: 'ATH-2002', initialPremium: '60000', contractStatus: 'Pending' },
  }, 'Loretta Stewart');

  const edited = saveAnnuityCase(db, {
    contactId: client.contact.id,
    caseId: created.case.id,
    fields: { contractStatus: 'In Force', contractNumber: 'ATH-2002-FINAL', effectiveDate: '2026-03-01' },
  }, 'Loretta Stewart');

  assert.equal(edited.case.id, created.case.id, 'must be the same case row');
  assert.equal(edited.policy.id, created.policy.id, 'must be the same policy row');
  assert.equal(edited.policy.policy_status, 'In Force');
  assert.equal(edited.policy.policy_number, 'ATH-2002-FINAL');
  assert.equal(edited.policy.effective_date, '2026-03-01');
  assert.equal(edited.policy.carrier, 'Athene', 'untouched fields must survive the edit');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(client.contactBrand.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies').get().n, 1);
});

test('5. an annuity case is never recognized as Life Insurance by the brand\'s own life-insurance product classification', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const prosperityClient = createClient(db, { firstName: 'Pros', lastName: 'Annuity', email: 'pros-annuity@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const ilClient = createClient(db, { firstName: 'IL', lastName: 'Annuity', email: 'il-annuity@example.com', brandSlug: 'insurance-lady' }, 'Loretta Stewart');

  const prosperityResult = saveAnnuityCase(db, { contactId: prosperityClient.contact.id, fields: { carrier: 'Carrier A' } }, 'Loretta Stewart');
  const ilResult = saveAnnuityCase(db, { contactId: ilClient.contact.id, fields: { carrier: 'Carrier B' } }, 'Loretta Stewart');

  // client.html's LIFE_INSURANCE_PRODUCTS_BY_BRAND -- mirrored here without
  // importing frontend code, matching how other backend tests in this
  // suite already verify this exact classification boundary.
  const LIFE_INSURANCE_PRODUCTS_BY_BRAND = {
    prosperity: ['Life insurance'],
    'insurance-lady': ['Online life-insurance application', 'Cash-building life insurance', 'Whole life/final expense'],
  };
  const prosperityProduct = db.prepare('SELECT name FROM products WHERE id = ?').get(prosperityResult.case.product_id);
  const ilProduct = db.prepare('SELECT name FROM products WHERE id = ?').get(ilResult.case.product_id);
  assert.ok(!LIFE_INSURANCE_PRODUCTS_BY_BRAND.prosperity.includes(prosperityProduct.name), 'Prosperity annuity must not be classified as Life Insurance');
  assert.ok(!LIFE_INSURANCE_PRODUCTS_BY_BRAND['insurance-lady'].includes(ilProduct.name), 'Insurance Lady annuity must not be classified as Life Insurance');
});

test('6. creating/editing an annuity never touches an existing, unrelated life insurance case or policy for the same client', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Both', lastName: 'Products', email: 'both-products@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const lifeCase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');
  const lifePolicy = createPolicy(db, { caseId: lifeCase.id, carrier: 'Midland National', policyNumber: 'LIFE-1', policyStatus: 'In Force', coverageAmount: 250000 }, 'Loretta Stewart');

  saveAnnuityCase(db, { contactId: client.contact.id, fields: { carrier: 'Athene', initialPremium: '100000' } }, 'Loretta Stewart');

  const lifePolicyAfter = db.prepare('SELECT * FROM policies WHERE id = ?').get(lifePolicy.id);
  const lifeCaseAfter = db.prepare('SELECT * FROM cases WHERE id = ?').get(lifeCase.id);
  assert.equal(lifePolicyAfter.carrier, 'Midland National');
  assert.equal(lifePolicyAfter.policy_number, 'LIFE-1');
  assert.equal(lifePolicyAfter.coverage_amount, 250000);
  assert.equal(lifeCaseAfter.status, 'Open');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(client.contactBrand.id).n, 2, 'the life insurance case and the new annuity case are two separate cases');
});

test('7. Insurance Lady and Prosperity annuities for different clients never cross brands', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const prosperityClient = createClient(db, { firstName: 'Pros', lastName: 'Only', email: 'pros-only-annuity@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const ilClient = createClient(db, { firstName: 'IL', lastName: 'Only', email: 'il-only-annuity@example.com', brandSlug: 'insurance-lady' }, 'Loretta Stewart');

  const prosperityResult = saveAnnuityCase(db, { contactId: prosperityClient.contact.id, fields: { carrier: 'Prosperity Carrier' } }, 'Loretta Stewart');
  const ilResult = saveAnnuityCase(db, { contactId: ilClient.contact.id, fields: { carrier: 'IL Carrier' } }, 'Loretta Stewart');

  const prosperityLink = db.prepare('SELECT * FROM contact_brands WHERE id = ?').get(prosperityResult.case.contact_brand_id);
  const ilLink = db.prepare('SELECT * FROM contact_brands WHERE id = ?').get(ilResult.case.contact_brand_id);
  assert.equal(prosperityLink.brand_id, prosperityId);
  assert.equal(ilLink.brand_id, insuranceLadyId);

  const prosperityProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(prosperityResult.case.product_id);
  const ilProduct = db.prepare('SELECT * FROM products WHERE id = ?').get(ilResult.case.product_id);
  assert.equal(prosperityProduct.name, 'Annuities');
  assert.equal(ilProduct.name, 'Annuities and safe-money solutions');
  assert.equal(prosperityProduct.brand_id, prosperityId);
  assert.equal(ilProduct.brand_id, insuranceLadyId);
});

test('8. calling saveAnnuityCase twice with caseId (an edit) is safe and idempotent -- it keeps updating the SAME case/policy, never creating a second pair; documents that CREATE-mode double-submission protection is the frontend Save-button-disable guard (crm/public/app/client.html\'s annuityCaseModal), matching the exact established pattern already used by addLifeInsurancePolicyModal', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'DoubleClick', lastName: 'Guard', email: 'double-click-guard@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const first = saveAnnuityCase(db, { contactId: client.contact.id, fields: { carrier: 'Carrier', initialPremium: '10000' } }, 'Loretta Stewart');
  // A second call WITH the resulting caseId (what every subsequent Edit
  // submission does, including a resubmission of the exact same edit
  // form) never creates a second case/policy -- confirming the EDIT path
  // is safe to call more than once by construction, regardless of any
  // frontend guard.
  const second = saveAnnuityCase(db, { contactId: client.contact.id, caseId: first.case.id, fields: { initialPremium: '10000' } }, 'Loretta Stewart');
  assert.equal(second.case.id, first.case.id);
  assert.equal(second.policy.id, first.policy.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(client.contactBrand.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies').get().n, 1);

  // By contrast (and only to document the known, accepted limitation --
  // NOT a gap being silently introduced): calling saveAnnuityCase in
  // CREATE mode (no caseId) twice, exactly as an unguarded double-click
  // would, DOES create two independent cases/policies. This is the same
  // limitation crm/public/app/client.html's addLifeInsurancePolicyModal
  // already documents for createPolicy ("createPolicy has no dedup of its
  // own, so two submits would otherwise create two policy rows") -- the
  // real protection is the Save button disabling itself immediately on
  // click (annuityCaseModal's own submit handler), not a backend
  // idempotency key.
  const dup1 = saveAnnuityCase(db, { contactId: client.contact.id, fields: { carrier: 'Second Contract' } }, 'Loretta Stewart');
  const dup2 = saveAnnuityCase(db, { contactId: client.contact.id, fields: { carrier: 'Second Contract' } }, 'Loretta Stewart');
  assert.notEqual(dup1.case.id, dup2.case.id, 'two unguarded CREATE-mode calls are two separate cases -- exactly why the frontend disables the button after the first click');
});

test('saveAnnuityCase requires an actor', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'NoActor', lastName: 'Test', email: 'no-actor-annuity@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => saveAnnuityCase(db, { contactId: client.contact.id, fields: { carrier: 'Carrier' } }, null));
});

test('saveAnnuityCase (edit) rejects a nonexistent case id', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'BadCase', lastName: 'Test', email: 'bad-case-annuity@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => saveAnnuityCase(db, { contactId: client.contact.id, caseId: 999999, fields: { carrier: 'Carrier' } }, 'Loretta Stewart'));
});

test('saveAnnuityCase (create) requires an active company assignment', () => {
  const { db } = setup();
  const orphanContact = db.prepare(`INSERT INTO contacts (first_name, last_name, email) VALUES ('Orphan', 'Contact', 'orphan-annuity@example.com')`).run();
  assert.throws(() => saveAnnuityCase(db, { contactId: orphanContact.lastInsertRowid, fields: { carrier: 'Carrier' } }, 'Loretta Stewart'));
});

// ── Life & Annuities tab: deleteAnnuityCase (2026-10-10) ────────────────

test('deleteAnnuityCase requires actor and explicit confirmDelete', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'DelAnn', lastName: 'Guard', email: 'del-ann-guard@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const { case: kase } = saveAnnuityCase(db, { contactId: client.contact.id, fields: { carrier: 'Athene' } }, 'Loretta Stewart');
  assert.throws(() => deleteAnnuityCase(db, kase.id, null, { confirmDelete: true }));
  assert.throws(() => deleteAnnuityCase(db, kase.id, 'Loretta Stewart', { confirmDelete: false }));
});

test('deleteAnnuityCase rejects a nonexistent case id', () => {
  const { db } = setup();
  assert.throws(() => deleteAnnuityCase(db, 999999, 'Loretta Stewart', { confirmDelete: true }));
});

test('deleteAnnuityCase refuses to delete a case that is not an annuity (e.g. a real Life insurance case)', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'NotAnn', lastName: 'Refuse', email: 'not-ann-refuse@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const lifeCase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  assert.throws(() => deleteAnnuityCase(db, lifeCase.id, 'Loretta Stewart', { confirmDelete: true }), /not an annuity/);
  assert.ok(db.prepare('SELECT * FROM cases WHERE id = ?').get(lifeCase.id), 'the life insurance case must survive untouched');
});

test('deleteAnnuityCase deletes a FULLY populated annuity (carrier, contract number, premium all on file) in one call -- unlike deleteCaseForClient, this is never blocked by "real information on file"', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Full', lastName: 'Annuity', email: 'full-annuity-delete@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const { case: kase, policy } = saveAnnuityCase(db, {
    contactId: client.contact.id,
    fields: { carrier: 'Athene', contractNumber: 'ATH-9999', initialPremium: '100000', contractStatus: 'In Force' },
  }, 'Loretta Stewart');

  const result = deleteAnnuityCase(db, kase.id, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.deleted, true);
  assert.equal(result.policiesRemoved, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(kase.id).n, 0, 'case is gone');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(policy.id).n, 0, 'its policy cascaded away with it');
});

test('deleteAnnuityCase only deletes the ONE targeted annuity, never a sibling annuity or the client itself', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Sibling', lastName: 'Annuity', email: 'sibling-annuity@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const first = saveAnnuityCase(db, { contactId: client.contact.id, fields: { carrier: 'Athene' } }, 'Loretta Stewart');
  const second = saveAnnuityCase(db, { contactId: client.contact.id, caseId: null, fields: { carrier: 'Nationwide' } }, 'Loretta Stewart');

  deleteAnnuityCase(db, first.case.id, 'Loretta Stewart', { confirmDelete: true });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(first.case.id).n, 0);
  assert.ok(db.prepare('SELECT * FROM cases WHERE id = ?').get(second.case.id), 'the second annuity case must survive');
  assert.ok(db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id), 'the contact itself must survive');
});
