// Tests for crm/lib/senderResolution.js. Uses in-memory databases built via
// migrateBrands.js — never touches disk or the live database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { dedupeContact, resolveContactBrand, matchOrCreateCase } = require('../lib/caseMatching');
const { resolveSenderIdentity, resolveBrandContext, resolveVoiceCallerId } = require('../lib/senderResolution');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const CONFIGURED_ENV = {
  GMAIL_CLIENT_ID: 'unit-test', GMAIL_CLIENT_SECRET: 'unit-test', GMAIL_REFRESH_TOKEN: 'unit-test',
  MICROSOFT_TENANT_ID: 'unit-test', MICROSOFT_CLIENT_ID: 'unit-test',
  MICROSOFT_CLIENT_SECRET: 'unit-test', MICROSOFT_FROM: 'loretta@insuranceladyllc.com', MICROSOFT_FROM_NAME: 'unit-test',
};

const CONFIGURED_SMS_ENV = {
  TWILIO_ACCOUNT_SID: 'unit-test', TWILIO_AUTH_TOKEN: 'unit-test',
  TWILIO_FROM_NUMBER_INSURANCE_LADY: '+18559305239', TWILIO_FROM_NUMBER_PROSPERITY: '+14144411177',
};

test('Insurance Lady case resolves only to Insurance Lady identity', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'ilcase@example-mail.com', first_name: 'Ivy', last_name: 'Lang' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const productId = getProductId(db, insuranceLadyId, 'Whole life/final expense');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-il-1', eventType: 'booking_created' });

  withEnv(CONFIGURED_ENV, () => {
    const result = resolveSenderIdentity(db, { caseId: created.case.id, channel: 'email' });
    assert.equal(result.blocked, false);
    assert.equal(result.brandId, 'insurance-lady');
    assert.equal(result.brand.emailSender, 'loretta@insuranceladyllc.com');
  });
});

test('Prosperity case resolves only to Prosperity identity', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'procase@example-mail.com', first_name: 'Priya', last_name: 'Menon' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Annuities');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-pr-1', eventType: 'booking_created' });

  withEnv(CONFIGURED_ENV, () => {
    const result = resolveSenderIdentity(db, { caseId: created.case.id, channel: 'email' });
    assert.equal(result.blocked, false);
    assert.equal(result.brandId, 'prosperity');
    assert.equal(result.brand.emailSender, 'loretta@prosperitylfs.com');
  });
});

test('dual-brand contact resolves correctly from relationship/case context, not from the contact itself', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'dual@example-mail.com', first_name: 'Devon', last_name: 'Pierce' });
  const ilLink = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const prLink = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const ilProduct = getProductId(db, insuranceLadyId, 'Cash cancer insurance');
  const prProduct = getProductId(db, prosperityId, 'Life insurance');
  const ilCase = matchOrCreateCase(db, { contactBrandId: ilLink.id, productId: ilProduct, externalRef: 'cal-dual-il', eventType: 'booking_created' });
  const prCase = matchOrCreateCase(db, { contactBrandId: prLink.id, productId: prProduct, externalRef: 'cal-dual-pr', eventType: 'booking_created' });

  withEnv(CONFIGURED_ENV, () => {
    const ilResult = resolveSenderIdentity(db, { caseId: ilCase.case.id, channel: 'email' });
    const prResult = resolveSenderIdentity(db, { caseId: prCase.case.id, channel: 'email' });
    assert.equal(ilResult.brandId, 'insurance-lady');
    assert.equal(prResult.brandId, 'prosperity');
  });
});

test('missing context blocks sending', () => {
  const { db } = setup();
  const result = resolveSenderIdentity(db, { channel: 'email' });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /no brand-resolution context/);
});

test('conflicting context blocks sending', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'conflict@example-mail.com', first_name: 'Cass', last_name: 'Ito' });
  const ilLink = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });

  const result = resolveSenderIdentity(db, { contactBrandId: ilLink.id, brandId: 'prosperity', channel: 'email' });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /conflicting brand signals/);
});

test('a viewing filter field has no effect on resolution — it is not a recognized context key', () => {
  const { db } = setup();
  const result = resolveSenderIdentity(db, { viewingFilter: 'insurance-lady', currentFilter: 'All Brands', channel: 'email' });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /no brand-resolution context/);
});

