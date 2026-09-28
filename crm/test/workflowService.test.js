// Tests for crm/lib/workflowService.js -- Version 1 Workflows (2026-09-28):
// validation, CRUD, condition evaluation, message rendering, and the
// specificity rule selectWorkflowForOccurrence/selectWorkflowsForOccurrence
// use to pick a single row (or a small conditional set) for a given
// brand/appointment type/message type. Pure unit tests against workflowService
// itself -- crm/test/appointmentConfirmationSms.test.js and
// crm/test/retirementIntakeSms.test.js separately cover the SENDER-SIDE
// integration (fallback to hardcoded wording when no row matches).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const {
  VALID_BRANDS, VALID_TRIGGER_TYPES, VALID_CONDITION_TYPES, VALID_OFFSET_UNITS, VALID_ACTION_TYPES,
  VALID_MESSAGE_TYPES, MESSAGE_TYPES_REQUIRING_INTAKE_LINK,
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow,
  evaluateCondition, renderWorkflowMessage,
  selectWorkflowsForOccurrence, selectWorkflowForOccurrence,
} = require('../lib/workflowService');

function setup() {
  return createLegacyDb();
}

function baseFields(overrides = {}) {
  return {
    name: '24 Hour Reminder', brandId: 'prosperity', triggerType: 'time_before_appointment',
    offsetValue: 24, offsetUnit: 'hours', messageType: 'reminder_24h', conditionType: 'always',
    actionType: 'send_sms', messageTemplate: 'Hi {{first_name}}, reminder for {{appt_date}}.',
    ...overrides,
  };
}

// ── Constants ────────────────────────────────────────────────────────────

test('exported constant vocabularies match the approved Version 1 design', () => {
  assert.deepEqual(VALID_BRANDS, ['prosperity', 'insurance-lady']);
  assert.deepEqual(VALID_TRIGGER_TYPES, ['appointment_booked', 'time_before_appointment']);
  assert.deepEqual(VALID_CONDITION_TYPES, ['always', 'retirement_intake_completed', 'retirement_intake_not_completed']);
  assert.deepEqual(VALID_OFFSET_UNITS, ['minutes', 'hours', 'days']);
  assert.deepEqual(VALID_ACTION_TYPES, ['send_sms']);
  assert.deepEqual(MESSAGE_TYPES_REQUIRING_INTAKE_LINK, ['retirement_intake', 'retirement_intake_2h_reminder']);
  assert.ok(VALID_MESSAGE_TYPES.includes('retirement_intake_2h_reminder'));
});

// ── createWorkflow validation ────────────────────────────────────────────

test('createWorkflow persists a valid "before the appointment" workflow and computes offsetMinutes from value+unit', () => {
  const db = setup();
  const w = createWorkflow(db, baseFields());
  assert.equal(w.name, '24 Hour Reminder');
  assert.equal(w.brandId, 'prosperity');
  assert.equal(w.offsetValue, 24);
  assert.equal(w.offsetUnit, 'hours');
  assert.equal(w.offsetMinutes, 1440, '24 hours must compute to 1440 minutes');
  assert.equal(w.enabled, true);
  assert.equal(w.isSystemDefault, false);
});

test('createWorkflow persists a valid "at time of booking" workflow with no offset at all', () => {
  const db = setup();
  const w = createWorkflow(db, baseFields({
    name: 'Booking Confirmation', triggerType: 'appointment_booked', offsetValue: undefined, offsetUnit: undefined,
    messageType: 'confirmation',
  }));
  assert.equal(w.triggerType, 'appointment_booked');
  assert.equal(w.offsetValue, null);
  assert.equal(w.offsetUnit, null);
  assert.equal(w.offsetMinutes, null);
});

test('createWorkflow rejects an unknown brand', () => {
  const db = setup();
  assert.throws(() => createWorkflow(db, baseFields({ brandId: 'acme-insurance' })), /brand/i);
});

test('createWorkflow rejects an unknown condition type -- no free-text/expression conditions allowed', () => {
  const db = setup();
  assert.throws(() => createWorkflow(db, baseFields({ conditionType: 'appointment_date > NOW()' })), /condition/i);
});

test('createWorkflow rejects "time_before_appointment" with no offset value/unit', () => {
  const db = setup();
  assert.throws(() => createWorkflow(db, baseFields({ offsetValue: undefined, offsetUnit: undefined })), /timing/i);
});

test('createWorkflow rejects "appointment_booked" if an offset value/unit is also supplied -- the two are mutually exclusive', () => {
  const db = setup();
  assert.throws(() => createWorkflow(db, baseFields({ triggerType: 'appointment_booked', messageType: 'confirmation' })), /cannot have/i);
});

test('createWorkflow rejects a zero, negative, or non-integer offset value -- reasonable guardrails, not a free-form expression', () => {
  const db = setup();
  for (const bad of [0, -5, 1.5, 'soon']) {
    assert.throws(() => createWorkflow(db, baseFields({ offsetValue: bad })), /positive whole number/);
  }
});

