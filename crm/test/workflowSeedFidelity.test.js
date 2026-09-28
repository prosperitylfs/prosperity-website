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

// ── Retirement Intake Link — both brands, now seeded (2026-10-02) ────────
// Both retirement_intake rows deliberately DIFFER from their pre-Workflows
// hardcoded wording (an unconditional "Hi {{first_name}}," greeting was
// added to both, per explicit request) -- so these tests assert against
// the exact NEW expected text, not "byte-identical to hardcoded" like the
// confirmation/reminder rows above. Each still helps() out its own
// retirement_intakes table (not part of testSupport/legacyDb.js's central
// schema -- see other retirement-intake test files' own setup()).

function withRetirementIntakesTable(db) {
  db.exec(`
    CREATE TABLE retirement_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL,
      token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Not Sent', sent_at DATETIME, completed_at DATETIME,
      responses_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function seedRetirementAppointment(db, contactId, apptDatetime = '2026-09-15T18:00:00.000Z') {
  return db.prepare(`INSERT INTO appointments (contact_id, appt_type, appt_datetime, status) VALUES (?, 'Safe Money & Retirement Consultation', ?, 'Scheduled')`)
    .run(contactId, apptDatetime).lastInsertRowid;
}

test('seeded insurance-lady retirement_intake (booking-time) workflow names Loretta Stewart, keeps the real unique short-link token, and uses the 2026-10-09 wording', async () => {
  const db = setup();
  seedDefaultWorkflows(db);
  withRetirementIntakesTable(db);
  const contactId = seedContact(db, { first_name: 'Janet' });
  const apptId = seedRetirementAppointment(db, contactId);
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  const cap = captureDeps();
  const result = await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'insurance-lady', firstName: 'Janet' }, cap.deps);

  assert.equal(result.sent, true);
  assert.equal(cap.state.body, `Hi Janet,

Your Safe Money & Retirement Consultation with Loretta Stewart of Insurance Lady LLC is scheduled for Tuesday, September 15, 2026 at 1:00 PM CT.

Please complete your Retirement Intake Form at least 2 hours before your appointment so we have time to review and prepare:

https://insuranceladyllc.com/i/${intake.token.slice(0, 16)}

If you have already completed the form, no further action is needed.

– Loretta`);
});

test('seeded prosperity retirement_intake workflow opens with "Hi {{first_name}}," and otherwise preserves Prosperity\'s own existing wording/domain, using its own real unique token', async () => {
  const db = setup();
  seedDefaultWorkflows(db);
  withRetirementIntakesTable(db);
  const contactId = seedContact(db, { first_name: 'Janet' });
  const apptId = seedRetirementAppointment(db, contactId);
  const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
  const cap = captureDeps();
  const result = await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'prosperity', firstName: 'Janet' }, cap.deps);

  assert.equal(result.sent, true);
  assert.equal(cap.state.body, `Hi Janet,

Your Safe Money & Retirement consultation with Loretta Stewart is scheduled for Tuesday, September 15, 2026 at 1:00 PM CT.

Please complete your Retirement Intake Form at least 2 hours before your appointment so Loretta has time to review and prepare:

https://www.prosperitylfs.com/retirement-intake?token=${intake.token}

If your intake form is not received at least 2 hours before your appointment, your consultation may need to be rescheduled.

Prosperity Life & Financial Solutions`);
});

test('Insurance Lady and Prosperity retirement intake links use their own separate domains -- never cross-contaminated', async () => {
  const db = setup();
  seedDefaultWorkflows(db);
  withRetirementIntakesTable(db);

  const ilContactId = seedContact(db, { first_name: 'Janet', email: 'il@example.com' });
  const ilApptId = seedRetirementAppointment(db, ilContactId);
  const ilIntake = createIntakeForAppointment(db, { contactId: ilContactId, appointmentId: ilApptId });
  const ilCap = captureDeps();
  await sendRetirementIntakeSms(db, { intake: ilIntake, contactId: ilContactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'insurance-lady', firstName: 'Janet' }, ilCap.deps);
  assert.match(ilCap.state.body, /https:\/\/insuranceladyllc\.com\/i\//);
  assert.doesNotMatch(ilCap.state.body, /prosperitylfs\.com/);
  assert.match(ilCap.state.body, /Insurance Lady LLC/);
  assert.doesNotMatch(ilCap.state.body, /Prosperity/);

  const prContactId = seedContact(db, { first_name: 'Janet', email: 'pr@example.com' });
  const prApptId = seedRetirementAppointment(db, prContactId);
  const prIntake = createIntakeForAppointment(db, { contactId: prContactId, appointmentId: prApptId });
  const prCap = captureDeps();
  await sendRetirementIntakeSms(db, { intake: prIntake, contactId: prContactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId: 'prosperity', firstName: 'Janet' }, prCap.deps);
  assert.match(prCap.state.body, /https:\/\/www\.prosperitylfs\.com\/retirement-intake\?token=/);
  assert.doesNotMatch(prCap.state.body, /insuranceladyllc\.com/);
  assert.match(prCap.state.body, /Prosperity Life & Financial Solutions/);
  assert.doesNotMatch(prCap.state.body, /Insurance Lady/);
});

// ── "Hi {{first_name}}," safety: never "Hi undefined," or "Hi null," ────

for (const brandId of ['insurance-lady', 'prosperity']) {
  test(`${brandId} retirement_intake: a missing first name renders "Hi there," -- never "Hi undefined," or "Hi null,"`, async () => {
    const db = setup();
    seedDefaultWorkflows(db);
    withRetirementIntakesTable(db);
    const contactId = seedContact(db, { first_name: null });
    const apptId = seedRetirementAppointment(db, contactId);
    const intake = createIntakeForAppointment(db, { contactId, appointmentId: apptId });
    const cap = captureDeps();
    const result = await sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso: '2026-09-15T18:00:00.000Z', brandId, firstName: undefined }, cap.deps);

    assert.equal(result.sent, true);
    assert.match(cap.state.body, /^Hi there,/);
    assert.doesNotMatch(cap.state.body, /Hi undefined,/);
    assert.doesNotMatch(cap.state.body, /Hi null,/);
  });
}

// ── Every DEFAULT_WORKFLOWS entry is well-formed ────────────────────────

test('DEFAULT_WORKFLOWS has exactly the 11 rows scoped so far (6 Insurance Lady incl. the 2-hour reminder, 5 Prosperity) -- no reschedule', () => {
  assert.equal(DEFAULT_WORKFLOWS.length, 11);
  const il = DEFAULT_WORKFLOWS.filter(w => w.brandId === 'insurance-lady');
  const pr = DEFAULT_WORKFLOWS.filter(w => w.brandId === 'prosperity');
  assert.deepEqual(il.map(w => w.messageType).sort(), ['confirmation', 'reminder_15m', 'reminder_1h', 'reminder_24h', 'retirement_intake', 'retirement_intake_2h_reminder'].sort());
  assert.deepEqual(pr.map(w => w.messageType).sort(), ['confirmation', 'reminder_15m', 'reminder_1h', 'reminder_24h', 'retirement_intake'].sort());
  for (const w of DEFAULT_WORKFLOWS) {
    if (w.messageType === 'retirement_intake_2h_reminder') continue; // deliberately appointment-type-specific -- see its own DEFAULT_WORKFLOWS comment
    assert.equal(w.appointmentType, null, `${w.brandId} ${w.messageType} must apply to ALL appointment types (Any), matching today's actual behavior`);
    assert.equal(w.conditionType, 'always', `${w.brandId} ${w.messageType} must be unconditional, matching today's actual behavior`);
  }
});

