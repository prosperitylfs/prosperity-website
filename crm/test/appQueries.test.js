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
  getNewProspectsQueue,
  getProspectPipelineQueue,
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

test('getClientDetail exposes Retirement & Annuity Planning fields, and separately surfaces legacy pre-Policies insurance/annuity data read-only', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'planning@example.com', first_name: 'Wade' });
  db.prepare(`
    UPDATE contacts SET
      retirement_account_type = '401(k)', current_institution = 'Fidelity',
      estimated_rollover_amount = 250000, retirement_timeline = '1-3 Years',
      has_current_advisor = 1, interested_in_roth_conversion = 0, retirement_date_goal = '2030-06-01',
      annuity_type = 'SPIA', estimated_income = 12000, surrender_period = '5 years', income_rider = 1,
      insurance_company = 'Legacy Co', policy_type = 'Term Life', face_amount = 100000,
      monthly_premium = 45, annual_premium = 540, policy_status = 'Issued / In-Force',
      application_date = '2018-01-01', policy_issue_date = '2018-02-01',
      annuity_carrier = 'Legacy Annuity Co', annuity_premium = 5000
    WHERE id = ?
  `).run(contact.id);

  const detail = getClientDetail(db, contact.id);
  assert.equal(detail.contact.retirementAccountType, '401(k)');
  assert.equal(detail.contact.currentInstitution, 'Fidelity');
  assert.equal(detail.contact.estimatedRolloverAmount, 250000);
  assert.equal(detail.contact.retirementTimeline, '1-3 Years');
  assert.equal(detail.contact.hasCurrentAdvisor, true);
  assert.equal(detail.contact.interestedInRothConversion, false);
  assert.equal(detail.contact.retirementDateGoal, '2030-06-01');
  assert.equal(detail.contact.annuityType, 'SPIA');
  assert.equal(detail.contact.estimatedIncome, 12000);
  assert.equal(detail.contact.surrenderPeriod, '5 years');
  assert.equal(detail.contact.incomeRider, true);

  assert.deepEqual(detail.contact.legacyInsurance, {
    insuranceCompany: 'Legacy Co', policyType: 'Term Life', faceAmount: 100000,
    monthlyPremium: 45, annualPremium: 540, policyStatus: 'Issued / In-Force',
    applicationDate: '2018-01-01', policyIssueDate: '2018-02-01',
  });
  assert.deepEqual(detail.contact.legacyAnnuity, { annuityCarrier: 'Legacy Annuity Co', annuityPremium: 5000 });
});

test('getClientDetail returns all-null Retirement/Annuity Planning fields and legacy insurance/annuity for a contact that never had any of it set', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'noplanning@example.com', first_name: 'Xena' });
  const detail = getClientDetail(db, contact.id);
  assert.equal(detail.contact.retirementAccountType, null);
  assert.equal(detail.contact.hasCurrentAdvisor, false);
  assert.equal(detail.contact.incomeRider, false);
  assert.deepEqual(detail.contact.legacyInsurance, {
    insuranceCompany: null, policyType: null, faceAmount: null, monthlyPremium: null,
    annualPremium: null, policyStatus: null, applicationDate: null, policyIssueDate: null,
  });
  assert.deepEqual(detail.contact.legacyAnnuity, { annuityCarrier: null, annuityPremium: null });
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

// ── Default "Sort: Name" = last name A-Z, then first name A-Z, displayed
//    as "Last Name, First Name" ─────────────────────────────────────────

test('getCaseList default sort (name) orders by LAST NAME A-Z, then FIRST NAME A-Z, and displays "Last, First"', () => {
  const { db, prosperityId } = setup();
  const productId = getProductId(db, prosperityId, 'Life insurance');
  const people = [
    { first: 'Kamren', last: 'Rainey' }, { first: 'Nadia', last: 'Rainey' },
    { first: 'Dieera', last: 'Robinson' }, { first: 'Dianne', last: 'Simmons' },
    { first: 'Ralph', last: 'Small' },
  ];
  for (const p of people) {
    const c = dedupeContact(db, { email: `${p.first.toLowerCase()}.sort@example.com`, first_name: p.first, last_name: p.last });
    const link = resolveContactBrand(db, { contactId: c.id, brandId: prosperityId });
    matchOrCreateCase(db, { contactBrandId: link.id, productId, eventType: 'new_inquiry' });
  }

  const list = getCaseList(db, { brandId: 'prosperity', sort: 'name', pageSize: 10 });
  assert.deepEqual(list.contacts.map(x => x.contactName), [
    'Rainey, Kamren', 'Rainey, Nadia', 'Robinson, Dieera', 'Simmons, Dianne', 'Small, Ralph',
  ]);
});

