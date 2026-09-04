// Tests for crm/lib/senderGuardrail.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { dedupeContact, resolveContactBrand, matchOrCreateCase } = require('../lib/caseMatching');
const { getSenderGuardrailForCase, getSenderGuardrailForManualSelection, defaultManualBrandForContact } = require('../lib/senderGuardrail');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

function productId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

const FULLY_CONFIGURED_ENV = {
  GMAIL_CLIENT_ID: 'unit-test', GMAIL_CLIENT_SECRET: 'unit-test', GMAIL_REFRESH_TOKEN: 'unit-test',
  MICROSOFT_TENANT_ID: 'unit-test', MICROSOFT_CLIENT_ID: 'unit-test', MICROSOFT_CLIENT_SECRET: 'unit-test',
  MICROSOFT_FROM: 'unit-test', MICROSOFT_FROM_NAME: 'unit-test',
  TWILIO_ACCOUNT_SID: 'unit-test', TWILIO_AUTH_TOKEN: 'unit-test',
  TWILIO_FROM_NUMBER_INSURANCE_LADY: 'unit-test', TWILIO_FROM_NUMBER_PROSPERITY: 'unit-test',
};

function makeCase(db, brandId, brandRowId, productName) {
  const contact = dedupeContact(db, { email: `guardrail-${Math.random()}@example.test`, first_name: 'Fake', last_name: 'Guardrail' });
  const link = resolveContactBrand(db, { contactId: contact.id, brandId: brandRowId });
  const c = matchOrCreateCase(db, { contactBrandId: link.id, productId: productId(db, brandRowId, productName), externalRef: `fake-guardrail-${Math.random()}`, eventType: 'booking_created' });
  return c.case.id;
}

// ── Scenario A: no relationship selected ────────────────────────────────────

test('scenario A: no case selected — lists both brand choices explicitly, none preselected', () => {
  const { db } = setup();
  const result = getSenderGuardrailForCase(db, { caseId: null });
  assert.equal(result.scenario, 'no_relationship');
  assert.equal(result.blocked, true);
  assert.match(result.message, /Insurance Lady/);
  assert.match(result.message, /Prosperity/);
  assert.equal(result.brandId, null);
  assert.deepEqual(result.brandChoices.map(b => b.id).sort(), ['insurance-lady', 'prosperity']);
});

test('scenario A: an invalid caseId also resolves to no_relationship, not a crash', () => {
  const { db } = setup();
  const result = getSenderGuardrailForCase(db, { caseId: 999999 });
  assert.equal(result.scenario, 'no_relationship');
  assert.equal(result.blocked, true);
});

// ── Scenario B: resolved brand, channel configured ──────────────────────────

test('scenario B: resolved Prosperity case with email configured shows exact brand + sender identity', () => {
  const { db, prosperityId } = setup();
  const caseId = makeCase(db, 'prosperity', prosperityId, 'Life insurance');

  withEnv(FULLY_CONFIGURED_ENV, () => {
    const result = getSenderGuardrailForCase(db, { caseId });
    assert.equal(result.scenario, 'resolved');
    assert.equal(result.blocked, false);
    assert.equal(result.brandId, 'prosperity');
    assert.equal(result.channels.email.blocked, false);
    assert.equal(result.channels.email.message, 'This email will be sent from loretta@prosperitylfs.com as Prosperity.');
    assert.equal(result.channels.call.message, 'This call will be placed from +1 414-441-1177 as Prosperity.');
    assert.equal(result.channels.text.message, 'This text will be sent from +1 414-441-1177 as Prosperity.');
    assert.equal(result.channels.email.canSend, false);
  });
});

// ── Scenario C: resolved brand, channel NOT configured ──────────────────────

test('scenario C: Insurance Lady resolved but email not configured — brand is known, only email is blocked', () => {
  const { db, insuranceLadyId } = setup();
  const caseId = makeCase(db, 'insurance-lady', insuranceLadyId, 'Whole life/final expense');

  withEnv({
    ...FULLY_CONFIGURED_ENV,
    MICROSOFT_TENANT_ID: undefined, MICROSOFT_CLIENT_ID: undefined, MICROSOFT_CLIENT_SECRET: undefined,
    MICROSOFT_FROM: undefined, MICROSOFT_FROM_NAME: undefined,
  }, () => {
    const result = getSenderGuardrailForCase(db, { caseId });
    assert.equal(result.scenario, 'resolved');
    assert.equal(result.blocked, false, 'the brand itself must not be reported as unresolved');
    assert.equal(result.brandId, 'insurance-lady');

    assert.equal(result.channels.email.blocked, true);
    assert.match(result.channels.email.message, /Insurance Lady is selected/);
    assert.match(result.channels.email.message, /email sender is not configured/);
    assert.doesNotMatch(result.channels.email.message, /Choose a brand relationship/);
    assert.match(result.channels.email.fallbackNotice, /will not fall back to Prosperity/);
    // Env var names must never appear in the main message — only in technicalDetails.
    assert.doesNotMatch(result.channels.email.message, /MICROSOFT_/);
    assert.match(result.channels.email.technicalDetails, /MICROSOFT_TENANT_ID/);
  });
});

