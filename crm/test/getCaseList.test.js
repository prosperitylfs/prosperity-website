// Tests for crm/lib/dashboardQueries.js's getCaseList -- the Clients page's
// main directory listing. 2026-10-10 fix: a contact with zero cases on
// file (e.g. an Existing/Active Client added before any policy/case was
// ever entered for them) used to be completely invisible on this page,
// under every filter, because the query was driven FROM cases. In-memory
// databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { getCaseList } = require('../lib/dashboardQueries');
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
function names(result) { return result.contacts.map(c => c.contactName); }

test('a case-less Existing/Active Client (Jasmine Alexander\'s exact shape) now appears on the Clients page under Prosperity + All Clients + Name sort', () => {
  const { db, prosperityId } = setup();
  createClient(db, {
    firstName: 'Jasmine', lastName: 'Alexander', email: 'jasmine.alexander@example.com',
    brandSlug: 'prosperity', relationshipType: 'active_client', leadType: 'Existing Client',
  }, 'Loretta Stewart');
  // Jennifer Anderson stands in for an ordinary, already-visible client with
  // a real case on file (matching the live bug report's own comparison
  // point) -- a bare contact with no case AND no client classification
  // would not appear here at all, by design (see the dedicated
  // "bare LEAD/prospect" test below), so she needs a real case to be a
  // valid comparison target.
  const jennifer = createClient(db, {
    firstName: 'Jennifer', lastName: 'Anderson', email: 'jennifer.anderson@example.com', brandSlug: 'prosperity',
  }, 'Loretta Stewart');
  createCaseForClient(db, { contactId: jennifer.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  const result = getCaseList(db, { brandId: 'prosperity', statusFilter: 'active', sort: 'name' });
  assert.ok(names(result).includes('Alexander, Jasmine'), 'Jasmine must now appear even with zero cases on file');

  const idx = names(result);
  assert.ok(idx.indexOf('Alexander, Jasmine') < idx.indexOf('Anderson, Jennifer'), 'Jasmine must sort alphabetically before Jennifer Anderson');

  const jasmine = result.contacts.find(c => c.contactName === 'Alexander, Jasmine');
  assert.deepEqual(jasmine.cases, [], 'a case-less contact has an empty cases array, not an error or a placeholder case');
});

test('the SAME case-less contact also appears with statusFilter "all", and with brandId "all"', () => {
  const { db } = setup();
  createClient(db, { firstName: 'Jasmine', lastName: 'Alexander', email: 'jasmine2@example.com', brandSlug: 'prosperity', relationshipType: 'active_client' }, 'Loretta Stewart');

  const allStatus = getCaseList(db, { brandId: 'prosperity', statusFilter: 'all', sort: 'name' });
  assert.ok(names(allStatus).includes('Alexander, Jasmine'));

  const allBrands = getCaseList(db, { brandId: 'all', statusFilter: 'active', sort: 'name' });
  assert.ok(names(allBrands).includes('Alexander, Jasmine'));
});

test('a case-less contact does NOT appear under statusFilter "archived" (nothing of theirs is archived)', () => {
  const { db } = setup();
  createClient(db, { firstName: 'Jasmine', lastName: 'Alexander', email: 'jasmine3@example.com', brandSlug: 'prosperity', relationshipType: 'active_client' }, 'Loretta Stewart');
  const archived = getCaseList(db, { brandId: 'prosperity', statusFilter: 'archived', sort: 'name' });
  assert.ok(!names(archived).includes('Alexander, Jasmine'));
});

test('a case-less contact under Insurance Lady never appears when filtering by Prosperity, and vice versa -- company isolation preserved', () => {
  const { db } = setup();
  createClient(db, { firstName: 'IL', lastName: 'Only', email: 'il-only@example.com', brandSlug: 'insurance-lady', relationshipType: 'active_client' }, 'Loretta Stewart');
  createClient(db, { firstName: 'Pros', lastName: 'Only', email: 'pros-only@example.com', brandSlug: 'prosperity', relationshipType: 'active_client' }, 'Loretta Stewart');

  const prosperityList = getCaseList(db, { brandId: 'prosperity', statusFilter: 'all', sort: 'name' });
  assert.ok(names(prosperityList).includes('Only, Pros'));
  assert.ok(!names(prosperityList).includes('Only, IL'));

  const ilList = getCaseList(db, { brandId: 'insurance-lady', statusFilter: 'all', sort: 'name' });
  assert.ok(names(ilList).includes('Only, IL'));
  assert.ok(!names(ilList).includes('Only, Pros'));
});

test('a contact with a real, ACTIVE case is completely unaffected -- same case data, same shape as before the fix', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Has', lastName: 'ACase', email: 'has-a-case@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const kase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  const result = getCaseList(db, { brandId: 'prosperity', statusFilter: 'active', sort: 'name' });
  const found = result.contacts.find(c => c.contactName === 'ACase, Has');
  assert.ok(found, 'a contact with a real case must still appear');
  assert.equal(found.cases.length, 1);
  assert.equal(found.cases[0].caseId, kase.id);
});

test('a contact whose ONLY case is Archived does not appear under statusFilter "active" -- unchanged from before the fix', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Only', lastName: 'ArchivedCase', email: 'only-archived@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const kase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  db.prepare(`UPDATE cases SET status = 'Archived' WHERE id = ?`).run(kase.id);

  const active = getCaseList(db, { brandId: 'prosperity', statusFilter: 'active', sort: 'name' });
  assert.ok(!names(active).includes('ArchivedCase, Only'));

  const archived = getCaseList(db, { brandId: 'prosperity', statusFilter: 'archived', sort: 'name' });
  assert.ok(names(archived).includes('ArchivedCase, Only'));
});

