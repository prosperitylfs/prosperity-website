// Tests for crm/lib/policyService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createPolicy, updatePolicy, archivePolicy, restorePolicy, deletePolicy } = require('../lib/policyService');
const { createClient } = require('../lib/clientService');
const { createCaseForClient } = require('../lib/caseService');

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

test('policy company always matches the client permanent company (no company field exists to mismatch)', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Otis', email: 'otis@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'Midland National', policyNumber: 'MN-1', policyStatus: 'Active', coverageAmount: 100000 }, 'Loretta Stewart');
  assert.equal(policy.case_id, c.id);
  // No brand_id/company column exists on policies at all -- structurally
  // impossible for a policy to diverge from its case's (and therefore its
  // client's) company.
  assert.ok(!('brand_id' in policy));
});

test('creating a policy under a nonexistent case is rejected', () => {
  const { db } = setup();
  assert.throws(() => createPolicy(db, { caseId: 999999, carrier: 'X' }, 'Loretta Stewart'), /does not exist/);
});

test('editing a policy never re-parents it to a different case', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Petra', email: 'petra@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'Midland National' }, 'Loretta Stewart');
  const updated = updatePolicy(db, policy.id, { carrier: 'Foresters', caseId: 999999 });
  assert.equal(updated.carrier, 'Foresters');
  assert.equal(updated.case_id, c.id);
});

test('archive and restore a policy round-trip', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Quinn', email: 'quinn2@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'Midland National' }, 'Loretta Stewart');
  const archived = archivePolicy(db, policy.id, 'Loretta Stewart');
  assert.ok(archived.archived_at);
  const restored = restorePolicy(db, policy.id, 'Loretta Stewart');
  assert.equal(restored.archived_at, null);
});

// ── Life Insurance section (2026-09-10): policy_type field, and multiple
//    independent policies per client ─────────────────────────────────────

test('createPolicy accepts and stores policy_type; updatePolicy can change it without touching anything else', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Reid', email: 'reid@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'Mutual of Omaha', policyType: 'Whole Life' }, 'Loretta Stewart');
  assert.equal(policy.policy_type, 'Whole Life');
  const updated = updatePolicy(db, policy.id, { policyType: 'Term Life' });
  assert.equal(updated.policy_type, 'Term Life');
  assert.equal(updated.carrier, 'Mutual of Omaha', 'an unrelated field must be untouched by a policy_type-only update');
});

test('a client can have THREE separate life insurance policies under the same case, each with its own Policy Number, and each keeps its own identity', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Sana', email: 'sana@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  const p1 = createPolicy(db, { caseId: c.id, carrier: 'Mutual of Omaha', policyNumber: 'MOO-111', policyType: 'Whole Life', coverageAmount: 25000, premium: 100, premiumFrequency: 'Monthly', policyStatus: 'In Force' }, 'Loretta Stewart');
  const p2 = createPolicy(db, { caseId: c.id, carrier: 'Royal Neighbors of America', policyNumber: 'RNA-222', policyType: 'Whole Life', coverageAmount: 20000, premium: 75, premiumFrequency: 'Monthly', policyStatus: 'In Force' }, 'Loretta Stewart');
  const p3 = createPolicy(db, { caseId: c.id, carrier: 'Occidental', policyNumber: 'OCC-333', policyType: 'Term Life', coverageAmount: 100000, premium: 60, premiumFrequency: 'Monthly', policyStatus: 'In Force' }, 'Loretta Stewart');

  assert.notEqual(p1.id, p2.id);
  assert.notEqual(p2.id, p3.id);
  assert.notEqual(p1.id, p3.id);

  const rows = db.prepare('SELECT * FROM policies WHERE case_id = ? ORDER BY id ASC').all(c.id);
  assert.equal(rows.length, 3, 'adding a second and third policy must never overwrite the first -- three separate rows must exist');
  assert.deepEqual(rows.map(r => r.policy_number), ['MOO-111', 'RNA-222', 'OCC-333']);
  assert.deepEqual(rows.map(r => r.carrier), ['Mutual of Omaha', 'Royal Neighbors of America', 'Occidental']);

  // Editing policy #2 must not change #1 or #3.
  updatePolicy(db, p2.id, { policyStatus: 'Lapsed', premium: 80 });
  const after = db.prepare('SELECT * FROM policies WHERE case_id = ? ORDER BY id ASC').all(c.id);
  assert.equal(after[0].policy_number, 'MOO-111');
  assert.equal(after[0].policy_status, 'In Force', 'policy #1 must be unaffected by editing policy #2');
  assert.equal(after[0].premium, 100);
  assert.equal(after[1].policy_number, 'RNA-222');
  assert.equal(after[1].policy_status, 'Lapsed');
  assert.equal(after[1].premium, 80);
  assert.equal(after[2].policy_number, 'OCC-333');
  assert.equal(after[2].policy_status, 'In Force', 'policy #3 must be unaffected by editing policy #2');
  assert.equal(after[2].premium, 60);
});

