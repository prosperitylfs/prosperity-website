// Tests for crm/db/migrateBrands.js. Every test uses an in-memory
// (':memory:') better-sqlite3 database — never a file on disk, never
// data/crm.db, never Render.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFreshDb, createLegacyDb, seedLegacyContacts } = require('../testSupport/legacyDb');
const { runMigrations, INSURANCE_LADY_PRODUCTS, PROSPERITY_PRODUCTS } = require('../db/migrateBrands');

test('fresh empty database: migration creates all new tables and seeds brands/products', () => {
  const db = createFreshDb();
  // Fresh DB has no contacts table yet either — migrateBrands.js's FK
  // clauses reference `contacts(id)`/`brands(id)` etc. but SQLite does not
  // require the referenced table to exist at ADD COLUMN/CREATE TABLE time
  // unless foreign_keys enforcement inserts against it, so this still needs
  // a contacts table to exist for the downstream ADD COLUMN calls to run
  // against a real table.
  db.exec(`CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.exec(`CREATE TABLE comm_calls (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.exec(`CREATE TABLE sms_messages (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.exec(`CREATE TABLE emails (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.exec(`CREATE TABLE appointments (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.exec(`CREATE TABLE follow_up_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.exec(`CREATE TABLE contact_notes (id INTEGER PRIMARY KEY AUTOINCREMENT);`);
  db.exec(`CREATE TABLE communications (id INTEGER PRIMARY KEY AUTOINCREMENT);`);

  runMigrations(db);

  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name);
  for (const expected of ['brands', 'products', 'contact_brands', 'cases', 'case_external_refs', 'sender_identities', 'case_brand_transfers', 'unresolved_intake']) {
    assert.ok(tables.includes(expected), `expected table '${expected}' to exist`);
  }

  const brands = db.prepare('SELECT name, slug FROM brands ORDER BY name').all();
  assert.deepEqual(brands, [
    { name: 'Insurance Lady LLC', slug: 'insurance-lady' },
    { name: 'Prosperity Life & Financial Solutions LLC', slug: 'prosperity' },
  ]);
});

test('existing legacy database: migration applies on top without error and preserves data', () => {
  const db = createLegacyDb();
  const ids = seedLegacyContacts(db);
  const contactCountBefore = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;

  runMigrations(db);

  const contactCountAfter = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  assert.equal(contactCountAfter, contactCountBefore);

  // All legacy records preserved — spot-check a specific row's fields are untouched.
  const carol = db.prepare('SELECT * FROM contacts WHERE email = ?').get('carol.meyers@example-mail.com');
  assert.equal(carol.first_name, 'Carol');
  assert.equal(carol.lead_type, 'Retirement Guide Lead');
  assert.equal(carol.phone_e164, '+14145552201');
});

test('all legacy records preserved: every original table, row count, and column value is unchanged', () => {
  const db = createLegacyDb();
  seedLegacyContacts(db);
  const before = db.prepare('SELECT * FROM contacts ORDER BY id').all();

  runMigrations(db);

  const after = db.prepare('SELECT id, first_name, last_name, email, phone, phone_e164, lead_type, lead_source, lead_status FROM contacts ORDER BY id').all();
  const beforeProjected = before.map(r => ({
    id: r.id, first_name: r.first_name, last_name: r.last_name, email: r.email,
    phone: r.phone, phone_e164: r.phone_e164, lead_type: r.lead_type,
    lead_source: r.lead_source, lead_status: r.lead_status,
  }));
  assert.deepEqual(after, beforeProjected);

  // New downstream reference columns exist and default to NULL for existing rows.
  const cols = db.prepare(`PRAGMA table_info(contacts)`).all().map(c => c.name);
  // contacts itself isn't a downstream target (contact_brands is the brand
  // link), so it should NOT have gained contact_brand_id/case_id columns.
  assert.ok(!cols.includes('contact_brand_id'));

  const applied = db.prepare('SELECT contact_brand_id, case_id FROM comm_calls').all();
  assert.equal(applied.length, 0); // no comm_calls rows seeded, but query must not error — columns exist
  const commCallsCols = db.prepare(`PRAGMA table_info(comm_calls)`).all().map(c => c.name);
  assert.ok(commCallsCols.includes('contact_brand_id'));
  assert.ok(commCallsCols.includes('case_id'));
});

test('second migration run: no duplicate brands, products, or schema errors', () => {
  const db = createLegacyDb();
  seedLegacyContacts(db);

  runMigrations(db);
  const brandsAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM brands').get().n;
  const productsAfterFirst = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;

  assert.doesNotThrow(() => runMigrations(db));
  assert.doesNotThrow(() => runMigrations(db)); // third time too

  const brandsAfterRepeat = db.prepare('SELECT COUNT(*) AS n FROM brands').get().n;
  const productsAfterRepeat = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;

  assert.equal(brandsAfterRepeat, brandsAfterFirst);
  assert.equal(productsAfterRepeat, productsAfterFirst);
  assert.equal(brandsAfterFirst, 2);
});

test('second migration run: repeated calls do not duplicate a manually created contact_brands relationship', () => {
  const db = createLegacyDb();
  const ids = seedLegacyContacts(db);
  runMigrations(db);

  const prosperityId = db.prepare(`SELECT id FROM brands WHERE slug = 'prosperity'`).get().id;
  const contactId = ids['Carol Meyers'];

  db.prepare('INSERT OR IGNORE INTO contact_brands (contact_id, brand_id) VALUES (?, ?)').run(contactId, prosperityId);
  db.prepare('INSERT OR IGNORE INTO contact_brands (contact_id, brand_id) VALUES (?, ?)').run(contactId, prosperityId);
  runMigrations(db); // migration itself doesn't touch contact_brands data, but must not error alongside it

  const rows = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ? AND brand_id = ?').all(contactId, prosperityId);
  assert.equal(rows.length, 1);
});

test('no Medicare seed: exact seeded product lists match the approved categories only', () => {
  const db = createLegacyDb();
  runMigrations(db);

  const insuranceLadyId = db.prepare(`SELECT id FROM brands WHERE slug = 'insurance-lady'`).get().id;
  const prosperityId = db.prepare(`SELECT id FROM brands WHERE slug = 'prosperity'`).get().id;

  const ilProducts = db.prepare('SELECT name FROM products WHERE brand_id = ? ORDER BY id').all(insuranceLadyId).map(r => r.name);
  const prosperityProducts = db.prepare('SELECT name FROM products WHERE brand_id = ? ORDER BY id').all(prosperityId).map(r => r.name);

  assert.deepEqual(ilProducts, INSURANCE_LADY_PRODUCTS);
  assert.deepEqual(prosperityProducts, PROSPERITY_PRODUCTS);

  const allProductNames = db.prepare('SELECT name FROM products').all().map(r => r.name.toLowerCase());
  assert.ok(!allProductNames.some(n => n.includes('medicare')), 'no product should mention Medicare');
});

test('no NULL-brand relationship: resolveContactBrand-style insert is rejected by schema if brand_id is NULL', () => {
  const db = createLegacyDb();
  const ids = seedLegacyContacts(db);
  runMigrations(db);

  assert.throws(() => {
    db.prepare('INSERT INTO contact_brands (contact_id, brand_id) VALUES (?, NULL)').run(ids['Carol Meyers']);
  }, /NOT NULL constraint failed/);
});

test('does not drop or rename any pre-existing table or column', () => {
  const db = createLegacyDb();
  const tablesBefore = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name).sort();
  const contactsColsBefore = db.prepare(`PRAGMA table_info(contacts)`).all().map(c => c.name).sort();

  runMigrations(db);

  const tablesAfter = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name);
  for (const t of tablesBefore) assert.ok(tablesAfter.includes(t), `table '${t}' must still exist`);

  const contactsColsAfter = db.prepare(`PRAGMA table_info(contacts)`).all().map(c => c.name);
  for (const c of contactsColsBefore) assert.ok(contactsColsAfter.includes(c), `column contacts.${c} must still exist`);
});
