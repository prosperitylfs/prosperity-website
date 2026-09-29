// Tests for crm/lib/communicationDraftService.js. In-memory databases only.
// No test here ever contacts a network — the fake adapter never does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { createDraft, confirmSend, resolveSenderForContact, previewCall } = require('../lib/communicationDraftService');
const { createClient } = require('../lib/clientService');
const { createCaseForClient } = require('../lib/caseService');
const { getAdapter } = require('../lib/providers');

function setup() {
  const db = createLegacyDb();
  const { prosperityId } = runMigrations(db);
  runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db); runRevenueMvpMigrations(db);
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

// Email Consent was removed as a CRM concept entirely (2026-09-14) -- an
// email draft no longer requires it, unlike a text draft, which still
// requires SMS consent exactly as before (see the test above).
test('an email draft can be created WITHOUT email consent -- Email Consent is no longer required in this CRM', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Eli', email: 'eli@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.equal(client.contact.email_consent, 0, 'starts with no email consent on file, and that must not block the draft');
  const draft = createDraft(db, { contactId: client.contact.id, channel: 'email', subject: 'Hello', body: 'Hi' }, 'Loretta Stewart');
  assert.equal(draft.status, 'draft');
  assert.equal(draft.channel, 'email');
});

test('an email draft still requires a subject', () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Eli2', email: 'eli2@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => createDraft(db, { contactId: client.contact.id, channel: 'email', body: 'Hi' }, 'Loretta Stewart'), /subject/);
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

// ── Email channel confirmSend (2026-10-16) ───────────────────────────────
// Unlike text (which stays hard-blocked here by the fake adapter -- see the
// test above), email's confirmSend branch now genuinely sends via
// crm/lib/emailSendGateway.js's sendEmailForDraft -- the SAME
// brand-resolution + sender-dispatch primitive crm/routes/email.js's
// POST /send already uses for the plain regular Email button. These tests
// prove the Draft Email confirm-send step routes each brand to the correct
// provider and never crosses.

function fakeEmailDeps({ gmail = 'ok', msGraph = 'ok' } = {}) {
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

test('confirming a Prosperity email draft sends via the injected sendGmailEmail, and never touches Microsoft Graph', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Ivy', email: 'ivy@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const draft = createDraft(db, { contactId: client.contact.id, channel: 'email', subject: 'Hello', body: 'Hi Ivy' }, 'Loretta Stewart');
  const deps = fakeEmailDeps();

  const { draft: after, providerResult } = await confirmSend(db, draft.id, 'Loretta Stewart', deps);

  assert.equal(after.status, 'blocked', 'the draft row itself is always marked blocked -- the real outcome lives in emails/communications');
  assert.equal(providerResult.status, 'sent');
  assert.equal(providerResult.brandId, 'prosperity');
  assert.equal(deps.gmailCalls.length, 1);
  assert.equal(deps.msGraphCalls.length, 0, 'a Prosperity draft must never touch the Microsoft Graph sender');
  assert.equal(deps.gmailCalls[0].toEmail, 'ivy@example.com');
});

test('confirming an Insurance Lady email draft sends via the injected sendMsGraphEmail, and never touches Gmail', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Jade', email: 'jade@example.com', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  const draft = createDraft(db, { contactId: client.contact.id, channel: 'email', subject: 'Hello', body: 'Hi Jade' }, 'Loretta Stewart');
  const deps = fakeEmailDeps();

  const { providerResult } = await confirmSend(db, draft.id, 'Loretta Stewart', deps);

  assert.equal(providerResult.status, 'sent');
  assert.equal(providerResult.brandId, 'insurance-lady');
  assert.equal(deps.msGraphCalls.length, 1);
  assert.equal(deps.gmailCalls.length, 0, 'an Insurance Lady draft must never touch the Prosperity Gmail sender, even though the fake would have succeeded');
  assert.equal(deps.msGraphCalls[0].toEmail, 'jade@example.com');
});

test('confirming an email draft for a contact with no resolvable brand is reported as blocked, with a clear reason, and never calls either sender', async () => {
  const { db } = setup();
  // A client created via clientService with no brandSlug link at all (kept
  // deliberately outside contact_brands) -- defaultManualBrandForContact
  // returns null for this, matching every other "never guess" test in
  // this codebase.
  const contactId = db.prepare(`
    INSERT INTO contacts (first_name, last_name, email) VALUES ('No', 'Brand', 'no-brand@example.com')
  `).run().lastInsertRowid;
  const draft = createDraft(db, { contactId, channel: 'email', subject: 'Hello', body: 'Hi' }, 'Loretta Stewart');
  const deps = fakeEmailDeps();

  const { providerResult } = await confirmSend(db, draft.id, 'Loretta Stewart', deps);

  assert.equal(providerResult.status, 'blocked');
  assert.match(providerResult.message, /cannot determine/i);
  assert.equal(deps.gmailCalls.length, 0);
  assert.equal(deps.msGraphCalls.length, 0);
});

test('a Microsoft Graph failure on an Insurance Lady draft is reported as blocked with the real reason, never thrown, and never falls back to Gmail', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Kim', email: 'kim@example.com', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  const draft = createDraft(db, { contactId: client.contact.id, channel: 'email', subject: 'Hello', body: 'Hi Kim' }, 'Loretta Stewart');
  const deps = fakeEmailDeps({ msGraph: 'fail' });

  const { providerResult } = await confirmSend(db, draft.id, 'Loretta Stewart', deps);

  assert.equal(providerResult.status, 'blocked');
  assert.match(providerResult.message, /Microsoft Graph sendMail failed/);
  assert.equal(deps.gmailCalls.length, 0);
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

// ── Regression: Clifford Turner-style bug (2026-09-17) ─────────────────────
// A client added via Add Client/Add Client + Policy never gets a `cases`
// row. Before this fix, resolveSenderForContact/previewCall ignored the
// contact's own contact_brands relationship entirely whenever caseId was
// null, so a Prosperity-only (or Insurance-Lady-only) client with no case
// was wrongly treated as brand-unresolved and asked "Insurance Lady or
// Prosperity?" on the Call button, even though only one brand was ever
// associated with them.
test('a single-brand client with NO case resolves Call to that brand automatically instead of asking which business', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Clifford', lastName: 'Turner', email: 'clifford.turner@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');

  const guardrail = resolveSenderForContact(db, { contactId: client.contact.id, caseId: null });
  assert.equal(guardrail.scenario, 'resolved', 'must not fall into the ambiguous "choose a business" scenario');
  assert.equal(guardrail.brandId, 'prosperity');
  assert.equal(guardrail.channels.call.brandId, 'prosperity');

  const { guardrail: previewGuardrail } = await previewCall(db, { contactId: client.contact.id, caseId: null });
  assert.equal(previewGuardrail.scenario, 'resolved');
  assert.equal(previewGuardrail.brandId, 'prosperity');
});

test('a client with BOTH brands and no case still correctly asks which business for Call', async () => {
  const { db } = setup();
  const client = createClient(db, { firstName: 'Dual', lastName: 'Brand', email: 'dual.brand@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const insuranceLadyBrand = db.prepare("SELECT id FROM brands WHERE slug = 'insurance-lady'").get();
  db.prepare(`INSERT INTO contact_brands (contact_id, brand_id, status) VALUES (?, ?, 'Active')`).run(client.contact.id, insuranceLadyBrand.id);

  const guardrail = resolveSenderForContact(db, { contactId: client.contact.id, caseId: null });
  assert.equal(guardrail.scenario, 'no_relationship', 'a genuinely dual-brand contact must still be asked, not guessed');
});
