// Tests for the new query functions added to crm/lib/dashboardQueries.js
// for the CRM interface redesign: getClientDetail, getDashboardSummary,
// getWorkList, getCompanyConflictQueue, getPoliciesList, and getCaseList's
// new `sort` option. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { dedupeContact, resolveContactBrand, matchOrCreateCase } = require('../lib/caseMatching');
const {
  getCaseList,
  getClientDetail,
  getDashboardSummary,
  getWorkList,
  getCompanyConflictQueue,
  getPoliciesList,
} = require('../lib/dashboardQueries');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

test('getClientDetail returns contact, contactBrands with cases, tasks, appointments, communications, notes', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'client@example.com', first_name: 'Nadia', last_name: 'Voss', phone: '(414) 555-1010', phone_e164: '+14145551010' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const lifeProductId = getProductId(db, prosperityId, 'Life insurance');
  matchOrCreateCase(db, { contactBrandId: link.id, productId: lifeProductId, eventType: 'new_inquiry', title: 'Life Insurance Lead' });
  db.prepare(`INSERT INTO contact_notes (contact_id, body) VALUES (?, 'Prefers evening calls')`).run(contact.id);
  db.prepare(`INSERT INTO follow_up_tasks (contact_id, task_type, due_date, notes) VALUES (?, 'Call', '2026-01-01', 'Follow up')`).run(contact.id);

  const detail = getClientDetail(db, contact.id);
  assert.equal(detail.contact.name, 'Nadia Voss');
  assert.equal(detail.contact.email, 'client@example.com');
  assert.equal(detail.contactBrands.length, 1);
  assert.equal(detail.contactBrands[0].brandId, 'prosperity');
  assert.equal(detail.contactBrands[0].cases.length, 1);
  assert.equal(detail.notes.length, 1);
  assert.equal(detail.tasks.length, 1);
});

test('getClientDetail returns null for an unknown contact id', () => {
  const { db } = setup();
  assert.equal(getClientDetail(db, 999999), null);
});

test('getClientDetail keeps multiple cases under one client as separate records', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'multi2@example.com', first_name: 'Omar' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  matchOrCreateCase(db, { contactBrandId: link.id, productId: getProductId(db, prosperityId, 'Life insurance'), eventType: 'new_inquiry', title: 'Life' });
  matchOrCreateCase(db, { contactBrandId: link.id, productId: getProductId(db, prosperityId, 'Annuities'), eventType: 'new_inquiry', title: 'Annuity' });

  const detail = getClientDetail(db, contact.id);
  assert.equal(detail.contactBrands[0].cases.length, 2);
});

test('archiving one case preserves the client when another active case exists', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'archive-preserve@example.com', first_name: 'Priya' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const life = matchOrCreateCase(db, { contactBrandId: link.id, productId: getProductId(db, prosperityId, 'Life insurance'), eventType: 'new_inquiry', title: 'Life' });
  matchOrCreateCase(db, { contactBrandId: link.id, productId: getProductId(db, prosperityId, 'Annuities'), eventType: 'new_inquiry', title: 'Annuity' });

  db.prepare("UPDATE cases SET status = 'Archived' WHERE id = ?").run(life.case.id);

  const list = getCaseList(db, { brandId: 'prosperity', statusFilter: 'active' });
  const found = list.contacts.find(c => c.contactId === contact.id);
  assert.ok(found, 'the client must still appear because the Annuity case is still active');
  assert.equal(found.cases.length, 1);
  assert.equal(found.cases[0].productName, 'Annuities');
});

