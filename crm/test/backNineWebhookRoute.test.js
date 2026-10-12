// Tests for POST /api/backnine/{eapp,case} (crm/routes/backNineWebhook.js)
// and crm/lib/backNineWebhook.js. The eapp route now stores/updates a
// backnine_applications row (crm/lib/backNineApplications.js) on a
// verified request -- DB_PATH is pointed at an in-memory database BEFORE
// crm/db/database.js is first required anywhere in this process (mirrors
// crm/test/calcomWebhookRoute.test.js), and the new migrateBackNine step
// is run so the table exists. The case route remains log-only (no
// confirmed payload schema), so it never touches the database.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const EAPP_SECRET = 'unit-test-fake-backnine-eapp-secret';
const CASE_SECRET = 'unit-test-fake-backnine-case-secret';
const savedEnv = {
  DB_PATH: process.env.DB_PATH,
  BACKNINE_EAPP_WEBHOOK_SECRET: process.env.BACKNINE_EAPP_WEBHOOK_SECRET,
  BACKNINE_CASE_WEBHOOK_SECRET: process.env.BACKNINE_CASE_WEBHOOK_SECRET,
};
process.env.DB_PATH = ':memory:';
process.env.BACKNINE_EAPP_WEBHOOK_SECRET = EAPP_SECRET;
process.env.BACKNINE_CASE_WEBHOOK_SECRET = CASE_SECRET;

const db = require('../db/database');
const { runBackNineMigrations } = require('../db/migrateBackNine');
const { verifyBackNineAuth, extractConfirmedEappSummary, safeEqualStrings } = require('../lib/backNineWebhook');
const backNineRouter = require('../routes/backNineWebhook');

let server, baseUrl;

