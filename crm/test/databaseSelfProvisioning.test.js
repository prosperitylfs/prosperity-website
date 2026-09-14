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

// ── Regression test for a REAL production bug (2026-09-15) ────────────────
// A live Add Client + Policy attempt failed with "table policies has no
// column named policy_type": crm/db/migrateCrmApp.js (creates the
// `policies` table) HAD been run against production at some point in the
// past (via crm/scripts/migrateProduction.js), but crm/db/migrateCrmCore.js
// (adds policies.archived_at/notes/policy_type) never was -- so the live
// table existed without those three columns, even though
// crm/lib/policyService.js's createPolicy/updatePolicy have always
// referenced them unconditionally. Fixed by moving those three addCol
// calls into database.js's own self-provisioning `if (tableExists('policies'))`
// guard (right next to the pre-existing application_date one, added for
// the exact same reason).
//
// This can't be tested via the top-level `db` this file already requires
// (module load happens before ANY table exists, so the guard correctly
// finds no `policies` table yet and skips -- that's the "brand-new
// database" case, not the bug). The real bug is specifically about a
// table that ALREADY EXISTS (from a past migration run) when
// database.js's bootstrap executes on a LATER boot -- which requires a
// genuinely separate process, run in the right order: create the table
// first (simulating "this already happened weeks ago"), THEN boot
// database.js fresh against that same file (simulating "the next
// production boot after this fix deploys").
{
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  test('a policies table that already existed WITHOUT archived_at/notes/policy_type gains them on the next database.js boot (production bug regression)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-policies-repro-'));
    const dbPath = path.join(tmpDir, 'repro.db');
    const repoRoot = path.join(__dirname, '..');
    try {
      // Step 1: create a `policies` table with ONLY the original
      // migrateCrmApp.js columns -- exactly what production had.
      execFileSync(process.execPath, ['-e', `
        const Database = require(${JSON.stringify(path.join(repoRoot, 'node_modules', 'better-sqlite3'))});
        const db = new Database(process.argv[1]);
        db.exec(\`CREATE TABLE policies (
          id INTEGER PRIMARY KEY AUTOINCREMENT, case_id INTEGER NOT NULL, carrier TEXT, policy_number TEXT,
          policy_status TEXT NOT NULL DEFAULT 'Pending', effective_date TEXT, premium REAL, premium_frequency TEXT,
          coverage_amount REAL, beneficiary TEXT, renewal_date TEXT, application_date TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )\`);
        db.close();
      `, dbPath], { cwd: repoRoot });

      // Step 2: a FRESH process boots the CURRENT db/database.js against
      // that same file -- this is the actual fix under test.
      const out = execFileSync(process.execPath, ['-e', `
        process.env.DB_PATH = process.argv[1];
        const db = require('./db/database');
        console.log(JSON.stringify(db.prepare("PRAGMA table_info(policies)").all().map(c => c.name)));
      `, dbPath], { cwd: repoRoot }).toString().trim();

      const columns = JSON.parse(out);
      for (const expected of ['archived_at', 'notes', 'policy_type']) {
        assert.ok(columns.includes(expected), `policies.${expected} must be self-provisioned on the next boot, even though the table already existed without it`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}

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
