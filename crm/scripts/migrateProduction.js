#!/usr/bin/env node
// Explicit, standalone production migration runner. Runs the five
// approved, additive, idempotent migrations — migrateBrands,
// migrateDashboard, migrateCrmApp, migrateCrmCore, migrateRevenueMvp — in
// that required order, against exactly one explicitly named database
// file. Never has a default target; never silently selects production.
//
// This script never starts the CRM server, never deploys, never touches
// Render, and never contacts Twilio. It performs exactly one job: apply
// schema migrations to a database file you name explicitly.
//
// Usage (placeholders only — this file never contains a real path):
//   node crm/scripts/migrateProduction.js --db <absolute-path-to-database> --confirm-migrate [--dry-run]
// or:
//   MIGRATION_DB_PATH=<absolute-path-to-database> node crm/scripts/migrateProduction.js --confirm-migrate [--dry-run]
//
// --confirm-migrate is REQUIRED in every mode — nothing runs without it.
// --dry-run copies the target file (and its -wal/-shm sidecar files, if
//   present) to a disposable, timestamped path next to it, and runs the
//   migrations against that COPY ONLY. The original file is never opened
//   for writing in this mode. The copy is left on disk afterward for
//   inspection; delete it yourself when done.
//
// All the actual logic — path validation, the dry-run copy, and running
// the five migrations in order — lives in crm/lib/migrationRunner.js,
// which is unit-tested against throwaway on-disk databases
// (crm/test/migrationRunner.test.js) and never calls process.exit itself.

const {
  runProductionMigration,
  MigrationRefusedError,
  MigrationStepError,
} = require('../lib/migrationRunner');

function parseArgs(argv) {
  const args = { db: null, confirm: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--db') { args.db = argv[i + 1]; i++; }
    else if (argv[i] === '--confirm-migrate') args.confirm = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = args.db || process.env.MIGRATION_DB_PATH || '';

  console.log(`[migrateProduction] Requested database path: ${dbPath || '(none given)'}`);
  console.log(`[migrateProduction] Mode: ${args.dryRun ? 'DRY RUN (disposable copy only, original untouched)' : 'LIVE (the exact target file will be modified)'}`);

  const result = runProductionMigration({
    dbPath,
    confirm: args.confirm,
    dryRun: args.dryRun,
    onStep: (name, phase) => console.log(`[migrateProduction]   ${name}: ${phase}`),
  });

  console.log(`\n[migrateProduction] Resolved target: ${result.resolvedPath}`);
  if (result.dryRun) {
    console.log(`[migrateProduction] DRY RUN complete — migrations ran against a disposable copy: ${result.targetPath}`);
    console.log('[migrateProduction] The original file above was NOT modified. Inspect the copy, then delete it when finished.');
  } else {
    console.log(`[migrateProduction] All five migrations completed successfully: ${result.completedSteps.join(' -> ')}`);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof MigrationRefusedError) {
    console.error(`\n[migrateProduction] REFUSED: ${err.message}\n`);
  } else if (err instanceof MigrationStepError) {
    console.error(`\n[migrateProduction] FAILED at step '${err.stepName}': ${err.cause.message}`);
    console.error('[migrateProduction] Stopping immediately — no later migration step was attempted.\n');
  } else {
    console.error(`\n[migrateProduction] Unexpected error: ${err.message}\n`);
  }
  process.exit(1);
}
