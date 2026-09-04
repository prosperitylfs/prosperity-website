// Tests for crm/lib/dashboardQueries.js. In-memory databases only, seeded
// with clearly fake contacts/cases via caseMatching.js primitives.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { dedupeContact, resolveContactBrand, matchOrCreateCase } = require('../lib/caseMatching');
const {
  getCaseList, getBrandReviewQueue, getCaseReviewQueue,
  getMessageDeliveryStatus, normalizeMessageStatus,
} = require('../lib/dashboardQueries');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  runRevenueMvpMigrations(db); // adds sms_messages.failure_reason, among others
  return { db, insuranceLadyId, prosperityId };
}

function productId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

// Flattens the new { contacts, pagination } shape back into one row per
// case (with contactId/contactName attached), matching the pre-search/
// pagination shape most of these tests were originally written against.
function flattenCases(result) {
  const rows = [];
  for (const c of result.contacts) {
    for (const cs of c.cases) {
      rows.push({ contactId: c.contactId, contactName: c.contactName, ...cs });
    }
  }
  return rows;
}

function seedTwoBrandFixture(db, insuranceLadyId, prosperityId) {
  // One person with a case under EACH brand.
  const dual = dedupeContact(db, { email: 'dual.fake@example.test', first_name: 'Test', last_name: 'DualBrand' });
  const dualIl = resolveContactBrand(db, { contactId: dual.id, brandId: insuranceLadyId });
  const dualPr = resolveContactBrand(db, { contactId: dual.id, brandId: prosperityId });
  const ilCase = matchOrCreateCase(db, { contactBrandId: dualIl.id, productId: productId(db, insuranceLadyId, 'Whole life/final expense'), externalRef: 'fake-il-1', eventType: 'booking_created' });
  const prCase = matchOrCreateCase(db, { contactBrandId: dualPr.id, productId: productId(db, prosperityId, 'Annuities'), externalRef: 'fake-pr-1', eventType: 'booking_created' });

  // A second Prosperity-only person with TWO separate cases.
  const multi = dedupeContact(db, { email: 'multi.fake@example.test', first_name: 'Test', last_name: 'MultiCase' });
  const multiLink = resolveContactBrand(db, { contactId: multi.id, brandId: prosperityId });
  const case1 = matchOrCreateCase(db, { contactBrandId: multiLink.id, productId: productId(db, prosperityId, 'Life insurance'), externalRef: 'fake-pr-2', eventType: 'booking_created' });
  const case2 = matchOrCreateCase(db, { contactBrandId: multiLink.id, productId: productId(db, prosperityId, 'Rollovers and safe-money solutions'), externalRef: 'fake-pr-3', eventType: 'booking_created' });

  return { dual, dualIl, dualPr, ilCase, prCase, multi, multiLink, case1, case2 };
}

test('All Brands (no filter) returns cases from both brands', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const rows = flattenCases(getCaseList(db, { brandId: 'all' }));
  const brandsSeen = new Set(rows.map(r => r.brandId));
  assert.ok(brandsSeen.has('insurance-lady'));
  assert.ok(brandsSeen.has('prosperity'));
});

test('Insurance Lady filter excludes Prosperity cases', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const rows = flattenCases(getCaseList(db, { brandId: 'insurance-lady' }));
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.brandId === 'insurance-lady'));
});

test('Prosperity filter excludes Insurance Lady cases', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const rows = flattenCases(getCaseList(db, { brandId: 'prosperity' }));
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.brandId === 'prosperity'));
});

test('one person can display cases under both brands', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const { dual } = seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const result = getCaseList(db, { brandId: 'all' });
  const contact = result.contacts.find(c => c.contactId === dual.id);
  assert.equal(contact.cases.length, 2);
  assert.deepEqual(contact.brandIds.sort(), ['insurance-lady', 'prosperity']);
});