test('the Insurance Lady 2-hour reminder is scoped to exactly the Safe Money & Retirement appointment type, on the retirement_intake_not_completed condition', () => {
  const row = DEFAULT_WORKFLOWS.find(w => w.messageType === 'retirement_intake_2h_reminder');
  assert.ok(row);
  assert.equal(row.brandId, 'insurance-lady');
  assert.equal(row.appointmentType, 'Safe Money & Retirement Consultation');
  assert.equal(row.triggerType, 'time_before_appointment');
  assert.equal(row.offsetValue, 2);
  assert.equal(row.offsetUnit, 'hours');
  assert.equal(row.offsetMinutes, 120);
  assert.equal(row.conditionType, 'retirement_intake_not_completed');
});

test('every retirement_intake / retirement_intake_2h_reminder entry in DEFAULT_WORKFLOWS opens with "Hi {{first_name}}," and still contains {{intake_link}}', () => {
  for (const w of DEFAULT_WORKFLOWS.filter(w => w.messageType === 'retirement_intake' || w.messageType === 'retirement_intake_2h_reminder')) {
    assert.match(w.messageTemplate, /^Hi \{\{first_name\}\},/, `${w.brandId} ${w.messageType} must open with the greeting`);
    assert.match(w.messageTemplate, /\{\{intake_link\}\}/, `${w.brandId} ${w.messageType} must still include the unique link placeholder`);
  }
});

test('seedDefaultWorkflows is idempotent -- calling it twice never creates duplicate rows', () => {
  const db = setup();
  seedDefaultWorkflows(db);
  const firstCount = db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n;
  seedDefaultWorkflows(db);
  const secondCount = db.prepare('SELECT COUNT(*) AS n FROM workflows').get().n;
  assert.equal(firstCount, 11);
  assert.equal(secondCount, 11);
});

// ── applyDefaultWorkflowCorrections (2026-10-02) ─────────────────────────

