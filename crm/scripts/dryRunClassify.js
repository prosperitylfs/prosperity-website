#!/usr/bin/env node
// Dry-run brand classification — reads contacts from a LOCAL TEST DATABASE
// COPY and prints proposed classifications with evidence. Writes nothing.
//
// Usage: node scripts/dryRunClassify.js <path-to-local-test-db-copy>
//
// Hard safety rails (not just documentation):
//   - Refuses to run with no path argument (never guesses/defaults a path).
//   - Refuses to run if the resolved path is crm/data/crm.db (the live DB).
//   - Opens the database with { readonly: true } — even if a future edit
//     accidentally added a write, SQLite itself would reject it.

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { classifyContact } = require('../lib/classification');

const LIVE_DB_PATH = path.resolve(__dirname, '..', 'data', 'crm.db');

function main() {
  const dbPathArg = process.argv[2];
  if (!dbPathArg) {
    console.error('Usage: node scripts/dryRunClassify.js <path-to-local-test-db-copy>');
    console.error('Refuses to run without an explicit path.');
    process.exit(1);
  }

  const resolvedPath = path.resolve(dbPathArg);
  if (resolvedPath === LIVE_DB_PATH) {
    console.error(`Refusing to run against ${LIVE_DB_PATH} — this tool must only be run against a local test copy, never the live database.`);
    process.exit(1);
  }
  if (!fs.existsSync(resolvedPath)) {
    console.error(`No file at ${resolvedPath}`);
    process.exit(1);
  }

  const db = new Database(resolvedPath, { readonly: true });
  try {
    const contacts = db.prepare('SELECT * FROM contacts ORDER BY id').all();
    console.log(`Dry-run classification — ${contacts.length} contact(s) from ${resolvedPath}`);
    console.log('No records were written. This tool only reads and prints proposals.\n');

    const counts = {};
    for (const contact of contacts) {
      const result = classifyContact(contact);
      counts[result.proposedBrand] = (counts[result.proposedBrand] || 0) + 1;

      const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '(no name)';
      console.log(`#${contact.id} ${name}`);
      console.log(`  Proposed: ${result.proposedBrand}`);
      console.log(`  Reason:   ${result.reason}`);
      console.log(`  Evidence: ${result.evidence.length ? result.evidence.join('; ') : '(none)'}`);
      console.log('');
    }

    console.log('Summary:');
    for (const [brand, count] of Object.entries(counts)) {
      console.log(`  ${brand}: ${count}`);
    }
  } finally {
    db.close();
  }
}

main();