test('getCaseList default sort (name) puts a contact with a blank last name LAST, not first', () => {
  const { db, prosperityId } = setup();
  const productId = getProductId(db, prosperityId, 'Life insurance');
  const blank = dedupeContact(db, { email: 'blanklast@example.com', first_name: 'Zack', last_name: '' });
  const named = dedupeContact(db, { email: 'named@example.com', first_name: 'Amy', last_name: 'Abbott' });
  for (const c of [blank, named]) {
    const link = resolveContactBrand(db, { contactId: c.id, brandId: prosperityId });
    matchOrCreateCase(db, { contactBrandId: link.id, productId, eventType: 'new_inquiry' });
  }

  const list = getCaseList(db, { brandId: 'prosperity', sort: 'name', pageSize: 10 });
  // Plain COLLATE NOCASE would put '' (blank last name) before 'Abbott' --
  // the fix pushes a blank last name to the end instead. A contact with no
  // last name shows just their first name (no dangling comma).
  assert.deepEqual(list.contacts.map(x => x.contactName), ['Abbott, Amy', 'Zack']);
});

// ── Dashboard "Recently Active Contacts": which 8 contacts appear is still
//    driven by recency; the DISPLAY order of that set matches the same
//    last-name sort/format as the two tests above. ───────────────────────

test('getRecentlyActiveClients selects by recency but DISPLAYS the result sorted "Last, First", blank last name last', () => {
  const { db } = setup();
  const { getRecentlyActiveClients } = require('../lib/dashboardQueries');

  // Deliberately created in an order that is NOT alphabetical, and each
  // given a distinct, increasing updated_at so recency-selection is
  // unambiguous and clearly different from the alphabetical display order.
  const small = dedupeContact(db, { email: 'small.recent@example.com', first_name: 'Ralph', last_name: 'Small' });
  const rainey = dedupeContact(db, { email: 'rainey.recent@example.com', first_name: 'Kamren', last_name: 'Rainey' });
  const blank = dedupeContact(db, { email: 'blank.recent@example.com', first_name: 'Zack', last_name: '' });
  db.prepare(`UPDATE contacts SET updated_at = '2026-01-01 00:00:00' WHERE id = ?`).run(small.id);
  db.prepare(`UPDATE contacts SET updated_at = '2026-01-02 00:00:00' WHERE id = ?`).run(rainey.id);
  db.prepare(`UPDATE contacts SET updated_at = '2026-01-03 00:00:00' WHERE id = ?`).run(blank.id);

  const list = getRecentlyActiveClients(db, { limit: 3 });
  // All three of the most-recently-active contacts are selected (recency
  // still decides WHICH contacts appear -- unchanged), but listed here in
  // last-name order, blank last name last -- not in recency order.
  assert.deepEqual(list.map(x => x.contactName), ['Rainey, Kamren', 'Small, Ralph', 'Zack']);
});

