const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'crm.db');
const DB_DIR  = path.dirname(DB_PATH);

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

  CREATE TABLE IF NOT EXISTS emails (
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

  CREATE TABLE IF NOT EXISTS sms_messages (
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

  CREATE TABLE IF NOT EXISTS appointments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id    INTEGER NOT NULL,
    appt_type     TEXT NOT NULL DEFAULT 'Phone Call',
    appt_datetime TEXT NOT NULL,
    duration_min  INTEGER DEFAULT 60,
    status        TEXT NOT NULL DEFAULT 'Scheduled',
    location      TEXT,
    notes         TEXT,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  -- Retirement Intake Form (crm/lib/retirementIntakeService.js). One row per
  -- Safe Money & Retirement appointment, created automatically by
  -- crm/routes/calcom.js when a new such appointment is booked. 'token' is
  -- the sole public-facing identifier (a secure random string) -- the public
  -- retirement-intake.html page and its API routes never see or accept a
  -- raw contact_id/appointment_id from the browser. 'status' is one of
  -- 'Not Sent' | 'Sent' | 'Completed' only ('Overdue' is a DISPLAY-ONLY
  -- value computed at read time from status='Sent' plus the linked
  -- appointment's current appt_datetime minus 2 hours -- never stored, and
  -- nothing in this codebase acts on it automatically yet). responses_json
  -- holds the full structured intake answers (all ten form sections) as one
  -- organized JSON object; core status/date fields stay real columns so
  -- they are directly queryable/sortable without parsing JSON.
  CREATE TABLE IF NOT EXISTS retirement_intakes (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id     INTEGER NOT NULL,
    appointment_id INTEGER NOT NULL,
    token          TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'Not Sent',
    sent_at        DATETIME,
    completed_at   DATETIME,
    responses_json TEXT,
    created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (contact_id)     REFERENCES contacts(id)     ON DELETE CASCADE,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sms_contact         ON sms_messages(contact_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_email      ON contacts(email);
  CREATE INDEX IF NOT EXISTS idx_contacts_phone_e164 ON contacts(phone_e164);
  CREATE INDEX IF NOT EXISTS idx_contacts_created    ON contacts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comms_contact       ON communications(contact_id);
  CREATE INDEX IF NOT EXISTS idx_notes_contact       ON contact_notes(contact_id);
  CREATE INDEX IF NOT EXISTS idx_calls_contact       ON comm_calls(contact_id);
  CREATE INDEX IF NOT EXISTS idx_emails_contact      ON emails(contact_id);
  CREATE INDEX IF NOT EXISTS idx_appts_contact       ON appointments(contact_id);
  CREATE INDEX IF NOT EXISTS idx_appts_datetime      ON appointments(appt_datetime);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_retirement_intakes_token       ON retirement_intakes(token);
  CREATE INDEX IF NOT EXISTS idx_retirement_intakes_contact     ON retirement_intakes(contact_id);
  CREATE INDEX IF NOT EXISTS idx_retirement_intakes_appointment ON retirement_intakes(appointment_id);
`);

// ─── Follow-up tasks table ────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS follow_up_tasks (
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
  CREATE INDEX IF NOT EXISTS idx_tasks_contact  ON follow_up_tasks(contact_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON follow_up_tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_tasks_status   ON follow_up_tasks(status);
`);

// ─── Migrations ───────────────────────────────────────────────────────────────
// Add columns to existing tables without dropping data. Safe to run on every boot.
function addCol(table, col, def) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); }
  catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}

