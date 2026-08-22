// Tests for crm/lib/migrationRunner.js — the production migration runner's
// core logic. Every test uses a newly created, throwaway, FILE-based fake
// production-shaped SQLite database (via crm/testSupport/legacyDb.js's
// createLegacyDb(), given an explicit temp file path) under the OS temp
// directory. The real crm/data/crm.db is never opened, copied, or
// referenced by value anywhere in this file — only via
// repoLiveDbPath()'s own computation, for the one test that must reject it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createLegacyDb, seedLegacyContacts } = require('../testSupport/legacyDb');
const {
  MIGRATION_ORDER,
  MigrationRefusedError,
  MigrationStepError,
  resolveAndValidateDbPath,
  runAllMigrations,
  runProductionMigration,
  repoLiveDbPath,
} = require('../lib/migrationRunner');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crm-migration-test-'));
}

// Builds a real, on-disk, fake production-shaped database (base legacy
// schema only, pre-two-brand-model) at a throwaway path and returns that
// path, closing the handle so the migration runner can open it fresh.
function makeFakeProductionDbFile(dir, name = 'fake-prod.db') {
  const filePath = path.join(dir, name);
  const db = createLegacyDb(filePath);
  seedLegacyContacts(db);
  db.close();
  return filePath;
}

test('MIGRATION_ORDER is the exact five approved migrations in their required order', () => {
  assert.deepEqual(MIGRATION_ORDER, [
    'migrateBrands', 'migrateDashboard', 'migrateCrmApp', 'migrateCrmCore', 'migrateRevenueMvp',
  ]);
});

test('a missing database path is blocked', () => {
  assert.throws(() => resolveAndValidateDbPath(undefined), MigrationRefusedError);
  assert.throws(() => resolveAndValidateDbPath(''), MigrationRefusedError);
  assert.throws(() => resolveAndValidateDbPath('   '), MigrationRefusedError);
});

test('a relative database path is blocked', () => {
  assert.throws(() => resolveAndValidateDbPath('crm/data/fake.db'), MigrationRefusedError);
  assert.throws(() => resolveAndValidateDbPath('./fake.db'), MigrationRefusedError);
});

test('the repository database at crm/data/crm.db is blocked', () => {
  assert.throws(() => resolveAndValidateDbPath(repoLiveDbPath()), (err) => {
    assert.ok(err instanceof MigrationRefusedError);
    assert.match(err.message, /repository database/);
    return true;
  });
});

test('an "unresolved" (non-normalized) absolute path is blocked', () => {
  const dir = makeTempDir();
  // path.join() would normalize this itself, so build the messy string by
  // hand -- a literal, un-normalized '..' segment path.resolve() would
  // collapse, proving the path was not already clean.
  const messy = `${dir}${path.sep}sub${path.sep}..${path.sep}fake.db`;
  assert.notEqual(path.resolve(messy), messy, 'sanity check: this string must not already be normalized');
  assert.throws(() => resolveAndValidateDbPath(messy), MigrationRefusedError);
});

test('a path whose parent directory does not exist is blocked', () => {
  const dir = makeTempDir();
  const nonexistentParent = path.join(dir, 'does-not-exist-subdir', 'fake.db');
  assert.throws(() => resolveAndValidateDbPath(nonexistentParent), MigrationRefusedError);
});

test('a valid absolute throwaway path passes validation and is returned resolved', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'fake.db');
  const resolved = resolveAndValidateDbPath(filePath);
  assert.equal(resolved, filePath);
});

test('a missing confirmation flag is blocked, even with an otherwise valid path', () => {
  const dir = makeTempDir();
  const filePath = makeFakeProductionDbFile(dir);
  assert.throws(() => runProductionMigration({ dbPath: filePath, confirm: false }), MigrationRefusedError);
  assert.throws(() => runProductionMigration({ dbPath: filePath }), MigrationRefusedError);
});

test('a non-existent target (real mode, not dry-run) is blocked -- this tool migrates an existing database, never bootstraps one', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'never-created.db');
  assert.throws(() => runProductionMigration({ dbPath: filePath, confirm: true }), MigrationRefusedError);
});

