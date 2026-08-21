// Additive, idempotent migration supporting the "CRM Core Functionality
// Completion" checkpoint. Same safety pattern as every prior migration in
// this directory: never imports crm/db/database.js, never opens a
// connection itself, takes an explicit better-sqlite3 `db` handle. Never
// drops/renames a table or column, never deletes existing data.
//
// Additions, and why each is needed:
//
// - contacts.archived_at / contact_notes.archived_at / contact_notes.updated_at
//   / policies.archived_at — every "archive" action in this checkpoint is a
//   soft-delete (nullable timestamp), never a real DELETE, per "Archiving a
//   client must not delete the client, cases, policies, communications,
//   notes, or audit history" and "Do not implement permanent deletion; use
//   archive where appropriate."
//
// - activities / activity_edits — the unified "Add Activity" timeline
//   (Note, Phone call, Text message, Email, Appointment, Follow-up,
//   Document received, Policy update, General activity) needs fields none
//   of the existing tables carry together (next_action, next_action_due,
//   created_by, an activity_type wide enough for "Document received"/
//   "Policy update"). activity_edits is a real, append-only edit-audit
//   trail for note/activity edits (required: "Notes must support create
//   and edit with audit history").
//
// - communication_drafts — Call/Text/Email must work "up to but not
//   including contacting a provider": a draft needs somewhere to live
//   that is explicitly never a sent record (sms_messages/emails imply a
//   provider attempt already happened).
//
// - import_batches / import_rows — the CSV import workflow needs to
//   preserve the original imported row and a per-batch/per-row audit
//   record, and support a dry run that writes nothing to contacts/cases
//   (a dry-run batch's rows are evaluated and recorded here, but never
//   applied to the live tables).

function addCol(db, table, col, def) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); }
  catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}

function runCrmCoreMigrations(db) {
  db.pragma('foreign_keys = ON');

  addCol(db, 'contacts', 'archived_at', 'DATETIME');
  addCol(db, 'contact_notes', 'archived_at', 'DATETIME');
  addCol(db, 'contact_notes', 'updated_at', 'DATETIME');
  addCol(db, 'policies', 'archived_at', 'DATETIME');
  addCol(db, 'policies', 'notes', 'TEXT');

  db.exec(`
    CREATE TABLE IF NOT EXISTS activities (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id            INTEGER NOT NULL,
      contact_brand_id      INTEGER,
      case_id               INTEGER,
      activity_type         TEXT NOT NULL,
      activity_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      summary               TEXT,
      details               TEXT,
      next_action           TEXT,
      next_action_due_date  TEXT,
      created_by            TEXT NOT NULL DEFAULT 'Loretta Stewart',
      archived_at           DATETIME,
      created_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
      FOREIGN KEY (case_id)    REFERENCES cases(id)    ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id);
    CREATE INDEX IF NOT EXISTS idx_activities_case    ON activities(case_id);

    CREATE TABLE IF NOT EXISTS activity_edits (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_id       INTEGER NOT NULL,
      previous_summary  TEXT,
      previous_details  TEXT,
      edited_at         DATETIME DEFAULT CURRENT_TIMESTAMP,
      edited_by         TEXT,
      FOREIGN KEY (activity_id) REFERENCES activities(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS communication_drafts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id        INTEGER NOT NULL,
      contact_brand_id  INTEGER,
      case_id           INTEGER,
      channel           TEXT NOT NULL,
      template_key      TEXT,
      to_address        TEXT,
      subject           TEXT,
      body              TEXT,
      status            TEXT NOT NULL DEFAULT 'draft',
      created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE,
      FOREIGN KEY (case_id)    REFERENCES cases(id)    ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS import_batches (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      filename     TEXT,
      brand_id     INTEGER,
      status       TEXT NOT NULL DEFAULT 'dry_run',
      created_by   TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      committed_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS import_rows (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id       INTEGER NOT NULL,
      row_number     INTEGER NOT NULL,
      raw_row        TEXT NOT NULL,
      outcome        TEXT NOT NULL,
      outcome_detail TEXT,
      contact_id     INTEGER,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (batch_id) REFERENCES import_batches(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_import_rows_batch ON import_rows(batch_id);
  `);
}

module.exports = { runCrmCoreMigrations };