test('getCaseList sorts by dueDate at the database level (nearest due first, no-due-date last)', () => {
  const { db, prosperityId } = setup();
  const a = dedupeContact(db, { email: 'soonest@example.com', first_name: 'Soonest' });
  const b = dedupeContact(db, { email: 'later@example.com', first_name: 'Later' });
  const c = dedupeContact(db, { email: 'nodue@example.com', first_name: 'NoDue' });
  const linkA = resolveContactBrand(db, { contactId: a.id, brandId: prosperityId });
  const linkB = resolveContactBrand(db, { contactId: b.id, brandId: prosperityId });
  const linkC = resolveContactBrand(db, { contactId: c.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Life insurance');
  const caseA = matchOrCreateCase(db, { contactBrandId: linkA.id, productId, eventType: 'new_inquiry' });
  const caseB = matchOrCreateCase(db, { contactBrandId: linkB.id, productId, eventType: 'new_inquiry' });
  matchOrCreateCase(db, { contactBrandId: linkC.id, productId, eventType: 'new_inquiry' });

  db.prepare(`INSERT INTO follow_up_tasks (contact_id, case_id, task_type, due_date) VALUES (?, ?, 'Call', '2026-03-01')`).run(a.id, caseA.case.id);
  db.prepare(`INSERT INTO follow_up_tasks (contact_id, case_id, task_type, due_date) VALUES (?, ?, 'Call', '2026-06-01')`).run(b.id, caseB.case.id);

  const list = getCaseList(db, { brandId: 'prosperity', sort: 'dueDate', pageSize: 10 });
  const names = list.contacts.map(x => x.contactName);
  assert.deepEqual(names, ['Soonest', 'Later', 'NoDue'], 'nearest due date first, no-due-date contacts last');
});

test('getDashboardSummary counts review-required items and respects the company filter', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type)
    VALUES ('fake_webform', '{}', 'test', 'Pending', 'brand')
  `).run();

  const summaryAll = getDashboardSummary(db, { brandId: null });
  assert.equal(summaryAll.reviewRequired, 1);

  const contact = dedupeContact(db, { email: 'summary@example.com', first_name: 'Rae' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  matchOrCreateCase(db, { contactBrandId: link.id, productId: getProductId(db, prosperityId, 'Life insurance'), eventType: 'new_inquiry' });

  const summaryProsperity = getDashboardSummary(db, { brandId: 'prosperity' });
  const summaryIL = getDashboardSummary(db, { brandId: 'insurance-lady' });
  assert.equal(summaryProsperity.casesInProgress, 1);
  assert.equal(summaryIL.casesInProgress, 0, 'the company filter must scope case counts correctly');
});

test('getWorkList never selects a sender and every item is openable (has a target)', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'worklist@example.com', first_name: 'Sana' });
  db.prepare(`INSERT INTO follow_up_tasks (contact_id, task_type, due_date, notes) VALUES (?, 'Call', '2020-01-01', 'Overdue call')`).run(contact.id);

  const items = getWorkList(db, { brandId: null });
  assert.ok(items.length >= 1);
  for (const item of items) {
    assert.ok(item.target && item.target.kind, `every work-list item must be openable: ${JSON.stringify(item)}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sender_identities').get().n, 0);
});

test('getCompanyConflictQueue surfaces existing vs incoming company labels', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'conflict@example.com', first_name: 'Tomas' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });

  db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, candidate_contact_id, reason, status, review_type, contact_brand_id, incoming_brand_id)
    VALUES ('test-il-source', '{"first_name":"Tomas"}', ?, 'conflict', 'Pending', 'company_conflict', ?, ?)
  `).run(contact.id, link.id, insuranceLadyId);

  const queue = getCompanyConflictQueue(db);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].existingBrandId, 'prosperity');
  assert.equal(queue[0].incomingBrandId, 'insurance-lady');
  assert.equal(queue[0].contactName, 'Tomas');
});

test('getPoliciesList returns an empty array against a freshly migrated (unseeded) database', () => {
  const { db } = setup();
  assert.deepEqual(getPoliciesList(db, {}), []);
});

test('getPoliciesList respects the company filter and never invents data beyond what is stored', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'policy@example.com', first_name: 'Uma' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const caseResult = matchOrCreateCase(db, { contactBrandId: link.id, productId: getProductId(db, prosperityId, 'Life insurance'), eventType: 'new_inquiry' });
  db.prepare(`
    INSERT INTO policies (case_id, carrier, policy_number, policy_status, coverage_amount)
    VALUES (?, 'Preview Carrier', 'PRV-0001', 'Active', 250000)
  `).run(caseResult.case.id);

  const prosperityPolicies = getPoliciesList(db, { brandId: 'prosperity' });
  const ilPolicies = getPoliciesList(db, { brandId: 'insurance-lady' });
  assert.equal(prosperityPolicies.length, 1);
  assert.equal(prosperityPolicies[0].carrier, 'Preview Carrier');
  assert.equal(prosperityPolicies[0].contactName, 'Uma');
  assert.equal(ilPolicies.length, 0);
});
