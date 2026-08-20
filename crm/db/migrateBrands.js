// Additive, idempotent migration for the two-brand (Insurance Lady /
// Prosperity) data model: contacts → contact_brands → cases, plus
// supporting tables.
//
// SAFETY: this module never imports crm/db/database.js (which opens the
// live DB_PATH / data/crm.db the moment it's required) and never opens any
// database connection itself. Every function here takes an explicit
// better-sqlite3 `db` handle supplied by the caller — tests and the dry-run
// CLI are responsible for pointing that handle at a local test database
// only. runMigrations() never drops or renames a table/column and never
// deletes or overwrites existing rows; every new column is nullable.

function addCol(db, table, col, def) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); }
  catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}

const INSURANCE_LADY_PRODUCTS = [
  'Online life-insurance application',
  'Cash-building life insurance',
  'Whole life/final expense',
  'Cash cancer insurance',
  'Annuities and safe-money solutions',
  'Follow-up/service',
];

const PROSPERITY_PRODUCTS = [
  'Life insurance',
  'Annuities',
  'Rollovers and safe-money solutions',
  'Follow-up/service',
];

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brands (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL UNIQUE,
      slug        TEXT NOT NULL UNIQUE,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id    INTEGER NOT NULL,
      name        TEXT NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
      UNIQUE (brand_id, name)
    );

    -- Level 2 of the three-level model: which brand(s) a contact has a
    -- relationship with. A contact may have zero, one, or two rows here
    -- (one per brand) — never a row with a NULL brand_id.
    CREATE TABLE IF NOT EXISTS contact_brands (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id  INTEGER NOT NULL,
      brand_id    INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'Active',
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
      FOREIGN KEY (brand_id)   REFERENCES brands(id)   ON DELETE RESTRICT,
      UNIQUE (contact_id, brand_id)
    );

    -- Level 3: a specific matter/opportunity under one brand relationship.
    CREATE TABLE IF NOT EXISTS cases (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_brand_id  INTEGER NOT NULL,
      product_id        INTEGER,
      status            TEXT NOT NULL DEFAULT 'Open',
      title             TEXT,
      opened_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at         DATETIME,
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_brand_id) REFERENCES contact_brands(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id)       REFERENCES products(id)       ON DELETE SET NULL
    );

    -- Supports exact, idempotent case-matching: every external booking/
    -- webhook reference (Cal.com booking uid, a reschedule's new uid, etc.)
    -- that has been attached to a case is recorded once here. A duplicate
    -- webhook delivery for a ref already present resolves to the same case
    -- instead of creating a new one.
    CREATE TABLE IF NOT EXISTS case_external_refs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id     INTEGER NOT NULL,
      ref_type    TEXT NOT NULL,
      ref_value   TEXT NOT NULL,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE,
      UNIQUE (ref_type, ref_value)
    );

    -- Which outbound email/SMS identity belongs to which brand. Left
    -- unseeded by this migration — real identities are only added once the
    -- corresponding Microsoft/Gmail credentials exist, which is out of
    -- scope for this checkpoint.
    CREATE TABLE IF NOT EXISTS sender_identities (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      brand_id      INTEGER NOT NULL,
      channel       TEXT NOT NULL,
      identity      TEXT NOT NULL,
      display_name  TEXT,
      is_default    INTEGER NOT NULL DEFAULT 0,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE CASCADE,
      UNIQUE (brand_id, channel, identity)
    );

    -- Audit trail if a case is later found to belong to a different brand
    -- than originally assigned. Schema only in this checkpoint — no
    -- transfer workflow/logic is implemented yet.
    CREATE TABLE IF NOT EXISTS case_brand_transfers (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id        INTEGER NOT NULL,
      from_brand_id  INTEGER NOT NULL,
      to_brand_id    INTEGER NOT NULL,
      reason         TEXT,
      transferred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id)       REFERENCES cases(id)  ON DELETE CASCADE,
      FOREIGN KEY (from_brand_id) REFERENCES brands(id) ON DELETE RESTRICT,
      FOREIGN KEY (to_brand_id)   REFERENCES brands(id) ON DELETE RESTRICT
    );

    -- Smallest suitable staging table for "Brand Review Required": any
    -- inbound record (contact, booking, webhook) the classifier/case-matcher
    -- could not confidently resolve lands here instead of being written into
    -- contacts/contact_brands/cases with a guess.
    CREATE TABLE IF NOT EXISTS unresolved_intake (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      source                    TEXT NOT NULL,
      raw_payload               TEXT NOT NULL,
      candidate_contact_id      INTEGER,
      reason                    TEXT NOT NULL,
      status                    TEXT NOT NULL DEFAULT 'Pending',
      created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at               DATETIME,
      resolved_contact_brand_id INTEGER,
      FOREIGN KEY (candidate_contact_id)      REFERENCES contacts(id)       ON DELETE SET NULL,
      FOREIGN KEY (resolved_contact_brand_id) REFERENCES contact_brands(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contact_brands_contact ON contact_brands(contact_id);
    CREATE INDEX IF NOT EXISTS idx_contact_brands_brand   ON contact_brands(brand_id);
    CREATE INDEX IF NOT EXISTS idx_cases_contact_brand    ON cases(contact_brand_id);
    CREATE INDEX IF NOT EXISTS idx_cases_status           ON cases(status);
    CREATE INDEX IF NOT EXISTS idx_case_ext_refs_case     ON case_external_refs(case_id);
    CREATE INDEX IF NOT EXISTS idx_products_brand         ON products(brand_id);
    CREATE INDEX IF NOT EXISTS idx_unresolved_status      ON unresolved_intake(status);
  `);
}

// Additive, nullable references from existing downstream tables back to the
// new model. Every column is nullable and has no default that would imply a
// brand — existing rows stay exactly as they are (NULL in these columns)
// until something explicitly classifies them.
function addDownstreamReferences(db) {
  const targets = [
    'comm_calls', 'sms_messages', 'emails', 'appointments',
    'follow_up_tasks', 'contact_notes', 'communications',
  ];
  for (const table of targets) {
    addCol(db, table, 'contact_brand_id', 'INTEGER REFERENCES contact_brands(id)');
    addCol(db, table, 'case_id',          'INTEGER REFERENCES cases(id)');
  }
}

function seedBrandsAndProducts(db) {
  const insertBrand = db.prepare('INSERT OR IGNORE INTO brands (name, slug) VALUES (?, ?)');
  insertBrand.run('Insurance Lady LLC', 'insurance-lady');
  insertBrand.run('Prosperity Life & Financial Solutions LLC', 'prosperity');

  const getBrandId = db.prepare('SELECT id FROM brands WHERE slug = ?');
  const insuranceLadyId = getBrandId.get('insurance-lady').id;
  const prosperityId    = getBrandId.get('prosperity').id;

  const insertProduct = db.prepare('INSERT OR IGNORE INTO products (brand_id, name) VALUES (?, ?)');
  for (const name of INSURANCE_LADY_PRODUCTS) insertProduct.run(insuranceLadyId, name);
  for (const name of PROSPERITY_PRODUCTS)     insertProduct.run(prosperityId, name);

  return { insuranceLadyId, prosperityId };
}

// Entry point. Safe to call repeatedly against the same db — every
// statement is IF NOT EXISTS / duplicate-column-tolerant / INSERT OR IGNORE.
function runMigrations(db) {
  db.pragma('foreign_keys = ON');
  createSchema(db);
  addDownstreamReferences(db);
  const brandIds = seedBrandsAndProducts(db);
  return brandIds;
}

module.exports = {
  runMigrations,
  INSURANCE_LADY_PRODUCTS,
  PROSPERITY_PRODUCTS,
};
