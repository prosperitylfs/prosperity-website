// Tests for crm/lib/policyService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createPolicy, updatePolicy, archivePolicy, restorePolicy } = require('../lib/policyService');
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
