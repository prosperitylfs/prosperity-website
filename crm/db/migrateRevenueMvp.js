// Additive, idempotent migration supporting the "Prosperity Revenue MVP"
// checkpoint. Same safety pattern as every prior migration in this
// directory: never imports crm/db/database.js, never opens a connection
// itself, takes an explicit better-sqlite3 `db` handle. Never drops/renames
// a table or column, never deletes existing data.
//
// Deliberately reuses the EXISTING sms_messages / comm_calls /
// follow_up_tasks / unresolved_intake tables (already brand-aware via
// contact_brand_id / case_id columns added by crm/db/migrateBrands.js)
// rather than inventing parallel tables — the real Twilio-backed single-
// number system already writes to sms_messages/comm_calls in production,
// so this checkpoint's brand-aware Prosperity SMS/call features are built
// as a genuine extension of that same audit trail, not a fork of it.
//
// Additions, and why each is needed:
//
// - contacts.sms_opted_out_at — sent by the inbound SMS webhook when a
//   client replies STOP (crm/lib/inboundSmsService.js). Kept distinct from
//   sms_consent (which the STOP handler also clears) so there is a real,
//   separate audit timestamp for exactly when/whether a client opted out,
//   not just the current 0/1 state.
//
// - comm_calls.outcome / .summary / .manual_entry / .follow_up_task_id —
//   manual call logging (crm/lib/callLogService.js) needs a fixed outcome
//   value and a short summary distinct from the existing free-text `notes`
//   (used here as "detailed notes"); manual_entry distinguishes a logged
//   call from a real Twilio-tracked one; follow_up_task_id links back to
//   the follow-up task the call log created, if any.
//
// - sms_messages.failure_reason — architecture for a future live Twilio
//   integration to record why a send failed; nothing in this checkpoint
//   ever populates it (the fake adapter always returns 'blocked', never
//   'failed'), but the column exists now so the threaded text view
//   (Requirement 4) has somewhere to read a failure reason from once live.
//
// - idx_sms_twilio_sid — re-asserted here (IF NOT EXISTS) because this
//   migration, unlike crm/db/database.js, is also run against dbs built by
//   crm/testSupport/legacyDb.js, which does not create it. Required for
//   inbound webhook idempotency (INSERT OR IGNORE on duplicate twilio_sid).

function addCol(db, table, col, def) {
  try { db.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`).run(); }
  catch (e) { if (!e.message.includes('duplicate column')) throw e; }
}

function runRevenueMvpMigrations(db) {
  db.pragma('foreign_keys = ON');

  addCol(db, 'contacts', 'sms_opted_out_at', 'DATETIME');

  addCol(db, 'comm_calls', 'outcome', 'TEXT');
  addCol(db, 'comm_calls', 'summary', 'TEXT');
  addCol(db, 'comm_calls', 'manual_entry', 'INTEGER DEFAULT 0');
  addCol(db, 'comm_calls', 'follow_up_task_id', 'INTEGER');

  addCol(db, 'sms_messages', 'failure_reason', 'TEXT');

  try {
    db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_twilio_sid ON sms_messages(twilio_sid) WHERE twilio_sid IS NOT NULL').run();
  } catch (e) { if (!e.message.includes('already exists')) throw e; }
}

module.exports = { runRevenueMvpMigrations };