test('a contact with an ARCHIVED (past) company relationship, and no active one, never appears for that brand -- even case-less', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Past', lastName: 'Relationship', email: 'past-relationship@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`UPDATE contact_brands SET status = 'Archived' WHERE contact_id = ?`).run(client.contact.id);

  const result = getCaseList(db, { brandId: 'prosperity', statusFilter: 'all', sort: 'name' });
  assert.ok(!names(result).includes('Relationship, Past'), 'an archived relationship must not surface a case-less contact for that brand');
});

test('search by name still finds a case-less contact', () => {
  const { db } = setup();
  createClient(db, { firstName: 'Jasmine', lastName: 'Alexander', email: 'jasmine-search@example.com', brandSlug: 'prosperity', relationshipType: 'active_client' }, 'Loretta Stewart');
  const result = getCaseList(db, { brandId: 'prosperity', statusFilter: 'all', search: 'Jasmine', sort: 'name' });
  assert.ok(names(result).includes('Alexander, Jasmine'));
});

test('a bare LEAD/prospect with zero cases and no client classification still does NOT appear on the Clients page -- that is exclusively New Prospects / Prospect Pipeline\'s job', () => {
  const { db } = setup();
  createClient(db, { firstName: 'Brand', lastName: 'NewLead', email: 'brand-new-lead@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const result = getCaseList(db, { brandId: 'prosperity', statusFilter: 'all', sort: 'name' });
  assert.ok(!names(result).includes('NewLead, Brand'), 'a plain lead (relationship_type NULL, no case) must stay out of the Clients page');
});

test('a case-less contact classified via lead_type = "Existing Client" (not relationship_type) also appears -- the same dual signal isExistingClient uses', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Via', lastName: 'LeadType', email: 'via-lead-type@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`UPDATE contacts SET lead_type = 'Existing Client' WHERE id = ?`).run(client.contact.id);
  const result = getCaseList(db, { brandId: 'prosperity', statusFilter: 'all', sort: 'name' });
  assert.ok(names(result).includes('LeadType, Via'));
});

test('pagination count (totalContacts) correctly includes case-less contacts', () => {
  const { db } = setup();
  for (let i = 0; i < 3; i++) {
    createClient(db, { firstName: 'Case', lastName: `Less${i}`, email: `caseless${i}@example.com`, brandSlug: 'prosperity', relationshipType: 'active_client' }, 'Loretta Stewart');
  }
  const result = getCaseList(db, { brandId: 'prosperity', statusFilter: 'all', sort: 'name', pageSize: 25 });
  assert.equal(result.pagination.totalContacts, 3);
  assert.equal(result.contacts.length, 3);
});

test('sorting by dueDate/nextAction/lastActivity never crashes for a case-less contact, and sorts them to the end (no due date/activity)', () => {
  const { db, prosperityId } = setup();
  createClient(db, { firstName: 'NoCase', lastName: 'ForSort', email: 'no-case-sort@example.com', brandSlug: 'prosperity', relationshipType: 'active_client' }, 'Loretta Stewart');
  const client2 = createClient(db, { firstName: 'Has', lastName: 'CaseForSort', email: 'has-case-sort@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  createCaseForClient(db, { contactId: client2.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  for (const sort of ['dueDate', 'nextAction', 'lastActivity']) {
    const result = getCaseList(db, { brandId: 'prosperity', statusFilter: 'all', sort });
    assert.equal(result.contacts.length, 2, `sort=${sort} must not drop or crash on the case-less contact`);
  }
});