test('scenario C, other direction: Prosperity resolved but email not configured never blames Insurance Lady', () => {
  const { db, prosperityId } = setup();
  const caseId = makeCase(db, 'prosperity', prosperityId, 'Annuities');

  withEnv({ ...FULLY_CONFIGURED_ENV, GMAIL_CLIENT_ID: undefined, GMAIL_CLIENT_SECRET: undefined, GMAIL_REFRESH_TOKEN: undefined }, () => {
    const result = getSenderGuardrailForCase(db, { caseId });
    assert.equal(result.brandId, 'prosperity');
    assert.match(result.channels.email.message, /Prosperity is selected/);
    assert.match(result.channels.email.fallbackNotice, /will not fall back to Insurance Lady/);
  });
});

// ── Channels are evaluated independently ────────────────────────────────────

test('one unavailable channel does not block a different channel with a valid identity', () => {
  const { db, insuranceLadyId } = setup();
  const caseId = makeCase(db, 'insurance-lady', insuranceLadyId, 'Cash cancer insurance');

  withEnv({
    ...FULLY_CONFIGURED_ENV,
    MICROSOFT_TENANT_ID: undefined, MICROSOFT_CLIENT_ID: undefined, MICROSOFT_CLIENT_SECRET: undefined,
    MICROSOFT_FROM: undefined, MICROSOFT_FROM_NAME: undefined,
  }, () => {
    const result = getSenderGuardrailForCase(db, { caseId });
    assert.equal(result.channels.email.blocked, true, 'email should be blocked — Microsoft creds missing');
    assert.equal(result.channels.call.blocked, false, 'call should still work — Twilio creds are present');
    assert.equal(result.channels.text.blocked, false, 'text should still work — Twilio creds are present');
    assert.equal(result.channels.call.brandId, 'insurance-lady');
    assert.equal(result.channels.text.brandId, 'insurance-lady');
  });
});

test('missing shared Twilio credentials blocks both call and text for a brand, independent of email', () => {
  const { db, prosperityId } = setup();
  const caseId = makeCase(db, 'prosperity', prosperityId, 'Rollovers and safe-money solutions');

  withEnv({ ...FULLY_CONFIGURED_ENV, TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: undefined }, () => {
    const result = getSenderGuardrailForCase(db, { caseId });
    assert.equal(result.channels.call.blocked, true);
    assert.equal(result.channels.text.blocked, true);
    assert.equal(result.channels.email.blocked, false, 'email should be unaffected — Gmail creds are present');
  });
});

test('missing one brand-specific FROM number does not block the other brand\'s call/text', () => {
  const { db, insuranceLadyId, prosperityId } = setup();
  const ilCaseId = makeCase(db, 'insurance-lady', insuranceLadyId, 'Follow-up/service');
  const prCaseId = makeCase(db, 'prosperity', prosperityId, 'Follow-up/service');

  withEnv({ ...FULLY_CONFIGURED_ENV, TWILIO_FROM_NUMBER_INSURANCE_LADY: undefined }, () => {
    const ilResult = getSenderGuardrailForCase(db, { caseId: ilCaseId });
    const prResult = getSenderGuardrailForCase(db, { caseId: prCaseId });
    assert.equal(ilResult.channels.text.blocked, true);
    assert.equal(prResult.channels.text.blocked, false);
  });
});

test('canSend is always false for every channel, even when fully resolved and configured', () => {
  const { db, prosperityId } = setup();
  const caseId = makeCase(db, 'prosperity', prosperityId, 'Life insurance');
  withEnv(FULLY_CONFIGURED_ENV, () => {
    const result = getSenderGuardrailForCase(db, { caseId });
    for (const ch of ['call', 'text', 'email']) {
      assert.equal(result.channels[ch].canSend, false);
    }
  });
});

// ── Person-level manual brand selection ─────────────────────────────────────