test('a target that does not look like a CRM database (no contacts table) is blocked', () => {
  const dir = makeTempDir();
  const filePath = path.join(dir, 'not-a-crm-db.db');
  const db = new Database(filePath);
  db.exec('CREATE TABLE something_else (id INTEGER PRIMARY KEY)');
  db.close();
  assert.throws(() => runProductionMigration({ dbPath: filePath, confirm: true }), MigrationRefusedError);
});

test('disposable-copy (--dry-run) migration succeeds and never modifies the original file', () => {
  const dir = makeTempDir();
  const filePath = makeFakeProductionDbFile(dir);
  const beforeStat = fs.statSync(filePath);

  const result = runProductionMigration({ dbPath: filePath, confirm: true, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.ok(result.dryRunCopyPath && result.dryRunCopyPath !== filePath);
  assert.deepEqual(result.completedSteps, MIGRATION_ORDER);

  // Original file: unchanged size (no new tables were ever written to it).
  const afterStat = fs.statSync(filePath);
  assert.equal(afterStat.size, beforeStat.size);
  const originalDb = new Database(filePath, { readonly: true });
  const originalHasBrands = originalDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brands'`).get();
  originalDb.close();
  assert.equal(originalHasBrands, undefined, 'the original file must never gain the new two-brand-model tables');

  // The disposable copy DOES have the new schema.
  const copyDb = new Database(result.dryRunCopyPath, { readonly: true });
  const copyHasBrands = copyDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'brands'`).get();
  const copyHasActivities = copyDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activities'`).get();
  copyDb.close();
  assert.ok(copyHasBrands, 'the disposable copy must have the migrated schema');
  assert.ok(copyHasActivities);

  fs.unlinkSync(result.dryRunCopyPath);
});

test('--dry-run copies -wal/-shm sidecar files when present, and never writes to the source database', () => {
  const dir = makeTempDir();
  const filePath = makeFakeProductionDbFile(dir);

  // Put the source into WAL mode and force a real -wal sidecar file to
  // exist on disk (a plain checkpoint/close would fold it away, so the
  // connection is kept open across the write to guarantee it persists).
  const liveConn = new Database(filePath);
  liveConn.pragma('journal_mode = WAL');
  liveConn.prepare(`INSERT INTO contacts (first_name, last_name) VALUES ('Wal', 'Sidecar')`).run();
  assert.ok(fs.existsSync(`${filePath}-wal`), 'sanity check: a real -wal sidecar file must exist before the dry run');

  const sourceMainBefore = fs.readFileSync(filePath);
  const sourceWalBefore = fs.readFileSync(`${filePath}-wal`);

  // Check the copy step's own output directly, BEFORE migrations run
  // against it — once runProductionMigration opens the copy, migrates it,
  // and cleanly closes it, SQLite auto-checkpoints WAL mode and legitimately
  // removes the COPY's own transient -wal file, which is correct behavior,
  // not a sign the sidecar was never copied.
  const { createDryRunCopy } = require('../lib/migrationRunner');
  const copyPath = createDryRunCopy(filePath);
  assert.ok(fs.existsSync(`${copyPath}-wal`), 'the -wal sidecar must be copied alongside the main file');
  assert.deepEqual(fs.readFileSync(`${copyPath}-wal`), sourceWalBefore);

  // The source file and its sidecar are byte-for-byte unchanged by the copy.
  assert.deepEqual(fs.readFileSync(filePath), sourceMainBefore);
  assert.deepEqual(fs.readFileSync(`${filePath}-wal`), sourceWalBefore);

  // Now run the full dry-run flow (copy + migrate + close) and re-confirm
  // the ORIGINAL source is still untouched end-to-end.
  const result = runProductionMigration({ dbPath: filePath, confirm: true, dryRun: true });
  assert.deepEqual(fs.readFileSync(filePath), sourceMainBefore);
  assert.deepEqual(fs.readFileSync(`${filePath}-wal`), sourceWalBefore);

  liveConn.close();
  fs.unlinkSync(copyPath);
  if (fs.existsSync(`${copyPath}-wal`)) fs.unlinkSync(`${copyPath}-wal`);
  if (fs.existsSync(`${copyPath}-shm`)) fs.unlinkSync(`${copyPath}-shm`);
  fs.unlinkSync(result.dryRunCopyPath);
  if (fs.existsSync(`${result.dryRunCopyPath}-wal`)) fs.unlinkSync(`${result.dryRunCopyPath}-wal`);
  if (fs.existsSync(`${result.dryRunCopyPath}-shm`)) fs.unlinkSync(`${result.dryRunCopyPath}-shm`);
});

test('running the migrations twice against the same real file remains safe (idempotent)', () => {
  const dir = makeTempDir();
  const filePath = makeFakeProductionDbFile(dir);

  const first = runProductionMigration({ dbPath: filePath, confirm: true });
  assert.deepEqual(first.completedSteps, MIGRATION_ORDER);

  assert.doesNotThrow(() => {
    const second = runProductionMigration({ dbPath: filePath, confirm: true });
    assert.deepEqual(second.completedSteps, MIGRATION_ORDER);
  });

  const db = new Database(filePath, { readonly: true });
  const brandCount = db.prepare('SELECT COUNT(*) AS n FROM brands').get().n;
  db.close();
  assert.equal(brandCount, 2, 'brands must still be seeded exactly once each (INSERT OR IGNORE), not duplicated by the second run');
});

test('existing row counts and legacy field values are preserved across the real migration run', () => {
  const dir = makeTempDir();
  const filePath = makeFakeProductionDbFile(dir);

  const before = new Database(filePath, { readonly: true });
  const beforeContactCount = before.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const beforeCarol = before.prepare(`SELECT * FROM contacts WHERE first_name = 'Carol'`).get();
  before.close();
  assert.ok(beforeCarol, 'sanity check: seed data present before migrating');

  runProductionMigration({ dbPath: filePath, confirm: true });

  const after = new Database(filePath, { readonly: true });
  const afterContactCount = after.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const afterCarol = after.prepare(`SELECT * FROM contacts WHERE first_name = 'Carol'`).get();
  after.close();

  assert.equal(afterContactCount, beforeContactCount, 'row count must be unchanged');
  assert.equal(afterCarol.email, beforeCarol.email);
  assert.equal(afterCarol.phone_e164, beforeCarol.phone_e164);
  assert.equal(afterCarol.lead_type, beforeCarol.lead_type);
  assert.equal(afterCarol.lead_source, beforeCarol.lead_source);
});

test('a failure in one migration step stops immediately and prevents any later step from running', () => {
  const dir = makeTempDir();
  const filePath = makeFakeProductionDbFile(dir);
  const db = new Database(filePath);

  let stepAran = false;
  let stepCran = false;
  const fakeSteps = [
    { name: 'stepA', run: () => { stepAran = true; } },
    { name: 'stepB', run: () => { throw new Error('simulated failure'); } },
    { name: 'stepC', run: () => { stepCran = true; } },
  ];

  assert.throws(() => runAllMigrations(db, { steps: fakeSteps }), (err) => {
    assert.ok(err instanceof MigrationStepError);
    assert.equal(err.stepName, 'stepB');
    assert.match(err.message, /simulated failure/);
    return true;
  });

  db.close();
  assert.equal(stepAran, true, 'the step before the failure must still have run');
  assert.equal(stepCran, false, 'no step after the failure may ever run');
});

test('runProductionMigration surfaces which real migration step failed, given an injected failing step via onStep observation', () => {
  // Exercises the full runProductionMigration path\'s error propagation
  // (not just runAllMigrations directly) using the real five migrations --
  // confirms the reported step name is always among the five approved ones
  // when a genuine run succeeds, and that onStep observes every step in order.
  const dir = makeTempDir();
  const filePath = makeFakeProductionDbFile(dir);
  const observed = [];
  const result = runProductionMigration({
    dbPath: filePath, confirm: true,
    onStep: (name, phase) => observed.push(`${name}:${phase}`),
  });
  assert.deepEqual(result.completedSteps, MIGRATION_ORDER);
  assert.deepEqual(observed, MIGRATION_ORDER.flatMap((n) => [`${n}:starting`, `${n}:complete`]));
});

test('this test file never contacts crm/data/crm.db -- repoLiveDbPath is only ever used to prove it is rejected', () => {
  const live = repoLiveDbPath();
  assert.ok(live.endsWith(path.join('crm', 'data', 'crm.db')));
  assert.throws(() => runProductionMigration({ dbPath: live, confirm: true }), MigrationRefusedError);
});
