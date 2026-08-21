// Inbound Prosperity SMS tests (Prosperity Revenue MVP, Requirement 3).
// In-memory databases only. No test here ever contacts Twilio — signature
// verification is exercised with LOCALLY COMPUTED fake signed fixtures
// (crypto only), matching the same pattern crm/test/twilioSignature.test.js
// already uses for the existing single-number webhook.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { handleInboundProsperitySms } = require('../lib/inboundSmsService');
const { isValidTwilioRequest, requireValidTwilioSignature, buildTwilioUrl } = require('../lib/twilioSignature');
const { createClient } = require('../lib/clientService');
const { BRANDS } = require('../config/brands');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db); runRevenueMvpMigrations(db);
  return db;
}

const PROSPERITY_NUMBER = BRANDS.prosperity.phone.e164; // +14144411177

// ── Signed-request verification, prepared for live activation ─────────────

function computeTwilioSignature(authToken, url, params) {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return crypto.createHmac('sha1', authToken).update(Buffer.from(data, 'utf-8')).digest('base64');
}

test('a genuinely fake-signed inbound SMS fixture verifies as valid (prepared for live Twilio activation)', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const url = 'https://example-crm.test/api/twilio-prosperity/sms/inbound';
  const params = { From: '+14145551234', To: PROSPERITY_NUMBER, Body: 'Hello', MessageSid: 'SMfake00000000000000000000000001' };
  const signature = computeTwilioSignature(authToken, url, params);
  assert.equal(isValidTwilioRequest({ authToken, signature, url, params }), true);
});

test('a tampered inbound SMS fixture (body changed after signing) fails verification', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const url = 'https://example-crm.test/api/twilio-prosperity/sms/inbound';
  const signedParams = { From: '+14145551234', To: PROSPERITY_NUMBER, Body: 'Hello', MessageSid: 'SMfake00000000000000000000000002' };
  const signature = computeTwilioSignature(authToken, url, signedParams);
  const tamperedParams = { ...signedParams, Body: 'STOP' };
  assert.equal(isValidTwilioRequest({ authToken, signature, url, params: tamperedParams }), false);
});

