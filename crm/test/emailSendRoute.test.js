// Tests for the brand-aware routing added to POST /api/email/send
// (crm/routes/email.js) -- 2026-10-16: a Prosperity contact must keep
// going through the existing Gmail sender exactly as before; an Insurance
// Lady contact must go through the new Microsoft Graph sender
// (crm/lib/msGraphSend.js); an ambiguous/unresolvable brand must be
// refused, never guessed.
//
// Mirrors crm/test/smsSendRoute.test.js's own approach and stated
// reasoning: no credentials are configured for EITHER provider in this
// test file, so a request that reaches a sender deterministically hits
// that sender's own pre-existing "not configured" error -- this proves
// WHICH sender was reached (each has a distinctly-worded error) without
// mocking googleapis, @azure/msal-node, or refactoring the route for
// dependency injection, which smsSendRoute.test.js's own header comment
// already establishes as out of scope for this kind of narrowly-scoped
// routing correction. No live network call is made either way.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const savedEnv = {
  DB_PATH: process.env.DB_PATH,
  GMAIL_CLIENT_ID: process.env.GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET: process.env.GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN: process.env.GMAIL_REFRESH_TOKEN,
  MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,
  MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
  MICROSOFT_FROM: process.env.MICROSOFT_FROM,
  MICROSOFT_FROM_NAME: process.env.MICROSOFT_FROM_NAME,
};
process.env.DB_PATH = ':memory:';
for (const k of ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN',
  'MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_FROM', 'MICROSOFT_FROM_NAME']) {
  delete process.env[k];
}

const db = require('../db/database');
const { runMigrations: runBrandsMigrations } = require('../db/migrateBrands');
const emailRouter = require('../routes/email');

let server, baseUrl;

before(() => {
  runBrandsMigrations(db);
  const app = express();
  app.use(express.json());
  app.use('/api/email', emailRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/email`;
});

after(() => {
  server.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

let contactCounter = 0;
function insertContact(overrides = {}) {
  contactCounter += 1;
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, email) VALUES (@first_name, @last_name, @email)
  `).run({ first_name: 'Test', last_name: 'Contact', email: `test-contact-${contactCounter}@example.com`, ...overrides }).lastInsertRowid;
}

function linkContactToBrand(contactId, brandSlug) {
  const brandRow = db.prepare('SELECT id FROM brands WHERE slug = ?').get(brandSlug);
  db.prepare('INSERT INTO contact_brands (contact_id, brand_id) VALUES (?, ?)').run(contactId, brandRow.id);
}

async function send(contactId) {
  const res = await fetch(`${baseUrl}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, to_email: 'someone@example.com', subject: 'Hi', body: 'Body' }),
  });
  return { status: res.status, body: await res.json() };
}

function emailRowCount(contactId) {
  return db.prepare('SELECT COUNT(*) AS n FROM emails WHERE contact_id = ?').get(contactId).n;
}

test('a Prosperity contact reaches the existing Gmail path (proven by Gmail\'s own "not authorised" error) -- unchanged from before this feature', async () => {
  const cid = insertContact();
  linkContactToBrand(cid, 'prosperity');
  const { status, body } = await send(cid);
  assert.equal(status, 500);
  assert.match(body.error, /Gmail not authoris/i);
  assert.equal(emailRowCount(cid), 0);
});

test('an Insurance Lady contact reaches the Microsoft Graph path (proven by its own distinct "not configured" error), and never the Gmail path', async () => {
  const cid = insertContact({ first_name: 'Renee' });
  linkContactToBrand(cid, 'insurance-lady');
  const { status, body } = await send(cid);
  assert.equal(status, 500);
  assert.match(body.error, /Microsoft Graph/i);
  assert.match(body.error, /not configured/i);
  assert.doesNotMatch(body.error, /Gmail/i, 'an Insurance Lady contact must never surface the Gmail-specific error');
  assert.equal(emailRowCount(cid), 0);
});

test('a contact with no brand relationship at all is refused (409) -- never guessed as Prosperity, never silently sent via Gmail', async () => {
  const cid = insertContact();
  const { status, body } = await send(cid);
  assert.equal(status, 409);
  assert.match(body.error, /cannot determine/i);
  assert.equal(emailRowCount(cid), 0);
});

test('a contact linked to BOTH brands is refused (409) -- genuinely ambiguous, not a signal to guess from', async () => {
  const cid = insertContact();
  linkContactToBrand(cid, 'prosperity');
  linkContactToBrand(cid, 'insurance-lady');
  const { status, body } = await send(cid);
  assert.equal(status, 409);
  assert.match(body.error, /cannot determine/i);
  assert.equal(emailRowCount(cid), 0);
});

test('a nonexistent contact_id is also refused (409) rather than crashing -- no brand relationship rows can exist for an id that was never created', async () => {
  const { status } = await send(999999);
  assert.equal(status, 409);
});

test('a request with no contact_id at all keeps its exact prior behavior -- still reaches Gmail (no contact to resolve a brand from in the first place)', async () => {
  const res = await fetch(`${baseUrl}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to_email: 'someone@example.com', subject: 'Hi', body: 'Body' }),
  });
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.match(body.error, /Gmail not authoris/i);
});