test('a lapsed/cancelled policy is never deleted -- it remains a distinct row alongside in-force policies', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Theo', email: 'theolife@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id, carrier: 'Carrier A', policyNumber: 'A-1', policyStatus: 'In Force' }, 'Loretta Stewart');
  const lapsed = createPolicy(db, { caseId: c.id, carrier: 'Carrier B', policyNumber: 'B-1', policyStatus: 'Lapsed' }, 'Loretta Stewart');
  const rows = db.prepare('SELECT * FROM policies WHERE case_id = ?').all(c.id);
  assert.equal(rows.length, 2, 'a Lapsed status must not remove the policy -- it stays a historical record');
  assert.ok(rows.some(r => r.id === lapsed.id && r.policy_status === 'Lapsed'));
});

// ── Permanent single-policy delete (2026-10-08) ─────────────────────────

test('deletePolicy requires actor and explicit confirmDelete', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Guard', lastName: 'Policy', email: 'guard-policy@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'Guard Carrier', policyNumber: 'G-1' }, 'Loretta Stewart');

  assert.throws(() => deletePolicy(db, policy.id, null, { confirmDelete: true }));
  assert.throws(() => deletePolicy(db, policy.id, 'Loretta Stewart', { confirmDelete: false }));
  assert.throws(() => deletePolicy(db, policy.id, 'Loretta Stewart', {}));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(policy.id).n, 1, 'none of the rejected calls above may have deleted anything');
});

test('deletePolicy rejects a nonexistent policy id', () => {
  const { db } = setup();
  assert.throws(() => deletePolicy(db, 999999, 'Loretta Stewart', { confirmDelete: true }));
});

test('deletePolicy deletes exactly the selected policy, never the case, never a sibling policy under the same case', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Mixed', lastName: 'Siblings', email: 'mixed-siblings@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const keep1 = createPolicy(db, { caseId: c.id, carrier: 'Keep Carrier 1', policyNumber: 'KEEP-1', policyStatus: 'In Force' }, 'Loretta Stewart');
  const toDelete = createPolicy(db, { caseId: c.id, carrier: 'Delete Me', policyNumber: 'DEL-1' }, 'Loretta Stewart');
  const keep2 = createPolicy(db, { caseId: c.id, carrier: 'Keep Carrier 2', policyNumber: 'KEEP-2', policyStatus: 'In Force' }, 'Loretta Stewart');

  const result = deletePolicy(db, toDelete.id, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.deleted, true);
  assert.equal(result.caseId, c.id);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(toDelete.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(keep1.id).n, 1, 'sibling policy #1 must survive untouched');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(keep2.id).n, 1, 'sibling policy #2 must survive untouched');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 1, 'the case itself must still exist');
});

test('deletePolicy on the LAST remaining policy under a case leaves the (now-empty) case intact -- it does not cascade to delete the case', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Last', lastName: 'Policy', email: 'last-policy@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const onlyPolicy = createPolicy(db, { caseId: c.id, carrier: 'Only Carrier', policyNumber: 'ONLY-1' }, 'Loretta Stewart');

  deletePolicy(db, onlyPolicy.id, 'Loretta Stewart', { confirmDelete: true });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 1, 'the case must still exist, now simply empty');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE case_id = ?').get(c.id).n, 0);
});

test('deletePolicy never touches the client record', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Client', lastName: 'Untouched', email: 'client-untouched-policy@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'Carrier', policyNumber: 'P-1' }, 'Loretta Stewart');

  deletePolicy(db, policy.id, 'Loretta Stewart', { confirmDelete: true });

  const contactAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.ok(contactAfter);
  assert.equal(contactAfter.archived_at, null);
});

test('deletePolicy can remove even an In Force policy with full information -- it is a deliberate, individually-confirmed delete, not subject to deleteCaseForClient\'s "never delete a meaningful policy" restriction (that restriction protects against deleting a WHOLE CASE as collateral damage, not against this explicit, single-record action)', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Deliberate', lastName: 'Delete', email: 'deliberate-delete@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'Occidental Life', policyNumber: '005178887E', policyStatus: 'In Force', coverageAmount: 50000 }, 'Loretta Stewart');

  const result = deletePolicy(db, policy.id, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(policy.id).n, 0);
});

test('surrender_period_years round-trips through createPolicy and updatePolicy, and is optional (annuity contracts)', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Surrender', lastName: 'Period', email: 'surrender-period@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Annuities') }, 'Loretta Stewart');

  const withoutIt = createPolicy(db, { caseId: c.id, carrier: 'Athene' }, 'Loretta Stewart');
  assert.equal(withoutIt.surrender_period_years, null);

  const updated = updatePolicy(db, withoutIt.id, { surrenderPeriodYears: '10' }, 'Loretta Stewart');
  assert.equal(updated.surrender_period_years, 10);

  const withIt = createPolicy(db, { caseId: c.id, carrier: 'Nationwide', surrenderPeriodYears: '7' }, 'Loretta Stewart');
  assert.equal(withIt.surrender_period_years, 7);
});
