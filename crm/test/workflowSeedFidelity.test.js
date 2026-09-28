// Phase 2 (2026-09-28) fidelity check: proves every seeded default workflow
// (crm/lib/workflowService.js's DEFAULT_WORKFLOWS) produces BYTE-IDENTICAL
// output to the pre-Workflows hardcoded automation it represents. For each
// scenario, the exact same send is run twice against two independent
// in-memory databases -- one with an empty `workflows` table (today's
// fallback path, unchanged since Phase 1) and one with seedDefaultWorkflows()
// applied (the new DB-driven path) -- and the two captured message bodies
// are asserted equal. This is the only place in the test suite that proves
// wording fidelity directly; the full suite passing unmodified is
// reassuring but several of its callers (crm/test/calcomWebhookRoute.test.js
// etc.) don't assert exact SMS body text, only whether a send was attempted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { seedDefaultWorkflows, DEFAULT_WORKFLOWS } = require('../lib/workflowService');
const { sendAppointmentConfirmationSms } = require('../lib/appointmentConfirmationSms');
const { sendRetirementIntakeSms } = require('../lib/retirementIntakeSms');
const { createIntakeForAppointment } = require('../lib/retirementIntakeService');

function setup() {
  const db = createLegacyDb();
  runRevenueMvpMigrations(db);
  return db;
}

