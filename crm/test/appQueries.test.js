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
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
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
  runRevenueMvpMigrations(db); // adds sms_messages.failure_reason, among others
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

test('getClientDetail exposes leadType and relationshipType, both null when unset', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'leadtype@example.com', first_name: 'Pat' });
  db.prepare(`UPDATE contacts SET lead_type = 'Existing Client' WHERE id = ?`).run(contact.id);

  const detail = getClientDetail(db, contact.id);
  assert.equal(detail.contact.leadType, 'Existing Client');

  const contact2 = dedupeContact(db, { email: 'nolead@example.com', first_name: 'Sam' });
  const detail2 = getClientDetail(db, contact2.id);
  assert.equal(detail2.contact.leadType, null);
  assert.equal(detail2.contact.relationshipType, null);
});

test('getClientDetail exposes the full "complete contact profile" field set added for the Edit Client expansion (2026-09-08)', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'fullprofile@example.com', first_name: 'Renee' });
  db.prepare(`
    UPDATE contacts SET
      middle_name = 'A', home_phone = '414-555-3000', alt_phone = '414-555-3001',
      preferred_contact_method = 'Email', best_time_to_contact = 'Mornings',
      age = 61, marital_status = 'Widowed', spouse_name = 'Prior spouse', spouse_date_of_birth = '1962-01-01',
      number_of_children = 4, number_of_grandchildren = 6, family_notes = 'Very involved family',
      occupation = 'Retired nurse', employer = NULL, referred_by = 'Friend from church'
    WHERE id = ?
  `).run(contact.id);

  const detail = getClientDetail(db, contact.id);
  assert.equal(detail.contact.middleName, 'A');
  assert.equal(detail.contact.homePhone, '414-555-3000');
  assert.equal(detail.contact.altPhone, '414-555-3001');
  assert.equal(detail.contact.preferredContactMethod, 'Email');
  assert.equal(detail.contact.bestTimeToContact, 'Mornings');
  assert.equal(detail.contact.age, 61);
  assert.equal(detail.contact.maritalStatus, 'Widowed');
  assert.equal(detail.contact.spouseName, 'Prior spouse');
  assert.equal(detail.contact.spouseDateOfBirth, '1962-01-01');
  assert.equal(detail.contact.numberOfChildren, 4);
  assert.equal(detail.contact.numberOfGrandchildren, 6);
  assert.equal(detail.contact.familyNotes, 'Very involved family');
  assert.equal(detail.contact.occupation, 'Retired nurse');
  assert.equal(detail.contact.employer, null);
  assert.equal(detail.contact.referredBy, 'Friend from church');
});

test('getClientDetail surfaces contactConflict on the flagged (new) contact, and null on an unrelated contact', () => {
  const { db } = setup();
  const existing = dedupeContact(db, { email: 'detail.existing@example.com', first_name: 'Renee', last_name: 'Jones', phone: '(414) 688-7619', phone_e164: '+14146887619' });
  const dup = dedupeContact(db, { email: null, first_name: 'Test', last_name: 'Caller', phone: '(414) 367-6486', phone_e164: '+14143676486' });
  const bystander = dedupeContact(db, { email: 'bystander@example.com', first_name: 'Someone', last_name: 'Else' });

  db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, candidate_contact_id, reason, status, review_type)
    VALUES ('calcom_webhook', ?, ?, 'Possible existing contact — email matches, but phone number is different. Verify identity before merging or updating.', 'Pending', 'contact_conflict')
  `).run(JSON.stringify({
    conflict_type: 'email_match_phone_diff', name_mismatch: true, new_contact_id: dup.id,
    existing: { first_name: 'Renee', last_name: 'Jones', email: 'detail.existing@example.com', phone: '(414) 688-7619' },
    incoming: { first_name: 'Test', last_name: 'Caller', email: 'detail.existing@example.com', phone: '(414) 367-6486' },
  }), existing.id);

  const dupDetail = getClientDetail(db, dup.id);
  assert.ok(dupDetail.contactConflict, 'the newly-created (flagged) contact must show its conflict');
  assert.equal(dupDetail.contactConflict.conflictType, 'email_match_phone_diff');
  assert.equal(dupDetail.contactConflict.nameMismatch, true);
  assert.equal(dupDetail.contactConflict.existing.name, 'Renee Jones');
  assert.equal(dupDetail.contactConflict.existing.phone, '(414) 688-7619');
  assert.equal(dupDetail.contactConflict.incoming.phone, '(414) 367-6486');

  const existingDetail = getClientDetail(db, existing.id);
  assert.equal(existingDetail.contactConflict, null, 'the EXISTING (established) contact must not itself show a Verification Needed warning');

  const bystanderDetail = getClientDetail(db, bystander.id);
  assert.equal(bystanderDetail.contactConflict, null);
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

test('getDashboardSummary counts pending contact_conflict items as verificationNeeded, separate from reviewRequired', () => {
  const { db } = setup();
  const existing = dedupeContact(db, { email: 'vn.existing@example.com', first_name: 'Renee', last_name: 'Jones', phone_e164: '+14146887619' });
  const dup = dedupeContact(db, { email: null, first_name: 'Test', last_name: 'Caller', phone_e164: '+14143676486' });
  db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, candidate_contact_id, reason, status, review_type)
    VALUES ('calcom_webhook', ?, ?, 'Possible existing contact — email matches, but phone number is different. Verify identity before merging or updating.', 'Pending', 'contact_conflict')
  `).run(JSON.stringify({ conflict_type: 'email_match_phone_diff', new_contact_id: dup.id, existing: {}, incoming: {} }), existing.id);

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.verificationNeeded, 1);
  assert.equal(summary.reviewRequired, 0, 'contact_conflict must not be double-counted inside the generic reviewRequired total');
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
