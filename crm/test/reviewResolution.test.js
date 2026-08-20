// Tests for crm/lib/reviewResolution.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { dedupeContact, resolveContactBrand, matchOrCreateCase } = require('../lib/caseMatching');
const { archiveCase, resolveBrandReviewItem, resolveCaseReviewItem } = require('../lib/reviewResolution');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

function productId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

function insertBrandReviewIntake(db, payload, extra = {}) {
  const result = db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type, product_id, ref_type, ref_value)
    VALUES ('fake_webhook', ?, 'no recognized signal', 'Pending', 'brand', ?, ?, ?)
  `).run(JSON.stringify(payload), extra.productId || null, extra.refType || null, extra.refValue || null);
  return db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(result.lastInsertRowid);
}

function insertCaseReviewIntake(db, contactBrandId, extra = {}) {
  const result = db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type, contact_brand_id, product_id, ref_type, ref_value)
    VALUES ('fake_webhook', '{}', ?, 'Pending', 'case', ?, ?, ?, ?)
  `).run(extra.reason || 'ambiguous match', contactBrandId, extra.productId || null, extra.refType || 'cal_booking_uid', extra.refValue || null);
  return db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(result.lastInsertRowid);
}

test('case archive affects only that case — contact, other cases, and relationship are untouched', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'archivetest.fake@example.test', first_name: 'Fake', last_name: 'Archive' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const caseA = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, prosperityId, 'Life insurance'), externalRef: 'fake-arch-1', eventType: 'booking_created' });
  const caseB = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, prosperityId, 'Annuities'), externalRef: 'fake-arch-2', eventType: 'booking_created' });

  archiveCase(db, { caseId: caseA.case.id, actor: 'test-agent' });

  const refreshedA = db.prepare('SELECT status FROM cases WHERE id = ?').get(caseA.case.id);
  const refreshedB = db.prepare('SELECT status FROM cases WHERE id = ?').get(caseB.case.id);
  const refreshedContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
  const refreshedLink = db.prepare('SELECT * FROM contact_brands WHERE id = ?').get(link.id);

  assert.equal(refreshedA.status, 'Archived');
  assert.equal(refreshedB.status, 'Open');
  assert.ok(refreshedContact);
  assert.ok(refreshedLink);
});

test('Brand Review assignment creates no NULL-brand relationship', () => {
  const { db } = setup();
  const intake = insertBrandReviewIntake(db, { first_name: 'Fake', last_name: 'NoNull', email: 'nonull.fake@example.test' });
  resolveBrandReviewItem(db, { intakeId: intake.id, decision: 'insurance-lady', actor: 'test-agent' });

  const nullBrandRows = db.prepare('SELECT COUNT(*) AS n FROM contact_brands WHERE brand_id IS NULL').get();
  assert.equal(nullBrandRows.n, 0);
});

test('Brand Review assignment creates the correct contact-brand relationship and case', () => {
  const { db, insuranceLadyId } = setup();
  const prodId = productId(db, insuranceLadyId, 'Cash-building life insurance');
  const intake = insertBrandReviewIntake(
    db,
    { first_name: 'Fake', last_name: 'Assigned', email: 'assigned.fake@example.test' },
    { productId: prodId, refType: 'cal_booking_uid', refValue: 'fake-brandreview-1' }
  );

  const result = resolveBrandReviewItem(db, { intakeId: intake.id, decision: 'insurance-lady', actor: 'test-agent' });

  assert.equal(result.outcome, 'resolved');
  const link = db.prepare('SELECT * FROM contact_brands WHERE id = ?').get(result.contactBrand.id);
  assert.equal(link.brand_id, insuranceLadyId);
  assert.equal(result.caseResult.outcome, 'created');
  assert.equal(result.caseResult.case.product_id, prodId);

  const refreshedIntake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intake.id);
  assert.equal(refreshedIntake.status, 'Resolved');
  assert.equal(refreshedIntake.decision, 'insurance-lady');
  assert.equal(refreshedIntake.resolved_by, 'test-agent');
  assert.ok(refreshedIntake.resolved_at);
});

