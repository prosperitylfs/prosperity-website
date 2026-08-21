// Builds an in-memory better-sqlite3 database mirroring the CURRENT live
// schema (mirrors crm/db/database.js's CREATE TABLE statements plus the
// handful of addCol() columns exercised by these tests) — WITHOUT ever
// requiring crm/db/database.js itself, which opens the live DB_PATH / a
// crm.db file on disk as a side effect of being required. Tests must never
// trigger that.
//
// Always :memory: — never touches disk, never touches data/crm.db.

const Database = require('better-sqlite3');

function createFreshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function createLegacyDb() {
  const db = createFreshDb();
  db.exec(`
    CREATE TABLE contacts (
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
      lead_status   TEXT DEFAULT 'New Lead',
      sms_consent   INTEGER DEFAULT 0,
      email_consent INTEGER DEFAULT 0,
      street_address   TEXT,
      city             TEXT,
      state            TEXT,
      zip_code         TEXT,
      date_of_birth    TEXT,
      general_notes    TEXT,
      archived_at      DATETIME,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE communications (
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

    CREATE TABLE contact_notes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id    INTEGER NOT NULL,
      body          TEXT NOT NULL,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE comm_calls (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id          INTEGER,
      contact_name        TEXT,
      direction           TEXT,
      from_number         TEXT,
      to_number           TEXT,
      status              TEXT,
      duration_sec        INTEGER,
      recording_url       TEXT,
      provider_call_uuid  TEXT,
      notes               TEXT,
      transcription       TEXT,
      started_at          DATETIME,
      answered_at         DATETIME,
      ended_at            DATETIME,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
    );

    CREATE TABLE emails (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id       INTEGER,
      to_email         TEXT NOT NULL,
      subject          TEXT,
      body             TEXT,
      status           TEXT DEFAULT 'sent',
      gmail_message_id TEXT,
      sent_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
    );

    CREATE TABLE sms_messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id  INTEGER,
      direction   TEXT NOT NULL DEFAULT 'outbound',
      from_number TEXT,
      to_number   TEXT,
      body        TEXT,
      status      TEXT DEFAULT 'queued',
      twilio_sid  TEXT,
      call_id     INTEGER,
      sent_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE appointments (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id    INTEGER NOT NULL,
      appt_type     TEXT NOT NULL DEFAULT 'Phone Call',
      appt_datetime TEXT NOT NULL,
      duration_min  INTEGER DEFAULT 60,
      status        TEXT NOT NULL DEFAULT 'Scheduled',
      location      TEXT,
      notes         TEXT,
      cal_booking_uid TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );

    CREATE TABLE follow_up_tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id   INTEGER NOT NULL,
      task_type    TEXT NOT NULL DEFAULT 'Call',
      due_date     TEXT NOT NULL,
      due_time     TEXT,
      notes        TEXT,
      priority     TEXT NOT NULL DEFAULT 'Medium',
      status       TEXT NOT NULL DEFAULT 'Pending',
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    );
  `);
  return db;
}

// A handful of realistic legacy contacts, as they'd exist before Checkpoint
// B ever ran — all created through Prosperity-only channels, exactly as
// main.js / send-guide.js / calcom.js / twilio.js actually populate lead_type
// and lead_source today.
function seedLegacyContacts(db) {
  const insert = db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, phone, phone_e164, lead_type, lead_source, lead_status)
    VALUES (@first_name, @last_name, @email, @phone, @phone_e164, @lead_type, @lead_source, @lead_status)
  `);
  const rows = [
    { first_name: 'Carol',  last_name: 'Meyers',     email: 'carol.meyers@example-mail.com', phone: '(414) 555-2201', phone_e164: '+14145552201', lead_type: 'Retirement Guide Lead', lead_source: '13 Retirement & Rollover Mistakes to Avoid', lead_status: 'New Lead' },
    { first_name: 'Hank',   last_name: 'Ostrowski',  email: 'hank.o@example-mail.com',        phone: '(262) 555-2202', phone_e164: '+12625552202', lead_type: 'Roth Conversion Lead',   lead_source: 'Roth Conversion Calculator',                    lead_status: 'New Lead' },
    { first_name: 'Unknown Caller', last_name: null, email: null,                             phone: '(414) 555-2203', phone_e164: '+14145552203', lead_type: 'Unknown Caller',         lead_source: 'Inbound Call',                                  lead_status: 'New Lead' },
    { first_name: 'Test',   last_name: 'User',       email: 'test.user@example.com',          phone: '(202) 555-0173', phone_e164: '+12025550173', lead_type: null,                     lead_source: null,                                            lead_status: 'New Lead' },
  ];
  const ids = {};
  for (const row of rows) {
    const r = insert.run(row);
    ids[row.first_name + ' ' + row.last_name] = r.lastInsertRowid;
  }
  return ids;
}

module.exports = { createFreshDb, createLegacyDb, seedLegacyContacts };