test('broken Insurance Lady provider never falls back to Prosperity', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'ilbroken@example-mail.com', first_name: 'Ira', last_name: 'Solis' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const productId = getProductId(db, insuranceLadyId, 'Online life-insurance application');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-il-broken', eventType: 'booking_created' });

  withEnv({
    MICROSOFT_TENANT_ID: undefined, MICROSOFT_CLIENT_ID: undefined,
    MICROSOFT_CLIENT_SECRET: undefined, MICROSOFT_FROM: undefined, MICROSOFT_FROM_NAME: undefined,
    GMAIL_CLIENT_ID: 'unit-test', GMAIL_CLIENT_SECRET: 'unit-test', GMAIL_REFRESH_TOKEN: 'unit-test',
  }, () => {
    const result = resolveSenderIdentity(db, { caseId: created.case.id, channel: 'email' });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /Insurance Lady email sender is not configured/);
    assert.notEqual(result.brandId, 'prosperity');
    assert.equal(result.brandId, null);
  });
});

test('broken Prosperity provider never falls back to Insurance Lady', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'prbroken@example-mail.com', first_name: 'Perry', last_name: 'Vance' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Rollovers and safe-money solutions');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-pr-broken', eventType: 'booking_created' });

  withEnv({
    GMAIL_CLIENT_ID: undefined, GMAIL_CLIENT_SECRET: undefined, GMAIL_REFRESH_TOKEN: undefined,
    MICROSOFT_TENANT_ID: 'unit-test', MICROSOFT_CLIENT_ID: 'unit-test',
    MICROSOFT_CLIENT_SECRET: 'unit-test', MICROSOFT_FROM: 'unit-test', MICROSOFT_FROM_NAME: 'unit-test',
  }, () => {
    const result = resolveSenderIdentity(db, { caseId: created.case.id, channel: 'email' });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /Prosperity email sender is not configured/);
    assert.notEqual(result.brandId, 'insurance-lady');
    assert.equal(result.brandId, null);
  });
});

test('shared Twilio credentials present but Insurance Lady FROM number missing blocks only Insurance Lady SMS', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'ilnofrom@example-mail.com', first_name: 'Ines', last_name: 'Park' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const productId = getProductId(db, insuranceLadyId, 'Cash-building life insurance');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-il-nofrom', eventType: 'booking_created' });

  withEnv({
    TWILIO_ACCOUNT_SID: 'unit-test', TWILIO_AUTH_TOKEN: 'unit-test',
    TWILIO_FROM_NUMBER_INSURANCE_LADY: undefined,
    TWILIO_FROM_NUMBER_PROSPERITY: '+14144411177', // the other brand's number IS configured — must not be borrowed
  }, () => {
    const result = resolveSenderIdentity(db, { caseId: created.case.id, channel: 'sms' });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /Insurance Lady sms sender is not configured/);
    assert.match(result.reason, /TWILIO_FROM_NUMBER_INSURANCE_LADY/);
    assert.equal(result.brandId, null);
  });
});

test('shared Twilio credentials present but Prosperity FROM number missing blocks only Prosperity SMS', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'prnofrom@example-mail.com', first_name: 'Percy', last_name: 'Nolan' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Life insurance');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-pr-nofrom', eventType: 'booking_created' });

  withEnv({
    TWILIO_ACCOUNT_SID: 'unit-test', TWILIO_AUTH_TOKEN: 'unit-test',
    TWILIO_FROM_NUMBER_PROSPERITY: undefined,
    TWILIO_FROM_NUMBER_INSURANCE_LADY: '+18559305239', // the other brand's number IS configured — must not be borrowed
  }, () => {
    const result = resolveSenderIdentity(db, { caseId: created.case.id, channel: 'sms' });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /Prosperity sms sender is not configured/);
    assert.match(result.reason, /TWILIO_FROM_NUMBER_PROSPERITY/);
    assert.equal(result.brandId, null);
  });
});