test('Brand Review Test/Archive preserves the staged record (not deleted)', () => {
  const { db } = setup();
  const intake = insertBrandReviewIntake(db, { first_name: 'Fake', last_name: 'Archived', email: 'archived.fake@example.test' });
  const result = resolveBrandReviewItem(db, { intakeId: intake.id, decision: 'test_archive', actor: 'test-agent' });

  assert.equal(result.outcome, 'archived');
  const row = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intake.id);
  assert.ok(row, 'record must still exist');
  assert.equal(row.status, 'Archived');
  assert.equal(row.raw_payload, intake.raw_payload, 'raw payload must be unchanged');
});

test('Case Review can attach to an existing open case', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'attach.fake@example.test', first_name: 'Fake', last_name: 'Attach' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const existingCase = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, prosperityId, 'Life insurance'), externalRef: 'fake-existing-1', eventType: 'booking_created' });
  const intake = insertCaseReviewIntake(db, link.id, { refValue: 'fake-resched-attach-1' });

  const result = resolveCaseReviewItem(db, { intakeId: intake.id, action: 'attach_existing_case', targetCaseId: existingCase.case.id, actor: 'test-agent' });

  assert.equal(result.outcome, 'attached');
  const ref = db.prepare(`SELECT case_id FROM case_external_refs WHERE ref_value = ?`).get('fake-resched-attach-1');
  assert.equal(ref.case_id, existingCase.case.id);
  const refreshedIntake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intake.id);
  assert.equal(refreshedIntake.status, 'Resolved');
  assert.equal(refreshedIntake.decision, 'attach_existing_case');
});

test('Case Review can create a genuinely new case', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'newcase.fake@example.test', first_name: 'Fake', last_name: 'NewCase' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const prodId = productId(db, prosperityId, 'Rollovers and safe-money solutions');
  const intake = insertCaseReviewIntake(db, link.id, { productId: prodId, refValue: 'fake-newcase-1' });

  const result = resolveCaseReviewItem(db, { intakeId: intake.id, action: 'create_new_case', actor: 'test-agent' });

  assert.equal(result.outcome, 'created');
  assert.equal(result.case.contact_brand_id, link.id);
  assert.equal(result.case.product_id, prodId);
  const openCases = db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ? AND status = 'Open'`).get(link.id);
  assert.equal(openCases.n, 1);
});

test('create_new_case refuses to create a case with no product when the intake has none and none is supplied', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'noproduct.fake@example.test', first_name: 'Fake', last_name: 'NoProduct' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const intake = insertCaseReviewIntake(db, link.id, { refValue: 'fake-noproduct-1' }); // no productId

  assert.throws(() => {
    resolveCaseReviewItem(db, { intakeId: intake.id, action: 'create_new_case', actor: 'test-agent' });
  }, /a product\/service must be selected/);

  const caseCount = db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?`).get(link.id).n;
  assert.equal(caseCount, 0, 'no case should have been created with a null product');
});

test('create_new_case succeeds when the intake has no product but the caller supplies one', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'suppliedproduct.fake@example.test', first_name: 'Fake', last_name: 'SuppliedProduct' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const intake = insertCaseReviewIntake(db, link.id, { refValue: 'fake-suppliedproduct-1' }); // no productId on the intake
  const chosenProductId = productId(db, prosperityId, 'Annuities');

  const result = resolveCaseReviewItem(db, { intakeId: intake.id, action: 'create_new_case', productId: chosenProductId, actor: 'test-agent' });

  assert.equal(result.outcome, 'created');
  assert.equal(result.case.product_id, chosenProductId);
});

