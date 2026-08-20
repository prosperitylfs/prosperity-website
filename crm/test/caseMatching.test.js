// Tests for crm/lib/caseMatching.js. Uses in-memory databases only, built
// via migrateBrands.js against a fresh legacy-shaped schema — never touches
// disk or the live database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const {
  dedupeContact,
  resolveContactBrand,
  matchOrCreateCase,
  findOpenCaseForMatter,
} = require('../lib/caseMatching');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

test('one person with relationships under both brands: same contact, two contact_brands rows', () => {
  const { db, insuranceLadyId, prosperityId } = setup();

  const contact = dedupeContact(db, { email: 'dual@example-mail.com', first_name: 'Robin', last_name: 'Zielke' });
  const prosperityLink = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const ilLink = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });

  assert.notEqual(prosperityLink.id, ilLink.id);
  assert.equal(prosperityLink.contact_id, contact.id);
  assert.equal(ilLink.contact_id, contact.id);

  const links = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(contact.id);
  assert.equal(links.length, 2);
});

test('multiple cases under one brand: different products open separate cases', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'multi@example-mail.com', first_name: 'Dana', last_name: 'Furst' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });

  const lifeProductId = getProductId(db, prosperityId, 'Life insurance');
  const annuityProductId = getProductId(db, prosperityId, 'Annuities');

  const case1 = matchOrCreateCase(db, {
    contactBrandId: link.id, productId: lifeProductId, externalRef: 'cal-uid-life-1',
    eventType: 'booking_created', title: 'Life insurance consult',
  });
  const case2 = matchOrCreateCase(db, {
    contactBrandId: link.id, productId: annuityProductId, externalRef: 'cal-uid-annuity-1',
    eventType: 'booking_created', title: 'Annuity consult',
  });

  assert.equal(case1.outcome, 'created');
  assert.equal(case2.outcome, 'created');
  assert.notEqual(case1.case.id, case2.case.id);

  const openCases = db.prepare(`SELECT * FROM cases WHERE contact_brand_id = ? AND status = 'Open'`).all(link.id);
  assert.equal(openCases.length, 2);
});

test('duplicate booking/webhook: processing the same external ref twice resolves to the same case, no duplicate', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'dup@example-mail.com', first_name: 'Sam', last_name: 'Iyer' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Life insurance');

  const first = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-uid-dup-1', eventType: 'booking_created' });
  const second = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-uid-dup-1', eventType: 'booking_created' });

  assert.equal(first.outcome, 'created');
  assert.equal(second.outcome, 'matched');
  assert.equal(first.case.id, second.case.id);

  const totalCases = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(link.id).n;
  assert.equal(totalCases, 1);
});

test('idempotency protection: matching the same ref a third and fourth time is still a no-op', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'idem@example-mail.com', first_name: 'Lee', last_name: 'Wan' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Annuities');

  for (let i = 0; i < 4; i++) {
    matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-uid-repeat', eventType: 'booking_created' });
  }
  const totalCases = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(link.id).n;
  assert.equal(totalCases, 1);
});

test('reschedule: a new booking ref for the same matter attaches to the original case', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'resched@example-mail.com', first_name: 'Alex', last_name: 'Cho' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Life insurance');

  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-uid-orig', eventType: 'booking_created' });
  const rescheduled = matchOrCreateCase(db, {
    contactBrandId: link.id, productId, externalRef: 'cal-uid-new-time',
    previousExternalRef: 'cal-uid-orig', eventType: 'booking_rescheduled',
  });

  assert.equal(rescheduled.outcome, 'matched');
  assert.equal(rescheduled.case.id, created.case.id);

  const totalCases = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(link.id).n;
  assert.equal(totalCases, 1);
});

test('reschedule referencing an unknown prior booking is routed to review, not silently matched or created', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'badresched@example-mail.com', first_name: 'Nia', last_name: 'Okafor' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Life insurance');

  const result = matchOrCreateCase(db, {
    contactBrandId: link.id, productId, externalRef: 'cal-uid-orphan-new',
    previousExternalRef: 'cal-uid-never-seen', eventType: 'booking_rescheduled',
    source: 'calcom_webhook', rawPayload: { note: 'test' },
  });

  assert.equal(result.outcome, 'review_required');
  assert.match(result.unresolvedIntake.reason, /unknown prior booking ref/);
});

