// Tests for the MM/DD/YY(YY) date normalization, the more robust per-row
// Company/brand matching, and the missing-email/phone/both diagnostic
// counts added to crm/lib/importService.js in response to the real
// Occidental CSV's date format and Company-column issues. In-memory dbs
// only, all data fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runImport, normalizeDateField, resolveRowBrandSlug } = require('../lib/importService');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  return db;
}

const MAPPING = {
  firstName: 'First Name', lastName: 'Last Name', phone: 'Phone', email: 'Email', company: 'Company',
  dateOfBirth: 'DOB', productName: 'Product', carrier: 'Carrier', policyNumber: 'Policy Number',
  effectiveDate: 'Effective Date', applicationDate: 'App Date',
};

// ── Date normalization ──────────────────────────────────────────────────────

test('normalizeDateField: YYYY-MM-DD passes through unchanged', () => {
  assert.equal(normalizeDateField('2020-01-15'), '2020-01-15');
});

test('normalizeDateField: MM/DD/YYYY normalizes to YYYY-MM-DD', () => {
  assert.equal(normalizeDateField('11/03/2024'), '2024-11-03');
  assert.equal(normalizeDateField('2/5/2019'), '2019-02-05');
});

test('normalizeDateField: two-digit year 50 (Date of Birth style) resolves to 1950, not 2050', () => {
  assert.equal(normalizeDateField('02/26/50'), '1950-02-26');
});

test('normalizeDateField: two-digit year 24 (recent Policy Date style) resolves to 2024, not 1924', () => {
  assert.equal(normalizeDateField('11/03/24'), '2024-11-03');
});

test('normalizeDateField: pivot boundary — 29 resolves to 2029, 30 resolves to 1930', () => {
  assert.equal(normalizeDateField('01/01/29'), '2029-01-01');
  assert.equal(normalizeDateField('01/01/30'), '1930-01-01');
});

test('normalizeDateField: empty value stays empty', () => {
  assert.equal(normalizeDateField(''), '');
  assert.equal(normalizeDateField(null), '');
});

test('normalizeDateField: a calendar-impossible date is left unchanged so validation still rejects it', () => {
  assert.equal(normalizeDateField('02/30/2020'), '02/30/2020');
  assert.equal(normalizeDateField('13/01/2020'), '13/01/2020');
});

test('normalizeDateField: unrecognized text is left unchanged rather than guessed at', () => {
  assert.equal(normalizeDateField('not a date'), 'not a date');
});

test('end-to-end: a row with MM/DD/YY dates for DOB and Application Date, and MM/DD/YYYY for Effective Date, imports correctly', () => {
  const db = setup();
  const records = [{
    'First Name': 'Harold', 'Last Name': 'Voss', Phone: '414-555-4001', Company: 'Prosperity',
    DOB: '02/26/50', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'DATE-1',
    'Effective Date': '01/15/2020', 'App Date': '12/20/19',
  }];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  assert.equal(summary.created, 1);
  const contact = db.prepare(`SELECT * FROM contacts WHERE phone_e164 = '+14145554001'`).get();
  assert.equal(contact.date_of_birth, '1950-02-26');
  const policy = db.prepare('SELECT * FROM policies WHERE policy_number = ?').get('DATE-1');
  assert.equal(policy.effective_date, '2020-01-15');
  assert.equal(policy.application_date, '2019-12-20');
});

// ── Robust, diagnosable Company/brand matching ──────────────────────────────

test('resolveRowBrandSlug recognizes the real legal name, not just the short name', () => {
  const row = { Company: 'Prosperity Life & Financial Solutions LLC' };
  assert.equal(resolveRowBrandSlug(row, { company: 'Company' }, null), 'prosperity');
});

test('resolveRowBrandSlug tolerates extra whitespace and a trailing period', () => {
  const row = { Company: '  Prosperity.  ' };
  assert.equal(resolveRowBrandSlug(row, { company: 'Company' }, null), 'prosperity');
});

test('resolveRowBrandSlug still returns null for a genuinely unrecognized value (e.g. a carrier name typed into the Company column)', () => {
  const row = { Company: 'Occidental Life' };
  assert.equal(resolveRowBrandSlug(row, { company: 'Company' }, null), null);
});

