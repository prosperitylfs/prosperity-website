// Tests for POST /api/backnine/webhook/{eapp,case} (crm/routes/backNineWebhook.js)
// and crm/lib/backNineWebhook.js. Phase 1 scope only: these routes verify the
// X-BACKNINE-AUTHENTICATION shared secret and acknowledge receipt -- they
// never touch the database, so these tests confirm exactly that (no db
// import at all in the router under test) alongside the auth/logging
// behavior itself.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const EAPP_SECRET = 'unit-test-fake-backnine-eapp-secret';
const CASE_SECRET = 'unit-test-fake-backnine-case-secret';
const savedEnv = {
  BACKNINE_EAPP_WEBHOOK_SECRET: process.env.BACKNINE_EAPP_WEBHOOK_SECRET,
  BACKNINE_CASE_WEBHOOK_SECRET: process.env.BACKNINE_CASE_WEBHOOK_SECRET,
};
process.env.BACKNINE_EAPP_WEBHOOK_SECRET = EAPP_SECRET;
process.env.BACKNINE_CASE_WEBHOOK_SECRET = CASE_SECRET;

const { verifyBackNineAuth, extractConfirmedEappSummary, safeEqualStrings } = require('../lib/backNineWebhook');
const backNineRouter = require('../routes/backNineWebhook');

let server, baseUrl;

before(() => {
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

test('F. extractConfirmedEappSummary: reads only the confirmed fields, from an array-wrapped payload', () => {
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

test('L. POST /eapp: 200 + processed:false with the correct secret', async () => {
  const res = await post('/eapp', { id: 1, uuid: 'abc', first_name: 'Jane' }, { 'x-backnine-authentication': EAPP_SECRET });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { ok: true, received: true, processed: false });
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
