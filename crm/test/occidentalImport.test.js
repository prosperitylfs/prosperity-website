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

// ── Two-level dedup: one contact, multiple policies ─────────────────────────

test('a client with three distinct policies in one CSV batch gets one contact and three separate cases + policies', () => {
  const db = setup();
  const records = [
    { 'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-3001', Email: 'mary.smith@example-mail.com', Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'ABC123' },
    { 'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-3001', Email: 'mary.smith@example-mail.com', Company: 'Prosperity', Product: 'Annuities', Carrier: 'Occidental Life', 'Policy Number': 'XYZ456' },
    { 'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-3001', Email: 'mary.smith@example-mail.com', Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'LMN789' },
  ];
  const { summary } = runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  assert.equal(summary.created, 1, 'only the first row creates a contact');
  assert.equal(summary.attached_policy, 2, 'the other two rows attach to the same existing contact');

  const contacts = db.prepare(`SELECT * FROM contacts WHERE email = 'mary.smith@example-mail.com'`).all();
  assert.equal(contacts.length, 1, 'exactly one contact, never a duplicate');

  const cases = db.prepare(`
    SELECT c.* FROM cases c JOIN contact_brands cb ON cb.id = c.contact_brand_id WHERE cb.contact_id = ?
  `).all(contacts[0].id);
  assert.equal(cases.length, 3, 'one case per policy, never shared');

  const policies = db.prepare(`
    SELECT p.policy_number FROM policies p
    JOIN cases c ON c.id = p.case_id JOIN contact_brands cb ON cb.id = c.contact_brand_id
    WHERE cb.contact_id = ? ORDER BY p.policy_number
  `).all(contacts[0].id);
  assert.deepEqual(policies.map(p => p.policy_number), ['ABC123', 'LMN789', 'XYZ456']);
});

test('a contact that already existed before this import receives a new policy without creating a second contact', () => {
  const db = setup();
  const preExisting = db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, phone, phone_e164, lead_status)
    VALUES ('Mary', 'Smith', 'mary.smith@example-mail.com', '414-555-3001', '+14145553001', 'New Lead')
  `).run();

  const records = [{
    'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-3001', Email: 'mary.smith@example-mail.com',
    Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'ABC123',
  }];
  const { summary, results } = runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart' });

  assert.equal(summary.created, 0);
  assert.equal(summary.attached_policy, 1);
  assert.equal(results[0].outcome, 'attached_policy');
  assert.equal(results[0].contactId, preExisting.lastInsertRowid);

  const allContacts = db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE email = 'mary.smith@example-mail.com'`).get();
  assert.equal(allContacts.n, 1, 'never a second contact for the same person');

  const policy = db.prepare(`
    SELECT p.* FROM policies p JOIN cases c ON c.id = p.case_id JOIN contact_brands cb ON cb.id = c.contact_brand_id
    WHERE cb.contact_id = ?
  `).get(preExisting.lastInsertRowid);
  assert.equal(policy.policy_number, 'ABC123');
});

