// Additive, idempotent migration supporting the CRM interface redesign
// checkpoint ("Checkpoint F"). Same safety pattern as migrateBrands.js /
// migrateDashboard.js: never imports crm/db/database.js, never opens a
// connection itself, takes an explicit better-sqlite3 `db` handle. Never
// drops/renames a table or column, never deletes existing data.
//
// Two additions:
//
// 1. unresolved_intake.incoming_brand_id — supports the permanent-company
//    rule (see crm/lib/leadIntake.js). When a verified source resolves to a
//    brand that conflicts with a contact's existing ACTIVE contact_brands
//    row, the record is staged with review_type='company_conflict':
//      contact_brand_id   = the EXISTING (already-established) relationship
//      incoming_brand_id  = the NEW brand the incoming source resolved to
//    Both are needed to show a reviewer "existing company" vs "incoming
//    source company" without parsing raw_payload JSON. Nullable — every
//    other review_type leaves this column NULL.
//
// 2. policies table — a real, currently-EMPTY table so the Policies screen
//    can be a genuine feature backed by a real query/route rather than
//    hardcoded frontend data. This migration seeds NO rows. Only the local
//    preview seed script (crm/scripts/seedCrmAppPreview.js) inserts fake
//    demo rows, and only into a throwaway local database — never into
//    crm/data/crm.db. Linked to `cases` only (never duplicates client/
//    company/product, which are already derivable via
//    cases -> contact_brands -> contacts/brands and cases -> products).

function addCol(db, table, col, def) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); }
  catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}

function runCrmAppMigrations(db) {
  db.pragma('foreign_keys = ON');

  addCol(db, 'unresolved_intake', 'incoming_brand_id', 'INTEGER REFERENCES brands(id)');

  db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id            INTEGER NOT NULL,
      carrier            TEXT,
      policy_number      TEXT,
      policy_status      TEXT NOT NULL DEFAULT 'Pending',
      effective_date     TEXT,
      premium            REAL,
      premium_frequency  TEXT,
      coverage_amount    REAL,
      beneficiary        TEXT,
      renewal_date       TEXT,
      created_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (case_id) REFERENCES cases(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_policies_case ON policies(case_id);
  `);
}

module.exports = { runCrmAppMigrations };
