// Tests for crm/lib/importService.js. In-memory databases only. All rows
// used are fake/invented data.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { parseCsv, runImport, getImportBatch, generateSampleCsv } = require('../lib/importService');
const { createClient } = require('../lib/clientService');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  return db;
}

const MAPPING = { firstName: 'First Name', lastName: 'Last Name', email: 'Email', phone: 'Phone', company: 'Company' };

test('parseCsv handles a quoted field containing a comma', () => {
  const { headers, records } = parseCsv('Name,Notes\n"Doe, Jane","Likes coffee, tea"\n');
  assert.deepEqual(headers, ['Name', 'Notes']);
  assert.equal(records[0].Name, 'Doe, Jane');
  assert.equal(records[0].Notes, 'Likes coffee, tea');
});

test('generateSampleCsv produces a parseable, non-empty CSV', () => {
  const csv = generateSampleCsv();
  const { headers, records } = parseCsv(csv);
  assert.ok(headers.includes('Email'));
  assert.ok(records.length >= 1);
});

test('CSV dry run writes nothing to contacts/contact_brands/cases', () => {
  const db = setup();
  const before = {
    contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
    contactBrands: db.prepare('SELECT COUNT(*) AS n FROM contact_brands').get().n,
  };
  const records = [
    { 'First Name': 'Dry', 'Last Name': 'Run', Email: 'dryrun@example.com', Phone: '4145551234', Company: 'Prosperity' },
  ];
  const { summary, batchId } = runImport(db, { records, columnMapping: MAPPING, dryRun: true, filename: 'test.csv', actor: 'Loretta Stewart' });
  assert.equal(summary.would_create, 1);
  const after = {
    contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
    contactBrands: db.prepare('SELECT COUNT(*) AS n FROM contact_brands').get().n,
  };
  assert.deepEqual(after, before, 'dry run must never write to contacts/contact_brands');
  // The audit record IS preserved even though no client data changed.
  const batch = getImportBatch(db, batchId);
  assert.equal(batch.batch.status, 'dry_run');
  assert.equal(batch.rows.length, 1);
  assert.equal(JSON.parse(batch.rows[0].raw_row).Email, 'dryrun@example.com');
});

test('CSV import detects a likely duplicate by normalized email', () => {
  const db = setup();
  createClient(db, { firstName: 'Existing', lastName: 'Client', email: 'Match@Example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const records = [{ 'First Name': 'Existing', 'Last Name': 'Client', Email: 'match@example.com', Company: 'Prosperity' }];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.likely_duplicate, 1);
});

test('CSV import detects a likely duplicate by normalized phone', () => {
  const db = setup();
  createClient(db, { firstName: 'Phone', lastName: 'Match', phone: '4145559999', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const records = [{ 'First Name': 'Phone', 'Last Name': 'Match', Phone: '(414) 555-9999', Company: 'Prosperity' }];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.likely_duplicate, 1);
});

test('CSV import never silently overwrites an existing client (default decision is skip)', () => {
  const db = setup();
  const original = createClient(db, { firstName: 'Original', lastName: 'Name', email: 'skiptest@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const records = [{ 'First Name': 'Overwritten', 'Last Name': 'Name', Email: 'skiptest@example.com', Company: 'Prosperity' }];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  assert.equal(summary.skipped, 1);
  const stillOriginal = db.prepare('SELECT * FROM contacts WHERE id = ?').get(original.contact.id);
  assert.equal(stillOriginal.first_name, 'Original');
});

test('CSV import applies an explicit "update" decision for a duplicate row', () => {
  const db = setup();
  const original = createClient(db, { firstName: 'Original2', email: 'updatetest@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const records = [{ 'First Name': 'Updated2', Email: 'updatetest@example.com', Company: 'Prosperity' }];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: false, duplicateDecisions: { '1': 'update' }, actor: 'Loretta Stewart' });
  assert.equal(summary.updated, 1);
  const updated = db.prepare('SELECT * FROM contacts WHERE id = ?').get(original.contact.id);
  assert.equal(updated.first_name, 'Updated2');
});

test('committing creates real clients under the batch company, one contact_brand each', () => {
  const db = setup();
  const records = [
    { 'First Name': 'New1', Email: 'new1@example.com', Company: 'Prosperity' },
    { 'First Name': 'New2', Email: 'new2@example.com', Company: 'Insurance Lady' },
  ];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  assert.equal(summary.created, 2);
  const c1 = db.prepare('SELECT * FROM contacts WHERE email = ?').get('new1@example.com');
  const c2 = db.prepare('SELECT * FROM contacts WHERE email = ?').get('new2@example.com');
  const l1 = db.prepare('SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.contact_id = ?').get(c1.id);
  const l2 = db.prepare('SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.contact_id = ?').get(c2.id);
  assert.equal(l1.slug, 'prosperity');
  assert.equal(l2.slug, 'insurance-lady');
});

test('a row with no batch company and no valid company column value is rejected, never inferred from product', () => {
  const db = setup();
  const records = [{ 'First Name': 'NoCo', Email: 'noco2@example.com' }]; // no Company column value
  const { summary, results } = runImport(db, { records, columnMapping: MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.invalid, 1);
  assert.match(results[0].detail, /company/);
});

test('invalid rows (bad email/phone/date) are never silently accepted', () => {
  const db = setup();
  const records = [
    { 'First Name': 'BadEmail', Email: 'not-an-email', Company: 'Prosperity' },
    { 'First Name': 'BadPhone', Phone: '123', Company: 'Prosperity' },
  ];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.invalid, 2);
});

test('import preserves the original imported row exactly, even for a failed row', () => {
  const db = setup();
  const records = [{ 'First Name': 'Original Row', Email: 'bad', Company: 'Prosperity' }];
  const { batchId } = runImport(db, { records, columnMapping: MAPPING, dryRun: false, filename: 'orig.csv', actor: 'Loretta Stewart' });
  const batch = getImportBatch(db, batchId);
  assert.equal(JSON.parse(batch.rows[0].raw_row)['First Name'], 'Original Row');
  assert.equal(batch.rows[0].outcome, 'failed');
});