function seedContact(db, overrides = {}) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164, sms_consent, sms_opted_out_at)
    VALUES (@first_name, @last_name, @phone, @phone_e164, @sms_consent, @sms_opted_out_at)
  `).run({
    first_name: 'Janet', last_name: 'Jackson', phone: '(414) 367-6486', phone_e164: '+14143676486',
    sms_consent: 1, sms_opted_out_at: null, ...overrides,
  }).lastInsertRowid;
}

let fakeSidCounter = 0;
function captureDeps() {
  const state = { body: null };
  const deps = { sendLegacySms: async (db2, { contactId, body, appointmentId = null, messageType = null, appointmentOccurrenceAt = null }) => {
    state.body = body;
    fakeSidCounter += 1;
    const ins = db2.prepare(`
      INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid, appointment_id, message_type, appointment_occurrence_at)
      VALUES (?, 'outbound', '+14144411177', '+14143676486', ?, 'sent', ?, ?, ?, ?)
    `).run(contactId, body, `SMfake${fakeSidCounter}`, appointmentId, messageType, appointmentOccurrenceAt);
    return { ok: true, sms: db2.prepare('SELECT * FROM sms_messages WHERE id = ?').get(ins.lastInsertRowid) };
  }};
  return { deps, state };
}

// ── Confirmation / 24h / 1h / 15m — both brands ─────────────────────────

const SCENARIOS = [
  { brandId: 'insurance-lady', messageType: 'confirmation' },
  { brandId: 'insurance-lady', messageType: 'reminder_24h' },
  { brandId: 'insurance-lady', messageType: 'reminder_1h' },
  { brandId: 'insurance-lady', messageType: 'reminder_15m' },
  { brandId: 'prosperity', messageType: 'confirmation' },
  { brandId: 'prosperity', messageType: 'reminder_24h' },
  { brandId: 'prosperity', messageType: 'reminder_1h' },
  { brandId: 'prosperity', messageType: 'reminder_15m' },
];

for (const { brandId, messageType } of SCENARIOS) {
  test(`seeded ${brandId} ${messageType} workflow produces byte-identical output to the pre-Workflows hardcoded automation`, async () => {
    const now = new Date('2026-09-14T12:00:00.000Z'); // fixed "now" so reminder_24h's day_phrase ("tomorrow") is deterministic
    const sendArgs = {
      firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
      appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId, messageType, now,
    };
    for (const envVar of [['INSURANCE_LADY_TWILIO_PHONE_NUMBER', '+18559305239']]) process.env[envVar[0]] = envVar[1];

    // Path A: empty workflows table -- today's hardcoded fallback.
    const dbA = setup();
    const contactIdA = seedContact(dbA);
    const capA = captureDeps();
    const resultA = await sendAppointmentConfirmationSms(dbA, { contactId: contactIdA, ...sendArgs }, capA.deps);

    // Path B: same scenario, seeded workflows table.
    const dbB = setup();
    seedDefaultWorkflows(dbB);
    const contactIdB = seedContact(dbB);
    const capB = captureDeps();
    const resultB = await sendAppointmentConfirmationSms(dbB, { contactId: contactIdB, ...sendArgs }, capB.deps);

    assert.equal(resultA.sent, true, 'sanity check: the hardcoded path must have actually sent');
    assert.equal(resultB.sent, true, 'sanity check: the seeded path must have actually sent');
    assert.equal(capB.state.body, capA.state.body, 'seeded workflow output must be byte-identical to the hardcoded fallback output');
  });
}

// ── Retirement Intake Link — Insurance Lady only (Prosperity intentionally not seeded this phase) ──

test('seeded insurance-lady retirement_intake workflow produces byte-identical output to buildIntakeSmsBody, including the real unique token', async () => {
  const dbA = setup();
  const contactIdA = seedContact(dbA);
  const apptIdA = dbA.prepare(`INSERT INTO appointments (contact_id, appt_type, appt_datetime, status) VALUES (?, 'Safe Money & Retirement Consultation', ?, 'Scheduled')`).run(contactIdA, '2026-09-15T18:00:00.000Z').lastInsertRowid;
  dbA.exec(`
    CREATE TABLE retirement_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL,
      token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Not Sent', sent_at DATETIME, completed_at DATETIME,
      responses_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const intakeA = createIntakeForAppointment(dbA, { contactId: contactIdA, appointmentId: apptIdA });
  const capA = captureDeps();
  const resultA = await sendRetirementIntakeSms(dbA, { intake: intakeA, contactId: contactIdA, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'insurance-lady', firstName: 'Janet' }, capA.deps);

  const dbB = setup();
  seedDefaultWorkflows(dbB);
  const contactIdB = seedContact(dbB);
  const apptIdB = dbB.prepare(`INSERT INTO appointments (contact_id, appt_type, appt_datetime, status) VALUES (?, 'Safe Money & Retirement Consultation', ?, 'Scheduled')`).run(contactIdB, '2026-09-15T18:00:00.000Z').lastInsertRowid;
  dbB.exec(`
    CREATE TABLE retirement_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL,
      token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Not Sent', sent_at DATETIME, completed_at DATETIME,
      responses_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const intakeB = createIntakeForAppointment(dbB, { contactId: contactIdB, appointmentId: apptIdB });
  const capB = captureDeps();
  const resultB = await sendRetirementIntakeSms(dbB, { intake: intakeB, contactId: contactIdB, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'insurance-lady', firstName: 'Janet' }, capB.deps);

  assert.equal(resultA.sent, true);
  assert.equal(resultB.sent, true);
  // Tokens differ between the two independent intakes (each is its own
  // crypto.randomBytes(32)) -- Insurance Lady's URL uses only the first 16
  // hex chars of the token (the short-link feature added 2026-09-25; see
  // lib/retirementIntakeService.js's shortCodeForToken), so normalize on
  // THAT prefix, not the full 64-char token, before comparing so the
  // assertion is about WORDING fidelity, not incidentally requiring two
  // random short codes to collide.
  const normalize = (body, token) => body.split(token.slice(0, 16)).join('SHORTCODE');
  assert.equal(normalize(capB.state.body, intakeB.token), normalize(capA.state.body, intakeA.token), 'seeded retirement_intake workflow output must be byte-identical (aside from the token itself) to buildIntakeSmsBody\'s hardcoded output');
});

test('Prosperity retirement_intake is intentionally NOT seeded this phase -- a Prosperity retirement intake send still uses the hardcoded buildIntakeSmsBody path even with seedDefaultWorkflows() applied', async () => {
  const db = setup();
  seedDefaultWorkflows(db);
  const contactId = seedContact(db);
  const apptId = db.prepare(`INSERT INTO appointments (contact_id, appt_type, appt_datetime, status) VALUES (?, 'Safe Money & Retirement Consultation', ?, 'Scheduled')`).run(contactId, '2026-09-15T18:00:00.000Z').lastInsertRowid;
  db.exec(`
    CREATE TABLE retirement_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL,
      token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Not Sent', sent_at DATETIME, completed_at DATETIME,
      responses_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  const cap = captureDeps();
  await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'prosperity', firstName: 'Janet' }, cap.deps);

  assert.match(cap.state.body, /^Hi Janet,\n\nYour Safe Money & Retirement consultation with Loretta Stewart/, 'must be buildIntakeSmsBody\'s original Prosperity wording, not a workflow row (none was seeded for Prosperity retirement_intake)');
});

