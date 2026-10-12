// BackNine BOSS application tracking -- Phase 2 (storage + matching).
//
// Deliberately its OWN table, not a row in `cases`/`policies`: those tables
// require a resolved contact_brand_id (cases.contact_brand_id is NOT NULL),
// but a BackNine application can arrive with no identified contact at all
// (see crm/lib/backNineApplications.js's header comment for why automatic
// contact-matching isn't attempted yet) -- a case/policy row literally
// cannot represent "we don't know whose application this is yet."
// Idempotent column add -- same pattern as every other migration file in
// this codebase (e.g. crm/db/migrateCrmApp.js). Needed here (not just in
// CREATE TABLE) because a production install that already ran this
// migration before 2026-10-12 has the table WITHOUT these three columns --
// CREATE TABLE IF NOT EXISTS is then a no-op and never adds them.
function addCol(db, table, col, def) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); }
  catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}

function runBackNineMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backnine_applications (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      backnine_uuid     TEXT NOT NULL UNIQUE,
      backnine_id       TEXT,
      contact_id        INTEGER,
      match_status      TEXT NOT NULL DEFAULT 'needs_review',
      first_name        TEXT,
      last_name         TEXT,
      product_name      TEXT,
      carrier_name      TEXT,
      product_category  TEXT,
      face_amount       REAL,
      premium           REAL,
      pay_duration_years INTEGER,
      backnine_status   TEXT,
      named_step        TEXT,
      case_status       TEXT,
      display_status    TEXT NOT NULL DEFAULT 'Needs Review',
      raw_payload       TEXT NOT NULL,
      received_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      matched_at        DATETIME,
      matched_by        TEXT,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_backnine_apps_contact      ON backnine_applications(contact_id);
    CREATE INDEX IF NOT EXISTS idx_backnine_apps_match_status ON backnine_applications(match_status);
  `);

  // 2026-10-12: product.name / product.carrier.name / individuals[0].quote.pay_duration
  // confirmed against a real delivery (case #560015) -- see
  // crm/lib/backNineWebhook.js's header comment. Additive for any
  // production install that migrated before this date.
  addCol(db, 'backnine_applications', 'product_name', 'TEXT');
  addCol(db, 'backnine_applications', 'carrier_name', 'TEXT');
  addCol(db, 'backnine_applications', 'pay_duration_years', 'INTEGER');
}

module.exports = { runBackNineMigrations };