// Lead management fields
addCol('contacts', 'lead_status',            "TEXT DEFAULT 'New Lead'");
addCol('contacts', 'sms_consent',            'INTEGER DEFAULT 0');
addCol('contacts', 'email_consent',          'INTEGER DEFAULT 0');
// Also added by crm/db/migrateRevenueMvp.js (kept there for that
// checkpoint's own bookkeeping) -- also added here, unconditionally on
// every boot, because crm/lib/legacySmsSend.js's consent gate (used by both
// the manual SMS composer and the automatic Retirement Intake SMS
// triggered from crm/routes/calcom.js) now depends on this column existing
// in every environment, not only after the separate production migration
// script has been run. addCol() is idempotent, so having it in both places
// is safe -- whichever runs first wins, the other is a no-op.
addCol('contacts', 'sms_opted_out_at',       'DATETIME');
addCol('contacts', 'appointment_booked',     'INTEGER DEFAULT 0');
addCol('contacts', 'appointment_date',       'TEXT');
addCol('contacts', 'last_contacted',         'TEXT');
// Retirement fields
addCol('contacts', 'retirement_assets',      'TEXT');
addCol('contacts', 'account_types',          'TEXT');
addCol('contacts', 'retirement_timeline',    'TEXT');
addCol('contacts', 'interested_in',          'TEXT');
addCol('contacts', 'existing_advisor',       'TEXT');
// Life insurance fields
addCol('contacts', 'coverage_goal',          'TEXT');
addCol('contacts', 'existing_coverage',      'TEXT');
addCol('contacts', 'mortgage_protection',    'INTEGER DEFAULT 0');
addCol('contacts', 'final_expense',          'INTEGER DEFAULT 0');
addCol('contacts', 'children_grandchildren', 'INTEGER DEFAULT 0');
// Retirement / rollover structured fields
addCol('contacts', 'retirement_account_type',       'TEXT');
addCol('contacts', 'current_institution',           'TEXT');
addCol('contacts', 'estimated_rollover_amount',     'REAL');
addCol('contacts', 'has_current_advisor',           'INTEGER DEFAULT 0');
addCol('contacts', 'interested_in_roth_conversion', 'INTEGER DEFAULT 0');
// Life insurance structured fields
addCol('contacts', 'insurance_company',   'TEXT');
addCol('contacts', 'policy_type',         'TEXT');
addCol('contacts', 'face_amount',         'REAL');
addCol('contacts', 'monthly_premium',     'REAL');
addCol('contacts', 'annual_premium',      'REAL');
addCol('contacts', 'policy_status',       'TEXT');
addCol('contacts', 'application_date',    'TEXT');
addCol('contacts', 'policy_issue_date',   'TEXT');
// Annuity structured fields
addCol('contacts', 'annuity_carrier',     'TEXT');
addCol('contacts', 'annuity_type',        'TEXT');
addCol('contacts', 'annuity_premium',     'REAL');
addCol('contacts', 'income_rider',        'INTEGER DEFAULT 0');
addCol('contacts', 'estimated_income',    'REAL');
addCol('contacts', 'surrender_period',    'TEXT');
// CRM / follow-up fields
addCol('contacts', 'next_follow_up_date', 'TEXT');
addCol('contacts', 'last_contact_date',   'TEXT');
addCol('contacts', 'commission_estimate', 'REAL');
// Click-to-call tracking
addCol('contacts', 'last_called_at',    'TEXT');
addCol('contacts', 'last_call_status',  'TEXT');
// Complete contact profile fields
// Mobile phone reuses the existing phone/phone_e164 columns (already the
// fields Twilio call/SMS routing matches contacts by) — no separate
// mobile_phone column, to avoid two phone fields drifting out of sync.
addCol('contacts', 'home_phone',                'TEXT');
addCol('contacts', 'preferred_contact_method',  'TEXT');
addCol('contacts', 'street_address',            'TEXT');
addCol('contacts', 'city',                      'TEXT');
addCol('contacts', 'state',                     'TEXT');
addCol('contacts', 'zip_code',                  'TEXT');
addCol('contacts', 'date_of_birth',             'TEXT');
addCol('contacts', 'age',                       'INTEGER');
addCol('contacts', 'marital_status',            'TEXT');
addCol('contacts', 'spouse_name',               'TEXT');
addCol('contacts', 'spouse_date_of_birth',      'TEXT');
addCol('contacts', 'number_of_children',        'INTEGER');
addCol('contacts', 'number_of_grandchildren',   'INTEGER');
addCol('contacts', 'family_notes',              'TEXT');
addCol('contacts', 'referred_by',               'TEXT');
// Distinct from the legacy unused 'notes' column (stripped from API
// responses in routes/contacts.js — old records have malformed data there).
addCol('contacts', 'general_notes',             'TEXT');
addCol('contacts', 'occupation',                'TEXT');
addCol('contacts', 'employer',                  'TEXT');
addCol('contacts', 'retirement_date_goal',      'TEXT');
addCol('contacts', 'best_time_to_contact',      'TEXT');
// comm_calls enrichment for click-to-call and voicemail
addCol('comm_calls', 'contact_name',      'TEXT');
addCol('comm_calls', 'notes',             'TEXT');
addCol('comm_calls', 'transcription',     'TEXT');
addCol('comm_calls', 'listened_at',       'TEXT'); // marks voicemail/missed as reviewed
addCol('comm_calls', 'auto_sms_sent',     'INTEGER DEFAULT 0');
addCol('comm_calls', 'recording_sid',     'TEXT');  // Twilio RecordingSid for deduplication
addCol('comm_calls', 'voicemail_left_at', 'TEXT');  // ISO timestamp set when agent marks VM left
addCol('comm_calls', 'voicemail_left_by', 'TEXT');  // who marked it — always 'agent' for now
// Cal.com integration
addCol('appointments', 'cal_booking_uid', 'TEXT');
// Link communications rows back to their appointment for deduplication
addCol('communications', 'appointment_id', 'INTEGER');
try {
  db.prepare('CREATE INDEX IF NOT EXISTS idx_comms_appt_id ON communications(appointment_id)').run();
} catch (e) { if (!e.message.includes('already exists')) throw e; }
try {
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_appts_cal_uid ON appointments(cal_booking_uid) WHERE cal_booking_uid IS NOT NULL'
  ).run();
} catch (e) {
  if (!e.message.includes('already exists')) throw e;
}

