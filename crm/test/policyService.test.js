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