test('with the shared Twilio credentials and both brand-specific FROM numbers present, each brand resolves SMS correctly', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const ilContact = dedupeContact(db, { email: 'ilsms@example-mail.com', first_name: 'Ilan', last_name: 'Boyd' });
  const ilLink = resolveContactBrand(db, { contactId: ilContact.id, brandId: insuranceLadyId });
  const ilProduct = getProductId(db, insuranceLadyId, 'Follow-up/service');
  const ilCase = matchOrCreateCase(db, { contactBrandId: ilLink.id, productId: ilProduct, externalRef: 'cal-il-sms', eventType: 'booking_created' });

  const prContact = dedupeContact(db, { email: 'prsms@example-mail.com', first_name: 'Petra', last_name: 'Cole' });
  const prLink = resolveContactBrand(db, { contactId: prContact.id, brandId: prosperityId });
  const prProduct = getProductId(db, prosperityId, 'Follow-up/service');
  const prCase = matchOrCreateCase(db, { contactBrandId: prLink.id, productId: prProduct, externalRef: 'cal-pr-sms', eventType: 'booking_created' });

  withEnv(CONFIGURED_SMS_ENV, () => {
    const ilResult = resolveSenderIdentity(db, { caseId: ilCase.case.id, channel: 'sms' });
    const prResult = resolveSenderIdentity(db, { caseId: prCase.case.id, channel: 'sms' });
    assert.equal(ilResult.blocked, false);
    assert.equal(ilResult.brandId, 'insurance-lady');
    assert.equal(prResult.blocked, false);
    assert.equal(prResult.brandId, 'prosperity');
  });
});

test('historical brand snapshot remains unchanged after a simulated case transfer, while new resolution reflects the current relationship', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'transfer@example-mail.com', first_name: 'Toni', last_name: 'Reyes' });
  const ilLink = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const productId = getProductId(db, insuranceLadyId, 'Annuities and safe-money solutions');
  const created = matchOrCreateCase(db, { contactBrandId: ilLink.id, productId, externalRef: 'cal-transfer-1', eventType: 'booking_created' });

  // An appointment booked while the case belonged to Insurance Lady stores
  // its own brand snapshot (contact_brands.id) at creation time.
  const apptResult = db.prepare(`
    INSERT INTO appointments (contact_id, appt_datetime, contact_brand_id, case_id)
    VALUES (?, '2026-09-01T15:00:00Z', ?, ?)
  `).run(contact.id, ilLink.id, created.case.id);
  const appointmentId = apptResult.lastInsertRowid;

  // Simulate a case transfer: the case's relationship now points at
  // Prosperity instead (a new contact_brands row + updating cases.contact_brand_id
  // directly, exactly as case_brand_transfers is designed to audit later).
  const prLink = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  db.prepare('UPDATE cases SET contact_brand_id = ? WHERE id = ?').run(prLink.id, created.case.id);
  db.prepare('INSERT INTO case_brand_transfers (case_id, from_brand_id, to_brand_id, reason) VALUES (?, ?, ?, ?)')
    .run(created.case.id, insuranceLadyId, prosperityId, 'unit test simulated transfer');

  // The OLD appointment row's own stored snapshot must be untouched.
  const apptAfter = db.prepare('SELECT contact_brand_id FROM appointments WHERE id = ?').get(appointmentId);
  assert.equal(apptAfter.contact_brand_id, ilLink.id);

  withEnv(CONFIGURED_ENV, () => {
    // A NEW communication resolved via the appointment's own snapshot still
    // reflects what that appointment was booked under (Insurance Lady) —
    // it is not silently re-derived from the case's new brand.
    const snapshotResult = resolveSenderIdentity(db, { appointmentBrandSnapshot: ilLink.id, channel: 'email' });
    assert.equal(snapshotResult.brandId, 'insurance-lady');

    // A NEW communication resolved via the case's current relationship
    // reflects the transfer.
    const currentResult = resolveSenderIdentity(db, { caseId: created.case.id, channel: 'email' });
    assert.equal(currentResult.brandId, 'prosperity');
  });
});

test('product choice cannot change case brand: resolution ignores product entirely', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'productignore@example-mail.com', first_name: 'Quinn', last_name: 'Ash' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Follow-up/service');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-prod-1', eventType: 'booking_created' });

  withEnv(CONFIGURED_ENV, () => {
    // Passing an Insurance Lady product name/id as extraneous context has no
    // recognized key in the resolver and cannot influence the outcome.
    const result = resolveSenderIdentity(db, { caseId: created.case.id, productId: 999999, someProduct: 'Cash cancer insurance', channel: 'email' });
    assert.equal(result.brandId, 'prosperity');
  });
});

// ── resolveVoiceCallerId (live outbound calling, Revenue MVP) ──────────────

test('a Prosperity case resolves the Prosperity Twilio number as caller ID', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'callpr@example-mail.com', first_name: 'Cara', last_name: 'Voss' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Life insurance');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-call-pr', eventType: 'booking_created' });

  withEnv(CONFIGURED_SMS_ENV, () => {
    const result = resolveVoiceCallerId(db, { caseId: created.case.id });
    assert.equal(result.blocked, false);
    assert.equal(result.brandId, 'prosperity');
    assert.equal(result.fromNumber, '+14144411177');
  });
});

