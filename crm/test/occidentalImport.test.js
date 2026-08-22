// Tests for the Occidental-client policy-field extension to
// crm/lib/importService.js (Prosperity Revenue MVP, Requirement 1). A new
// file rather than editing crm/test/importService.test.js, which already
// covers the base import behavior this only adds to. In-memory dbs only,
// all data fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runImport, generateClientPolicySampleCsv, parseCsv } = require('../lib/importService');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  return db;
}

const OCCIDENTAL_MAPPING = {
  firstName: 'First Name', lastName: 'Last Name', phone: 'Phone', email: 'Email',
  address: 'Address', city: 'City', state: 'State', zip: 'Zip', company: 'Company',
  productName: 'Product', carrier: 'Carrier', policyNumber: 'Policy Number',
  effectiveDate: 'Effective Date', premium: 'Premium', generalNotes: 'Notes', originalSource: 'Original Source',
};

test('generateClientPolicySampleCsv produces a parseable CSV with every policy field', () => {
  const csv = generateClientPolicySampleCsv();
  const { headers, records } = parseCsv(csv);
  for (const col of ['Product', 'Carrier', 'Policy Number', 'Effective Date', 'Premium']) {
    assert.ok(headers.includes(col), `missing column ${col}`);
  }
  assert.ok(records.length >= 1);
});

test('committing an Occidental row creates the client, assigns Prosperity explicitly, and attaches a case + policy', () => {
  const db = setup();
  const records = [{
    'First Name': 'Harold', 'Last Name': 'Voss', Phone: '414-555-2201', Email: 'harold.voss@example-mail.com',
    Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'OCC-40021',
    'Effective Date': '2019-06-01', Premium: '54.00', Notes: 'Existing whole life policy',
  }];
  const { summary, results } = runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  assert.equal(summary.created, 1);
  const contact = db.prepare(`SELECT * FROM contacts WHERE email = 'harold.voss@example-mail.com'`).get();
  assert.ok(contact);
  const link = db.prepare(`SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.contact_id = ?`).get(contact.id);
  assert.equal(link.slug, 'prosperity');
  const kase = db.prepare(`SELECT c.* FROM cases c JOIN contact_brands cb ON cb.id = c.contact_brand_id WHERE cb.contact_id = ?`).get(contact.id);
  assert.ok(kase, 'a case must be attached when policy data is present');
  const policy = db.prepare('SELECT * FROM policies WHERE case_id = ?').get(kase.id);
  assert.equal(policy.carrier, 'Occidental Life');
  assert.equal(policy.policy_number, 'OCC-40021');
  assert.equal(policy.effective_date, '2019-06-01');
  assert.equal(policy.premium, 54);
  assert.match(results[0].detail, /case \+ policy|new case/);
});

test('company is still never inferred from product for Occidental rows -- a row with no company column and no batch company is rejected', () => {
  const db = setup();
  const records = [{
    'First Name': 'Ines', 'Last Name': 'Calloway', Phone: '414-555-2202', Product: 'Annuities', Carrier: 'Occidental Life',
  }];
  const { summary, results } = runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.invalid, 1);
  assert.match(results[0].detail, /company/);
});

test('a dry run with policy fields present writes no case or policy rows', () => {
  const db = setup();
  const records = [{
    'First Name': 'Deshawn', 'Last Name': 'Priest', Phone: '414-555-2203', Company: 'Prosperity',
    Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'OCC-40023', Premium: '88.50',
  }];
  const before = { cases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, policies: db.prepare('SELECT COUNT(*) AS n FROM policies').get().n };
  runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  const after = { cases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, policies: db.prepare('SELECT COUNT(*) AS n FROM policies').get().n };
  assert.deepEqual(after, before);
});

test('an invalid premium value is rejected rather than silently coerced', () => {
  const db = setup();
  const records = [{ 'First Name': 'Bad', 'Last Name': 'Premium', Phone: '414-555-2299', Company: 'Prosperity', Premium: 'not-a-number' }];
  const { summary, results } = runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.invalid, 1);
  assert.match(results[0].detail, /premium/);
});

test('the original imported row (including policy fields) is preserved exactly in the import audit record', () => {
  const db = setup();
  const records = [{
    'First Name': 'Preserve', 'Last Name': 'Me', Phone: '414-555-2300', Company: 'Prosperity',
    Product: 'Life insurance', 'Policy Number': 'OCC-99999',
  }];
  const { batchId } = runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, filename: 'occidental.csv', actor: 'Loretta Stewart' });
  const row = db.prepare('SELECT raw_row FROM import_rows WHERE batch_id = ?').get(batchId);
  const raw = JSON.parse(row.raw_row);
  assert.equal(raw['Policy Number'], 'OCC-99999');
  assert.equal(raw['First Name'], 'Preserve');
});
