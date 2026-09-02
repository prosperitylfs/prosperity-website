// Tests for crm/lib/reviewResolution.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { dedupeContact, resolveContactBrand, matchOrCreateCase } = require('../lib/caseMatching');
const { archiveCase, resolveBrandReviewItem, resolveCaseReviewItem, resolveContactConflict } = require('../lib/reviewResolution');

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

// ── resolveContactConflict ("Verification Needed") ─────────────────────────
// crm/routes/calcom.js's matchContactForBooking / stageContactMatchReview
// stages one of these whenever an incoming Cal.com booking matches an
// existing contact on exactly one of email/phone. Mirrors the shape
// crm/routes/calcom.js's stageContactMatchReview actually writes.

function insertContact(db, overrides = {}) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, phone, phone_e164)
    VALUES (@first_name, @last_name, @email, @phone, @phone_e164)
  `).run({ first_name: 'Renee', last_name: 'Jones', email: null, phone: null, phone_e164: null, ...overrides }).lastInsertRowid;
}

function insertContactConflictIntake(db, { existingContactId, newContactId, conflictType, nameMismatch = false, existing, incoming }) {
  const reasonByType = {
    email_match_phone_diff: 'Possible existing contact — email matches, but phone number is different. Verify identity before merging or updating.',
    phone_match_email_diff: 'Possible existing contact — phone number matches, but email address is different. Verify identity before merging or updating.',
  };
  const result = db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, candidate_contact_id, reason, status, review_type)
    VALUES ('calcom_webhook', ?, ?, ?, 'Pending', 'contact_conflict')
  `).run(
    JSON.stringify({ conflict_type: conflictType, name_mismatch: nameMismatch, new_contact_id: newContactId, existing, incoming }),
    existingContactId,
    reasonByType[conflictType],
  );
  return db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(result.lastInsertRowid);
}

test('resolveContactConflict "confirm_different" leaves both contacts completely untouched', () => {
  const { db } = setup();
  const existingId = insertContact(db, { email: 'diff.existing@example.test', phone: '414-688-7619', phone_e164: '+14146887619' });
  const newId = insertContact(db, { first_name: 'Test', last_name: 'Caller', email: null, phone: '414-367-6486', phone_e164: '+14143676486' });
  const intake = insertContactConflictIntake(db, {
    existingContactId: existingId, newContactId: newId, conflictType: 'email_match_phone_diff',
    existing: { first_name: 'Renee', last_name: 'Jones', email: 'diff.existing@example.test', phone: '414-688-7619' },
    incoming: { first_name: 'Test', last_name: 'Caller', email: 'diff.existing@example.test', phone: '414-367-6486' },
  });

  const result = resolveContactConflict(db, { intakeId: intake.id, action: 'confirm_different', actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'confirmed_different');

  const resolvedIntake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intake.id);
  assert.equal(resolvedIntake.status, 'Resolved');
  assert.equal(resolvedIntake.decision, 'confirmed_different_person');

  const existingAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existingId);
  const newAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(newId);
  assert.equal(existingAfter.phone_e164, '+14146887619', 'existing contact must be completely untouched');
  assert.equal(newAfter.archived_at, null, 'the new contact must NOT be archived -- it stays separate');
  assert.equal(newAfter.phone_e164, '+14143676486', 'the new contact keeps its own phone');
});