test('an Insurance Lady case resolves the Insurance Lady Twilio number as caller ID', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'callil@example-mail.com', first_name: 'Ida', last_name: 'Cruz' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const productId = getProductId(db, insuranceLadyId, 'Whole life/final expense');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-call-il', eventType: 'booking_created' });

  withEnv(CONFIGURED_SMS_ENV, () => {
    const result = resolveVoiceCallerId(db, { caseId: created.case.id });
    assert.equal(result.blocked, false);
    assert.equal(result.brandId, 'insurance-lady');
    assert.equal(result.fromNumber, '+18559305239');
  });
});

test('a resolved Prosperity case with no TWILIO_FROM_NUMBER_PROSPERITY configured is refused, never borrowing the Insurance Lady number', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'callprnofrom@example-mail.com', first_name: 'Cole', last_name: 'Pena' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Annuities');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-call-pr-nofrom', eventType: 'booking_created' });

  withEnv({
    TWILIO_ACCOUNT_SID: 'unit-test', TWILIO_AUTH_TOKEN: 'unit-test',
    TWILIO_FROM_NUMBER_PROSPERITY: undefined,
    TWILIO_FROM_NUMBER_INSURANCE_LADY: '+18559305239',
  }, () => {
    const result = resolveVoiceCallerId(db, { caseId: created.case.id });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /TWILIO_FROM_NUMBER_PROSPERITY/);
    assert.notEqual(result.fromNumber, '+18559305239');
  });
});

test('a resolved Insurance Lady case with no TWILIO_FROM_NUMBER_INSURANCE_LADY configured is refused, never borrowing the Prosperity number', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'callilnofrom@example-mail.com', first_name: 'Iris', last_name: 'Dean' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const productId = getProductId(db, insuranceLadyId, 'Cash cancer insurance');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-call-il-nofrom', eventType: 'booking_created' });

  withEnv({
    TWILIO_ACCOUNT_SID: 'unit-test', TWILIO_AUTH_TOKEN: 'unit-test',
    TWILIO_FROM_NUMBER_INSURANCE_LADY: undefined,
    TWILIO_FROM_NUMBER_PROSPERITY: '+14144411177',
  }, () => {
    const result = resolveVoiceCallerId(db, { caseId: created.case.id });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /TWILIO_FROM_NUMBER_INSURANCE_LADY/);
    assert.notEqual(result.fromNumber, '+14144411177');
  });
});

test('leading/trailing whitespace around TWILIO_FROM_NUMBER_PROSPERITY does not block call routing', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'callprspace@example-mail.com', first_name: 'Wes', last_name: 'Marsh' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Life insurance');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-call-pr-space', eventType: 'booking_created' });

  withEnv({ ...CONFIGURED_SMS_ENV, TWILIO_FROM_NUMBER_PROSPERITY: '  +14144411177\n' }, () => {
    const result = resolveVoiceCallerId(db, { caseId: created.case.id });
    assert.equal(result.blocked, false);
    assert.equal(result.fromNumber, '+14144411177');
  });
});

test('a misconfigured Prosperity number that does not match brand config is refused rather than used', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'callprwrong@example-mail.com', first_name: 'Wren', last_name: 'Fox' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });
  const productId = getProductId(db, prosperityId, 'Life insurance');
  const created = matchOrCreateCase(db, { contactBrandId: link.id, productId, externalRef: 'cal-call-pr-wrong', eventType: 'booking_created' });

  withEnv({ ...CONFIGURED_SMS_ENV, TWILIO_FROM_NUMBER_PROSPERITY: '+19995550000' }, () => {
    const result = resolveVoiceCallerId(db, { caseId: created.case.id });
    assert.equal(result.blocked, true);
    assert.match(result.reason, /does not match the configured Prosperity number/);
  });
});

test('resolveVoiceCallerId with no resolvable brand context blocks, matching resolveSenderIdentity behavior', () => {
  const { db } = setup();
  const result = resolveVoiceCallerId(db, {});
  assert.equal(result.blocked, true);
  assert.match(result.reason, /no brand-resolution context/);
});

test('resolveBrandContext resolves identity without requiring a channel', () => {
  const { db, insuranceLadyId } = setup();
  const contact = dedupeContact(db, { email: 'nochannel@example-mail.com', first_name: 'Noel', last_name: 'Diaz' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: insuranceLadyId });
  const result = resolveBrandContext(db, { contactBrandId: link.id });
  assert.equal(result.blocked, false);
  assert.equal(result.brandId, 'insurance-lady');
});