test('requireValidTwilioSignature middleware accepts a fake-signed fixture for the new Prosperity route', () => {
  const authToken = 'fake_test_only_auth_token_never_real';
  const originalToken = process.env.TWILIO_AUTH_TOKEN;
  const originalPublicUrl = process.env.CRM_PUBLIC_URL;
  process.env.TWILIO_AUTH_TOKEN = authToken;
  process.env.CRM_PUBLIC_URL = 'https://example-crm.test';
  try {
    const params = { From: '+14145551234', To: PROSPERITY_NUMBER, Body: 'Hello', MessageSid: 'SMfake00000000000000000000000003' };
    const url = buildTwilioUrl({ originalUrl: '/api/twilio-prosperity/sms/inbound' });
    const signature = computeTwilioSignature(authToken, url, params);
    const req = { headers: { 'x-twilio-signature': signature }, body: params, originalUrl: '/api/twilio-prosperity/sms/inbound', method: 'POST' };
    let nextCalled = false;
    const res = { status() { return this; }, send() {} };
    requireValidTwilioSignature(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
  } finally {
    if (originalToken === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = originalToken;
    if (originalPublicUrl === undefined) delete process.env.CRM_PUBLIC_URL; else process.env.CRM_PUBLIC_URL = originalPublicUrl;
  }
});

// ── Matching / storage / idempotency / consent-keyword logic ──────────────

test('an inbound reply from a known Prosperity client is matched and stored in that client\'s record', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Gwen', lastName: 'Ibarra', phone: '4145551401', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const result = handleInboundProsperitySms(db, { From: '+14145551401', To: PROSPERITY_NUMBER, Body: 'Sounds good, thanks!', MessageSid: 'SM_MATCH_1' });
  assert.equal(result.outcome, 'matched');
  assert.equal(result.contactId, client.contact.id);
  const row = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').get(client.contact.id);
  assert.equal(row.direction, 'inbound');
  assert.equal(row.body, 'Sounds good, thanks!');
  assert.equal(row.twilio_sid, 'SM_MATCH_1');
});

test('an unknown sender number is routed to Review Required, never guessed at', () => {
  const db = setup();
  const result = handleInboundProsperitySms(db, { From: '+14145559999', To: PROSPERITY_NUMBER, Body: 'Hi is this Loretta?', MessageSid: 'SM_UNKNOWN_1' });
  assert.equal(result.outcome, 'staged_for_review');
  const staged = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(result.unresolvedIntakeId);
  assert.equal(staged.review_type, 'unknown_sms_sender');
  assert.equal(staged.status, 'Pending');
  const messageRows = db.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n;
  assert.equal(messageRows, 0, 'an unmatched reply must never be attached to a guessed contact');
});

test('a reply from a number belonging only to an Insurance Lady client is never attached to that client', () => {
  const db = setup();
  const ilClient = createClient(db, { firstName: 'Hank', lastName: 'Juno', phone: '4145551402', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  const result = handleInboundProsperitySms(db, { From: '+14145551402', To: PROSPERITY_NUMBER, Body: 'Hello?', MessageSid: 'SM_IL_1' });
  assert.equal(result.outcome, 'staged_for_review');
  const attachedToIl = db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(ilClient.contact.id).n;
  assert.equal(attachedToIl, 0);
});

test('a duplicate webhook delivery (same MessageSid) never creates a second message', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Ivy', lastName: 'Knox', phone: '4145551403', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const params = { From: '+14145551403', To: PROSPERITY_NUMBER, Body: 'On my way', MessageSid: 'SM_DUP_2' };
  const first = handleInboundProsperitySms(db, params);
  const second = handleInboundProsperitySms(db, params);
  assert.equal(first.outcome, 'matched');
  assert.equal(second.outcome, 'duplicate_ignored');
  const count = db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(client.contact.id).n;
  assert.equal(count, 1);
});

test('a duplicate webhook for an unmatched number never creates a second review item', () => {
  const db = setup();
  const params = { From: '+14145559998', To: PROSPERITY_NUMBER, Body: 'Who is this', MessageSid: 'SM_DUP_UNKNOWN' };
  const first = handleInboundProsperitySms(db, params);
  const second = handleInboundProsperitySms(db, params);
  assert.equal(first.outcome, 'staged_for_review');
  assert.equal(second.outcome, 'already_staged');
  const count = db.prepare(`SELECT COUNT(*) AS n FROM unresolved_intake WHERE review_type = 'unknown_sms_sender'`).get().n;
  assert.equal(count, 1);
});

test('STOP suppresses later nonessential SMS by clearing consent and recording an opt-out timestamp', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Jude', lastName: 'Lang', phone: '4145551404', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(client.contact.id);
  const result = handleInboundProsperitySms(db, { From: '+14145551404', To: PROSPERITY_NUMBER, Body: 'STOP', MessageSid: 'SM_STOP_1' });
  assert.equal(result.consentAction, 'opted_out');
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 0);
  assert.ok(contact.sms_opted_out_at);
});

test('START restores consent and clears the opt-out timestamp', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Kira', lastName: 'Munn', phone: '4145551405', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`UPDATE contacts SET sms_consent = 0, sms_opted_out_at = '2026-01-01' WHERE id = ?`).run(client.contact.id);
  const result = handleInboundProsperitySms(db, { From: '+14145551405', To: PROSPERITY_NUMBER, Body: 'START', MessageSid: 'SM_START_1' });
  assert.equal(result.consentAction, 'opted_in');
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 1);
  assert.equal(contact.sms_opted_out_at, null);
});

test('HELP is logged normally and does not change consent state', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Liam', lastName: 'North', phone: '4145551406', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(client.contact.id);
  const result = handleInboundProsperitySms(db, { From: '+14145551406', To: PROSPERITY_NUMBER, Body: 'HELP', MessageSid: 'SM_HELP_1' });
  assert.equal(result.consentAction, 'help_requested');
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 1);
});

test('a message to a number other than the Prosperity 414 number is ignored, not attached to any client', () => {
  const db = setup();
  createClient(db, { firstName: 'Mona', lastName: 'Ochoa', phone: '4145551407', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const result = handleInboundProsperitySms(db, { From: '+14145551407', To: '+18885550000', Body: 'Hi', MessageSid: 'SM_WRONG_NUM' });
  assert.equal(result.outcome, 'ignored_wrong_number');
  const count = db.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n;
  assert.equal(count, 0);
});