test('multiple cases under one relationship remain separate rows, not merged', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const { multi, case1, case2 } = seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const result = getCaseList(db, { brandId: 'all' });
  const contact = result.contacts.find(c => c.contactId === multi.id);
  assert.equal(contact.cases.length, 2);
  const caseIds = contact.cases.map(c => c.caseId).sort();
  assert.deepEqual(caseIds, [case1.case.id, case2.case.id].sort((a, b) => a - b));
  assert.notEqual(contact.cases[0].productName, contact.cases[1].productName);
});

test('list never shows phone, email, lead_source, or booking id fields', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const rows = flattenCases(getCaseList(db, { brandId: 'all' }));
  for (const row of rows) {
    const keys = Object.keys(row);
    for (const forbidden of ['phone', 'email', 'leadSource', 'lead_source', 'bookingId', 'cal_booking_uid']) {
      assert.ok(!keys.includes(forbidden), `case list row must not include '${forbidden}'`);
    }
  }
});

test('case archive (via getCaseList after archiving) affects only that case', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const { multi, case1, case2 } = seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  db.prepare("UPDATE cases SET status = 'Archived' WHERE id = ?").run(case1.case.id);

  const active = flattenCases(getCaseList(db, { brandId: 'all', statusFilter: 'active' })).filter(r => r.contactId === multi.id);
  const archived = flattenCases(getCaseList(db, { brandId: 'all', statusFilter: 'archived' })).filter(r => r.contactId === multi.id);

  assert.equal(active.length, 1);
  assert.equal(active[0].caseId, case2.case.id);
  assert.equal(archived.length, 1);
  assert.equal(archived[0].caseId, case1.case.id);
});

test('archiving one case does not remove the person if they still have another matching case', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const { multi, case1 } = seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  db.prepare("UPDATE cases SET status = 'Archived' WHERE id = ?").run(case1.case.id);

  const result = getCaseList(db, { brandId: 'all', statusFilter: 'active' });
  const contact = result.contacts.find(c => c.contactId === multi.id);
  assert.ok(contact, 'person must still appear — they still have one active case');
  assert.equal(contact.cases.length, 1);
});

// ── Search ───────────────────────────────────────────────────────────────

test('search matches by contact name', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const { dual, multi } = seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const result = getCaseList(db, { brandId: 'all', search: 'DualBrand' });
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].contactId, dual.id);
});

test('search matches by phone number', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'searchphone.fake@example.test', first_name: 'Fake', last_name: 'SearchPhone', phone_e164: '+15550199001' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, insuranceLadyId, 'Cash cancer insurance'), externalRef: 'fake-search-phone', eventType: 'booking_created' });

  const result = getCaseList(db, { brandId: 'all', search: '0199001' });
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].contactId, contact.id);
});

test('search matches by email address', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'unique.searchable@example.test', first_name: 'Fake', last_name: 'SearchEmail' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, insuranceLadyId, 'Cash cancer insurance'), externalRef: 'fake-search-email', eventType: 'booking_created' });

  const result = getCaseList(db, { brandId: 'all', search: 'unique.searchable' });
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].contactId, contact.id);
});

test('search matches by product/service name', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'searchproduct.fake@example.test', first_name: 'Fake', last_name: 'SearchProduct' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, prosperityId, 'Rollovers and safe-money solutions'), externalRef: 'fake-search-product', eventType: 'booking_created' });

  const result = getCaseList(db, { brandId: 'all', search: 'safe-money' });
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].contactId, contact.id);
});

test('search combined with brand filter narrows correctly', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const { dual } = seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  // dual has cases under both brands — searching their name but restricting
  // to Prosperity should surface them with only the Prosperity case.
  const result = getCaseList(db, { brandId: 'prosperity', search: 'DualBrand' });
  assert.equal(result.contacts.length, 1);
  assert.equal(result.contacts[0].contactId, dual.id);
  assert.deepEqual(result.contacts[0].brandIds, ['prosperity']);
});