// sms_messages — unique index on twilio_sid for INSERT OR IGNORE deduplication
try {
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_twilio_sid ON sms_messages(twilio_sid) WHERE twilio_sid IS NOT NULL'
  ).run();
} catch (e) {
  if (!e.message.includes('already exists')) throw e;
}

// Which brand a Cal.com booking is for ('prosperity' | 'insurance-lady'),
// resolved once at webhook time (crm/routes/calcom.js's inferBookingBrand)
// and persisted here so the appointment-reminder scheduler
// (crm/lib/appointmentReminderScheduler.js) can pick the correct SMS
// template/Twilio sender later without the original webhook payload
// (Cal.com-created contacts have no contact_brands link -- see
// crm/lib/retirementIntakeSms.js's own comment). NULL for any appointment
// created before this column existed, or one not created via Cal.com --
// callers must default a NULL value to 'prosperity', matching
// inferBookingBrand's own existing default.
addCol('appointments', 'booking_brand', 'TEXT');

// Links an sms_messages row back to the appointment it's about (reminders,
// confirmation, reschedule notice) -- NULL for manual/STOP-HELP/missed-call
// SMS, which aren't about any specific appointment. message_type
// distinguishes what KIND of automated SMS this was in SMS History:
// 'confirmation' | 'reschedule' | 'reminder_24h' | 'reminder_1h' |
// 'reminder_15m' | NULL (manual send / other, unchanged from before this
// column existed).
addCol('sms_messages', 'appointment_id', 'INTEGER REFERENCES appointments(id)');
addCol('sms_messages', 'message_type',   'TEXT');
// A snapshot of appointments.appt_datetime AT THE TIME this SMS was sent --
// what crm/lib/appointmentReminderScheduler.js dedupes reminders by
// (appointment_id + message_type + appointment_occurrence_at), so a
// reschedule (which changes appt_datetime on the SAME appointment row)
// automatically makes each reminder type eligible again for the NEW time,
// without re-sending for the time that no longer applies. NULL for any SMS
// not tied to a specific appointment occurrence.
addCol('sms_messages', 'appointment_occurrence_at', 'TEXT');
try {
  db.prepare('CREATE INDEX IF NOT EXISTS idx_sms_appointment_id ON sms_messages(appointment_id)').run();
} catch (e) { if (!e.message.includes('already exists')) throw e; }
try {
  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_sms_reminder_dedup
    ON sms_messages(appointment_id, message_type, appointment_occurrence_at)
  `).run();
} catch (e) { if (!e.message.includes('already exists')) throw e; }

// One-time cleanup: remove communications rows with comm_type='sms' that were
// created as double-writes alongside sms_messages rows. These caused every SMS
// to appear twice in the SMS History card. Safe to run on every boot — the DELETE
// is a no-op once the duplicate rows are gone.
try {
  const del = db.prepare(`
    DELETE FROM communications
    WHERE comm_type = 'sms'
      AND id IN (
        SELECT c.id FROM communications c
        WHERE c.comm_type = 'sms'
          AND EXISTS (
            SELECT 1 FROM sms_messages s
            WHERE s.contact_id = c.contact_id
          )
      )
  `).run();
  if (del.changes > 0) {
    console.log(`[db/migration] removed ${del.changes} duplicate communications.sms row(s)`);
  }
} catch (e) {
  console.warn('[db/migration] sms cleanup skipped:', e.message);
}

// Gmail inbox sync — inbound email fields
addCol('emails', 'from_email', 'TEXT');
addCol('emails', 'thread_id',  'TEXT');
addCol('emails', 'direction',  "TEXT NOT NULL DEFAULT 'outbound'");
// Unique index enables INSERT OR IGNORE deduplication by Gmail message ID
try {
  db.prepare(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_gmail_msg_id ON emails(gmail_message_id) WHERE gmail_message_id IS NOT NULL'
  ).run();
} catch (e) {
  if (!e.message.includes('already exists')) throw e;
}

// Middle name/initial — client/policy CSV import (e.g. an existing carrier's
// book of business), for accurate legal-name records.
addCol('contacts', 'middle_name', 'TEXT');

// Application date, distinct from a policy's effective date — a per-POLICY
// field (a contact can have several policies with different application
// dates), so it belongs on `policies`, not `contacts`. Guarded: the
// `policies` table only exists once crm/db/migrateCrmApp.js has run, which
// (unlike this file) is not automatic on every boot — a fresh/test database
// that hasn't run it yet must not crash trying to ALTER a table that
// doesn't exist.
function tableExists(name) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}
if (tableExists('policies')) {
  addCol('policies', 'application_date', 'TEXT');
}

// Google Calendar task/follow-up sync (crm/lib/taskCalendarSync.js). No
// guard needed -- follow_up_tasks is created unconditionally above, in
// this same file. calendar_event_id ties a task to the ONE calendar event
// it owns (never more than one, per the duplicate-prevention design);
// calendar_sync_status ('synced' | 'failed' | 'not_applicable' | 'removed')
// is purely informational -- a failed or missing sync never blocks any
// task operation.
addCol('follow_up_tasks', 'calendar_event_id',    'TEXT');
addCol('follow_up_tasks', 'calendar_sync_status', 'TEXT');

// Manual contact/client entry: relationship type (Lead/Prospect vs Existing
// Client, independent of lead_type's source-tracking role -- see
// crm/lib/clientService.js's RELATIONSHIP_TYPES) and an SMS consent audit
// trail (source/date/notes) alongside the existing sms_consent flag. All
// nullable/additive -- sms_consent, sms_opted_out_at, and email_consent are
// unchanged. sms_consent_at is only ever set server-side when sms_consent
// transitions from false to true (crm/lib/clientService.js), never
// backfilled for existing rows.
addCol('contacts', 'relationship_type',   'TEXT');
addCol('contacts', 'sms_consent_source',  'TEXT');
addCol('contacts', 'sms_consent_at',      'DATETIME');
addCol('contacts', 'sms_consent_notes',   'TEXT');

module.exports = db;
