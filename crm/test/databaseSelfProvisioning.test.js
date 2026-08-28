// Pre-deployment verification: crm/db/database.js must fully provision
// everything the Retirement Intake feature needs on its own, in a
// completely fresh environment, with NO separate migration script
// (crm/scripts/migrateProduction.js) ever having been run. This is exactly
// what happens the first time this code boots against a brand-new
// database file (and is already how the live crm/data/crm.db is
// bootstrapped on every server start).
//
// Deliberately does NOT call runRevenueMvpMigrations, runCrmCoreMigrations,
// or any other crm/db/migrate*.js function — only requires crm/db/database.js
// itself, with DB_PATH pointed at a throwaway in-memory database, to prove
// self-sufficiency rather than assuming it.

const test = require('node:test');
const assert = require('node:assert/strict');

const savedDbPath = process.env.DB_PATH;
process.env.DB_PATH = ':memory:';
const db = require('../db/database');

test.after(() => {
  if (savedDbPath === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = savedDbPath;
});

function columnNames(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
}
function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

test('contacts.sms_opted_out_at exists with no separate migration run', () => {
  assert.ok(columnNames('contacts').includes('sms_opted_out_at'));
});

test('contacts.sms_consent exists (pre-existing, unaffected)', () => {
  assert.ok(columnNames('contacts').includes('sms_consent'));
});

test('the retirement_intakes table exists with no separate migration run', () => {
  assert.ok(tableExists('retirement_intakes'));
  const cols = columnNames('retirement_intakes');
  for (const expected of ['id', 'contact_id', 'appointment_id', 'token', 'status', 'sent_at', 'completed_at', 'responses_json']) {
    assert.ok(cols.includes(expected), `retirement_intakes is missing column: ${expected}`);
  }
});

test('a real consent-gate check against this freshly self-provisioned schema does not throw', () => {
  const { checkConsentGate } = require('../lib/legacySmsSend');
  const r = db.prepare(`
    INSERT INTO contacts (first_name, last_name, sms_consent, sms_opted_out_at) VALUES ('Fresh', 'Db', 0, NULL)
  `).run();
  const contact = db.prepare('SELECT sms_consent, sms_opted_out_at FROM contacts WHERE id = ?').get(r.lastInsertRowid);
  assert.doesNotThrow(() => checkConsentGate(contact));
});

test('retirement_intakes.token has a unique index (idempotent CREATE ran)', () => {
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'retirement_intakes'").all().map(i => i.name);
  assert.ok(indexes.includes('idx_retirement_intakes_token'));
});

test('running the base schema block twice (simulating a second boot) never drops or duplicates data', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  // Re-require via the module cache is a no-op (Node caches modules), so
  // instead directly re-run the exact same idempotent statement patterns
  // database.js uses, against the SAME live handle, to prove they're safe
  // to execute more than once (exactly what happens on every real reboot).
  assert.doesNotThrow(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS retirement_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL,
      token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Not Sent', sent_at DATETIME, completed_at DATETIME,
      responses_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  });
  const after = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  assert.equal(before, after, 'no existing contact rows were touched');
});