test('search combined with archived status filter narrows correctly', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const { multi, case1 } = seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  db.prepare("UPDATE cases SET status = 'Archived' WHERE id = ?").run(case1.case.id);

  const activeSearch = getCaseList(db, { brandId: 'all', statusFilter: 'active', search: 'MultiCase' });
  const archivedSearch = getCaseList(db, { brandId: 'all', statusFilter: 'archived', search: 'MultiCase' });
  assert.equal(activeSearch.contacts.length, 1);
  assert.equal(activeSearch.contacts[0].cases.length, 1);
  assert.equal(archivedSearch.contacts.length, 1);
  assert.equal(archivedSearch.contacts[0].cases.length, 1);
});

test('search with no matches returns an empty contacts array', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const result = getCaseList(db, { brandId: 'all', search: 'NoSuchPersonAtAll' });
  assert.deepEqual(result.contacts, []);
  assert.equal(result.pagination.totalContacts, 0);
});

test('search never returns sender/channel information — it is a viewing filter only', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const result = getCaseList(db, { brandId: 'all', search: 'Dual' });
  const json = JSON.stringify(result);
  for (const forbidden of ['emailSender', 'canSend', 'aiReceptionist']) {
    assert.ok(!json.includes(forbidden), `getCaseList must never surface sender-identity field '${forbidden}'`);
  }
});

// ── Pagination ───────────────────────────────────────────────────────────

function seedManyContacts(db, brandRowId, count) {
  const ids = [];
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(3, '0');
    const contact = dedupeContact(db, { email: `bulk${n}.fake@example.test`, first_name: 'Bulk', last_name: `Contact${n}` });
    const link = resolveContactBrand(db, { contactId: contact.id, brandId: brandRowId });
    matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, brandRowId, 'Life insurance'), externalRef: `fake-bulk-${n}`, eventType: 'booking_created' });
    ids.push(contact.id);
  }
  return ids;
}

test('pagination defaults to 25 people per page and reports an accurate range', () => {
  const { db, prosperityId } = setup();
  seedManyContacts(db, prosperityId, 32);

  const page1 = getCaseList(db, { brandId: 'all' });
  assert.equal(page1.contacts.length, 25);
  assert.equal(page1.pagination.totalContacts, 32);
  assert.equal(page1.pagination.totalPages, 2);
  assert.equal(page1.pagination.rangeStart, 1);
  assert.equal(page1.pagination.rangeEnd, 25);

  const page2 = getCaseList(db, { brandId: 'all', page: 2 });
  assert.equal(page2.contacts.length, 7);
  assert.equal(page2.pagination.rangeStart, 26);
  assert.equal(page2.pagination.rangeEnd, 32);
});

test('pagination never splits one person\'s cases across two pages', () => {
  const { db, prosperityId } = setup();
  seedManyContacts(db, prosperityId, 30);
  const page1 = getCaseList(db, { brandId: 'all', page: 1 });
  const page2 = getCaseList(db, { brandId: 'all', page: 2 });
  const page1Ids = new Set(page1.contacts.map(c => c.contactId));
  const page2Ids = new Set(page2.contacts.map(c => c.contactId));
  for (const id of page1Ids) assert.ok(!page2Ids.has(id), 'a contact must not appear on both pages');
});

test('a page number beyond the last page clamps to the last valid page rather than erroring or showing empty', () => {
  const { db, prosperityId } = setup();
  seedManyContacts(db, prosperityId, 5);
  const result = getCaseList(db, { brandId: 'all', page: 99 });
  assert.equal(result.pagination.page, 1); // only one page exists for 5 contacts
  assert.equal(result.contacts.length, 5);
});

test('an empty result set (search matches nothing) reports zero total pages worth of content, not an error', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  seedTwoBrandFixture(db, insuranceLadyId, prosperityId);
  const result = getCaseList(db, { brandId: 'all', search: 'NoSuchPersonAtAll', page: 5 });
  assert.deepEqual(result.contacts, []);
  assert.equal(result.pagination.totalContacts, 0);
});