test('create_new_case refuses a supplied product from the wrong brand — product never determines brand', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'wrongbrandproduct.fake@example.test', first_name: 'Fake', last_name: 'WrongBrandProduct' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId }); // Prosperity relationship
  const intake = insertCaseReviewIntake(db, link.id, { refValue: 'fake-wrongbrand-1' });
  const insuranceLadyProductId = productId(db, insuranceLadyId, 'Whole life/final expense'); // wrong brand's product

  assert.throws(() => {
    resolveCaseReviewItem(db, { intakeId: intake.id, action: 'create_new_case', productId: insuranceLadyProductId, actor: 'test-agent' });
  }, /does not belong to this relationship's brand/);
});

test('Case Review Test/Archive preserves the staged record', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'casearchive.fake@example.test', first_name: 'Fake', last_name: 'CaseArchive' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const intake = insertCaseReviewIntake(db, link.id, { refValue: 'fake-casearchive-1' });

  const result = resolveCaseReviewItem(db, { intakeId: intake.id, action: 'test_archive', actor: 'test-agent' });

  assert.equal(result.outcome, 'archived');
  const row = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intake.id);
  assert.ok(row);
  assert.equal(row.status, 'Archived');
});

test('duplicate external reference cannot create a duplicate case (attach path)', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'dupref.fake@example.test', first_name: 'Fake', last_name: 'DupRef' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const caseA = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, prosperityId, 'Life insurance'), externalRef: 'fake-dup-ref-1', eventType: 'booking_created' });
  const caseB = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, prosperityId, 'Annuities'), externalRef: 'fake-dup-ref-2', eventType: 'booking_created' });

  // A case-review item that (incorrectly) references a ref already attached
  // to caseA — attaching it to caseB instead must be refused.
  const intake = insertCaseReviewIntake(db, link.id, { refValue: 'fake-dup-ref-1' });
  assert.throws(() => {
    resolveCaseReviewItem(db, { intakeId: intake.id, action: 'attach_existing_case', targetCaseId: caseB.case.id, actor: 'test-agent' });
  }, /already attached to case/);
});

test('duplicate external reference cannot create a duplicate case (create path)', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'dupref2.fake@example.test', first_name: 'Fake', last_name: 'DupRef2' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, prosperityId, 'Life insurance'), externalRef: 'fake-dup-ref-3', eventType: 'booking_created' });

  const intake = insertCaseReviewIntake(db, link.id, { productId: productId(db, prosperityId, 'Life insurance'), refValue: 'fake-dup-ref-3' });
  assert.throws(() => {
    resolveCaseReviewItem(db, { intakeId: intake.id, action: 'create_new_case', actor: 'test-agent' });
  }, /already belongs to case/);

  const caseCount = db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?`).get(link.id);
  assert.equal(caseCount.n, 1, 'no duplicate case should have been created');
});

test('attach_existing_case refuses to cross brand relationships', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const contact1 = dedupeContact(db, { email: 'cross1.fake@example.test', first_name: 'Fake', last_name: 'Cross1' });
  const ilLink = resolveContactBrand(db, { contactId: contact1.id, brandId: insuranceLadyId });
  const ilCase = matchOrCreateCase(db, { contactBrandId: ilLink.id, productId: productId(db, insuranceLadyId, 'Whole life/final expense'), externalRef: 'fake-cross-il', eventType: 'booking_created' });

  const contact2 = dedupeContact(db, { email: 'cross2.fake@example.test', first_name: 'Fake', last_name: 'Cross2' });
  const prLink = resolveContactBrand(db, { contactId: contact2.id, brandId: prosperityId });
  const intake = insertCaseReviewIntake(db, prLink.id, { refValue: 'fake-cross-pr' });

  assert.throws(() => {
    resolveCaseReviewItem(db, { intakeId: intake.id, action: 'attach_existing_case', targetCaseId: ilCase.case.id, actor: 'test-agent' });
  }, /different brand relationship/);
});