test('an unrecognized per-row Company value produces an error that names the actual value, not a generic message', () => {
  const db = setup();
  const records = [{ 'First Name': 'Bad', 'Last Name': 'Company', Phone: '414-555-4002', Company: 'Occidental Life' }];
  const { summary, results } = runImport(db, { records, columnMapping: MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.invalid, 1);
  assert.match(results[0].detail, /company value "Occidental Life" was not recognized/);
});

test('a per-row Company column with the correct value works exactly as before', () => {
  const db = setup();
  const records = [{ 'First Name': 'Good', 'Last Name': 'Company', Phone: '414-555-4003', Company: 'Prosperity Life & Financial Solutions LLC' }];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  assert.equal(summary.created, 1);
  const contact = db.prepare(`SELECT * FROM contacts WHERE phone_e164 = '+14145554003'`).get();
  const link = db.prepare(`SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.contact_id = ?`).get(contact.id);
  assert.equal(link.slug, 'prosperity');
});

// ── Missing email/phone/both counts ─────────────────────────────────────────

test('rows_missing_email / rows_missing_phone / rows_missing_both are counted correctly and independently of validity', () => {
  const db = setup();
  const records = [
    { 'First Name': 'Has', 'Last Name': 'Both', Phone: '414-555-4010', Email: 'both@example.com', Company: 'Prosperity' },
    { 'First Name': 'No', 'Last Name': 'Email', Phone: '414-555-4011', Company: 'Prosperity' },
    { 'First Name': 'No', 'Last Name': 'Phone', Email: 'nophone@example.com', Company: 'Prosperity' },
    { 'First Name': 'No', 'Last Name': 'Either', Company: 'Prosperity' }, // also invalid -- must still be counted
  ];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.rows_missing_email, 2, 'the no-email row and the no-either row');
  assert.equal(summary.rows_missing_phone, 2, 'the no-phone row and the no-either row');
  assert.equal(summary.rows_missing_both, 1, 'only the no-either row');
  assert.equal(summary.invalid, 1, 'only the row with neither email nor phone is actually invalid');
});

test('the "email or phone is required" rule is unchanged -- a row with neither is still rejected, never silently imported', () => {
  const db = setup();
  const records = [{ 'First Name': 'No', 'Last Name': 'Contact', Company: 'Prosperity' }];
  const { summary, results } = runImport(db, { records, columnMapping: MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.invalid, 1);
  assert.match(results[0].detail, /email or phone is required/);
});

// ── Dry run still writes nothing, even with the new date/company logic ─────

test('a dry run with MM/DD/YY dates and a legal-name Company value writes nothing', () => {
  const db = setup();
  const records = [{
    'First Name': 'Dry', 'Last Name': 'Run', Phone: '414-555-4020', Company: 'Prosperity Life & Financial Solutions LLC',
    DOB: '02/26/50', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'DRY-1',
    'Effective Date': '01/15/20',
  }];
  const before = {
    contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
    cases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n,
    policies: db.prepare('SELECT COUNT(*) AS n FROM policies').get().n,
  };
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.would_create, 1);
  const after = {
    contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n,
    cases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n,
    policies: db.prepare('SELECT COUNT(*) AS n FROM policies').get().n,
  };
  assert.deepEqual(after, before);
});

// ── Regression: multiple policies for one client, no duplicate contacts,
//    still correct with real-world-shaped dates and Company values ────────

test('regression: three policies for the same client (MM/DD/YY dates, legal-name Company) still produce one contact and three cases', () => {
  const db = setup();
  const records = [
    { 'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-4030', Company: 'Prosperity Life & Financial Solutions LLC', DOB: '03/02/50', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'ABC123', 'Effective Date': '01/15/20' },
    { 'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-4030', Company: 'Prosperity Life & Financial Solutions LLC', DOB: '03/02/50', Product: 'Annuities', Carrier: 'Occidental Life', 'Policy Number': 'XYZ456', 'Effective Date': '06/01/21' },
    { 'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-4030', Company: 'Prosperity Life & Financial Solutions LLC', DOB: '03/02/50', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'LMN789', 'Effective Date': '09/10/16' },
  ];
  const { summary } = runImport(db, { records, columnMapping: MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  assert.equal(summary.created, 1);
  assert.equal(summary.attached_policy, 2);
  const contacts = db.prepare(`SELECT * FROM contacts WHERE phone_e164 = '+14145554030'`).all();
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].date_of_birth, '1950-03-02');
  const cases = db.prepare(`SELECT COUNT(*) AS n FROM cases c JOIN contact_brands cb ON cb.id = c.contact_brand_id WHERE cb.contact_id = ?`).get(contacts[0].id);
  assert.equal(cases.n, 3);
});