before(() => {
  runBackNineMigrations(db);
  const app = express();
  app.use(express.json());
  app.use('/api/backnine', backNineRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/backnine`;
});

after(() => {
  server.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

async function post(path, body, headers = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('A. verifyBackNineAuth: rejects when no secret is configured', () => {
  assert.equal(verifyBackNineAuth({ headers: { 'x-backnine-authentication': 'anything' } }, undefined), false);
  assert.equal(verifyBackNineAuth({ headers: { 'x-backnine-authentication': 'anything' } }, ''), false);
});

test('B. verifyBackNineAuth: rejects a missing header', () => {
  assert.equal(verifyBackNineAuth({ headers: {} }, 'configured-secret'), false);
});

test('C. verifyBackNineAuth: rejects a wrong header value', () => {
  assert.equal(verifyBackNineAuth({ headers: { 'x-backnine-authentication': 'wrong' } }, 'configured-secret'), false);
});

test('D. verifyBackNineAuth: accepts the exact configured secret', () => {
  assert.equal(verifyBackNineAuth({ headers: { 'x-backnine-authentication': 'configured-secret' } }, 'configured-secret'), true);
});

test('E. safeEqualStrings: false for falsy inputs, true only for exact matches', () => {
  assert.equal(safeEqualStrings(null, 'x'), false);
  assert.equal(safeEqualStrings('x', null), false);
  assert.equal(safeEqualStrings('abc', 'abd'), false);
  assert.equal(safeEqualStrings('abc', 'abc'), true);
});

test('F. extractConfirmedEappSummary: reads the docs-example (top-level, fallback) shape from an array-wrapped payload', () => {
  const payload = [{
    id: 116662,
    uuid: 'ae9f4263-95e6-4fab-ab65-7a641bef0e81',
    first_name: 'John',
    last_name: 'Doe',
    product_category: '20 Year Term',
    face_amount: 1000000.0,
    premium: 44.94,
    status: 'Completed',
    step: 14,
    named_step: 'DocuSign - Final Step',
    case: { status: 'Entered', timeline: ['Submitted to Carrier', 'Approved', 'Issued'] },
  }];
  const summary = extractConfirmedEappSummary(payload);
  assert.equal(summary.backNineUuid, 'ae9f4263-95e6-4fab-ab65-7a641bef0e81');
  assert.equal(summary.backNineId, '116662');
  assert.equal(summary.firstName, 'John');
  assert.equal(summary.lastName, 'Doe');
  assert.equal(summary.productCategory, '20 Year Term');
  assert.equal(summary.faceAmount, 1000000.0);
  assert.equal(summary.premium, 44.94);
  assert.equal(summary.eappStatus, 'Completed');
  assert.equal(summary.step, 14);
  assert.equal(summary.namedStep, 'DocuSign - Final Step');
  assert.equal(summary.caseStatus, 'Entered');
  assert.deepEqual(summary.timeline, ['Submitted to Carrier', 'Approved', 'Issued']);
});

test('G. extractConfirmedEappSummary: also accepts a bare (non-array) object', () => {
  const summary = extractConfirmedEappSummary({ id: 1, uuid: 'abc' });
  assert.equal(summary.backNineUuid, 'abc');
  assert.equal(summary.backNineId, '1');
});

test('H. extractConfirmedEappSummary: returns null for an unrecognizable payload', () => {
  assert.equal(extractConfirmedEappSummary(null), null);
  assert.equal(extractConfirmedEappSummary([]), null);
  assert.equal(extractConfirmedEappSummary('not an object'), null);
});

test('F2. extractConfirmedEappSummary: reads the CONFIRMED-REAL nested shape (BackNine case #560015, Janet Jackson)', () => {
  const payload = {
    id: 560015,
    uuid: 'janet-560015-uuid',
    first_name: 'Janet',
    last_name: 'Jackson',
    named_step: 'Quote - 10% Complete',
    product: { name: 'OPTerm 20', carrier: { name: 'Banner' } },
    individuals: [{ quote: { product_category: '20 Year Term', face_amount: 1000000, premium: 224.73, pay_duration: 20 }, phone: null, email: null }],
  };
  const summary = extractConfirmedEappSummary(payload);
  assert.equal(summary.backNineUuid, 'janet-560015-uuid');
  assert.equal(summary.backNineId, '560015');
  assert.equal(summary.productName, 'OPTerm 20');
  assert.equal(summary.carrierName, 'Banner');
  assert.equal(summary.productCategory, '20 Year Term');
  assert.equal(summary.faceAmount, 1000000);
  assert.equal(summary.premium, 224.73);
  assert.equal(summary.payDurationYears, 20);
  assert.equal(summary.namedStep, 'Quote - 10% Complete');
});

test('F3. extractConfirmedEappSummary: the nested (confirmed-real) path wins over the top-level (docs-only) fallback when both are present', () => {
  const payload = {
    uuid: 'both-shapes-uuid',
    product_category: 'TOP LEVEL (should be ignored)', face_amount: 1, premium: 1,
    product: { name: 'Nested Product' },
    individuals: [{ quote: { product_category: 'Nested Category', face_amount: 999, premium: 50 } }],
  };
  const summary = extractConfirmedEappSummary(payload);
  assert.equal(summary.productCategory, 'Nested Category');
  assert.equal(summary.faceAmount, 999);
  assert.equal(summary.premium, 50);
});

test('F4. extractConfirmedEappSummary: missing product/individuals/quote never throws, returns null for those fields', () => {
  const summary = extractConfirmedEappSummary({ uuid: 'no-product-uuid' });
  assert.equal(summary.productName, null);
  assert.equal(summary.carrierName, null);
  assert.equal(summary.productCategory, null);
  assert.equal(summary.faceAmount, null);
  assert.equal(summary.premium, null);
  assert.equal(summary.payDurationYears, null);
});

test('I. extractConfirmedEappSummary: never reads case.contract_parties (unconfirmed field, deliberately not guessed)', () => {
  const summary = extractConfirmedEappSummary({
    id: 1, uuid: 'abc',
    case: { status: 'Entered', contract_parties: [{ email: 'should-never-surface@example.com' }] },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'contractParties'), false);
  assert.equal(JSON.stringify(summary).includes('should-never-surface'), false);
});

test('J. POST /eapp: 401 with no X-BACKNINE-AUTHENTICATION header', async () => {
  const res = await post('/eapp', { id: 1, uuid: 'abc' });
  assert.equal(res.status, 401);
});

test('K. POST /eapp: 401 with a wrong secret', async () => {
  const res = await post('/eapp', { id: 1, uuid: 'abc' }, { 'x-backnine-authentication': 'wrong-secret' });
  assert.equal(res.status, 401);
});

test('L. POST /eapp: 200 + processed:true, stores a new backnine_applications row, with the correct secret', async () => {
  const res = await post('/eapp', { id: 1, uuid: 'route-test-l-uuid', first_name: 'Jane', last_name: 'Doe' }, { 'x-backnine-authentication': EAPP_SECRET });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, received: true, processed: true, outcome: 'created' });

  const row = db.prepare('SELECT * FROM backnine_applications WHERE backnine_uuid = ?').get('route-test-l-uuid');
  assert.ok(row);
  assert.equal(row.first_name, 'Jane');
  assert.equal(row.match_status, 'needs_review');
  assert.equal(row.contact_id, null);
});

test('P. POST /eapp: a repeat delivery for the same uuid updates the same row, never creates a second one', async () => {
  await post('/eapp', { id: 2, uuid: 'route-test-p-uuid', first_name: 'First', premium: 10 }, { 'x-backnine-authentication': EAPP_SECRET });
  const res = await post('/eapp', { id: 2, uuid: 'route-test-p-uuid', first_name: 'First', premium: 25 }, { 'x-backnine-authentication': EAPP_SECRET });
  const body = await res.json();
  assert.equal(body.outcome, 'updated');

  const rows = db.prepare('SELECT * FROM backnine_applications WHERE backnine_uuid = ?').all('route-test-p-uuid');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].premium, 25);
});

test('Q. POST /eapp: a repeat delivery never overwrites a manual match already made on that row', async () => {
  await post('/eapp', { id: 3, uuid: 'route-test-q-uuid' }, { 'x-backnine-authentication': EAPP_SECRET });
  const contactId = db.prepare(`INSERT INTO contacts (first_name, last_name) VALUES ('Test', 'Client')`).run().lastInsertRowid;
  db.prepare(`UPDATE backnine_applications SET contact_id = ?, match_status = 'matched' WHERE backnine_uuid = ?`).run(contactId, 'route-test-q-uuid');

  await post('/eapp', { id: 3, uuid: 'route-test-q-uuid', premium: 99 }, { 'x-backnine-authentication': EAPP_SECRET });

  const row = db.prepare('SELECT * FROM backnine_applications WHERE backnine_uuid = ?').get('route-test-q-uuid');
  assert.equal(row.match_status, 'matched');
  assert.equal(row.contact_id, contactId);
  assert.equal(row.premium, 99);
});

test('M. POST /eapp: the case secret does NOT authenticate the eapp endpoint', async () => {
  const res = await post('/eapp', { id: 1, uuid: 'abc' }, { 'x-backnine-authentication': CASE_SECRET });
  assert.equal(res.status, 401);
});

test('N. POST /case: 401 with no header, 200 with the correct (case-specific) secret', async () => {
  const unauthed = await post('/case', { anything: 'here' });
  assert.equal(unauthed.status, 401);

  const authed = await post('/case', { anything: 'here' }, { 'x-backnine-authentication': CASE_SECRET });
  assert.equal(authed.status, 200);
  const body = await authed.json();
  assert.deepEqual(body, { ok: true, received: true, processed: false });
});

test('O. GET /eapp and /case liveness checks need no auth', async () => {
  const eapp = await fetch(`${baseUrl}/eapp`);
  assert.equal(eapp.status, 200);
  const caseRes = await fetch(`${baseUrl}/case`);
  assert.equal(caseRes.status, 200);
});
