const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'crm.db');

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ─── Schema ───────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name    TEXT,
    last_name     TEXT,
    phone         TEXT,
    phone_e164    TEXT,
    alt_phone     TEXT,
    email         TEXT UNIQUE,
    role          TEXT DEFAULT 'lead',
    tags          TEXT DEFAULT '[]',
    notes         TEXT,
    lead_type     TEXT,
    lead_source   TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS communications (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id    INTEGER NOT NULL,
    comm_type     TEXT NOT NULL,
    direction     TEXT NOT NULL,
    subject       TEXT,
    body          TEXT,
    external_id   TEXT,
    status        TEXT DEFAULT 'logged',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS contact_notes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id    INTEGER NOT NULL,
    body          TEXT NOT NULL,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS sms_consent (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    phone               TEXT NOT NULL,
    consent_timestamp   DATETIME,
    consent_source      TEXT,
    consent_text        TEXT,
    opt_out_timestamp   DATETIME
  );

  CREATE TABLE IF NOT EXISTS comm_calls (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id          INTEGER,
    direction           TEXT,
    from_number         TEXT,
    to_number           TEXT,
    status              TEXT,
    duration_sec        INTEGER,
    recording_url       TEXT,
    provider_call_uuid  TEXT,
    started_at          DATETIME,
    answered_at         DATETIME,
    ended_at            DATETIME,
    created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_email      ON contacts(email);
  CREATE INDEX IF NOT EXISTS idx_contacts_created    ON contacts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comms_contact       ON communications(contact_id);
  CREATE INDEX IF NOT EXISTS idx_notes_contact       ON contact_notes(contact_id);
  CREATE INDEX IF NOT EXISTS idx_calls_contact       ON comm_calls(contact_id);
`);

module.exports = db;
