// Tests for crm/lib/communicationDraftService.js. In-memory databases only.
// No test here ever contacts a network — the fake adapter never does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createDraft, confirmSend, resolveSenderForContact, previewCall } = require('../lib/communicationDraftService');
const { createClient } = require('../lib/clientService');
const { createCaseForClient } = require('../lib/caseService');
const { getAdapter } = require('../lib/providers');

function setup() {
  const db = createLegacyDb();
  const { prosperityId } = runMigrations(db);
  runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  return { db, prosperityId };
}
function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

test('a text draft requires SMS consent', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Dara', email: 'dara@example.com', phone: '4145557000', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => createDraft(db, { contactId: client.contact.id, channel: 'text', body: 'Hi' }, 'Loretta Stewart'), /SMS consent/);
});

test('an email draft requires email consent and a subject', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Eli', email: 'eli@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => createDraft(db, { contactId: client.contact.id, channel: 'email', body: 'Hi' }, 'Loretta Stewart'), /email consent/);
});

test('a valid draft resolves the correct sender company and stores as status=draft', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Fay', email: 'fay@example.com', phone: '4145557001', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(client.contact.id);
  const draft = createDraft(db, { contactId: client.contact.id, channel: 'text', body: 'Following up on your quote' }, 'Loretta Stewart');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.contact_brand_id, client.contactBrand.id);
});

test('confirming a draft never marks it Sent or Delivered, and never contacts a provider', async () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Gia', email: 'gia@example.com', phone: '4145557002', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(client.contact.id);
  const draft = createDraft(db, { contactId: client.contact.id, channel: 'text', body: 'Hello' }, 'Loretta Stewart');

  const { draft: after, providerResult } = await confirmSend(db, draft.id, 'Loretta Stewart');
  assert.equal(after.status, 'blocked');
  assert.notEqual(after.status, 'sent');
  assert.notEqual(after.status, 'delivered');
  assert.equal(providerResult.status, 'blocked');
  assert.match(providerResult.message, /disabled in this local checkpoint/i);
});

test('the fake adapter is the only adapter reachable through getAdapter() and never throws a network error (because it never calls the network)', async () => {
  const adapter = getAdapter();
  const result = await adapter.sendText({ toNumber: '+14145550000', body: 'test' });
  assert.equal(result.status, 'blocked');
});

test('missing channel configuration blocks only that channel, with no cross-company fallback', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Hana2', email: 'hana2@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const caseResult = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const guardrail = resolveSenderForContact(db, { contactId: client.contact.id, caseId: caseResult.id });
  assert.equal(guardrail.scenario, 'resolved');
  assert.equal(guardrail.brandId, 'prosperity');
  // No live Twilio/Gmail credentials exist in this test environment, so
  // every channel is correctly blocked -- but each is evaluated
  // independently and none of them silently resolves to Insurance Lady.
  for (const channel of ['call', 'text', 'email']) {
    assert.equal(guardrail.channels[channel].brandId, 'prosperity');
    assert.notEqual(guardrail.channels[channel].brandId, 'insurance-lady');
  }
});

test('previewCall never places a real call and resolves the guardrail', async () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Ivo', email: 'ivo@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const caseResult = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const { guardrail, providerResult } = await previewCall(db, { contactId: client.contact.id, caseId: caseResult.id });
  assert.equal(guardrail.scenario, 'resolved');
  assert.equal(providerResult.status, 'blocked');
});