test('cancellation of a known booking matches the existing case', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'cancel@example-mail.com', first_name: 'Ola', last_name: 'Reyes' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Annuities');

  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-uid-cancel-me', eventType: 'booking_created' });
  const cancelled = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-uid-cancel-me', eventType: 'booking_cancelled' });

  assert.equal(cancelled.outcome, 'matched');
  assert.equal(cancelled.case.id, created.case.id);
});

test('cancellation of an unknown booking is routed to review, never silently accepted', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'ghostcancel@example-mail.com', first_name: 'Priya', last_name: 'Desai' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Annuities');

  const result = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-uid-ghost', eventType: 'booking_cancelled' });
  assert.equal(result.outcome, 'review_required');
  assert.match(result.unresolvedIntake.reason, /unknown booking ref/);
});

test('repeat website submission for the same matter reuses the existing open case', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'repeat@example-mail.com', first_name: 'Marcus', last_name: 'Byrne' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Rollovers and safe-money solutions');

  const first = matchOrCreateCase(db, {
    contactBrandId: link.id, productId, externalRef: null, eventType: 'new_inquiry', title: 'Rollover inquiry',
  });
  const repeat = matchOrCreateCase(db, {
    contactBrandId: link.id, productId, externalRef: null, eventType: 'repeat_submission',
  });

  assert.equal(first.outcome, 'created');
  assert.equal(repeat.outcome, 'matched');
  assert.equal(repeat.case.id, first.case.id);
});

test('follow-up booking with no existing open case opens a new one rather than guessing', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'followup@example-mail.com', first_name: 'Erin', last_name: 'Voss' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Follow-up/service');

  const result = matchOrCreateCase(db, {
    contactBrandId: link.id, productId, externalRef: 'cal-uid-followup-1', eventType: 'followup_booking',
  });
  assert.equal(result.outcome, 'created');
});

test('genuinely new opportunity: different product for the same contact_brand opens a distinct case', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'newopp@example-mail.com', first_name: 'Talia', last_name: 'Kwan' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const lifeProductId = getProductId(db, prosperityId, 'Life insurance');
  const annuityProductId = getProductId(db, prosperityId, 'Annuities');

  const existing = matchOrCreateCase(db, { contactBrandId: link.id, productId: lifeProductId, externalRef: 'cal-uid-life-a', eventType: 'booking_created' });
  const newOpp = matchOrCreateCase(db, { contactBrandId: link.id, productId: annuityProductId, externalRef: 'cal-uid-annuity-a', eventType: 'new_inquiry' });

  assert.equal(newOpp.outcome, 'created');
  assert.notEqual(newOpp.case.id, existing.case.id);
});

test('uncertainty (missing product) routes to Case Review Required, never creates a guess case', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'unclear@example-mail.com', first_name: 'Gus', last_name: 'Halvorsen' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });

  const result = matchOrCreateCase(db, { contactBrandId: link.id, productId: null, externalRef: 'cal-uid-unclear', eventType: 'new_inquiry' });
  assert.equal(result.outcome, 'review_required');

  const caseCount = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(link.id).n;
  assert.equal(caseCount, 0);
});

test('uncertainty (missing contact_brand_id) routes to review, never resolves a brand relationship implicitly', () => {
  const { db } = setup();
  const result = matchOrCreateCase(db, { contactBrandId: null, productId: 1, externalRef: 'cal-uid-no-brand', eventType: 'new_inquiry' });
  assert.equal(result.outcome, 'review_required');
  assert.match(result.unresolvedIntake.reason, /brand relationship could not be resolved/);
});

test('dedupeContact: same email resolves to the same contact rather than creating a duplicate', () => {
  const { db } = setup();
  const a = dedupeContact(db, { email: 'same@example-mail.com', first_name: 'First', last_name: 'Call' });
  const b = dedupeContact(db, { email: 'same@example-mail.com', first_name: 'First', last_name: 'Call' });
  assert.equal(a.id, b.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').get('same@example-mail.com').n;
  assert.equal(count, 1);
});

test('resolveContactBrand refuses a NULL/undefined brandId', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'nobra@example-mail.com', first_name: 'No', last_name: 'Brand' });
  assert.throws(() => resolveContactBrand(db, { contactId: contact.id, brandId: null }), /brandId is required/);
  assert.throws(() => resolveContactBrand(db, { contactId: contact.id, brandId: undefined }), /brandId is required/);
});