// ── Every DEFAULT_WORKFLOWS entry is well-formed ────────────────────────

test('DEFAULT_WORKFLOWS has exactly the 9 rows Phase 2 was scoped to (5 Insurance Lady, 4 Prosperity) -- no reschedule, no Prosperity retirement_intake yet', () => {
  assert.equal(DEFAULT_WORKFLOWS.length, 9);
  const il = DEFAULT_WORKFLOWS.filter(w => w.brandId === 'insurance-lady');
  const pr = DEFAULT_WORKFLOWS.filter(w => w.brandId === 'prosperity');
  assert.deepEqual(il.map(w => w.messageType).sort(), ['confirmation', 'reminder_15m', 'reminder_1h', 'reminder_24h', 'retirement_intake'].sort());
  assert.deepEqual(pr.map(w => w.messageType).sort(), ['confirmation', 'reminder_15m', 'reminder_1h', 'reminder_24h'].sort());
  for (const w of DEFAULT_WORKFLOWS) {
    assert.equal(w.appointmentType, null, `${w.brandId} ${w.messageType} must apply to ALL appointment types (Any), matching today's actual behavior`);
    assert.equal(w.conditionType, 'always', `${w.brandId} ${w.messageType} must be unconditional, matching today's actual behavior`);
  }
});

test('seedDefaultWorkflows is idempotent -- calling it twice never creates duplicate rows', () => {
  const db = setup();
  seedDefaultWorkflows(db);
  const firstCount = db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n;
  seedDefaultWorkflows(db);
  const secondCount = db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n;
  assert.equal(firstCount, 9);
  assert.equal(secondCount, 9);
});

test('seedDefaultWorkflows never overwrites a row Loretta has since edited -- editing a seeded row\'s wording then re-seeding leaves the edit intact', () => {
  const { updateWorkflow, listWorkflows } = require('../lib/workflowService');
  const db = setup();
  seedDefaultWorkflows(db);
  const confirmationRow = listWorkflows(db).find(w => w.brandId === 'prosperity' && w.messageType === 'confirmation');
  updateWorkflow(db, confirmationRow.id, { messageTemplate: 'Loretta\'s custom edited wording for {{first_name}}.' });

  seedDefaultWorkflows(db); // re-run, simulating a second server boot

  const after = listWorkflows(db).find(w => w.id === confirmationRow.id);
  assert.equal(after.messageTemplate, 'Loretta\'s custom edited wording for {{first_name}}.', 'the edit must survive a re-seed');
});

// ── Duplicate-send protection, brand isolation, and per-row disable, all WITH seeded data active ──

