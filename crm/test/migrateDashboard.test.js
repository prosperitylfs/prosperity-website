// Tests for crm/db/migrateDashboard.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');

function setup() {
  const db = createLegacyDb();
  runMigrations(db);
  return db;
}

test('adds the expected evidence/audit columns to unresolved_intake', () => {
  const db = setup();
  runDashboardMigrations(db);
  const cols = db.prepare('PRAGMA table_info(unresolved_intake)').all().map(c => c.name);
  for (const expected of ['review_type', 'contact_brand_id', 'product_id', 'ref_type', 'ref_value', 'decision', 'resolved_by']) {
    assert.ok(cols.includes(expected), `expected column '${expected}'`);
  }
});

test('review_type defaults to \'brand\' for a plain insert', () => {
  const db = setup();
  runDashboardMigrations(db);
  db.prepare(`INSERT INTO unresolved_intake (source, raw_payload, reason) VALUES ('test', '{}', 'test reason')`).run();
  const row = db.prepare('SELECT review_type FROM unresolved_intake ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.review_type, 'brand');
});

test('running the dashboard migration twice is idempotent (no error, no duplicate columns)', () => {
  const db = setup();
  assert.doesNotThrow(() => { runDashboardMigrations(db); runDashboardMigrations(db); runDashboardMigrations(db); });
});

test('does not drop or rename any existing table or column', () => {
  const db = setup();
  const tablesBefore = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  const intakeColsBefore = db.prepare('PRAGMA table_info(unresolved_intake)').all().map(c => c.name);

  runDashboardMigrations(db);

  const tablesAfter = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
  for (const t of tablesBefore) assert.ok(tablesAfter.includes(t));
  const intakeColsAfter = db.prepare('PRAGMA table_info(unresolved_intake)').all().map(c => c.name);
  for (const c of intakeColsBefore) assert.ok(intakeColsAfter.includes(c));
});
