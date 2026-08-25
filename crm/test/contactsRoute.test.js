// Tests for the NEW brand/relationship/consent-audit behavior added to the
// legacy /api/contacts route (crm/routes/contacts.js), used by the old
// interface's "+ Add Contact" modal (public/add-contact-modal.js). This is
// the manual-entry counterpart to crm/test/clientService.test.js, which
// covers the same rules for the new interface's /api/app/clients route.
//
// Mirrors crm/test/tasksRoute.test.js's approach: DB_PATH is pointed at an
// in-memory database BEFORE crm/db/database.js is first required anywhere
// in this process (that route file requires it directly at module scope),
// then a real Express app is spun up on an ephemeral port and exercised
// with real HTTP requests (global fetch) rather than requiring the route
// module in isolation.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const savedEnv = { DB_PATH: process.env.DB_PATH };
process.env.DB_PATH = ':memory:';

const db = require('../db/database');
const { runMigrations } = require('../db/migrateBrands');
const contactsRouter = require('../routes/contacts');

let server, baseUrl, prosperityId, insuranceLadyId;

before(() => {
  ({ prosperityId, insuranceLadyId } = runMigrations(db));

  const app = express();
  app.use(express.json());
  app.use('/api/contacts', contactsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/contacts`;
});

after(() => {
  server.close();
  if (savedEnv.DB_PATH === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = savedEnv.DB_PATH;
});

async function post(body) {
  const res = await fetch(baseUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('creating a contact without a brand is rejected — no default brand', async () => {
  const { status, body } = await post({ first_name: 'No', last_name: 'Brand', email: 'nobrand@example.com' });
  assert.equal(status, 400);
  assert.match(body.error, /company \(brand\) is required/);
});

test('creating a contact with an unknown brand_slug is rejected', async () => {
  const { status, body } = await post({ first_name: 'Bad', email: 'badbrand@example.com', brand_slug: 'medicare-lady' });
  assert.equal(status, 400);
  assert.match(body.error, /company \(brand\) is required/);
});

test('creating a contact with a valid brand succeeds and creates the contact_brands row', async () => {
  const { status, body } = await post({
    first_name: 'Nora', last_name: 'Ellis', email: 'nora.ellis@example.com', brand_slug: 'prosperity',
  });
  assert.equal(status, 201);
  assert.equal(body.first_name, 'Nora');
  const link = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').get(body.id);
  assert.ok(link, 'a contact_brands row must be created for a manually-added legacy contact');
  assert.equal(link.brand_id, prosperityId);
  assert.equal(link.status, 'Active');
});

test('Insurance Lady brand resolves to the correct contact_brands row', async () => {
  const { status, body } = await post({
    first_name: 'Ilya', email: 'ilya@example.com', brand_slug: 'insurance-lady',
  });
  assert.equal(status, 201);
  const link = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').get(body.id);
  assert.equal(link.brand_id, insuranceLadyId);
});

test('relationship_type defaults to null and can be set to active_client', async () => {
  const noRel = await post({ first_name: 'Default', email: 'defaultrel@example.com', brand_slug: 'prosperity' });
  assert.equal(noRel.body.relationship_type, null);

  const client = await post({
    first_name: 'Ray', email: 'ray.client@example.com', brand_slug: 'prosperity', relationship_type: 'active_client',
  });
  assert.equal(client.status, 201);
  assert.equal(client.body.relationship_type, 'active_client');
});

test('every approved relationship_type value is accepted (lead, active_client, former_client, prior_applicant, declined_applicant)', async () => {
  const values = ['lead', 'active_client', 'former_client', 'prior_applicant', 'declined_applicant'];
  for (const value of values) {
    const { status, body } = await post({
      first_name: 'Val', email: `valroute-${value}@example.com`, brand_slug: 'prosperity', relationship_type: value,
    });
    assert.equal(status, 201);
    assert.equal(body.relationship_type, value);
  }
});

test('an unknown relationship_type is rejected', async () => {
  const { status, body } = await post({
    first_name: 'Bad', email: 'badrel@example.com', brand_slug: 'prosperity', relationship_type: 'vip',
  });
  assert.equal(status, 400);
  assert.match(body.error, /relationship_type must be one of/);
});

test('marking a contact Active Client does NOT itself grant SMS consent', async () => {
  const { status, body } = await post({
    first_name: 'Kai', email: 'kai@example.com', brand_slug: 'prosperity', relationship_type: 'active_client',
  });
  assert.equal(status, 201);
  assert.equal(body.relationship_type, 'active_client');
  assert.equal(body.sms_consent, 0);
  assert.equal(body.sms_consent_source, null);
});

test('SMS consent checked without a consent source is rejected', async () => {
  const { status, body } = await post({
    first_name: 'No', last_name: 'Source', email: 'nosourcelegacy@example.com', brand_slug: 'prosperity', sms_consent: true,
  });
  assert.equal(status, 400);
  assert.match(body.error, /consent source is required/);
});

test('SMS consent unchecked never requires a consent source, and consent fields stay null', async () => {
  const { status, body } = await post({ first_name: 'Off', email: 'offlegacy@example.com', brand_slug: 'prosperity' });
  assert.equal(status, 201);
  assert.equal(body.sms_consent, 0);
  assert.equal(body.sms_consent_source, null);
  assert.equal(body.sms_consent_at, null);
});

test('granting SMS consent stores the source/notes and auto-stamps sms_consent_at to now', async () => {
  const before = Date.now();
  const { status, body } = await post({
    first_name: 'Amy', email: 'amylegacy@example.com', brand_slug: 'prosperity',
    sms_consent: true, sms_consent_source: 'Phone – Jennifer', sms_consent_notes: 'Verbal on inbound call',
  });
  assert.equal(status, 201);
  assert.equal(body.sms_consent, 1);
  assert.equal(body.sms_consent_source, 'Phone – Jennifer');
  assert.equal(body.sms_consent_notes, 'Verbal on inbound call');
  assert.ok(body.sms_consent_at);
  const stamped = new Date(body.sms_consent_at.replace(' ', 'T') + 'Z').getTime();
  assert.ok(stamped >= before - 5000, 'consent date must be "now", never fabricated/backdated');
});

test('email_consent is preserved exactly as before, independent of sms_consent', async () => {
  const { status, body } = await post({
    first_name: 'Em', email: 'em@example.com', brand_slug: 'prosperity', email_consent: true,
  });
  assert.equal(status, 201);
  assert.equal(body.email_consent, 1);
  assert.equal(body.sms_consent, 0, 'email_consent must never imply sms_consent');
});

test('a duplicate email is still rejected with 409 exactly as before, before any brand logic runs', async () => {
  await post({ first_name: 'Dup', email: 'dupcheck@example.com', brand_slug: 'prosperity' });
  const { status, body } = await post({ first_name: 'Dup', email: 'dupcheck@example.com', brand_slug: 'prosperity' });
  assert.equal(status, 409);
  assert.ok(body.contact_id);
});

test('missing name/email/phone is still rejected with 400 exactly as before', async () => {
  const { status } = await post({ brand_slug: 'prosperity' });
  assert.equal(status, 400);
});
