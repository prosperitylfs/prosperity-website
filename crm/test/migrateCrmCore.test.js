// Tests for crm/db/migrateCrmCore.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  runCrmCoreMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

test('adds archived_at to contacts, contact_notes, policies', () => {
  const { db } = setup();
  for (const [table, col] of [['contacts', 'archived_at'], ['contact_notes', 'archived_at'], ['contact_notes', 'updated_at'], ['policies', 'archived_at'], ['policies', 'notes']]) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    assert.ok(cols.includes(col), `${table} must have column '${col}'`);
  }
});

test('creates activities, activity_edits, communication_drafts, import_batches, import_rows -- all empty', () => {
  const { db } = setup();
  for (const table of ['activities', 'activity_edits', 'communication_drafts', 'import_batches', 'import_rows']) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.equal(n, 0, `${table} must start empty`);
  }
});

test('is idempotent', () => {
  const { db } = setup();
  assert.doesNotThrow(() => runCrmCoreMigrations(db));
  assert.doesNotThrow(() => runCrmCoreMigrations(db));
});

test('never deletes existing data', () => {
  const db = createLegacyDb();
  const ins = db.prepare(`INSERT INTO contacts (first_name, email) VALUES ('Preexisting', 'pre@example.com')`).run();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ins.lastInsertRowid);
  assert.equal(row.first_name, 'Preexisting');
});
