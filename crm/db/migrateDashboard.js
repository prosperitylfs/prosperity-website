// Additive, idempotent migration supporting Checkpoint D's Brand Review
// Required / Case Review Required dashboard views.
//
// SAFETY: same pattern as crm/db/migrateBrands.js — never imports
// crm/db/database.js, never opens a connection itself. Takes an explicit
// better-sqlite3 `db` handle. Never drops/renames a table or column, never
// deletes existing data.
//
// Why this is needed: Checkpoint B's unresolved_intake table stored only a
// free-text `reason` — enough to explain why a record couldn't be resolved,
// but not enough for a dashboard to show a human the *evidence* needed to
// make a decision (which brand relationship, which product, which external
// booking reference). This migration adds nullable, structured columns so
// that evidence can be queried and displayed without parsing raw_payload
// JSON, and adds an audit trail (who decided what, and when) for every
// resolution.

function addCol(db, table, col, def) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); }
  catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}

function runDashboardMigrations(db) {
  db.pragma('foreign_keys = ON');

  // review_type distinguishes the two dashboard queues:
  //   'brand' — the person/brand relationship itself is unresolved
  //             (Brand Review Required)
  //   'case'  — the brand relationship IS known; which case this event
  //             belongs to is uncertain (Case Review Required)
  // Existing rows (all created before this column existed, by Checkpoint B
  // code) default to 'brand', since every review_required path that existed
  // before this migration was the "missing contact_brand_id" case.
  addCol(db, 'unresolved_intake', 'review_type', "TEXT NOT NULL DEFAULT 'brand'");

  // Structured evidence — nullable, populated where the caller has it.
  addCol(db, 'unresolved_intake', 'contact_brand_id', 'INTEGER REFERENCES contact_brands(id)');
  addCol(db, 'unresolved_intake', 'product_id',       'INTEGER REFERENCES products(id)');
  addCol(db, 'unresolved_intake', 'ref_type',          'TEXT');
  addCol(db, 'unresolved_intake', 'ref_value',          'TEXT');

  // Audit trail for the resolution decision itself.
  addCol(db, 'unresolved_intake', 'decision',    'TEXT');   // e.g. 'insurance-lady' | 'prosperity' | 'test_archive' | 'attach_existing_case' | 'create_new_case'
  addCol(db, 'unresolved_intake', 'resolved_by', 'TEXT');   // actor identifier (dashboard user / system)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_unresolved_review_type ON unresolved_intake(review_type);
  `);
}

module.exports = { runDashboardMigrations };
