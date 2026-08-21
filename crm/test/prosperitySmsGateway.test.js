// Tests for crm/lib/prosperitySmsGateway.js -- the queued -> sent | failed |
// blocked lifecycle. Uses a plain mock adapter object injected via
// deps.adapter, never the real Twilio client and never
// process.env.COMMUNICATION_PROVIDER -- these tests never risk a network
// call regardless of environment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { sendProsperitySmsForDraft, resolveSendContext } = require('../lib/prosperitySmsGateway');
const { createDraft } = require('../lib/communicationDraftService');
const { createClient } = require('../lib/clientService');
const { BRANDS } = require('../config/brands');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db); runRevenueMvpMigrations(db);
  return db;
}
function consentClient(db, fields) {
  const client = createClient(db, fields, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(client.contact.id);
  return client;
}
function draftFor(db, client, body = 'Hello') {
  return createDraft(db, { contactId: client.contact.id, channel: 'text', body }, 'Loretta Stewart');
}

test('writes a queued row before calling the adapter, then updates it to the adapter\'s final status', async () => {
  const db = setup();
  const client = consentClient(db, { firstName: 'Gwen', lastName: 'Iyer', phone: '4145557101', brandSlug: 'prosperity' });
  const draft = draftFor(db, client);

  let sawQueuedBeforeAdapterCalled = null;
  const mockAdapter = {
    sendText: async () => {
      sawQueuedBeforeAdapterCalled = db.prepare('SELECT status FROM sms_messages WHERE contact_id = ?').get(client.contact.id)?.status;
      return { ok: true, status: 'sent', sid: 'SM_test_1' };
    },
  };

  const { message } = await sendProsperitySmsForDraft(db, draft, 'Loretta Stewart', { adapter: mockAdapter });
  assert.equal(sawQueuedBeforeAdapterCalled, 'queued', 'the row must exist with status=queued at the moment the adapter is called');
  assert.equal(message.status, 'sent');
  assert.equal(message.twilio_sid, 'SM_test_1');
});

test('an adapter-blocked result is stored as blocked with the adapter\'s message as the failure reason', async () => {
  const db = setup();
  const client = consentClient(db, { firstName: 'Hiro', lastName: 'Jack', phone: '4145557102', brandSlug: 'prosperity' });
  const draft = draftFor(db, client);
  const mockAdapter = { sendText: async () => ({ ok: false, status: 'blocked', message: 'Test block reason' }) };
  const { message } = await sendProsperitySmsForDraft(db, draft, 'Loretta Stewart', { adapter: mockAdapter });
  assert.equal(message.status, 'blocked');
  assert.equal(message.failure_reason, 'Test block reason');
  assert.equal(message.twilio_sid, null);
});

test('an adapter-failed result is stored as failed with a safe reason', async () => {
  const db = setup();
  const client = consentClient(db, { firstName: 'Ines', lastName: 'Kwan', phone: '4145557103', brandSlug: 'prosperity' });
  const draft = draftFor(db, client);
  const mockAdapter = { sendText: async () => ({ ok: false, status: 'failed', message: 'Twilio error 21211: invalid number' }) };
  const { message } = await sendProsperitySmsForDraft(db, draft, 'Loretta Stewart', { adapter: mockAdapter });
  assert.equal(message.status, 'failed');
  assert.match(message.failure_reason, /21211/);
});

test('never writes status=delivered under any adapter result', async () => {
  const db = setup();
  const client = consentClient(db, { firstName: 'Jael', lastName: 'Lombard', phone: '4145557104', brandSlug: 'prosperity' });
  const draft = draftFor(db, client);
  const mockAdapter = { sendText: async () => ({ ok: false, status: 'delivered', message: 'a misbehaving adapter' }) };
  const { message } = await sendProsperitySmsForDraft(db, draft, 'Loretta Stewart', { adapter: mockAdapter });
  assert.notEqual(message.status, 'delivered');
  assert.equal(message.status, 'blocked', 'an unrecognized/unexpected adapter status must fall through to blocked, never delivered');
});

test('resolveSendContext resolves the Prosperity 414 fromNumber, consent, and opt-out state fresh from the db', async () => {
  const db = setup();
  const client = consentClient(db, { firstName: 'Kato', lastName: 'Mireles', phone: '4145557105', brandSlug: 'prosperity' });
  const draft = draftFor(db, client);
  const ctx = resolveSendContext(db, draft);
  assert.equal(ctx.brandId, 'prosperity');
  assert.equal(ctx.fromNumber, BRANDS.prosperity.phone.e164);
  assert.equal(ctx.hasConsent, true);
  assert.equal(ctx.isOptedOut, false);
  assert.equal(ctx.toNumber, client.contact.phone_e164);
});

test('a STOP reply that arrives after the draft was created is still caught at send time', async () => {
  const db = setup();
  const client = consentClient(db, { firstName: 'Luz', lastName: 'Novak', phone: '4145557106', brandSlug: 'prosperity' });
  const draft = draftFor(db, client);
  // Simulate STOP arriving between draft creation and confirm-send.
  db.prepare('UPDATE contacts SET sms_consent = 0, sms_opted_out_at = CURRENT_TIMESTAMP WHERE id = ?').run(client.contact.id);
  const ctx = resolveSendContext(db, draft);
  assert.equal(ctx.isOptedOut, true);
  assert.equal(ctx.hasConsent, false);
});

test('defaults to the real getAdapter() (fake by default) when no adapter override is given', async () => {
  const db = setup();
  const client = consentClient(db, { firstName: 'Milo', lastName: 'Ott', phone: '4145557107', brandSlug: 'prosperity' });
  const draft = draftFor(db, client);
  const { message, providerResult } = await sendProsperitySmsForDraft(db, draft, 'Loretta Stewart');
  assert.equal(providerResult.status, 'blocked');
  assert.match(providerResult.message, /disabled in this local checkpoint/i);
  assert.equal(message.status, 'blocked');
});