test('Brand Review queue lists only pending brand-review items with evidence', () => {
  const { db } = setup();
  db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type)
    VALUES ('fake_webhook', ?, 'no recognized lead_type/lead_source signal', 'Pending', 'brand')
  `).run(JSON.stringify({ first_name: 'Fake', last_name: 'Reviewperson', email: 'fake.review@example.test' }));

  const queue = getBrandReviewQueue(db);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].identifier, 'Fake Reviewperson');
  assert.ok(queue[0].evidence.some(e => e.includes('fake.review@example.test')));
});

test('Case Review queue lists candidate open cases for the same relationship', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'casereview.fake@example.test', first_name: 'Fake', last_name: 'CaseReview' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const openCase = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, insuranceLadyId, 'Cash cancer insurance'), externalRef: 'fake-open-case-1', eventType: 'booking_created' });

  db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type, contact_brand_id, ref_type, ref_value)
    VALUES ('fake_webhook', '{}', 'reschedule references unknown prior booking ref', 'Pending', 'case', ?, 'cal_booking_uid', 'fake-resched-1')
  `).run(link.id);

  const queue = getCaseReviewQueue(db);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].brandId, 'insurance-lady');
  assert.equal(queue[0].candidateCases.length, 1);
  assert.equal(queue[0].candidateCases[0].caseId, openCase.case.id);
  assert.equal(queue[0].candidateCases[0].label, 'Cash cancer insurance');
  // Technical ref is available for a details disclosure, not the primary display.
  assert.equal(queue[0].technicalDetails.refValue, 'fake-resched-1');
});

test('Brand Review evidence uses plain-language labels, not raw field names', () => {
  const { db } = setup();
  db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type)
    VALUES ('website_form', ?, 'no recognized lead_type/lead_source signal', 'Pending', 'brand')
  `).run(JSON.stringify({ first_name: 'Fake', last_name: 'Plainlang', email: 'plain@example.test', lead_type: 'Contact Form' }));

  const queue = getBrandReviewQueue(db);
  assert.equal(queue[0].channelLabel, 'Website Form');
  assert.ok(queue[0].evidence.some(e => e.startsWith('Name:')));
  assert.ok(queue[0].evidence.some(e => e.startsWith('Inquiry type:')));
  assert.ok(!queue[0].evidence.some(e => e.startsWith('lead_type:')));
  assert.doesNotMatch(queue[0].reason, /lead_type/);
});

test('Case Review reason is plain-language, not the raw technical reason', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'plaincase.fake@example.test', first_name: 'Fake', last_name: 'PlainCase' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type, contact_brand_id, ref_type, ref_value)
    VALUES ('calcom_webhook', '{}', ?, 'Pending', 'case', ?, 'cal_booking_uid', 'fake-ref-plain-1')
  `).run(`reschedule references unknown prior booking ref 'fake-old-ref'`, link.id);

  const queue = getCaseReviewQueue(db);
  assert.match(queue[0].reason, /reschedule/i);
  assert.doesNotMatch(queue[0].reason, /fake-old-ref/);
  assert.equal(queue[0].technicalDetails.rawReason.includes('fake-old-ref'), true);
});

test('message statuses normalize correctly and Failed is distinguishable', () => {
  assert.equal(normalizeMessageStatus('queued'), 'Queued');
  assert.equal(normalizeMessageStatus('sending'), 'Queued');
  assert.equal(normalizeMessageStatus('sent'), 'Sent');
  assert.equal(normalizeMessageStatus('delivered'), 'Delivered');
  assert.equal(normalizeMessageStatus('failed'), 'Failed');
  assert.equal(normalizeMessageStatus('undelivered'), 'Failed');
});