test('resolveContactConflict "same_person" (email matched, phone differed): merges history, updates only the phone, archives the duplicate', () => {
  const { db } = setup();
  const existingId = insertContact(db, { email: 'same.existing@example.test', phone: '(414) 688-7619', phone_e164: '+14146887619' });
  const newId = insertContact(db, { first_name: 'Test', last_name: 'Caller', email: null, phone: '(414) 367-6486', phone_e164: '+14143676486' });

  // Pre-existing history on BOTH contacts -- must never be lost or duplicated.
  db.prepare(`INSERT INTO appointments (contact_id, appt_type, appt_datetime, status) VALUES (?, 'Consultation', '2026-09-10T18:00:00.000Z', 'Scheduled')`).run(existingId);
  db.prepare(`INSERT INTO sms_messages (contact_id, direction, body, status) VALUES (?, 'outbound', 'existing contact old sms', 'sent')`).run(existingId);
  const newApptId = db.prepare(`INSERT INTO appointments (contact_id, appt_type, appt_datetime, status) VALUES (?, 'Consultation', '2026-09-15T18:00:00.000Z', 'Scheduled')`).run(newId).lastInsertRowid;
  const newSmsId = db.prepare(`INSERT INTO sms_messages (contact_id, direction, body, status) VALUES (?, 'outbound', 'new booking confirmation sms', 'sent')`).run(newId).lastInsertRowid;
  db.prepare(`INSERT INTO contact_notes (contact_id, body) VALUES (?, 'a note on the new contact')`).run(newId);
  db.prepare(`INSERT INTO follow_up_tasks (contact_id, task_type, due_date) VALUES (?, 'Call', '2026-09-20')`).run(newId);

  const intake = insertContactConflictIntake(db, {
    existingContactId: existingId, newContactId: newId, conflictType: 'email_match_phone_diff',
    existing: { first_name: 'Renee', last_name: 'Jones', email: 'same.existing@example.test', phone: '(414) 688-7619' },
    incoming: { first_name: 'Test', last_name: 'Caller', email: 'same.existing@example.test', phone: '(414) 367-6486' },
  });

  const result = resolveContactConflict(db, { intakeId: intake.id, action: 'same_person', actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'merged');

  const existingAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existingId);
  assert.equal(existingAfter.phone_e164, '+14143676486', 'the existing contact\'s phone must update to the incoming (new booking\'s) number');
  assert.equal(existingAfter.phone, '(414) 367-6486');
  assert.equal(existingAfter.email, 'same.existing@example.test', 'the email, which already agreed, must not change');

  const newAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(newId);
  assert.ok(newAfter.archived_at, 'the drained duplicate contact must be archived, never deleted');

  const apptCount = db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE contact_id = ?').get(existingId).n;
  assert.equal(apptCount, 2, 'both the existing contact\'s own appointment AND the new one must now be under the existing contact');
  const movedAppt = db.prepare('SELECT contact_id FROM appointments WHERE id = ?').get(newApptId);
  assert.equal(movedAppt.contact_id, existingId, 'the new booking\'s appointment must be moved, not duplicated or dropped');

  const smsCount = db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(existingId).n;
  assert.equal(smsCount, 2, 'SMS history from both contacts must be preserved under the existing contact');
  const movedSms = db.prepare('SELECT contact_id FROM sms_messages WHERE id = ?').get(newSmsId);
  assert.equal(movedSms.contact_id, existingId);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_notes WHERE contact_id = ?').get(existingId).n, 1, 'notes must move too');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM follow_up_tasks WHERE contact_id = ?').get(existingId).n, 1, 'tasks must move too');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE contact_id = ?').get(newId).n, 0, 'nothing should remain under the archived duplicate');

  const resolvedIntake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intake.id);
  assert.equal(resolvedIntake.status, 'Resolved');
  assert.equal(resolvedIntake.decision, 'confirmed_same_person');
});

test('resolveContactConflict "same_person" (phone matched, email differed): updates only the email, without violating the UNIQUE email constraint', () => {
  const { db } = setup();
  const existingId = insertContact(db, { email: 'phonematch.old@example.test', phone: '(414) 555-7001', phone_e164: '+14145557001' });
  const newId = insertContact(db, { first_name: 'Test', last_name: 'Caller', email: 'phonematch.new@example.test', phone: '(414) 555-7001', phone_e164: '+14145557001' });

  const intake = insertContactConflictIntake(db, {
    existingContactId: existingId, newContactId: newId, conflictType: 'phone_match_email_diff',
    existing: { first_name: 'Renee', last_name: 'Jones', email: 'phonematch.old@example.test', phone: '(414) 555-7001' },
    incoming: { first_name: 'Test', last_name: 'Caller', email: 'phonematch.new@example.test', phone: '(414) 555-7001' },
  });

  const result = resolveContactConflict(db, { intakeId: intake.id, action: 'same_person', actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'merged');

  const existingAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existingId);
  assert.equal(existingAfter.email, 'phonematch.new@example.test', 'email must update to the incoming value');
  assert.equal(existingAfter.phone_e164, '+14145557001', 'the phone, which already agreed, must not change');

  const newAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(newId);
  assert.equal(newAfter.email, null, 'the duplicate\'s own email must be cleared once its value has moved to the existing contact');
  assert.ok(newAfter.archived_at);
});