test('getRecentlyActiveClients recency selection is unaffected by the display re-sort -- a genuinely older contact is excluded even though it would sort first alphabetically', () => {
  const { db } = setup();
  const { getRecentlyActiveClients } = require('../lib/dashboardQueries');
  const aaron = dedupeContact(db, { email: 'aaron.old@example.com', first_name: 'Aaron', last_name: 'Aardvark' });
  const zed = dedupeContact(db, { email: 'zed.new@example.com', first_name: 'Zed', last_name: 'Zorro' });
  db.prepare(`UPDATE contacts SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(aaron.id);
  db.prepare(`UPDATE contacts SET updated_at = '2026-01-01 00:00:00' WHERE id = ?`).run(zed.id);

  const list = getRecentlyActiveClients(db, { limit: 1 });
  assert.deepEqual(list.map(x => x.contactName), ['Zorro, Zed'], 'the more recently active contact must still be the one selected, even though it would sort last alphabetically');
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

// ── New Prospects -- Last 7 Days (2026-09-22 audit) ─────────────────────────
// contacts.created_at is only ever set at INSERT time and never touched
// again (confirmed across dedupeContact/leadIntake.js/routes/calcom.js/
// clientService.js/importService.js) -- these tests simulate "this contact
// has existed for a while" by directly backdating created_at, exactly the
// way a real pre-existing row would look, rather than relying on real wall-
// clock time passing during the test run.

function backdateContact(db, contactId, daysAgo) {
  db.prepare(`UPDATE contacts SET created_at = datetime('now', ?) WHERE id = ?`)
    .run(`-${daysAgo} days`, contactId);
}

test('A. a brand-new Cal.com-style prospect (no relationship_type, default lead_status) counts as a New Prospect', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'newprospect-calcom@example.com', first_name: 'Janet', last_name: 'Jackson', phone_e164: '+14145551000' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  // Cal.com immediately sets lead_status to 'Appointment Scheduled' on a
  // brand-new contact (routes/calcom.js) -- simulated directly here, since
  // this test exercises dashboardQueries.js in isolation, not the webhook.
  db.prepare(`UPDATE contacts SET lead_status = 'Appointment Scheduled' WHERE id = ?`).run(contact.id);

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newProspects, 1, '"New Prospect" must not require lead_status to be literally \'New Lead\'');
});

test('B. a brand-new website-lead-style prospect (lead_status stays the schema default \'New Lead\') counts as a New Prospect', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'newprospect-website@example.com', first_name: 'Wanda' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newProspects, 1);
});

test('C. an existing CRM client who books another appointment is NOT counted as a New Prospect', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'existing-rebooks@example.com', first_name: 'Renee', last_name: 'Jones' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  backdateContact(db, contact.id, 30); // established 30 days ago
  // Simulate today's new booking touching lead_status, exactly like
  // routes/calcom.js's upgrade logic does -- created_at must stay untouched.
  db.prepare(`UPDATE contacts SET lead_status = 'Appointment Scheduled', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(contact.id);

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newProspects, 0, 'rebooking must never make an existing client look like a new prospect');
});

test('D. an imported existing client (lead_status=\'Existing Client\') is NOT counted, even with a fresh created_at', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'imported-existing@example.com', first_name: 'Ida' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  db.prepare(`UPDATE contacts SET lead_status = 'Existing Client' WHERE id = ?`).run(contact.id);

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newProspects, 0, 'lib/importService.js\'s own "Existing Client" classification must be honored');
});

test('E. a manually-added Active Client (relationship_type=\'active_client\') is NOT counted, even with a fresh created_at', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'manual-active-client@example.com', first_name: 'Al' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  db.prepare(`UPDATE contacts SET relationship_type = 'active_client' WHERE id = ?`).run(contact.id);

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newProspects, 0);
});

test('F. a manually-added Lead/Prospect (relationship_type=\'lead\') IS counted', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'manual-lead@example.com', first_name: 'Lea' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  db.prepare(`UPDATE contacts SET relationship_type = 'lead' WHERE id = ?`).run(contact.id);

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newProspects, 1);
});

test('other manual Relationship values (former_client, prior_applicant, declined_applicant) are all excluded, same as active_client', () => {
  const { db, prosperityId } = setup();
  for (const rel of ['former_client', 'prior_applicant', 'declined_applicant']) {
    const contact = dedupeContact(db, { email: `manual-${rel}@example.com`, first_name: 'Test' });
    resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
    db.prepare(`UPDATE contacts SET relationship_type = ? WHERE id = ?`).run(rel, contact.id);
  }
  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newProspects, 0);
});

