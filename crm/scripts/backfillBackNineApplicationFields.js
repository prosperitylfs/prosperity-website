#!/usr/bin/env node
// One-off maintenance script: re-derives product/carrier/face amount/
// premium/term/status for every already-stored BackNine application from
// its own saved raw_payload, using the current field-extraction logic
// (crm/lib/backNineWebhook.js's extractConfirmedEappSummary). Run this
// once after deploying a fix to that extraction logic (like the 2026-10-12
// fix for product.name / product.carrier.name / individuals[0].quote.*)
// so applications already received (e.g. Janet Jackson, case #560015)
// pick up the corrected fields without needing BackNine to resend
// anything.
//
// Never touches raw_payload, contact_id, match_status, matched_at, or
// matched_by -- only the columns that are themselves derived FROM
// raw_payload. Safe to run more than once.
//
// Usage: DB_PATH=<absolute-path-to-crm.db> node crm/scripts/backfillBackNineApplicationFields.js

const Database = require('better-sqlite3');
const { backfillApplicationFields } = require('../lib/backNineApplications');
const { extractConfirmedEappSummary } = require('../lib/backNineWebhook');

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  console.error('Set DB_PATH to the absolute path of the production crm.db file before running this script.');
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
try {
  const result = backfillApplicationFields(db, { extractConfirmedEappSummary });
  if (!result.ok) {
    console.error('Backfill did not run:', result.reason);
    process.exit(1);
  }
  console.log(`Backfill complete: ${result.updated} of ${result.totalRows} application row(s) updated.`);
} finally {
  db.close();
}