test('resolveContactConflict "same_person" merges contact_brands without violating UNIQUE(contact_id, brand_id)', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const existingId = insertContact(db, { email: 'brandmerge.existing@example.test', phone: '(414) 555-7002', phone_e164: '+14145557002' });
  const newId = insertContact(db, { first_name: 'Test', last_name: 'Caller', email: null, phone: '(414) 555-7003', phone_e164: '+14145557003' });

  // existing already has Prosperity; the duplicate has BOTH Prosperity
  // (redundant -- must not violate the UNIQUE index) and Insurance Lady
  // (new -- must be picked up by the existing contact).
  resolveContactBrand(db, { contactId: existingId, brandId: prosperityId });
  resolveContactBrand(db, { contactId: newId, brandId: prosperityId });
  resolveContactBrand(db, { contactId: newId, brandId: insuranceLadyId });

  const intake = insertContactConflictIntake(db, {
    existingContactId: existingId, newContactId: newId, conflictType: 'email_match_phone_diff',
    existing: { first_name: 'Renee', last_name: 'Jones', email: 'brandmerge.existing@example.test', phone: '(414) 555-7002' },
    incoming: { first_name: 'Test', last_name: 'Caller', email: 'brandmerge.existing@example.test', phone: '(414) 555-7003' },
  });

  assert.doesNotThrow(() => {
    resolveContactConflict(db, { intakeId: intake.id, action: 'same_person', actor: 'Loretta Stewart' });
  });

  const existingLinks = db.prepare('SELECT brand_id FROM contact_brands WHERE contact_id = ?').all(existingId);
  assert.equal(existingLinks.length, 2, 'the existing contact must end up linked to both brands, no duplicates');
  assert.deepEqual(new Set(existingLinks.map(l => l.brand_id)), new Set([prosperityId, insuranceLadyId]));

  const dupLinks = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(newId);
  assert.equal(dupLinks.length, 0, 'the duplicate\'s own brand links must be gone (merged or removed as redundant)');
});

test('resolveContactConflict rejects an unknown action', () => {
  const { db } = setup();
  const existingId = insertContact(db, { email: 'unknown.action@example.test' });
  const newId = insertContact(db, { email: null });
  const intake = insertContactConflictIntake(db, {
    existingContactId: existingId, newContactId: newId, conflictType: 'email_match_phone_diff', existing: {}, incoming: {},
  });
  assert.throws(() => {
    resolveContactConflict(db, { intakeId: intake.id, action: 'merge_everything', actor: 'Loretta Stewart' });
  }, /unknown action/);
});

test('resolveContactConflict refuses to resolve an already-resolved intake a second time', () => {
  const { db } = setup();
  const existingId = insertContact(db, { email: 'already.resolved@example.test' });
  const newId = insertContact(db, { email: null });
  const intake = insertContactConflictIntake(db, {
    existingContactId: existingId, newContactId: newId, conflictType: 'email_match_phone_diff', existing: {}, incoming: {},
  });
  resolveContactConflict(db, { intakeId: intake.id, action: 'confirm_different', actor: 'Loretta Stewart' });
  assert.throws(() => {
    resolveContactConflict(db, { intakeId: intake.id, action: 'confirm_different', actor: 'Loretta Stewart' });
  }, /not pending/);
});
