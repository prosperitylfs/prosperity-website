// Tests for the Prosperity Revenue MVP's dashboardQueries.js / reviewResolution.js
// extensions: the threaded text view, Last Activity updates from calls/SMS,
// and the unknown-SMS-sender review queue + resolution. In-memory dbs only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { getClientDetail, normalizeMessageStatus, getUnknownSmsReviewQueue } = require('../lib/dashboardQueries');
const { createClient } = require('../lib/clientService');
const { logCall } = require('../lib/callLogService');
const { handleInboundProsperitySms } = require('../lib/inboundSmsService');
const { resolveUnknownSmsReview } = require('../lib/reviewResolution');
const { BRANDS } = require('../config/brands');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db); runRevenueMvpMigrations(db);
  return db;
}

test("normalizeMessageStatus maps the fake adapter's 'blocked' status distinctly from 'Queued'", () => {
  assert.equal(normalizeMessageStatus('blocked'), 'Blocked');
  assert.notEqual(normalizeMessageStatus('blocked'), 'Queued');
});

test('the text thread displays inbound and outbound messages in one chronological list', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Nora', lastName: 'Ott', phone: '4145551501', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const link = db.prepare(`SELECT id FROM contact_brands WHERE contact_id = ?`).get(client.contact.id);
  db.prepare(`INSERT INTO sms_messages (contact_id, contact_brand_id, direction, from_number, to_number, body, status, sent_at) VALUES (?, ?, 'outbound', ?, '+14145551501', 'Hi there', 'blocked', '2026-08-20T09:00:00Z')`)
    .run(client.contact.id, link.id, BRANDS.prosperity.phone.e164);
  db.prepare(`INSERT INTO sms_messages (contact_id, contact_brand_id, direction, from_number, to_number, body, status, sent_at) VALUES (?, ?, 'inbound', '+14145551501', ?, 'Thanks!', 'received', '2026-08-20T09:05:00Z')`)
    .run(client.contact.id, link.id, BRANDS.prosperity.phone.e164);
  const detail = getClientDetail(db, client.contact.id);
  assert.equal(detail.smsThread.length, 2);
  assert.equal(detail.smsThread[0].direction, 'outbound');
  assert.equal(detail.smsThread[1].direction, 'inbound');
  assert.ok(detail.smsThread[0].sent_at < detail.smsThread[1].sent_at);
});

test('a call log updates Last Activity for the correct client (via cases.lastActivity)', () => {
  const db = setup();
  const { createCaseForClient } = require('../lib/caseService');
  const brandRow = db.prepare(`SELECT id FROM brands WHERE slug = 'prosperity'`).get();
  const productRow = db.prepare(`SELECT id FROM products WHERE brand_id = ? AND name = 'Life insurance'`).get(brandRow.id);
  const client = createClient(db, { firstName: 'Omar', lastName: 'Pace', phone: '4145551502', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const kase = createCaseForClient(db, { contactId: client.contact.id, productId: productRow.id }, 'Loretta Stewart');
  const beforeDetail = getClientDetail(db, client.contact.id);
  const beforeActivity = beforeDetail.contactBrands[0].cases[0].lastActivity;

  logCall(db, { contactId: client.contact.id, caseId: kase.id, direction: 'outbound', date: '2026-08-20', startTime: '11:00', outcome: 'Spoke with client' }, 'Loretta Stewart');

  const afterDetail = getClientDetail(db, client.contact.id);
  const afterActivity = afterDetail.contactBrands[0].cases[0].lastActivity;
  assert.ok(afterActivity >= beforeActivity);
  assert.equal(afterDetail.callLog.length, 1);
  assert.equal(afterDetail.callLog[0].outcome, 'Spoke with client');
});

test('an unknown SMS sender appears in the unknown-SMS review queue', () => {
  const db = setup();
  handleInboundProsperitySms(db, { From: '+14145559911', To: BRANDS.prosperity.phone.e164, Body: 'hey', MessageSid: 'SM_QUEUE_1' });
  const queue = getUnknownSmsReviewQueue(db);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].fromNumber, '+14145559911');
  assert.equal(queue[0].body, 'hey');
});

test('resolveUnknownSmsReview attaches the message to the chosen Prosperity client and preserves the original intake', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Petra', lastName: 'Quinn', phone: '4145551503', brandSlug: 'prosperity' }, 'Loretta Stewart');
  handleInboundProsperitySms(db, { From: '+14145559922', To: BRANDS.prosperity.phone.e164, Body: 'is this Loretta', MessageSid: 'SM_QUEUE_2' });
  const pending = getUnknownSmsReviewQueue(db)[0];
  const result = resolveUnknownSmsReview(db, { intakeId: pending.intakeId, contactId: client.contact.id, actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'attached');
  assert.equal(result.messageCreated, true);
  const message = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').get(client.contact.id);
  assert.equal(message.body, 'is this Loretta');
  assert.equal(message.twilio_sid, 'SM_QUEUE_2');
  const intake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(pending.intakeId);
  assert.equal(intake.status, 'Resolved');
  assert.equal(JSON.parse(intake.raw_payload).Body, 'is this Loretta', 'original raw payload must be preserved untouched');
  assert.equal(getUnknownSmsReviewQueue(db).length, 0);
});

test('resolveUnknownSmsReview refuses to attach to a client whose active company is Insurance Lady', () => {
  const db = setup();
  const ilClient = createClient(db, { firstName: 'Quinn', lastName: 'Rios', phone: '4145551504', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  handleInboundProsperitySms(db, { From: '+14145559933', To: BRANDS.prosperity.phone.e164, Body: 'hi', MessageSid: 'SM_QUEUE_3' });
  const pending = getUnknownSmsReviewQueue(db)[0];
  assert.throws(() => resolveUnknownSmsReview(db, { intakeId: pending.intakeId, contactId: ilClient.contact.id, actor: 'Loretta Stewart' }), /Prosperity/);
});
