// Tests for crm/lib/dashboardQueries.js's getReportsSummary(). In-memory
// databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { getReportsSummary } = require('../lib/dashboardQueries');
const { createClient } = require('../lib/clientService');
const { createCaseForClient } = require('../lib/caseService');
const { createPolicy } = require('../lib/policyService');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  runRevenueMvpMigrations(db); // adds sms_messages.failure_reason, among others
  return { db, insuranceLadyId, prosperityId };
}
function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

test('reports show real per-company totals only -- no invented metrics', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const p1 = createClient(db, { firstName: 'Report1', email: 'report1@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  createClient(db, { firstName: 'Report2', email: 'report2@example.com', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: p1.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id, carrier: 'Test Carrier', policyStatus: 'Active' }, 'Loretta Stewart');

  const summary = getReportsSummary(db);
  const prosperityClients = summary.clientsByCompany.find(x => x.brand_id === 'prosperity');
  const ilClients = summary.clientsByCompany.find(x => x.brand_id === 'insurance-lady');
  assert.equal(prosperityClients.n, 1);
  assert.equal(ilClients.n, 1);

  const prosperityCases = summary.activeCasesByCompany.find(x => x.brand_id === 'prosperity');
  assert.equal(prosperityCases.n, 1);

  const activePolicies = summary.policiesByCompanyStatus.find(x => x.brand_id === 'prosperity' && x.status === 'Active');
  assert.equal(activePolicies.n, 1);

  assert.ok(Number.isInteger(summary.tasksDue));
  assert.ok(Number.isInteger(summary.tasksOverdue));
  assert.ok(Array.isArray(summary.commsByStatus));
  assert.ok(typeof summary.reviewTotals.brand === 'number');

  // No decorative/invented metrics anywhere in the shape.
  const json = JSON.stringify(summary).toLowerCase();
  assert.ok(!json.includes('commission'));
  assert.ok(!json.includes('hot') && !json.includes('warm') && !json.includes('cool'));
});

test('archived clients and policies are excluded from report totals', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Archived', email: 'archived@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'X', policyStatus: 'Active' }, 'Loretta Stewart');

  require('../lib/policyService').archivePolicy(db, policy.id, 'Loretta Stewart');
  require('../lib/clientService').archiveClient(db, client.contact.id, 'Loretta Stewart');

  const summary = getReportsSummary(db);
  const prosperityClients = summary.clientsByCompany.find(x => x.brand_id === 'prosperity');
  assert.equal(prosperityClients ? prosperityClients.n : 0, 0);
  const activePolicies = summary.policiesByCompanyStatus.find(x => x.brand_id === 'prosperity' && x.status === 'Active');
  assert.equal(activePolicies ? activePolicies.n : 0, 0);
});