test('getMessageDeliveryStatus surfaces channel, recipient, timestamp, brand, and related case', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'msgstatus.fake@example.test', first_name: 'Fake', last_name: 'MsgStatus' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const c = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, insuranceLadyId, 'Follow-up/service'), externalRef: 'fake-msg-1', eventType: 'booking_created' });

  db.prepare(`
    INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, contact_brand_id, case_id)
    VALUES (?, 'outbound', '+18559305239', '+15555550100', 'fake test message', 'failed', ?, ?)
  `).run(contact.id, link.id, c.case.id);

  const rows = getMessageDeliveryStatus(db, { brandId: 'all' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].channel, 'sms');
  assert.equal(rows[0].recipient, '+15555550100');
  assert.equal(rows[0].status, 'Failed');
  assert.equal(rows[0].brandShortName, 'Insurance Lady');
  assert.ok(rows[0].relatedCase);
});

test('failed SMS surfaces its stored [FAILED] reason; failed email states no detail is stored', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'failreason.fake@example.test', first_name: 'Fake', last_name: 'FailReason' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const c = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, insuranceLadyId, 'Follow-up/service'), externalRef: 'fake-fail-1', eventType: 'booking_created' });

  db.prepare(`
    INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, contact_brand_id, case_id)
    VALUES (?, 'outbound', '+18559305239', '+15555550101', '[FAILED] Error 30003: Unreachable destination handset | Code: 30003\n\nOriginal message: hi', 'failed', ?, ?)
  `).run(contact.id, link.id, c.case.id);
  db.prepare(`
    INSERT INTO emails (contact_id, to_email, subject, body, status, contact_brand_id, case_id)
    VALUES (?, 'failreason.fake@example.test', 'subj', 'body', 'failed', ?, ?)
  `).run(contact.id, link.id, c.case.id);

  const rows = getMessageDeliveryStatus(db, { brandId: 'all' });
  const sms = rows.find(r => r.channel === 'sms');
  const email = rows.find(r => r.channel === 'email');
  assert.match(sms.failureReason, /Error 30003/);
  assert.equal(email.failureReason, 'No further detail is stored for this message.');
});

test('a real failure_reason column value is preferred over the [FAILED]-prefixed body -- the current path (legacySmsSend.js / smsStatusService.js), not just the legacy fallback', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'failreason2.fake@example.test', first_name: 'Fake', last_name: 'FailReasonColumn' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const c = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, insuranceLadyId, 'Follow-up/service'), externalRef: 'fake-fail-2', eventType: 'booking_created' });

  db.prepare(`
    INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, failure_reason, contact_brand_id, case_id)
    VALUES (?, 'outbound', '+18559305239', '+15555550102', 'hi', 'undelivered', 'Message undelivered -- Twilio error code 30006.', ?, ?)
  `).run(contact.id, link.id, c.case.id);

  const rows = getMessageDeliveryStatus(db, { brandId: 'all' });
  const sms = rows.find(r => r.channel === 'sms' && r.recipient === '+15555550102');
  assert.equal(sms.status, 'Failed', 'undelivered normalizes to the same Failed status as failed');
  assert.equal(sms.failureReason, 'Message undelivered -- Twilio error code 30006.');
});

test('Last Activity reflects the most recent related record, not just cases.updated_at', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'lastactivity.fake@example.test', first_name: 'Fake', last_name: 'LastActivity' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const c = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, prosperityId, 'Life insurance'), externalRef: 'fake-lastact-1', eventType: 'booking_created' });

  // Force the case's own updated_at far in the past...
  db.prepare(`UPDATE cases SET updated_at = '2020-01-01 00:00:00' WHERE id = ?`).run(c.case.id);
  // ...but attach a much more recent note.
  db.prepare(`INSERT INTO contact_notes (contact_id, body, case_id, created_at) VALUES (?, 'fake recent note', ?, '2026-08-12 10:06:05')`).run(contact.id, c.case.id);

  const rows = flattenCases(getCaseList(db, { brandId: 'all' })).filter(r => r.caseId === c.case.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].lastActivity, '2026-08-12T10:06:05Z');
});