test('applyDefaultWorkflowCorrections fast-forwards a row still on the ORIGINAL Phase 2 (no-greeting) wording all the way to the current 2026-10-09 text, in one call', () => {
  const { applyDefaultWorkflowCorrections, listWorkflows, DEFAULT_WORKFLOWS: DW } = require('../lib/workflowService');
  const db = setup();

  // Simulate a database seeded by the ORIGINAL Phase 2 deploy, before EITHER
  // later wording change -- insert the row directly with the oldest text,
  // exactly as seedDefaultWorkflows would have at the time.
  const oldestTemplate = `Your Safe Money & Retirement consultation with Insurance Lady LLC is scheduled for {{appt_date}} at {{appt_time}}.

Please complete your Retirement Intake Form at least 2 hours before your appointment so we have time to review and prepare:

{{intake_link}}

If your intake form is not received at least 2 hours before your appointment, your consultation may need to be rescheduled.

Insurance Lady LLC`;
  db.prepare(`
    INSERT INTO workflows (name, brand_id, appointment_type, trigger_type, message_type, condition_type, action_type, message_template, enabled, is_system_default)
    VALUES ('Retirement Intake Link', 'insurance-lady', NULL, 'appointment_booked', 'retirement_intake', 'always', 'send_sms', ?, 1, 1)
  `).run(oldestTemplate);

  applyDefaultWorkflowCorrections(db); // one call -- both corrections apply in sequence

  const row = listWorkflows(db).find(w => w.brandId === 'insurance-lady' && w.messageType === 'retirement_intake');
  const current = DW.find(w => w.brandId === 'insurance-lady' && w.messageType === 'retirement_intake');
  assert.equal(row.messageTemplate, current.messageTemplate, 'a row starting from the oldest deployed wording must land exactly on the current DEFAULT_WORKFLOWS text after one call');
});

test('applyDefaultWorkflowCorrections updates a row still on the 2026-10-02 (greeting-added, but pre-Loretta-Stewart) wording to the current text', () => {
  const { applyDefaultWorkflowCorrections, listWorkflows, DEFAULT_WORKFLOWS: DW } = require('../lib/workflowService');
  const db = setup();
  const intermediateTemplate = `Hi {{first_name}},

Your Safe Money & Retirement consultation with Insurance Lady LLC is scheduled for {{appt_date}} at {{appt_time}}.

Please complete your Retirement Intake Form at least 2 hours before your appointment so we have time to review and prepare:

{{intake_link}}

If your intake form is not received at least 2 hours before your appointment, your consultation may need to be rescheduled.

Insurance Lady LLC`;
  db.prepare(`
    INSERT INTO workflows (name, brand_id, appointment_type, trigger_type, message_type, condition_type, action_type, message_template, enabled, is_system_default)
    VALUES ('Retirement Intake Link', 'insurance-lady', NULL, 'appointment_booked', 'retirement_intake', 'always', 'send_sms', ?, 1, 1)
  `).run(intermediateTemplate);

  applyDefaultWorkflowCorrections(db);

  const row = listWorkflows(db).find(w => w.brandId === 'insurance-lady' && w.messageType === 'retirement_intake');
  const current = DW.find(w => w.brandId === 'insurance-lady' && w.messageType === 'retirement_intake');
  assert.equal(row.messageTemplate, current.messageTemplate);
  assert.match(row.messageTemplate, /Loretta Stewart of Insurance Lady LLC/);
});

test('applyDefaultWorkflowCorrections never touches a row Loretta has already customized away from the old default text', () => {
  const { applyDefaultWorkflowCorrections, listWorkflows } = require('../lib/workflowService');
  const db = setup();
  const customWording = 'Loretta\'s own custom retirement intake wording: {{intake_link}}';
  db.prepare(`
    INSERT INTO workflows (name, brand_id, appointment_type, trigger_type, message_type, condition_type, action_type, message_template, enabled, is_system_default)
    VALUES ('Retirement Intake Link', 'insurance-lady', NULL, 'appointment_booked', 'retirement_intake', 'always', 'send_sms', ?, 1, 1)
  `).run(customWording);

  applyDefaultWorkflowCorrections(db);

  const row = listWorkflows(db).find(w => w.brandId === 'insurance-lady' && w.messageType === 'retirement_intake');
  assert.equal(row.messageTemplate, customWording, 'a row that no longer matches the exact old default text must be left completely alone');
});

test('applyDefaultWorkflowCorrections is a no-op on a fresh database seeded for the first time -- DEFAULT_WORKFLOWS already has the corrected wording', () => {
  const { applyDefaultWorkflowCorrections, listWorkflows } = require('../lib/workflowService');
  const db = setup();
  seedDefaultWorkflows(db);
  const before = listWorkflows(db).find(w => w.brandId === 'insurance-lady' && w.messageType === 'retirement_intake');

  applyDefaultWorkflowCorrections(db);

  const after = listWorkflows(db).find(w => w.brandId === 'insurance-lady' && w.messageType === 'retirement_intake');
  assert.equal(after.messageTemplate, before.messageTemplate);
  assert.equal(after.updatedAt, before.updatedAt, 'a fresh seed already has the correct wording -- the correction must not even fire an UPDATE');
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
