// Tests for the Occidental-import client-classification correction: an
// existing-policyholder CSV import must never be classified or counted as
// a 'New Lead'. In-memory dbs only, all data fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { runImport } = require('../lib/importService');
const { getDashboardSummary } = require('../lib/dashboardQueries');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  runRevenueMvpMigrations(db); // adds sms_messages.failure_reason, among others
  return db;
}

const OCCIDENTAL_MAPPING = {
  firstName: 'First Name', lastName: 'Last Name', phone: 'Phone', email: 'Email', company: 'Company',
  productName: 'Product', carrier: 'Carrier', policyNumber: 'Policy Number', effectiveDate: 'Effective Date', premium: 'Premium',
};
const PLAIN_MAPPING = { firstName: 'First Name', lastName: 'Last Name', email: 'Email', phone: 'Phone', company: 'Company' };

function newLeadCount(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE lead_status = 'New Lead'`).get().n;
}

test('1. an Occidental import does not create a New Lead classification', () => {
  const db = setup();
  const records = [{ 'First Name': 'Harold', 'Last Name': 'Voss', Phone: '414-555-2201', Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'OCC-40021' }];
  runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  const contact = db.prepare(`SELECT * FROM contacts WHERE phone_e164 = '+14145552201'`).get();
  assert.ok(contact);
  assert.notEqual(contact.lead_status, 'New Lead');
  assert.equal(contact.lead_status, 'Existing Client');
});

test('2. an Occidental import does not increase the Dashboard New Leads count (either counting method)', () => {
  const db = setup();
  const beforeStatsCount = newLeadCount(db);
  const beforeAppSummary = getDashboardSummary(db, { brandId: null }).newLeads;

  const records = [
    { 'First Name': 'Ines', 'Last Name': 'Calloway', Phone: '414-555-2202', Company: 'Prosperity', Product: 'Annuities', Carrier: 'Occidental Life', 'Policy Number': 'OCC-40022' },
    { 'First Name': 'Deshawn', 'Last Name': 'Priest', Phone: '414-555-2203', Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'OCC-40023' },
  ];
  runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart' });

  assert.equal(newLeadCount(db), beforeStatsCount, 'the stats.js-style New Leads count (lead_status) must not increase');
  assert.equal(getDashboardSummary(db, { brandId: null }).newLeads, beforeAppSummary, 'the /app Dashboard New Leads count (unresolved_intake brand-review queue) must not increase');
});

test('3. the imported person is recognized as an active existing client/policyholder', () => {
  const db = setup();
  const records = [{ 'First Name': 'Marjorie', 'Last Name': 'Nunn', Phone: '414-555-2204', Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life' }];
  runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  const contact = db.prepare(`SELECT * FROM contacts WHERE phone_e164 = '+14145552204'`).get();
  assert.equal(contact.lead_status, 'Existing Client');
  const link = db.prepare(`SELECT * FROM contact_brands WHERE contact_id = ?`).get(contact.id);
  assert.equal(link.status, 'Active');
});

test('4. the policy, case, and Prosperity company assignment remain intact', () => {
  const db = setup();
  const records = [{ 'First Name': 'Tobias', 'Last Name': 'Estrada', Phone: '414-555-2205', Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'OCC-40025', Premium: '42.00' }];
  runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  const contact = db.prepare(`SELECT * FROM contacts WHERE phone_e164 = '+14145552205'`).get();
  const link = db.prepare(`SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.contact_id = ?`).get(contact.id);
  assert.equal(link.slug, 'prosperity');
  const kase = db.prepare(`SELECT c.* FROM cases c JOIN contact_brands cb ON cb.id = c.contact_brand_id WHERE cb.contact_id = ?`).get(contact.id);
  assert.ok(kase);
  const policy = db.prepare('SELECT * FROM policies WHERE case_id = ?').get(kase.id);
  assert.equal(policy.carrier, 'Occidental Life');
  assert.equal(policy.policy_number, 'OCC-40025');
  assert.equal(policy.premium, 42);
  // Classification correction must never affect this row's classification twice removed.
  assert.equal(contact.lead_status, 'Existing Client');
});

test('5. re-importing a duplicate never creates another person, case, or policy (exact policy already on file is skipped)', () => {
  const db = setup();
  const records = [{ 'First Name': 'Yolanda', 'Last Name': 'Pike', Phone: '414-555-2206', Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'OCC-40026' }];
  const first = runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, filename: 'first.csv', actor: 'Loretta Stewart' });
  assert.equal(first.summary.created, 1);
  const contactCountAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const caseCountAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM cases').get().n;
  const policyCountAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM policies').get().n;

  // Re-import the exact same row -- same carrier + policy number already on
  // file for this client, so the policy-level dedup check skips it (never
  // the whole client, and never a blanket "any duplicate contact = skip").
  const second = runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, filename: 'second.csv', actor: 'Loretta Stewart' });
  assert.equal(second.summary.skipped_existing_policy, 1);
  assert.equal(second.summary.created, 0);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, contactCountAfterFirst);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, caseCountAfterFirst);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies').get().n, policyCountAfterFirst);
});

test('an ordinary plain CSV import (no policy columns) is unaffected -- still classified New Lead', () => {
  const db = setup();
  const records = [{ 'First Name': 'Ordinary', 'Last Name': 'Lead', Phone: '414-555-2299', Company: 'Prosperity' }];
  runImport(db, { records, columnMapping: PLAIN_MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  const contact = db.prepare(`SELECT * FROM contacts WHERE phone_e164 = '+14145552299'`).get();
  assert.equal(contact.lead_status, 'New Lead');
});

test('dry-run preview for an Occidental row describes it as an Existing Client, and still writes nothing', () => {
  const db = setup();
  const before = newLeadCount(db);
  const records = [{ 'First Name': 'Corinne', 'Last Name': 'Vance', Phone: '414-555-2207', Company: 'Prosperity', Product: 'Annuities', Carrier: 'Occidental Life' }];
  const { results } = runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.match(results[0].detail, /Existing Client/);
  const contactCount = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  assert.equal(contactCount, 0, 'dry run must still write nothing to contacts');
  assert.equal(newLeadCount(db), before);
});
