// BackNine BOSS application tracking -- Phase 2 (storage + matching).
//
// Deliberately its OWN table, not a row in `cases`/`policies`: those tables
// require a resolved contact_brand_id (cases.contact_brand_id is NOT NULL),
// but a BackNine application can arrive with no identified contact at all
// (see crm/lib/backNineApplications.js's header comment for why automatic
// contact-matching isn't attempted yet) -- a case/policy row literally
// cannot represent "we don't know whose application this is yet."
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
      product_category  TEXT,
      face_amount       REAL,
      premium           REAL,
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
}

module.exports = { runBackNineMigrations };
