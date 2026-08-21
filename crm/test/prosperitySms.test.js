// Outbound Prosperity SMS tests (Prosperity Revenue MVP, Requirement 2).
// In-memory databases only. No test here ever contacts a network — the
// fake adapter never does, and confirmSend() never calls a real Twilio API.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { createDraft, confirmSend, resolveSenderForContact } = require('../lib/communicationDraftService');
const { createClient } = require('../lib/clientService');
const { createCaseForClient } = require('../lib/caseService');
const { BRANDS } = require('../config/brands');

function setup() {
  const db = createLegacyDb();
  const { prosperityId, insuranceLadyId } = runMigrations(db);
  runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db); runRevenueMvpMigrations(db);
  return { db, prosperityId, insuranceLadyId };
}
function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}
function consentClient(db, fields) {
  const client = createClient(db, fields, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(client.contact.id);
  return client;
}

// Fake, non-secret placeholder values used only to make
// isChannelConfigured() report the Prosperity SMS channel as "configured"
// so the guardrail's friendly message (which includes the actual sending
// number) is exercised — the same way a real deploy's env would, but with
// values that are never read for anything other than a presence check
// (crm/config/brands.js) and never contacted (the fake adapter never reads
// process.env at all). Restored after every test; never written to .env.
function withFakeTwilioConfigured(fn) {
  const keys = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER_PROSPERITY'];
  const originals = keys.map(k => process.env[k]);
  keys.forEach(k => { process.env[k] = 'test_placeholder_never_real'; });
  try { return fn(); }
  finally { keys.forEach((k, i) => { if (originals[i] === undefined) delete process.env[k]; else process.env[k] = originals[i]; }); }
}

test('a Prosperity client\'s text sender resolves only the 414 number', () => {
  const { db, prosperityId } = setup();
  const client = consentClient(db, { firstName: 'Anna', lastName: 'Kroll', phone: '4145551301', brandSlug: 'prosperity' });
  const kase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  withFakeTwilioConfigured(() => {
    const guardrail = resolveSenderForContact(db, { contactId: client.contact.id, caseId: kase.id });
    assert.equal(guardrail.scenario, 'resolved');
    assert.equal(guardrail.brandId, 'prosperity');
    assert.equal(guardrail.channels.text.identity, BRANDS.prosperity.phone.display);
    assert.equal(BRANDS.prosperity.phone.e164, '+14144411177');
  });
});

test('never falls back to the Insurance Lady number for a Prosperity client', () => {
  const { db, prosperityId } = setup();
  const client = consentClient(db, { firstName: 'Bo', lastName: 'Ives', phone: '4145551302', brandSlug: 'prosperity' });
  const kase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  withFakeTwilioConfigured(() => {
    const guardrail = resolveSenderForContact(db, { contactId: client.contact.id, caseId: kase.id });
    assert.notEqual(guardrail.channels.text.identity, BRANDS['insurance-lady'].phone.display);
    assert.equal(guardrail.brandId, 'prosperity');
  });
});

test('a confirmed text draft stores the outgoing message in the correct client record with a delivery status', async () => {
  const { db, prosperityId } = setup();
  const client = consentClient(db, { firstName: 'Cleo', lastName: 'Dunn', phone: '4145551303', brandSlug: 'prosperity' });
  const kase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const draft = createDraft(db, { contactId: client.contact.id, caseId: kase.id, channel: 'text', body: 'Hi Cleo, following up on your quote.' }, 'Loretta Stewart');
  const { smsMessage, providerResult } = await confirmSend(db, draft.id, 'Loretta Stewart');
  assert.ok(smsMessage, 'confirming a text draft must persist a real sms_messages row');
  assert.equal(smsMessage.contact_id, client.contact.id);
  assert.equal(smsMessage.direction, 'outbound');
  assert.equal(smsMessage.from_number, BRANDS.prosperity.phone.e164);
  assert.equal(smsMessage.status, 'blocked');
  assert.equal(providerResult.status, 'blocked');
  assert.notEqual(smsMessage.status, 'sent');
  assert.notEqual(smsMessage.status, 'delivered');
});

test('confirming a text draft never contacts a real Twilio API (fake adapter only)', async () => {
  const { db, prosperityId } = setup();
  const client = consentClient(db, { firstName: 'Dex', lastName: 'Farr', phone: '4145551304', brandSlug: 'prosperity' });
  const draft = createDraft(db, { contactId: client.contact.id, channel: 'text', body: 'Hello' }, 'Loretta Stewart');
  const { providerResult } = await confirmSend(db, draft.id, 'Loretta Stewart');
  assert.match(providerResult.message, /disabled in this local checkpoint/i);
});

test('a client who has replied STOP cannot have a new text drafted', () => {
  const { db } = setup();
  const client = consentClient(db, { firstName: 'Elle', lastName: 'Grant', phone: '4145551305', brandSlug: 'prosperity' });
  db.prepare('UPDATE contacts SET sms_consent = 0, sms_opted_out_at = CURRENT_TIMESTAMP WHERE id = ?').run(client.contact.id);
  assert.throws(() => createDraft(db, { contactId: client.contact.id, channel: 'text', body: 'Hi again' }, 'Loretta Stewart'), /STOP/);
});

test('missing SMS credentials block only the text channel, with no cross-company fallback', () => {
  const { db, prosperityId } = setup();
  const client = consentClient(db, { firstName: 'Faye', lastName: 'Hull', phone: '4145551306', brandSlug: 'prosperity' });
  const kase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const guardrail = resolveSenderForContact(db, { contactId: client.contact.id, caseId: kase.id });
  // No real Twilio credentials exist in this test environment, so text is
  // correctly blocked -- but it's still evaluated as Prosperity, never
  // silently re-evaluated as Insurance Lady.
  assert.equal(guardrail.channels.text.brandId, 'prosperity');
  assert.notEqual(guardrail.channels.text.brandId, 'insurance-lady');
});
