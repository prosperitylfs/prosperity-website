// Core logic for the explicit production migration runner
// (crm/scripts/migrateProduction.js is the thin CLI wrapper around this
// file). Never calls process.exit — every refusal or failure is a thrown
// Error subclass, so this module is fully testable against throwaway
// on-disk SQLite files without ever touching a real process lifecycle.
//
// Never imports crm/db/database.js (which opens the live DB_PATH / a
// crm.db file on disk as a side effect of being required) or
// crm/server.js. Never starts the CRM server, never deploys, never
// contacts Twilio or Render. The only side effects anywhere in this file
// are: reading/copying files on disk, and running the five approved,
// additive, idempotent migration functions against an explicitly
// caller-supplied better-sqlite3 handle.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Order is significant — each step's migration ALTERs or references
// tables the previous ones create. See each file's own doc comment for
// the exact dependency.
const MIGRATION_STEPS = [
  { name: 'migrateBrands', run: (db) => require('../db/migrateBrands').runMigrations(db) },
  { name: 'migrateDashboard', run: (db) => require('../db/migrateDashboard').runDashboardMigrations(db) },
  { name: 'migrateCrmApp', run: (db) => require('../db/migrateCrmApp').runCrmAppMigrations(db) },
  { name: 'migrateCrmCore', run: (db) => require('../db/migrateCrmCore').runCrmCoreMigrations(db) },
  { name: 'migrateRevenueMvp', run: (db) => require('../db/migrateRevenueMvp').runRevenueMvpMigrations(db) },
];
const MIGRATION_ORDER = MIGRATION_STEPS.map((s) => s.name);

class MigrationRefusedError extends Error {}
class MigrationStepError extends Error {
  constructor(stepName, cause) {
    super(`Migration step '${stepName}' failed: ${cause.message}`);
    this.stepName = stepName;
    this.cause = cause;
  }
}

function repoLiveDbPath() {
  return path.resolve(__dirname, '..', 'data', 'crm.db');
}

// Pure path validation — no filesystem writes, no database connection.
// Refuses an empty, missing, relative, or "unresolved" (not already a
// clean, normalized absolute path) database path, and refuses the
// repository's own live database file outright.
function resolveAndValidateDbPath(rawPath) {
  if (!rawPath || String(rawPath).trim() === '') {
    throw new MigrationRefusedError('No database path was provided. Pass --db <absolute-path> or set MIGRATION_DB_PATH.');
  }
  if (!path.isAbsolute(rawPath)) {
    throw new MigrationRefusedError(`Database path must be absolute — received a relative path: '${rawPath}'`);
  }
  const resolved = path.resolve(rawPath);
  if (resolved !== rawPath) {
    throw new MigrationRefusedError(`Database path did not resolve cleanly (received '${rawPath}', normalizes to '${resolved}'). Supply the exact, already-normalized absolute path.`);
  }
  if (resolved === repoLiveDbPath()) {
    throw new MigrationRefusedError('Refusing to run against the repository database (crm/data/crm.db). This runner is for an explicitly named external database file only.');
  }
  const parentDir = path.dirname(resolved);
  if (!fs.existsSync(parentDir)) {
    throw new MigrationRefusedError(`Parent directory does not exist: ${parentDir}`);
  }
  return resolved;
}

// Copies the target file (and its WAL/SHM sidecar files, if present — this
// database runs in WAL mode) to a disposable, timestamped path alongside
// it, and returns that path. The original is never opened for writing by
// this function.
function createDryRunCopy(resolvedPath) {
  if (!fs.existsSync(resolvedPath)) {
    throw new MigrationRefusedError(`--dry-run requires the source database to already exist at the given path. Not found: ${resolvedPath}`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dryRunPath = `${resolvedPath}.dryrun-${stamp}.db`;
  fs.copyFileSync(resolvedPath, dryRunPath);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${resolvedPath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.copyFileSync(sidecar, `${dryRunPath}${suffix}`);
  }
  return dryRunPath;
}

// A minimal sanity check that this is genuinely a CRM-shaped database
// before running migrations against it — refuses a database that doesn't
// even have a `contacts` table, rather than silently "succeeding" against
// an unrelated or empty file.
function looksLikeCrmDatabase(db) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contacts'`).get();
  return !!row;
}

// Runs the five migrations, in order, against an ALREADY-OPEN db handle.
// Stops immediately on the first failure — no later step is ever attempted
// — and reports exactly which step failed via MigrationStepError.
// `steps` defaults to the real MIGRATION_STEPS; tests may inject a fake
// array to exercise the stop-on-failure behavior without needing a real
// migration to fail.
function runAllMigrations(db, { onStep, steps = MIGRATION_STEPS } = {}) {
  const completed = [];
  for (const step of steps) {
    if (onStep) onStep(step.name, 'starting');
    try {
      step.run(db);
    } catch (err) {
      throw new MigrationStepError(step.name, err);
    }
    completed.push(step.name);
    if (onStep) onStep(step.name, 'complete');
  }
  return { completed };
}

// End-to-end orchestration used by both crm/scripts/migrateProduction.js
// and tests. Never calls process.exit and never prints anything itself —
// callers decide what to log and what exit code to use.
//
// Returns { resolvedPath, targetPath, dryRun, dryRunCopyPath, completedSteps }
// on success. Throws MigrationRefusedError for every safety refusal, or
// MigrationStepError if a migration itself fails partway through.
function runProductionMigration({ dbPath, confirm, dryRun, onStep } = {}) {
  if (!confirm) {
    throw new MigrationRefusedError('Missing required confirmation (--confirm-migrate). Refusing to run without it.');
  }

  const resolved = resolveAndValidateDbPath(dbPath);

  let targetPath = resolved;
  let dryRunCopyPath = null;
  if (dryRun) {
    targetPath = createDryRunCopy(resolved);
    dryRunCopyPath = targetPath;
  } else if (!fs.existsSync(resolved)) {
    throw new MigrationRefusedError(`Target database does not exist yet: ${resolved} — this tool migrates an existing database; it does not bootstrap a new one. Ensure the application has been deployed and booted at least once first.`);
  }

  const db = new Database(targetPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try {
    if (!looksLikeCrmDatabase(db)) {
      throw new MigrationRefusedError(`The database at ${targetPath} does not look like a CRM database (no 'contacts' table) — refusing to run migrations against it.`);
    }
    const result = runAllMigrations(db, { onStep });
    return {
      resolvedPath: resolved, targetPath, dryRun: !!dryRun, dryRunCopyPath,
      completedSteps: result.completed,
    };
  } finally {
    db.close();
  }
}

module.exports = {
  MIGRATION_ORDER,
  MigrationRefusedError,
  MigrationStepError,
  resolveAndValidateDbPath,
  createDryRunCopy,
  looksLikeCrmDatabase,
  runAllMigrations,
  runProductionMigration,
  repoLiveDbPath,
};