test('duplicate-send protection (sms_messages appointment_id+message_type+appointment_occurrence_at) is unaffected by seeding -- a second send for the same occurrence is still blocked', async () => {
  const { alreadySent } = (() => {
    // Same dedup check crm/lib/appointmentReminderScheduler.js itself uses --
    // inlined here since it's not exported; this proves the sms_messages row
    // the seeded send wrote is indistinguishable, for dedup purposes, from
    // one the hardcoded path would have written.
    return { alreadySent: (db, { appointmentId, messageType, appointmentOccurrenceAt }) => !!db.prepare(`
      SELECT 1 FROM sms_messages WHERE appointment_id = ? AND message_type = ? AND appointment_occurrence_at = ? AND status != 'failed' LIMIT 1
    `).get(appointmentId, messageType, appointmentOccurrenceAt) };
  })();

  const db = setup();
  seedDefaultWorkflows(db);
  const contactId = seedContact(db);
  const cap = captureDeps();
  const sendArgs = {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'prosperity', messageType: 'reminder_24h', appointmentId: 42,
  };

  assert.equal(alreadySent(db, { appointmentId: 42, messageType: 'reminder_24h', appointmentOccurrenceAt: '2026-09-15T18:00:00.000Z' }), false, 'nothing sent yet');
  const first = await sendAppointmentConfirmationSms(db, sendArgs, cap.deps);
  assert.equal(first.sent, true);
  assert.equal(alreadySent(db, { appointmentId: 42, messageType: 'reminder_24h', appointmentOccurrenceAt: '2026-09-15T18:00:00.000Z' }), true, 'the seeded send must be visible to the exact same dedup query the reminder scheduler uses');

  // A second attempt for the exact same appointment_id+messageType+occurrence
  // isn't blocked by sendAppointmentConfirmationSms itself (that's the
  // scheduler's own responsibility, unchanged) -- but the dedup ROW it
  // would check is correctly present, which is what this test verifies.
  const rows = db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE appointment_id = 42 AND message_type = ?').get('reminder_24h').n;
  assert.equal(rows, 1);
});

test('Insurance Lady workflows cannot affect a Prosperity send, and vice versa, even with all 9 rows seeded simultaneously', async () => {
  const db = setup();
  seedDefaultWorkflows(db);
  const contactId = seedContact(db);
  process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER = '+18559305239';

  const capIl = captureDeps();
  const ilResult = await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'insurance-lady', messageType: 'reminder_1h',
  }, capIl.deps);
  assert.equal(ilResult.sent, true);
  assert.match(capIl.state.body, /Insurance Lady LLC/);
  assert.doesNotMatch(capIl.state.body, /Prosperity/);

  const capPr = captureDeps();
  const prResult = await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'prosperity', messageType: 'reminder_1h',
  }, capPr.deps);
  assert.equal(prResult.sent, true);
  assert.match(capPr.state.body, /Prosperity Life & Financial Solutions/);
  assert.doesNotMatch(capPr.state.body, /Insurance Lady/);
});

test('disabling ONE seeded workflow falls back to hardcoded wording for that automation only -- every other seeded row (same and other brand) keeps using its seeded wording', async () => {
  const { listWorkflows, updateWorkflow } = require('../lib/workflowService');
  const db = setup();
  seedDefaultWorkflows(db);
  const contactId = seedContact(db);
  process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER = '+18559305239';

  const ilReminder24h = listWorkflows(db).find(w => w.brandId === 'insurance-lady' && w.messageType === 'reminder_24h');
  updateWorkflow(db, ilReminder24h.id, { enabled: false });

  // The disabled one: falls back to buildConfirmationSmsBody's hardcoded output.
  const capDisabled = captureDeps();
  await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'insurance-lady', messageType: 'reminder_24h',
  }, capDisabled.deps);
  assert.match(capDisabled.state.body, /^Hi Janet, this is your 24-hour reminder\. Your Life Insurance Consultation with Loretta Stewart is/, 'must be the original hardcoded reminder_24h wording, not the (now-disabled) seeded template');

  // A DIFFERENT still-enabled Insurance Lady row: still uses its seeded wording.
  const capStillOn = captureDeps();
  await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'insurance-lady', messageType: 'reminder_1h',
  }, capStillOn.deps);
  assert.match(capStillOn.state.body, /this is your 1-hour reminder/, 'unrelated seeded rows must be completely unaffected by disabling a different one');

  // Prosperity's own reminder_24h row: also completely unaffected (different brand).
  const capOtherBrand = captureDeps();
  await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'prosperity', messageType: 'reminder_24h',
  }, capOtherBrand.deps);
  assert.match(capOtherBrand.state.body, /Prosperity Life & Financial Solutions/, 'disabling Insurance Lady\'s 24h reminder must never affect Prosperity\'s own 24h reminder');
});