test('the exact same Carrier + Policy Number already on file is skipped, not duplicated', () => {
  const db = setup();
  const first = [{
    'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-3001', Email: 'mary.smith@example-mail.com',
    Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'ABC123',
  }];
  runImport(db, { records: first, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart' });

  const before = { contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, cases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, policies: db.prepare('SELECT COUNT(*) AS n FROM policies').get().n };

  // Same person, same carrier, same policy number -- re-imported (e.g. the
  // same CSV run twice, or ABC123 appears again in a later file).
  const repeat = [{
    'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-3001', Email: 'mary.smith@example-mail.com',
    Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'ABC123',
  }];
  const { summary, results } = runImport(db, { records: repeat, columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart' });
  assert.equal(summary.skipped_existing_policy, 1);
  assert.match(results[0].detail, /Existing Policy — Skip/);

  const after = { contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, cases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, policies: db.prepare('SELECT COUNT(*) AS n FROM policies').get().n };
  assert.deepEqual(after, before, 'no new contact, case, or policy row from the exact-duplicate policy');
});

test('a dry run for an existing contact with a new policy, and for an already-existing policy, both write nothing', () => {
  const db = setup();
  runImport(db, {
    records: [{ 'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-3001', Email: 'mary.smith@example-mail.com', Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'ABC123' }],
    columnMapping: OCCIDENTAL_MAPPING, dryRun: false, actor: 'Loretta Stewart',
  });
  const before = { contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, cases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, policies: db.prepare('SELECT COUNT(*) AS n FROM policies').get().n };

  const dryRunRecords = [
    { 'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-3001', Email: 'mary.smith@example-mail.com', Company: 'Prosperity', Product: 'Annuities', Carrier: 'Occidental Life', 'Policy Number': 'XYZ456' },
    { 'First Name': 'Mary', 'Last Name': 'Smith', Phone: '414-555-3001', Email: 'mary.smith@example-mail.com', Company: 'Prosperity', Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'ABC123' },
  ];
  const { summary } = runImport(db, { records: dryRunRecords, columnMapping: OCCIDENTAL_MAPPING, dryRun: true, actor: 'Loretta Stewart' });
  assert.equal(summary.would_attach_policy, 1);
  assert.equal(summary.would_skip_existing_policy, 1);

  const after = { contacts: db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, cases: db.prepare('SELECT COUNT(*) AS n FROM cases').get().n, policies: db.prepare('SELECT COUNT(*) AS n FROM policies').get().n };
  assert.deepEqual(after, before, 'dry run must never write, even down the new attach/skip-existing-policy paths');
});

// ── Face amount, application date, middle name, batch carrier ──────────────

test('face amount maps to policies.coverage_amount, not premium', () => {
  const db = setup();
  const mapping = { ...OCCIDENTAL_MAPPING, faceAmount: 'Face' };
  const records = [{
    'First Name': 'Fay', 'Last Name': 'Cevalue', Phone: '414-555-3100', Company: 'Prosperity',
    Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'FACE-1', Premium: '54.00', Face: '50000',
  }];
  runImport(db, { records, columnMapping: mapping, dryRun: false, actor: 'Loretta Stewart' });
  const policy = db.prepare('SELECT * FROM policies WHERE policy_number = ?').get('FACE-1');
  assert.equal(policy.coverage_amount, 50000);
  assert.equal(policy.premium, 54);
});

test('application date is stored on the policy, distinct from effective date', () => {
  const db = setup();
  const mapping = { ...OCCIDENTAL_MAPPING, applicationDate: 'App Date' };
  const records = [{
    'First Name': 'Ann', 'Last Name': 'Datestamp', Phone: '414-555-3101', Company: 'Prosperity',
    Product: 'Life insurance', Carrier: 'Occidental Life', 'Policy Number': 'APPD-1',
    'Effective Date': '2020-01-01', 'App Date': '2019-12-15',
  }];
  runImport(db, { records, columnMapping: mapping, dryRun: false, actor: 'Loretta Stewart' });
  const policy = db.prepare('SELECT * FROM policies WHERE policy_number = ?').get('APPD-1');
  assert.equal(policy.application_date, '2019-12-15');
  assert.equal(policy.effective_date, '2020-01-01');
});

test('middle name is stored on the contact', () => {
  const db = setup();
  const mapping = { ...OCCIDENTAL_MAPPING, middleName: 'MI' };
  const records = [{
    'First Name': 'Em', 'Last Name': 'Middleton', MI: 'Q', Phone: '414-555-3102', Company: 'Prosperity',
  }];
  runImport(db, { records, columnMapping: mapping, dryRun: false, actor: 'Loretta Stewart' });
  const contact = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get('+14145553102');
  assert.ok(contact, 'contact should exist');
  assert.equal(contact.middle_name, 'Q');
});

test('a batch-level carrier is used when the CSV has no per-row Carrier column', () => {
  const db = setup();
  const mappingNoCarrierColumn = {
    firstName: 'First Name', lastName: 'Last Name', phone: 'Phone', company: 'Company',
    productName: 'Product', policyNumber: 'Policy Number',
  };
  const records = [{
    'First Name': 'Bea', 'Last Name': 'Carrierless', Phone: '414-555-3103', Company: 'Prosperity',
    Product: 'Life insurance', 'Policy Number': 'BATCH-1',
  }];
  runImport(db, { records, columnMapping: mappingNoCarrierColumn, carrierSlug: 'Occidental Life', dryRun: false, actor: 'Loretta Stewart' });
  const policy = db.prepare('SELECT * FROM policies WHERE policy_number = ?').get('BATCH-1');
  assert.equal(policy.carrier, 'Occidental Life');
});

test('a per-row Carrier column wins over the batch carrier when both are present', () => {
  const db = setup();
  const records = [{
    'First Name': 'Rowena', 'Last Name': 'Wins', Phone: '414-555-3104', Company: 'Prosperity',
    Product: 'Life insurance', Carrier: 'Mutual of Omaha', 'Policy Number': 'ROW-1',
  }];
  runImport(db, { records, columnMapping: OCCIDENTAL_MAPPING, carrierSlug: 'Occidental Life', dryRun: false, actor: 'Loretta Stewart' });
  const policy = db.prepare('SELECT * FROM policies WHERE policy_number = ?').get('ROW-1');
  assert.equal(policy.carrier, 'Mutual of Omaha');
});
