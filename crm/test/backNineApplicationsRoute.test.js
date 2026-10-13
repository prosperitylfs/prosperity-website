// Tests for /api/app/backnine-applications/* (crm/routes/backNineApplications.js):
// needs-review list, manual match, and the detail view.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

process.env.DB_PATH = ':memory:';
const db = require('../db/database');
const { runBackNineMigrations } = require('../db/migrateBackNine');
const { runMigrations: runBrandsMigrations } = require('../db/migrateBrands');
const { upsertApplicationFromEapp } = require('../lib/backNineApplications');
const { extractConfirmedEappSummary } = require('../lib/backNineWebhook');
const router = require('../routes/backNineApplications');

let server, baseUrl;

before(() => {
  runBrandsMigrations(db);
  runBackNineMigrations(db);
  const app = express();
  app.use(express.json());
  app.use('/api/app', router);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/app`;
});

after(() => { server.close(); });

function createApplication(uuid, overrides = {}) {
  const payload = { uuid, product: { name: 'OPTerm 20', carrier: { name: 'Banner' } }, individuals: [{ quote: { product_category: '20 Year Term', face_amount: 1000000, premium: 224.73, pay_duration: 20 } }], ...overrides };
  const summary = extractConfirmedEappSummary(payload);
  return upsertApplicationFromEapp(db, summary, payload).application;
}

test('A. GET needs-review: lists applications, never includes raw_payload', async () => {
  createApplication('route-a-uuid');
  const res = await fetch(`${baseUrl}/backnine-applications/needs-review`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const app = body.applications.find(a => a.backnine_uuid === 'route-a-uuid');
  assert.ok(app);
  assert.equal(app.product_name, 'OPTerm 20');
  assert.equal(Object.prototype.hasOwnProperty.call(app, 'raw_payload'), false);
});

test('B. GET :id: returns the full structured detail, never raw_payload', async () => {
  const created = createApplication('route-b-uuid');
  const res = await fetch(`${baseUrl}/backnine-applications/${created.id}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.application.carrier_name, 'Banner');
  assert.equal(body.application.pay_duration_years, 20);
  assert.equal(Object.prototype.hasOwnProperty.call(body.application, 'raw_payload'), false);
});

test('C. GET :id: 404 for an unknown id', async () => {
  const res = await fetch(`${baseUrl}/backnine-applications/999999`);
  assert.equal(res.status, 404);
});

test('D. GET :id: 400 for a non-numeric id', async () => {
  const res = await fetch(`${baseUrl}/backnine-applications/not-a-number`);
  assert.equal(res.status, 400);
});

test('E. POST :id/match: matches to an existing contact and removes it from needs-review', async () => {
  const created = createApplication('route-e-uuid');
  const contactId = db.prepare(`INSERT INTO contacts (first_name) VALUES ('Route E Target')`).run().lastInsertRowid;

  const res = await fetch(`${baseUrl}/backnine-applications/${created.id}/match`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contactId }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.application.match_status, 'matched');

  const listRes = await fetch(`${baseUrl}/backnine-applications/needs-review`);
  const listBody = await listRes.json();
  assert.ok(!listBody.applications.some(a => a.id === created.id));
});

test('F. POST :id/match: 400 for a missing/invalid contactId', async () => {
  const created = createApplication('route-f-uuid');
  const res = await fetch(`${baseUrl}/backnine-applications/${created.id}/match`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('G. POST :id/create-lead: creates a lead, links it, and removes the application from needs-review', async () => {
  const created = createApplication('route-g-uuid', { first_name: 'Route', last_name: 'Lead' });

  const res = await fetch(`${baseUrl}/backnine-applications/${created.id}/create-lead`, { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.outcome, 'created');
  assert.ok(body.contactId);

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(body.contactId);
  assert.equal(contact.lead_source, 'BackNine');

  const listRes = await fetch(`${baseUrl}/backnine-applications/needs-review`);
  const listBody = await listRes.json();
  assert.ok(!listBody.applications.some(a => a.id === created.id));
});

test('H. POST :id/create-lead: idempotent over HTTP -- a second call returns the same contactId, not a new one', async () => {
  const created = createApplication('route-h-uuid');
  const first = await (await fetch(`${baseUrl}/backnine-applications/${created.id}/create-lead`, { method: 'POST' })).json();
  const second = await (await fetch(`${baseUrl}/backnine-applications/${created.id}/create-lead`, { method: 'POST' })).json();
  assert.equal(first.outcome, 'created');
  assert.equal(second.outcome, 'existing');
  assert.equal(first.contactId, second.contactId);
});

test('I. POST :id/create-lead: 400 for an unknown application id', async () => {
  const res = await fetch(`${baseUrl}/backnine-applications/999999/create-lead`, { method: 'POST' });
  assert.equal(res.status, 400);
});
