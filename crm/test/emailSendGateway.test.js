// Tests for crm/lib/emailSendGateway.js -- the single shared brand-
// resolution + sender-dispatch primitive for outbound email, reused by
// BOTH crm/routes/email.js's POST /send and
// crm/lib/communicationDraftService.js's confirmSend (see
// crm/test/emailSendRoute.test.js and
// crm/test/communicationDraftService.test.js for those two callers' own
// integration-level coverage). These tests exercise sendBrandRoutedEmail
// directly, at the unit level.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations: runBrandsMigrations } = require('../db/migrateBrands');
const { sendBrandRoutedEmail } = require('../lib/emailSendGateway');

function setup() {
  const db = createLegacyDb();
  runBrandsMigrations(db);
  return db;
}

function insertContact(db, overrides = {}) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, email) VALUES (@first_name, @last_name, @email)
  `).run({ first_name: 'Test', last_name: 'Contact', email: 'test@example.com', ...overrides }).lastInsertRowid;
}

function linkContactToBrand(db, contactId, brandSlug) {
  const brandRow = db.prepare('SELECT id FROM brands WHERE slug = ?').get(brandSlug);
  db.prepare('INSERT INTO contact_brands (contact_id, brand_id) VALUES (?, ?)').run(contactId, brandRow.id);
}

function fakeDeps({ gmail = 'ok', msGraph = 'ok' } = {}) {
  const gmailCalls = [];
  const msGraphCalls = [];
  return {
    gmailCalls, msGraphCalls,
    sendGmailEmail: async (db, params) => {
      gmailCalls.push(params);
      if (gmail === 'fail') throw new Error('Gmail API error');
      return { gmailMessageId: 'gmail-fake-1', threadId: null };
    },
    sendMsGraphEmail: async (db, params) => {
      msGraphCalls.push(params);
      if (msGraph === 'fail') throw new Error('Microsoft Graph sendMail failed (HTTP 500): fake failure');
      return { sentAt: new Date().toISOString() };
    },
  };
}

test('a Prosperity contact routes to the injected sendGmailEmail, and never sendMsGraphEmail', async () => {
  const db = setup();
  const cid = insertContact(db, { email: 'a@example.com' });
  linkContactToBrand(db, cid, 'prosperity');
  const deps = fakeDeps();

  const { brandId, result } = await sendBrandRoutedEmail(db, { contactId: cid, toEmail: 'a@example.com', subject: 'Hi', body: 'Body' }, deps);

  assert.equal(brandId, 'prosperity');
  assert.equal(result.gmailMessageId, 'gmail-fake-1');
  assert.equal(deps.gmailCalls.length, 1);
  assert.equal(deps.msGraphCalls.length, 0);
});

test('an Insurance Lady contact routes to the injected sendMsGraphEmail, and never sendGmailEmail', async () => {
  const db = setup();
  const cid = insertContact(db, { email: 'b@example.com' });
  linkContactToBrand(db, cid, 'insurance-lady');
  const deps = fakeDeps();

  const { brandId, result } = await sendBrandRoutedEmail(db, { contactId: cid, toEmail: 'b@example.com', subject: 'Hi', body: 'Body' }, deps);

  assert.equal(brandId, 'insurance-lady');
  assert.ok(result.sentAt);
  assert.equal(deps.msGraphCalls.length, 1);
  assert.equal(deps.gmailCalls.length, 0);
});

test('a contact with no brand relationship throws with status 409, and calls neither sender', async () => {
  const db = setup();
  const cid = insertContact(db, { email: 'c@example.com' });
  const deps = fakeDeps();

  await assert.rejects(
    () => sendBrandRoutedEmail(db, { contactId: cid, toEmail: 'c@example.com', subject: 'Hi', body: 'Body' }, deps),
    (err) => { assert.equal(err.status, 409); assert.match(err.message, /cannot determine/i); return true; }
  );
  assert.equal(deps.gmailCalls.length, 0);
  assert.equal(deps.msGraphCalls.length, 0);
});

test('a contact linked to BOTH brands throws with status 409 -- genuinely ambiguous, never guessed', async () => {
  const db = setup();
  const cid = insertContact(db, { email: 'd@example.com' });
  linkContactToBrand(db, cid, 'prosperity');
  linkContactToBrand(db, cid, 'insurance-lady');
  const deps = fakeDeps();

  await assert.rejects(
    () => sendBrandRoutedEmail(db, { contactId: cid, toEmail: 'd@example.com', subject: 'Hi', body: 'Body' }, deps),
    /cannot determine/i
  );
});

test('omitting contactId entirely defaults to Prosperity (matches the pre-existing no-contact behavior of the regular Email button)', async () => {
  const db = setup();
  const deps = fakeDeps();

  const { brandId } = await sendBrandRoutedEmail(db, { toEmail: 'no-contact@example.com', subject: 'Hi', body: 'Body' }, deps);

  assert.equal(brandId, 'prosperity');
  assert.equal(deps.gmailCalls.length, 1);
  assert.equal(deps.msGraphCalls.length, 0);
});

test('a sender failure propagates the underlying error (never swallowed, never retried against the other brand)', async () => {
  const db = setup();
  const cid = insertContact(db, { email: 'e@example.com' });
  linkContactToBrand(db, cid, 'insurance-lady');
  const deps = fakeDeps({ msGraph: 'fail' });

  await assert.rejects(
    () => sendBrandRoutedEmail(db, { contactId: cid, toEmail: 'e@example.com', subject: 'Hi', body: 'Body' }, deps),
    /Microsoft Graph sendMail failed/
  );
  assert.equal(deps.gmailCalls.length, 0, 'must never retry via Gmail after a Microsoft failure');
});