test('manual selection: with no brand picked, explains the selection controls only this communication and never moves a case', () => {
  const { db } = setup();
  const result = getSenderGuardrailForManualSelection(db, {});
  assert.equal(result.scenario, 'no_relationship');
  assert.equal(result.blocked, true);
  assert.equal(result.message, 'Choose the business this communication is from. This selection controls the sender for this communication only. It does not move or reassign any case.');
  assert.equal(result.brandId, null);
  assert.deepEqual(result.brandChoices.map(b => b.id).sort(), ['insurance-lady', 'prosperity']);
  assert.doesNotMatch(result.message, /case-brand-transfer/);
});

test('manual selection: picking Prosperity resolves identity and evaluates channels independently, without touching any case', () => {
  const { db } = setup();
  withEnv(FULLY_CONFIGURED_ENV, () => {
    const result = getSenderGuardrailForManualSelection(db, { manualBrandSelection: 'prosperity' });
    assert.equal(result.scenario, 'resolved');
    assert.equal(result.brandId, 'prosperity');
    assert.equal(result.channels.email.message, 'This email will be sent from loretta@prosperitylfs.com as Prosperity.');
    assert.equal(result.channels.call.blocked, false);
  });
  // No case or contact_brands row was created or modified by this call.
  const caseCount = db.prepare('SELECT COUNT(*) AS n FROM cases').get().n;
  const linkCount = db.prepare('SELECT COUNT(*) AS n FROM contact_brands').get().n;
  assert.equal(caseCount, 0);
  assert.equal(linkCount, 0);
});

test('manual selection: picking Insurance Lady with email unconfigured blocks only email, never falls back to Prosperity', () => {
  const { db } = setup();
  withEnv({
    ...FULLY_CONFIGURED_ENV,
    MICROSOFT_TENANT_ID: undefined, MICROSOFT_CLIENT_ID: undefined, MICROSOFT_CLIENT_SECRET: undefined,
    MICROSOFT_FROM: undefined, MICROSOFT_FROM_NAME: undefined,
  }, () => {
    const result = getSenderGuardrailForManualSelection(db, { manualBrandSelection: 'insurance-lady' });
    assert.equal(result.brandId, 'insurance-lady');
    assert.equal(result.channels.email.blocked, true);
    assert.match(result.channels.email.fallbackNotice, /will not fall back to Prosperity/);
    assert.equal(result.channels.call.blocked, false);
    assert.equal(result.channels.text.blocked, false);
  });
});

test('manual selection: an unknown brand id resolves to no_relationship rather than crashing or guessing', () => {
  const { db } = setup();
  const result = getSenderGuardrailForManualSelection(db, { manualBrandSelection: 'not-a-real-brand' });
  assert.equal(result.scenario, 'no_relationship');
  assert.equal(result.blocked, true);
  assert.equal(result.brandId, null);
});

test('manual selection: a resolved brand also carries brandChoices, so a caller can render a selector', () => {
  const { db } = setup();
  withEnv(FULLY_CONFIGURED_ENV, () => {
    const result = getSenderGuardrailForManualSelection(db, { manualBrandSelection: 'prosperity' });
    assert.deepEqual(result.brandChoices.map(b => b.id).sort(), ['insurance-lady', 'prosperity']);
  });
});

// ── Default brand for a contact with no case (client-record Text/Email button) ──

test('defaultManualBrandForContact: a contact with exactly one active brand relationship resolves to it unambiguously', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'default-brand-prosperity@example.test', first_name: 'Renee', last_name: 'Client' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });

  assert.equal(defaultManualBrandForContact(db, contact.id), 'prosperity');
});

test('defaultManualBrandForContact: a contact with no active brand relationship returns null, still a genuine "choose a business" situation', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'default-brand-none@example.test', first_name: 'Sam', last_name: 'Unlinked' });

  assert.equal(defaultManualBrandForContact(db, contact.id), null);
});

test('defaultManualBrandForContact feeding into getSenderGuardrailForManualSelection resolves the contact\'s Draft Text/Email preview without any case', () => {
  const { db, prosperityId } = setup();
  const contact = dedupeContact(db, { email: 'default-brand-flow@example.test', first_name: 'Pat', last_name: 'Existing' });
  resolveContactBrand(db, { contactId: contact.id, brandId: prosperityId });

  withEnv(FULLY_CONFIGURED_ENV, () => {
    const defaultBrand = defaultManualBrandForContact(db, contact.id);
    const result = getSenderGuardrailForManualSelection(db, { manualBrandSelection: defaultBrand });
    assert.equal(result.scenario, 'resolved');
    assert.equal(result.brandId, 'prosperity');
    assert.equal(result.channels.text.message, 'This text will be sent from +1 414-441-1177 as Prosperity.');
  });
});