test('duplicate/matched contacts that already existed before a new inquiry are not counted, even when the new inquiry happens today', () => {
  const { db, prosperityId } = setup();
  // Same shape as C, phrased against the exact scenario named in the audit:
  // dedupeContact() MATCHES the existing row (same email) rather than
  // inserting a new one -- created_at is never touched by a match.
  const first = dedupeContact(db, { email: 'dup-match@example.com', first_name: 'Dana' });
  resolveContactBrand(db, { contactId: first.id, brandId: prosperityId });
  backdateContact(db, first.id, 14);

  const second = dedupeContact(db, { email: 'dup-match@example.com', first_name: 'Dana' }); // matches, not a new row
  assert.equal(second.id, first.id, 'sanity check: dedupeContact must have matched, not created a second row');

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newProspects, 0);
});

test('a contact created more than 7 days ago is excluded regardless of lead_status/relationship_type', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'old-prospect@example.com', first_name: 'Otto' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  backdateContact(db, contact.id, 8);

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newProspects, 0);
});

test('G. Brand Review Required (newLeads) still returns the exact same unresolved_intake/review_type=\'brand\' count as before -- unaffected by New Prospects', () => {
  const { db, prosperityId } = setup();
  db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type)
    VALUES ('fake_webform', '{}', 'test', 'Pending', 'brand')
  `).run();
  // Also seed a New Prospect at the same time, to prove the two metrics are
  // independent and neither leaks into the other.
  const contact = dedupeContact(db, { email: 'independent-check@example.com', first_name: 'Iggy' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.newLeads, 1);
  assert.equal(summary.newProspects, 1);
});

test('H. All Companies / Insurance Lady / Prosperity filters correctly scope New Prospects, using the same contact_brands/brands join as other tiles', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const prContact = dedupeContact(db, { email: 'filter-prosperity@example.com', first_name: 'Pat' });
  resolveContactBrand(db, { contactId: prContact.id, brandId: prosperityId });
  const ilContact = dedupeContact(db, { email: 'filter-il@example.com', first_name: 'Ivy' });
  resolveContactBrand(db, { contactId: ilContact.id, brandId: insuranceLadyId });

  assert.equal(getDashboardSummary(db, { brandId: null }).newProspects, 2, 'All Companies must include both');
  assert.equal(getDashboardSummary(db, { brandId: 'prosperity' }).newProspects, 1);
  assert.equal(getDashboardSummary(db, { brandId: 'insurance-lady' }).newProspects, 1);
});

// ── Dedicated New Prospects page / getNewProspectsQueue (2026-09-23) ───────
// The Dashboard tile's count and this dedicated list must be structurally
// incapable of disagreeing -- getDashboardSummary's newProspects field IS
// getNewProspectsQueue(...).length, not a second, independently-written
// query. These tests exercise getNewProspectsQueue directly and cross-check
// it against getDashboardSummary wherever relevant.

test('the Dashboard newProspects count and getNewProspectsQueue\'s own list length always agree, across every filter', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const prContact = dedupeContact(db, { email: 'consistency-pr@example.com', first_name: 'Cory' });
  resolveContactBrand(db, { contactId: prContact.id, brandId: prosperityId });
  const ilContact = dedupeContact(db, { email: 'consistency-il@example.com', first_name: 'Ilsa' });
  resolveContactBrand(db, { contactId: ilContact.id, brandId: insuranceLadyId });
  // Also seed a few excluded contacts, to prove the two never drift apart
  // even when there's real data the query has to filter out.
  const existingClient = dedupeContact(db, { email: 'consistency-existing@example.com', first_name: 'Ed' });
  resolveContactBrand(db, { contactId: existingClient.id, brandId: prosperityId });
  db.prepare(`UPDATE contacts SET lead_status = 'Existing Client' WHERE id = ?`).run(existingClient.id);

  for (const brandId of [null, 'prosperity', 'insurance-lady']) {
    const summaryCount = getDashboardSummary(db, { brandId }).newProspects;
    const queueLength = getNewProspectsQueue(db, { brandId }).length;
    assert.equal(summaryCount, queueLength, `mismatch for brandId=${brandId}`);
  }
});

test('getNewProspectsQueue returns the full field set the New Prospects page needs: name, brand, phone, email, date entered, lead status, relationship, and a linkable contactId', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, {
    email: 'fullrow@example.com', first_name: 'Fiona', last_name: 'Rowe',
    phone: '(414) 555-0100', phone_e164: '+14145550100',
  });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  db.prepare(`UPDATE contacts SET lead_status = 'Appointment Scheduled' WHERE id = ?`).run(contact.id);

  const [row] = getNewProspectsQueue(db, { brandId: null });
  assert.equal(row.contactId, contact.id);
  assert.equal(row.name, 'Fiona Rowe');
  assert.equal(row.brandId, 'prosperity');
  assert.equal(row.brandShortName, 'Prosperity');
  assert.equal(row.phone, '+14145550100', 'must prefer the E.164 phone when available');
  assert.equal(row.email, 'fullrow@example.com');
  assert.ok(row.createdAt, 'created_at must be present so the page can show "Date Entered"');
  assert.equal(row.leadStatus, 'Appointment Scheduled');
  assert.equal(row.relationshipType, null);
});

test('a qualifying contact with ZERO cases still appears in getNewProspectsQueue -- this must never go through the Clients page\'s case-based query', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'no-case-yet@example.com', first_name: 'Nico' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 0, 'sanity check: no case exists anywhere in this database');

  const queue = getNewProspectsQueue(db, { brandId: null });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].contactId, contact.id);

  // And confirm the CONTRAST: this same contact is correctly invisible to
  // the case-driven Clients page query, which is exactly why a dedicated
  // view was required instead of filtering clients.html.
  const caseListResult = getCaseList(db, { brandId: null, statusFilter: 'all' });
  assert.equal(caseListResult.contacts.find(c => c.contactId === contact.id), undefined, 'a caseless contact must not appear on the case-driven Clients page');
});

test('an existing client does not appear in getNewProspectsQueue\'s list (not just the count)', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'existing-not-listed@example.com', first_name: 'Elsa' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  db.prepare(`UPDATE contacts SET relationship_type = 'active_client' WHERE id = ?`).run(contact.id);

  const queue = getNewProspectsQueue(db, { brandId: null });
  assert.equal(queue.length, 0);
});

test('a matched/re-booking existing contact does not appear in the list, even though today\'s booking touched its lead_status', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'rebooking-not-listed@example.com', first_name: 'Rex' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  backdateContact(db, contact.id, 20);
  // Re-match (not re-create) via the same primitive Cal.com/leadIntake use,
  // then simulate the lead_status upgrade a new booking performs.
  const matched = dedupeContact(db, { email: 'rebooking-not-listed@example.com', first_name: 'Rex' });
  assert.equal(matched.id, contact.id);
  db.prepare(`UPDATE contacts SET lead_status = 'Appointment Scheduled' WHERE id = ?`).run(contact.id);

  const queue = getNewProspectsQueue(db, { brandId: null });
  assert.equal(queue.length, 0);
});

test('the 7-day boundary is correct in the list, not just the count: 6 days ago is included, 8 days ago is excluded', () => {
  const { db, prosperityId } = setup();
  const recent = dedupeContact(db, { email: 'boundary-recent@example.com', first_name: 'Ray' });
  resolveContactBrand(db, { contactId: recent.id, brandId: prosperityId });
  backdateContact(db, recent.id, 6);

  const old = dedupeContact(db, { email: 'boundary-old@example.com', first_name: 'Ona' });
  resolveContactBrand(db, { contactId: old.id, brandId: prosperityId });
  backdateContact(db, old.id, 8);

  const queue = getNewProspectsQueue(db, { brandId: null });
  const ids = queue.map(p => p.contactId);
  assert.ok(ids.includes(recent.id), '6 days ago must still be included');
  assert.ok(!ids.includes(old.id), '8 days ago must be excluded');
});

test('getNewProspectsQueue respects the company filter directly (All / Prosperity / Insurance Lady)', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const prContact = dedupeContact(db, { email: 'queue-filter-pr@example.com', first_name: 'Priya' });
  resolveContactBrand(db, { contactId: prContact.id, brandId: prosperityId });
  const ilContact = dedupeContact(db, { email: 'queue-filter-il@example.com', first_name: 'Isla' });
  resolveContactBrand(db, { contactId: ilContact.id, brandId: insuranceLadyId });

  const all = getNewProspectsQueue(db, { brandId: null });
  const pr = getNewProspectsQueue(db, { brandId: 'prosperity' });
  const il = getNewProspectsQueue(db, { brandId: 'insurance-lady' });
  assert.equal(all.length, 2);
  assert.deepEqual(pr.map(p => p.contactId), [prContact.id]);
  assert.deepEqual(il.map(p => p.contactId), [ilContact.id]);
});

// ── Prospect Pipeline (2026-09-23) ──────────────────────────────────────────
// The permanent, unbounded-age sibling of New Prospects -- same
// qualification rule (queryProspects() in lib/dashboardQueries.js), just
// without the 7-day recency clause. These tests deliberately mirror the
// New Prospects suite above, with the one addition that matters here: a
// prospect older than 7 days must still appear.

test('a brand-new prospect appears in Prospect Pipeline', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'pipeline-new@example.com', first_name: 'Nina' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });

  const pipeline = getProspectPipelineQueue(db, { brandId: null });
  assert.equal(pipeline.length, 1);
  assert.equal(pipeline[0].contactId, contact.id);
});

test('a prospect older than 7 days STILL appears in Prospect Pipeline -- the entire point of this view versus New Prospects', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'pipeline-old@example.com', first_name: 'Oscar' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  backdateContact(db, contact.id, 45); // well past the New Prospects 7-day window

  const pipeline = getProspectPipelineQueue(db, { brandId: null });
  assert.equal(pipeline.length, 1);
  assert.equal(pipeline[0].contactId, contact.id);

  // Cross-check against the sibling view, to directly prove this is the
  // actual gap Prospect Pipeline closes.
  const newProspects = getNewProspectsQueue(db, { brandId: null });
  assert.equal(newProspects.length, 0, 'sanity check: this same contact must NOT appear in New Prospects once past 7 days');
});

test('an imported existing client (lead_status=\'Existing Client\') does not appear in Prospect Pipeline', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'pipeline-existing-client@example.com', first_name: 'Elle' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  db.prepare(`UPDATE contacts SET lead_status = 'Existing Client' WHERE id = ?`).run(contact.id);

  assert.equal(getProspectPipelineQueue(db, { brandId: null }).length, 0);
});

test('Active Client, Former Client, and Declined Applicant relationship_type values are all excluded from Prospect Pipeline, at any age', () => {
  const { db, prosperityId } = setup();
  for (const rel of ['active_client', 'former_client', 'declined_applicant', 'prior_applicant']) {
    const contact = dedupeContact(db, { email: `pipeline-${rel}@example.com`, first_name: 'Test' });
    resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
    db.prepare(`UPDATE contacts SET relationship_type = ? WHERE id = ?`).run(rel, contact.id);
    backdateContact(db, contact.id, 60); // prove age alone never brings them back
  }
  assert.equal(getProspectPipelineQueue(db, { brandId: null }).length, 0);
});

test('Prospect Pipeline respects the company filter (All / Prosperity / Insurance Lady), regardless of prospect age', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const prContact = dedupeContact(db, { email: 'pipeline-filter-pr@example.com', first_name: 'Pia' });
  resolveContactBrand(db, { contactId: prContact.id, brandId: prosperityId });
  backdateContact(db, prContact.id, 90);
  const ilContact = dedupeContact(db, { email: 'pipeline-filter-il@example.com', first_name: 'Ines' });
  resolveContactBrand(db, { contactId: ilContact.id, brandId: insuranceLadyId });
  backdateContact(db, ilContact.id, 90);

  assert.equal(getProspectPipelineQueue(db, { brandId: null }).length, 2);
  assert.deepEqual(getProspectPipelineQueue(db, { brandId: 'prosperity' }).map(p => p.contactId), [prContact.id]);
  assert.deepEqual(getProspectPipelineQueue(db, { brandId: 'insurance-lady' }).map(p => p.contactId), [ilContact.id]);
});

test('a prospect with ZERO cases still appears in Prospect Pipeline -- must never go through the Clients page\'s case-based query', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'pipeline-no-case@example.com', first_name: 'Zeke' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  backdateContact(db, contact.id, 30);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, 0, 'sanity check: no case exists anywhere');

  const pipeline = getProspectPipelineQueue(db, { brandId: null });
  assert.equal(pipeline.length, 1);
  assert.equal(pipeline[0].contactId, contact.id);

  const caseListResult = getCaseList(db, { brandId: null, statusFilter: 'all' });
  assert.equal(caseListResult.contacts.find(c => c.contactId === contact.id), undefined, 'confirms this is exactly the contact the Clients page cannot show');
});

test('the same contact appears in BOTH New Prospects and Prospect Pipeline during its first 7 days -- same underlying row, never a duplicate record', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'pipeline-both-views@example.com', first_name: 'Beau' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });

  const newProspects = getNewProspectsQueue(db, { brandId: null });
  const pipeline = getProspectPipelineQueue(db, { brandId: null });
  assert.equal(newProspects.length, 1);
  assert.equal(pipeline.length, 1);
  assert.equal(newProspects[0].contactId, pipeline[0].contactId, 'both views must point at the exact same contact id');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').get('pipeline-both-views@example.com').n, 1, 'exactly one contacts row -- no duplicate prospect record was created for either view');
});

test('Prospect Pipeline\'s count comes from the same list the page displays -- the length of getProspectPipelineQueue\'s own return value, never a separate COUNT query', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const a = dedupeContact(db, { email: 'pipeline-count-a@example.com', first_name: 'A' });
  resolveContactBrand(db, { contactId: a.id, brandId: prosperityId });
  backdateContact(db, a.id, 15);
  const b = dedupeContact(db, { email: 'pipeline-count-b@example.com', first_name: 'B' });
  resolveContactBrand(db, { contactId: b.id, brandId: insuranceLadyId });

  const list = getProspectPipelineQueue(db, { brandId: null });
  // The route (crm/routes/crmApp.js's GET /prospect-pipeline) sends exactly
  // this array as { prospects: list } -- the page's own displayed count is
  // list.length client-side, so proving the list itself is correct IS
  // proving the count is correct; there is no separate query to drift.
  assert.equal(list.length, 2);
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

// ── Failed Communications dashboard count ─────────────────────────────────
// The Dashboard "Failed Communications" tile/count must represent only
// communications that STILL NEED attention -- once resolved
// (crm/lib/dashboardQueries.js's resolveFailedCommunication), a failure
// stops counting even though its sms_messages/emails row (status='failed')
// is never deleted or changed.

test('getDashboardSummary.failedComms counts only Failed communications, and drops to 0 once none remain unresolved', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'failedcomms@example.com', first_name: 'Fern' });

  const before = getDashboardSummary(db, { brandId: null });
  assert.equal(before.failedComms, 0);

  const ins = db.prepare(`INSERT INTO sms_messages (contact_id, direction, to_number, body, status) VALUES (?, 'outbound', '+15555550300', 'hi', 'failed')`).run(contact.id);
  const afterFail = getDashboardSummary(db, { brandId: null });
  assert.equal(afterFail.failedComms, 1);

  const { resolveFailedCommunication } = require('../lib/dashboardQueries');
  resolveFailedCommunication(db, { channel: 'sms', id: ins.lastInsertRowid }, 'Loretta Stewart');

  const afterResolve = getDashboardSummary(db, { brandId: null });
  assert.equal(afterResolve.failedComms, 0, 'a resolved failure must no longer count toward Failed Communications');
});

test('getDashboardSummary.failedComms only counts UNRESOLVED failures when several exist', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'failedcomms2@example.com', first_name: 'Gale' });
  const a = db.prepare(`INSERT INTO sms_messages (contact_id, direction, to_number, body, status) VALUES (?, 'outbound', '+15555550301', 'a', 'failed')`).run(contact.id);
  db.prepare(`INSERT INTO sms_messages (contact_id, direction, to_number, body, status) VALUES (?, 'outbound', '+15555550302', 'b', 'failed')`).run(contact.id);

  assert.equal(getDashboardSummary(db, { brandId: null }).failedComms, 2);

  const { resolveFailedCommunication } = require('../lib/dashboardQueries');
  resolveFailedCommunication(db, { channel: 'sms', id: a.lastInsertRowid }, 'Loretta Stewart');

  assert.equal(getDashboardSummary(db, { brandId: null }).failedComms, 1, 'only the resolved one drops out -- the other still-unresolved failure keeps counting');
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