test('createWorkflow rejects an offset beyond the sane 90-day guardrail', () => {
  const db = setup();
  assert.throws(() => createWorkflow(db, baseFields({ offsetValue: 91, offsetUnit: 'days' })), /too far/);
});

test('createWorkflow rejects an empty name or empty message', () => {
  const db = setup();
  assert.throws(() => createWorkflow(db, baseFields({ name: '' })), /name/i);
  assert.throws(() => createWorkflow(db, baseFields({ messageTemplate: '' })), /message/i);
});

test('createWorkflow requires {{intake_link}} for a retirement_intake message, but not for any other message type', () => {
  const db = setup();
  assert.throws(() => createWorkflow(db, baseFields({
    triggerType: 'appointment_booked', offsetValue: undefined, offsetUnit: undefined,
    messageType: 'retirement_intake', messageTemplate: 'No link included.',
  })), /\{\{intake_link\}\}/);

  const ok = createWorkflow(db, baseFields({
    triggerType: 'appointment_booked', offsetValue: undefined, offsetUnit: undefined,
    messageType: 'retirement_intake', messageTemplate: 'Complete it here: {{intake_link}}',
  }));
  assert.ok(ok.id);

  // reminder_24h (not in MESSAGE_TYPES_REQUIRING_INTAKE_LINK) is fine without it.
  const reminder = createWorkflow(db, baseFields());
  assert.ok(reminder.id);
});

// ── updateWorkflow (partial update) ─────────────────────────────────────

test('updateWorkflow can toggle only `enabled` without resending every other field', () => {
  const db = setup();
  const created = createWorkflow(db, baseFields());
  const disabled = updateWorkflow(db, created.id, { enabled: false });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.name, created.name, 'every other field must be preserved untouched');
  assert.equal(disabled.messageTemplate, created.messageTemplate);

  const reenabled = updateWorkflow(db, created.id, { enabled: true });
  assert.equal(reenabled.enabled, true);
});

test('updateWorkflow re-validates the MERGED result -- changing only messageTemplate on a retirement_intake row still enforces the {{intake_link}} guard', () => {
  const db = setup();
  const created = createWorkflow(db, baseFields({
    triggerType: 'appointment_booked', offsetValue: undefined, offsetUnit: undefined,
    messageType: 'retirement_intake', messageTemplate: 'Here: {{intake_link}}',
  }));
  assert.throws(() => updateWorkflow(db, created.id, { messageTemplate: 'Oops, no link.' }), /\{\{intake_link\}\}/);
});

test('updateWorkflow throws for an unknown id', () => {
  const db = setup();
  assert.throws(() => updateWorkflow(db, 999999, { enabled: false }), /unknown workflow/i);
});

// ── listWorkflows / getWorkflow ─────────────────────────────────────────

test('listWorkflows returns every row, getWorkflow returns null for an unknown id', () => {
  const db = setup();
  createWorkflow(db, baseFields({ name: 'A' }));
  createWorkflow(db, baseFields({ name: 'B', messageType: 'reminder_1h', offsetValue: 1, offsetUnit: 'hours' }));
  assert.equal(listWorkflows(db).length, 2);
  assert.equal(getWorkflow(db, 999999), null);
});

// ── evaluateCondition ────────────────────────────────────────────────────

test('evaluateCondition: "always" is always true, regardless of any retirement_intakes state', () => {
  const db = setup();
  assert.equal(evaluateCondition(db, 'always', { appointmentId: 1 }), true);
});

