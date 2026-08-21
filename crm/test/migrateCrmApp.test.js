// Tests for crm/db/migrateCrmApp.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');

function setup() {
  const db = createLegacyDb();
  runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  return db;
}

test('adds incoming_brand_id to unresolved_intake', () => {
  const db = setup();
  const cols = db.prepare('PRAGMA table_info(unresolved_intake)').all().map(c => c.name);
  assert.ok(cols.includes('incoming_brand_id'));
});

test('creates an empty policies table linked to cases', () => {
  const db = setup();
  const count = db.prepare('SELECT COUNT(*) AS n FROM policies').get().n;
  assert.equal(count, 0, 'the real migration must never seed fake policy rows');

  const cols = db.prepare('PRAGMA table_info(policies)').all().map(c => c.name);
  for (const expected of ['case_id', 'carrier', 'policy_number', 'policy_status', 'effective_date', 'premium', 'coverage_amount', 'beneficiary', 'renewal_date']) {
    assert.ok(cols.includes(expected), `policies table must have '${expected}'`);
  }
});

test('is idempotent — safe to run twice against the same db', () => {
  const db = setup();
  assert.doesNotThrow(() => runCrmAppMigrations(db));
  assert.doesNotThrow(() => runCrmAppMigrations(db));
});

test('never drops or alters existing tables/data', () => {
  const db = createLegacyDb();
  const ins = db.prepare(`INSERT INTO contacts (first_name, email) VALUES ('Preexisting', 'preexisting@example.com')`).run();
  runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ins.lastInsertRowid);
  assert.equal(row.first_name, 'Preexisting');
  assert.equal(row.email, 'preexisting@example.com');
});

test('stageUnresolvedIntake still works against a db that never ran this migration (backward compatible)', () => {
  const { stageUnresolvedIntake } = require('../lib/caseMatching');
  const db = createLegacyDb();
  runMigrations(db); // no runCrmAppMigrations here — the older schema shape
  runDashboardMigrations(db);

  assert.doesNotThrow(() => {
    stageUnresolvedIntake(db, { source: 'test', rawPayload: { a: 1 }, reason: 'test reason', incomingBrandId: 999 });
  });
});