test('evaluateCondition: retirement_intake_completed / retirement_intake_not_completed reflect the actual stored status', () => {
  const db = setup();
  db.exec(`
    CREATE TABLE retirement_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL,
      token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Not Sent', sent_at DATETIME, completed_at DATETIME,
      responses_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare(`INSERT INTO retirement_intakes (contact_id, appointment_id, token, status) VALUES (1, 501, 'tok', 'Completed')`).run();
  db.prepare(`INSERT INTO retirement_intakes (contact_id, appointment_id, token, status) VALUES (2, 502, 'tok2', 'Sent')`).run();

  assert.equal(evaluateCondition(db, 'retirement_intake_completed', { appointmentId: 501 }), true);
  assert.equal(evaluateCondition(db, 'retirement_intake_not_completed', { appointmentId: 501 }), false);
  assert.equal(evaluateCondition(db, 'retirement_intake_completed', { appointmentId: 502 }), false);
  assert.equal(evaluateCondition(db, 'retirement_intake_not_completed', { appointmentId: 502 }), true);
});

test('evaluateCondition: NO retirement_intakes row at all is treated as NOT completed -- fails conservative', () => {
  const db = setup();
  db.exec(`
    CREATE TABLE retirement_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL,
      token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Not Sent', sent_at DATETIME, completed_at DATETIME,
      responses_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  assert.equal(evaluateCondition(db, 'retirement_intake_completed', { appointmentId: 999 }), false);
  assert.equal(evaluateCondition(db, 'retirement_intake_not_completed', { appointmentId: 999 }), true);
});

// ── renderWorkflowMessage ────────────────────────────────────────────────

test('renderWorkflowMessage substitutes every known placeholder and leaves a missing one as empty string', () => {
  const out = renderWorkflowMessage('Hi {{first_name}}, on {{appt_date}} at {{appt_time}} from {{brand_name}}: {{intake_link}}', {
    first_name: 'Janet', appt_date: 'Sept 15', appt_time: '1:00 PM',
  });
  assert.equal(out, 'Hi Janet, on Sept 15 at 1:00 PM from : ');
  assert.doesNotMatch(out, /\{\{|\}\}/);
});

// ── Selection / specificity ──────────────────────────────────────────────

function insertRow(db, overrides = {}) {
  return createWorkflow(db, baseFields(overrides));
}

test('selectWorkflowForOccurrence returns null when nothing matches -- the empty-table / no-match case callers fall back on', () => {
  const db = setup();
  assert.equal(selectWorkflowForOccurrence(db, { brandId: 'prosperity', appointmentType: 'Life Insurance Consultation', messageType: 'reminder_24h' }), null);
});

test('selectWorkflowForOccurrence never returns a disabled row', () => {
  const db = setup();
  const w = insertRow(db);
  updateWorkflow(db, w.id, { enabled: false });
  assert.equal(selectWorkflowForOccurrence(db, { brandId: 'prosperity', appointmentType: null, messageType: 'reminder_24h' }), null);
});

test('selectWorkflowForOccurrence never crosses brand or messageType boundaries', () => {
  const db = setup();
  insertRow(db, { brandId: 'insurance-lady' });
  insertRow(db, { messageType: 'reminder_1h', offsetValue: 1, offsetUnit: 'hours' });
  assert.equal(selectWorkflowForOccurrence(db, { brandId: 'prosperity', appointmentType: null, messageType: 'reminder_24h' }), null);
});

test('a generic ("Any appointment type") row matches any appointmentType, including null', () => {
  const db = setup();
  const w = insertRow(db); // appointmentType omitted -> NULL -> "Any"
  for (const apptType of [null, 'Life Insurance Consultation', 'Safe Money & Retirement Consultation']) {
    const found = selectWorkflowForOccurrence(db, { brandId: 'prosperity', appointmentType: apptType, messageType: 'reminder_24h' });
    assert.equal(found.id, w.id);
  }
});

test('an exact appointment_type match wins over a generic "Any" row for the same brand+messageType', () => {
  const db = setup();
  const generic = insertRow(db, { name: 'Generic 24h' });
  const specific = insertRow(db, { name: 'Retirement 24h', appointmentType: 'Safe Money & Retirement Consultation' });

  const forRetirement = selectWorkflowForOccurrence(db, { brandId: 'prosperity', appointmentType: 'Safe Money & Retirement Consultation', messageType: 'reminder_24h' });
  assert.equal(forRetirement.id, specific.id, 'the specific row must win');

  const forLifeInsurance = selectWorkflowForOccurrence(db, { brandId: 'prosperity', appointmentType: 'Life Insurance Consultation', messageType: 'reminder_24h' });
  assert.equal(forLifeInsurance.id, generic.id, 'a different, non-matching appointment type must fall back to the generic row');
});

test('selectWorkflowsForOccurrence returns EVERY row in the winning specificity tier -- lets a caller evaluate multiple mutually-exclusive conditions for the same (brand, appointmentType, messageType) slot', () => {
  const db = setup();
  const completed = insertRow(db, {
    name: '1h if completed', appointmentType: 'Safe Money & Retirement Consultation',
    messageType: 'reminder_1h', offsetValue: 1, offsetUnit: 'hours', conditionType: 'retirement_intake_completed',
  });
  const notCompleted = insertRow(db, {
    name: '1h if not completed', appointmentType: 'Safe Money & Retirement Consultation',
    messageType: 'reminder_1h', offsetValue: 1, offsetUnit: 'hours', conditionType: 'retirement_intake_not_completed',
  });

  const rows = selectWorkflowsForOccurrence(db, { brandId: 'prosperity', appointmentType: 'Safe Money & Retirement Consultation', messageType: 'reminder_1h' });
  assert.deepEqual(rows.map(r => r.id).sort(), [completed.id, notCompleted.id].sort(), 'both conditional rows for this slot must come back -- the caller evaluates each row\'s own condition to pick the one that applies');
});

test('the unique index prevents two enabled rows for the exact same (brand, messageType, appointmentType, conditionType) -- SQLite rejects the duplicate insert', () => {
  const db = setup();
  insertRow(db);
  assert.throws(() => insertRow(db, { name: 'Duplicate' }), /UNIQUE constraint failed/);
});
