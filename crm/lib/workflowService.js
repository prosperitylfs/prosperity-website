// Workflows: Version 1, 2026-09-28. Lets Loretta manage the CRM's
// automated appointment messages (confirmation, retirement intake link,
// 24h/1h/15m reminders) from the CRM UI -- see db/database.js's own
// header comment on the `workflows` table for the schema rationale.
//
// This module owns validation, CRUD, condition evaluation, and message
// rendering ONLY. It does not itself decide when to check anything or send
// anything -- lib/appointmentConfirmationSms.js and lib/retirementIntakeSms.js
// call selectWorkflowForOccurrence() at the moment they're about to build a
// message, and fall back to their existing pre-Workflows hardcoded
// behavior whenever it returns null (no enabled row matches). The actual
// send mechanics (Twilio, brand's sending number, sms_messages dedup) are
// completely unowned by this module and untouched by Version 1.
//
// ── Selection / specificity ─────────────────────────────────────────────
// selectWorkflowForOccurrence(db, { brandId, appointmentType, messageType })
// looks up enabled rows for (brand_id, message_type) -- message_type is the
// real identity of "which automation is this" (it's the same vocabulary
// sms_messages.message_type already uses, plus 'retirement_intake'), NOT
// trigger_type/offset, which are just scheduling metadata on the row.
// Among matches, a row whose appointment_type exactly equals the caller's
// appointmentType wins over a row with appointment_type NULL ("Any
// appointment type"); the unique index on the table guarantees at most one
// row can exist per (brand_id, message_type, appointment_type, condition_type)
// combination, so ties are not expected in practice -- if a caller ever
// needs BOTH a "some condition" and a "some other condition" row alive for
// the same (brand, message_type, appointment_type) slot (e.g. the Insurance
// Lady 1-hour reschedule-notice design), selectWorkflowForOccurrence
// returns every matching row (already narrowed to the most specific
// appointment_type tier) and the caller evaluates each one's condition in
// turn -- see selectWorkflowForOccurrence's own comment below for exactly
// how that's exposed.

const VALID_BRANDS = ['prosperity', 'insurance-lady'];
const VALID_TRIGGER_TYPES = ['appointment_booked', 'time_before_appointment'];
const VALID_CONDITION_TYPES = ['always', 'retirement_intake_completed', 'retirement_intake_not_completed'];
const VALID_OFFSET_UNITS = ['minutes', 'hours', 'days'];
const VALID_ACTION_TYPES = ['send_sms']; // Version 1 supports only sending an SMS.

// The complete, closed set of automations Version 1 can represent --
// message_type must be one of these (2026-09-28: previously free-text, an
// internal-terminology dropdown replaces it in the Workflows UI so Loretta
// never has to type an internal code like 'reminder_24h' by hand). Every
// value here is either an sms_messages.message_type value already used by
// the pre-Workflows hardcoded senders, or 'retirement_intake' (which has no
// sms_messages.message_type of its own -- see workflowService's own header
// comment / lib/retirementIntakeSms.js for why). Adding a genuinely new
// automation type in a future phase means adding it here first.
const MESSAGE_TYPE_OPTIONS = [
  { value: 'confirmation', label: 'Booking Confirmation' },
  { value: 'reschedule', label: 'Reschedule Notice' },
  { value: 'reminder_24h', label: '24 Hour Reminder' },
  { value: 'reminder_1h', label: '1 Hour Reminder' },
  { value: 'reminder_15m', label: '15 Minute Reminder' },
  { value: 'retirement_intake', label: 'Retirement Intake Link' },
  // 2026-10-09: deliberately a DIFFERENT value from 'retirement_intake'
  // above, even though both are conceptually "about the retirement
  // intake" -- selectWorkflowForOccurrence (this file, below) keys purely
  // on (brand_id, message_type), with appointment_type only breaking a
  // tie WITHIN that same message_type. If this reminder shared
  // 'retirement_intake' with the booking-time link, an Insurance Lady
  // Safe Money booking would make THIS row (appointment_type-specific)
  // win over the booking-time row (appointment_type: Any) for EVERY send
  // of that message_type, including the one at booking time -- silently
  // replacing the booking-time message with "coming up in 2 hours"
  // wording the moment the appointment is created. A distinct
  // message_type keeps the two sends completely independent: independent
  // selection, independent sms_messages dedup, independent scheduling
  // (see appointmentReminderScheduler.js's REMINDER_SPECS).
  { value: 'retirement_intake_2h_reminder', label: 'Retirement Intake — 2 Hour Reminder' },
];
const VALID_MESSAGE_TYPES = MESSAGE_TYPE_OPTIONS.map(o => o.value);

const UNIT_TO_MINUTES = { minutes: 1, hours: 60, days: 1440 };
const MAX_OFFSET_MINUTES = 90 * 1440; // 90 days -- a sane upper bound, not a real limit anyone should need.

// message_type values whose message_template MUST retain the literal
// {{intake_link}} placeholder -- enforced on every create/update so the
// wording can be freely edited without ever silently dropping the client's
// unique link.
const MESSAGE_TYPES_REQUIRING_INTAKE_LINK = ['retirement_intake', 'retirement_intake_2h_reminder'];

function toStringOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function computeOffsetMinutes(offsetValue, offsetUnit) {
  const factor = UNIT_TO_MINUTES[offsetUnit];
  if (!factor) throw new Error(`workflowService: unknown offset unit '${offsetUnit}' -- must be one of ${VALID_OFFSET_UNITS.join(', ')}`);
  const n = Number(offsetValue);
  if (!Number.isInteger(n) || n <= 0) throw new Error('workflowService: offset value must be a positive whole number');
  const minutes = n * factor;
  if (minutes > MAX_OFFSET_MINUTES) throw new Error(`workflowService: offset is too far in the future (max ${MAX_OFFSET_MINUTES / 1440} days before the appointment)`);
  return minutes;
}

// Validates a merged (existing + incoming) field set. Throws a clear,
// specific Error on the first problem found -- callers (routes/crmActions.js)
// surface Error.message directly as the API's 400 response body.
function validateWorkflowFields(fields) {
  if (!toStringOrNull(fields.name)) throw new Error('workflowService: a workflow name is required');
  if (!VALID_BRANDS.includes(fields.brandId)) throw new Error(`workflowService: brand must be one of ${VALID_BRANDS.join(', ')}`);
  if (!VALID_TRIGGER_TYPES.includes(fields.triggerType)) throw new Error(`workflowService: trigger type must be one of ${VALID_TRIGGER_TYPES.join(', ')}`);
  if (!VALID_CONDITION_TYPES.includes(fields.conditionType)) throw new Error(`workflowService: condition must be one of ${VALID_CONDITION_TYPES.join(', ')}`);
  if (!VALID_ACTION_TYPES.includes(fields.actionType)) throw new Error(`workflowService: action must be one of ${VALID_ACTION_TYPES.join(', ')}`);
  if (!VALID_MESSAGE_TYPES.includes(fields.messageType)) throw new Error(`workflowService: message type must be one of ${VALID_MESSAGE_TYPES.join(', ')}`);
  if (!toStringOrNull(fields.messageTemplate)) throw new Error('workflowService: a message is required');

  if (fields.triggerType === 'time_before_appointment') {
    if (fields.offsetValue == null || fields.offsetUnit == null) {
      throw new Error('workflowService: "Before the appointment" workflows require a timing value and unit');
    }
  } else if (fields.offsetValue != null || fields.offsetUnit != null) {
    throw new Error('workflowService: "At time of booking" workflows cannot have a timing value/unit');
  }

  if (MESSAGE_TYPES_REQUIRING_INTAKE_LINK.includes(fields.messageType) && !String(fields.messageTemplate).includes('{{intake_link}}')) {
    throw new Error('workflowService: this message must include the {{intake_link}} placeholder so the client\'s unique intake link is still sent');
  }
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    brandId: row.brand_id,
    appointmentType: row.appointment_type,
    triggerType: row.trigger_type,
    offsetValue: row.offset_value,
    offsetUnit: row.offset_unit,
    offsetMinutes: row.offset_minutes,
    messageType: row.message_type,
    conditionType: row.condition_type,
    actionType: row.action_type,
    messageTemplate: row.message_template,
    enabled: !!row.enabled,
    isSystemDefault: !!row.is_system_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listWorkflows(db) {
  return db.prepare(`
    SELECT * FROM workflows
    ORDER BY brand_id, message_type, appointment_type IS NULL, appointment_type
  `).all().map(mapRow);
}

function getWorkflow(db, id) {
  return mapRow(db.prepare('SELECT * FROM workflows WHERE id = ?').get(id));
}

function createWorkflow(db, fields) {
  const merged = {
    name: fields.name, brandId: fields.brandId, appointmentType: toStringOrNull(fields.appointmentType),
    triggerType: fields.triggerType, offsetValue: fields.offsetValue ?? null, offsetUnit: fields.offsetUnit ?? null,
    messageType: fields.messageType, conditionType: fields.conditionType || 'always',
    actionType: fields.actionType || 'send_sms', messageTemplate: fields.messageTemplate,
    enabled: fields.enabled !== undefined ? !!fields.enabled : true,
  };
  validateWorkflowFields(merged);
  const offsetMinutes = merged.triggerType === 'time_before_appointment' ? computeOffsetMinutes(merged.offsetValue, merged.offsetUnit) : null;

  const result = db.prepare(`
    INSERT INTO workflows (
      name, brand_id, appointment_type, trigger_type, offset_value, offset_unit, offset_minutes,
      message_type, condition_type, action_type, message_template, enabled
    ) VALUES (
      @name, @brand_id, @appointment_type, @trigger_type, @offset_value, @offset_unit, @offset_minutes,
      @message_type, @condition_type, @action_type, @message_template, @enabled
    )
  `).run({
    name: merged.name, brand_id: merged.brandId, appointment_type: merged.appointmentType,
    trigger_type: merged.triggerType, offset_value: merged.offsetValue, offset_unit: merged.offsetUnit,
    offset_minutes: offsetMinutes, message_type: merged.messageType, condition_type: merged.conditionType,
    action_type: merged.actionType, message_template: merged.messageTemplate, enabled: merged.enabled ? 1 : 0,
  });
  return getWorkflow(db, result.lastInsertRowid);
}

// Partial update -- any field not present in `fields` keeps its existing
// value. The merged (existing + incoming) result is re-validated as a
// whole, exactly like createWorkflow, so e.g. toggling only `enabled` on a
// row that's already valid never fails, but changing triggerType away from
// 'time_before_appointment' without also clearing offsetValue/offsetUnit
// (or vice versa) is still caught.
function updateWorkflow(db, id, fields) {
  const existing = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
  if (!existing) throw new Error(`workflowService: unknown workflow id ${id}`);

  const merged = {
    name: fields.name !== undefined ? fields.name : existing.name,
    brandId: fields.brandId !== undefined ? fields.brandId : existing.brand_id,
    appointmentType: fields.appointmentType !== undefined ? toStringOrNull(fields.appointmentType) : existing.appointment_type,
    triggerType: fields.triggerType !== undefined ? fields.triggerType : existing.trigger_type,
    offsetValue: fields.offsetValue !== undefined ? fields.offsetValue : existing.offset_value,
    offsetUnit: fields.offsetUnit !== undefined ? fields.offsetUnit : existing.offset_unit,
    messageType: fields.messageType !== undefined ? fields.messageType : existing.message_type,
    conditionType: fields.conditionType !== undefined ? fields.conditionType : existing.condition_type,
    actionType: fields.actionType !== undefined ? fields.actionType : existing.action_type,
    messageTemplate: fields.messageTemplate !== undefined ? fields.messageTemplate : existing.message_template,
    enabled: fields.enabled !== undefined ? !!fields.enabled : !!existing.enabled,
  };
  validateWorkflowFields(merged);
  const offsetMinutes = merged.triggerType === 'time_before_appointment' ? computeOffsetMinutes(merged.offsetValue, merged.offsetUnit) : null;

  db.prepare(`
    UPDATE workflows SET
      name = @name, brand_id = @brand_id, appointment_type = @appointment_type,
      trigger_type = @trigger_type, offset_value = @offset_value, offset_unit = @offset_unit,
      offset_minutes = @offset_minutes, message_type = @message_type, condition_type = @condition_type,
      action_type = @action_type, message_template = @message_template, enabled = @enabled,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    id, name: merged.name, brand_id: merged.brandId, appointment_type: merged.appointmentType,
    trigger_type: merged.triggerType, offset_value: merged.offsetValue, offset_unit: merged.offsetUnit,
    offset_minutes: offsetMinutes, message_type: merged.messageType, condition_type: merged.conditionType,
    action_type: merged.actionType, message_template: merged.messageTemplate, enabled: merged.enabled ? 1 : 0,
  });
  return getWorkflow(db, id);
}

// A missing retirement_intakes row (no intake was ever created for this
// appointment) is treated as NOT completed -- fails conservative, matching
// the business intent ("don't assume completed just because we don't know").
function evaluateCondition(db, conditionType, { appointmentId }) {
  if (conditionType === 'always') return true;
  if (!VALID_CONDITION_TYPES.includes(conditionType)) {
    throw new Error(`workflowService: unknown condition type '${conditionType}'`);
  }
  const intake = db.prepare('SELECT status FROM retirement_intakes WHERE appointment_id = ?').get(appointmentId);
  const completed = !!intake && intake.status === 'Completed';
  return conditionType === 'retirement_intake_completed' ? completed : !completed;
}

// Same {{key}} substitution convention as lib/appointmentConfirmationSms.js's
// fillTemplate -- a missing var simply renders as empty string, never
// leaves a literal {{token}} in the sent message.
function renderWorkflowMessage(template, vars = {}) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

// Returns EVERY enabled row matching (brand_id, message_type), narrowed to
// the single most specific appointment_type tier (an exact match, if any
// exist; otherwise every "Any appointment type" row) -- never a mix of
// both tiers. Callers that only expect one active condition at a time
// (Version 1: nothing yet creates more than one enabled row per tier) can
// just use result[0]; a caller evaluating multiple mutually-exclusive
// conditions for the same slot (e.g. a future "completed" vs "not
// completed" pair) should evaluate each returned row's conditionType in
// turn and use whichever one matches.
function selectWorkflowsForOccurrence(db, { brandId, appointmentType, messageType }) {
  const rows = db.prepare(`
    SELECT * FROM workflows WHERE enabled = 1 AND brand_id = ? AND message_type = ?
  `).all(brandId, messageType);

  const specific = appointmentType ? rows.filter(r => r.appointment_type === appointmentType) : [];
  const tier = specific.length ? specific : rows.filter(r => !r.appointment_type);
  return tier.map(mapRow);
}

// Convenience wrapper for the common case (Version 1: at most one enabled
// row per tier in practice) -- returns the first matching row, or null.
function selectWorkflowForOccurrence(db, params) {
  const rows = selectWorkflowsForOccurrence(db, params);
  return rows.length ? rows[0] : null;
}

// ── Default seed data (Phase 2, 2026-09-28; updated 2026-10-02) ─────────
// Phase 2 was a byte-for-byte migration of the pre-Workflows hardcoded
// automations. Two later, explicitly requested changes (2026-10-02) departed
// from strict byte-identical fidelity on purpose:
//   - Insurance Lady's retirement_intake now opens with "Hi {{first_name}},"
//     -- it never had a greeting before. See DEFAULT_WORKFLOW_CORRECTIONS
//     below for how an ALREADY-SEEDED production row (from the original
//     Phase 2 deploy) picks up this wording safely.
//   - Prosperity's retirement_intake is now seeded too, also always opening
//     with "Hi {{first_name}}," -- this removes the one obstacle that kept
//     it unseeded in Phase 2 (the hardcoded version's conditional greeting,
//     present only when firstName was truthy, omitted as a whole LINE
//     otherwise -- a flat {{first_name}} placeholder could only blank the
//     name, not remove the line). Making the greeting unconditional (with a
//     "there" fallback, matching every other "Hi {{first_name}}," message in
//     this codebase) removes that obstacle entirely.
// Both brands' underlying lib/retirementIntakeSms.js hardcoded fallback
// strings are UNCHANGED -- if either seeded row is ever disabled, the send
// reverts to the original (Insurance Lady: no greeting; Prosperity:
// conditional greeting) wording, exactly as before this change.
//
// One remaining deliberate omission:
//   - 'reschedule' (both brands): not in the set Loretta asked to migrate.
//     Stays on the config/templates.js hardcoded fallback, unaffected.
function offsetFields(value, unit) {
  return { offsetValue: value, offsetUnit: unit, offsetMinutes: computeOffsetMinutes(value, unit) };
}

const DEFAULT_WORKFLOWS = [
  // ── Insurance Lady ───────────────────────────────────────────────────
  {
    name: 'Booking Confirmation', brandId: 'insurance-lady', appointmentType: null,
    triggerType: 'appointment_booked', messageType: 'confirmation', conditionType: 'always',
    // Source: config/templates.js TEMPLATES['insurance-lady'].appointmentConfirmationSms.body
    messageTemplate: 'Hi {{first_name}}, your {{appointment_type}} with Loretta Stewart is confirmed for {{appt_date}} at {{appt_time}}. Loretta will call you at the scheduled time. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.',
  },
  {
    name: '24 Hour Reminder', brandId: 'insurance-lady', appointmentType: null,
    triggerType: 'time_before_appointment', ...offsetFields(24, 'hours'), messageType: 'reminder_24h', conditionType: 'always',
    // Source: config/templates.js TEMPLATES['insurance-lady'].reminder24hSms.body
    messageTemplate: 'Hi {{first_name}}, this is your 24-hour reminder. Your {{appointment_type}} with Loretta Stewart is {{day_phrase}} at {{appt_time}}. Loretta will call you at the scheduled time. Need to reschedule? Reply RESCHEDULE. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.',
  },
  {
    name: '1 Hour Reminder', brandId: 'insurance-lady', appointmentType: null,
    triggerType: 'time_before_appointment', ...offsetFields(1, 'hours'), messageType: 'reminder_1h', conditionType: 'always',
    // Source: config/templates.js TEMPLATES['insurance-lady'].reminder1hSms.body
    messageTemplate: 'Hi {{first_name}}, this is your 1-hour reminder. Your {{appointment_type}} with Loretta Stewart begins at {{appt_time}}. Loretta will call you at the scheduled time. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.',
  },
  {
    name: '15 Minute Reminder', brandId: 'insurance-lady', appointmentType: null,
    triggerType: 'time_before_appointment', ...offsetFields(15, 'minutes'), messageType: 'reminder_15m', conditionType: 'always',
    // Source: config/templates.js TEMPLATES['insurance-lady'].reminder15mSms.body
    messageTemplate: 'Hi {{first_name}}, this is your 15-minute reminder. Your {{appointment_type}} with Loretta Stewart begins at {{appt_time}}. Loretta will call you at the scheduled time. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.',
  },
  {
    name: 'Retirement Intake Link', brandId: 'insurance-lady', appointmentType: null,
    triggerType: 'appointment_booked', messageType: 'retirement_intake', conditionType: 'always',
    // Wording updated 2026-10-09 to name Loretta Stewart and shorten the
    // deadline language -- see DEFAULT_WORKFLOW_CORRECTIONS below for how
    // an already-seeded production row (from the original Phase 2 deploy,
    // or the 2026-10-02 greeting update) picks this up safely.
    messageTemplate: `Hi {{first_name}},

Your Safe Money & Retirement Consultation with Loretta Stewart of Insurance Lady LLC is scheduled for {{appt_date}} at {{appt_time}}.

Please complete your Retirement Intake Form at least 2 hours before your appointment so we have time to review and prepare:

{{intake_link}}

If you have already completed the form, no further action is needed.

– Loretta`,
  },
  {
    name: 'Retirement Intake - 2 Hour Reminder', brandId: 'insurance-lady',
    // Specific on purpose (unlike every other Insurance Lady row, which is
    // Any) -- this reminder must never fire for a Life Insurance
    // Consultation or Policy Review appointment that happens to be 2 hours
    // out at the same moment. See appointmentReminderScheduler.js's
    // REMINDER_SPECS for the new 115-125 minute polling window this row
    // depends on, and appointmentConfirmationSms.js's buildConfirmationSmsBody
    // for why an appointment/brand with NO matching row here (i.e.
    // everyone else in that same window) gets nothing sent at all rather
    // than a fallback message.
    appointmentType: 'Safe Money & Retirement Consultation',
    triggerType: 'time_before_appointment', ...offsetFields(2, 'hours'),
    messageType: 'retirement_intake_2h_reminder', conditionType: 'retirement_intake_not_completed',
    messageTemplate: `Hi {{first_name}},

Your Safe Money & Retirement Consultation with Loretta Stewart of Insurance Lady LLC is coming up in 2 hours.

We have not yet received your Retirement Intake Form. Please complete it now so we have time to review your information and prepare for your consultation:

{{intake_link}}

If you have already completed the form, no further action is needed.

– Loretta`,
  },

  // ── Prosperity ───────────────────────────────────────────────────────
  {
    name: 'Booking Confirmation', brandId: 'prosperity', appointmentType: null,
    triggerType: 'appointment_booked', messageType: 'confirmation', conditionType: 'always',
    // Source: config/templates.js TEMPLATES.prosperity.appointmentConfirmationSms.body
    messageTemplate: 'Hi {{first_name}}, your {{appointment_type}} with Loretta Stewart is confirmed for {{appt_date}} at {{appt_time}}. Loretta will call you at the scheduled time. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.',
  },
  {
    name: '24 Hour Reminder', brandId: 'prosperity', appointmentType: null,
    triggerType: 'time_before_appointment', ...offsetFields(24, 'hours'), messageType: 'reminder_24h', conditionType: 'always',
    // Source: config/templates.js TEMPLATES.prosperity.reminder24hSms.body
    messageTemplate: 'Hi {{first_name}}, this is your 24-hour reminder. Your {{appointment_type}} with Loretta Stewart is {{day_phrase}} at {{appt_time}}. Loretta will call you at the scheduled time. Need to reschedule? Reply RESCHEDULE. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.',
  },
  {
    name: '1 Hour Reminder', brandId: 'prosperity', appointmentType: null,
    triggerType: 'time_before_appointment', ...offsetFields(1, 'hours'), messageType: 'reminder_1h', conditionType: 'always',
    // Source: config/templates.js TEMPLATES.prosperity.reminder1hSms.body
    messageTemplate: 'Hi {{first_name}}, this is your 1-hour reminder. Your {{appointment_type}} with Loretta Stewart begins at {{appt_time}}. Loretta will call you at the scheduled time. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.',
  },
  {
    name: '15 Minute Reminder', brandId: 'prosperity', appointmentType: null,
    triggerType: 'time_before_appointment', ...offsetFields(15, 'minutes'), messageType: 'reminder_15m', conditionType: 'always',
    // Source: config/templates.js TEMPLATES.prosperity.reminder15mSms.body
    messageTemplate: 'Hi {{first_name}}, this is your 15-minute reminder. Your {{appointment_type}} with Loretta Stewart begins at {{appt_time}}. Loretta will call you at the scheduled time. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.',
  },
  {
    name: 'Retirement Intake Link', brandId: 'prosperity', appointmentType: null,
    triggerType: 'appointment_booked', messageType: 'retirement_intake', conditionType: 'always',
    // Source: lib/retirementIntakeSms.js buildIntakeSmsBody's prosperity
    // branch (Loretta Stewart / "so Loretta has time" wording -- distinct
    // from Insurance Lady's own phrasing, preserved exactly, not
    // homogenized), plus an unconditional "Hi {{first_name}}," greeting
    // added 2026-10-02 (the hardcoded branch only added one when firstName
    // was truthy, omitting the whole line otherwise -- see this file's
    // header comment for why that's what kept this row unseeded in Phase
    // 2). The intake link itself is generated exactly as before -- see
    // WORKFLOW_MESSAGE_TYPE's own comment in lib/retirementIntakeSms.js:
    // buildIntakeUrl(intake.token, brandId) resolves Prosperity's own
    // domain (prosperitylfs.com), never Insurance Lady's.
    messageTemplate: `Hi {{first_name}},

Your Safe Money & Retirement consultation with Loretta Stewart is scheduled for {{appt_date}} at {{appt_time}}.

Please complete your Retirement Intake Form at least 2 hours before your appointment so Loretta has time to review and prepare:

{{intake_link}}

If your intake form is not received at least 2 hours before your appointment, your consultation may need to be rescheduled.

Prosperity Life & Financial Solutions`,
  },
  {
    // 2026-10-13: mirrors the Insurance Lady 2-hour reminder above as
    // closely as possible -- same appointment-type-specific scoping, same
    // condition, same offset, and deliberately the SAME message_type
    // ('retirement_intake_2h_reminder') rather than a new one. This is
    // safe and intentional: selectWorkflowForOccurrence (below) keys on
    // (brand_id, message_type) TOGETHER, so this row and Insurance Lady's
    // never collide -- brand_id alone already keeps them completely
    // independent for selection, sms_messages dedup, and scheduling. No
    // scheduler, sender, or UI change was needed for this row at all: the
    // 115-125 minute window in appointmentReminderScheduler.js's
    // REMINDER_SPECS and the null-fallback safety fix in
    // appointmentConfirmationSms.js's buildConfirmationSmsBody are both
    // already brand-agnostic, and buildIntakeUrl already resolves
    // Prosperity's own domain (prosperitylfs.com, full-token URL) from
    // the same brandId parameter every other Prosperity send already
    // uses -- see appointmentConfirmationSms.js's own {{intake_link}}
    // comment for exactly how that lookup works.
    name: 'Retirement Intake - 2 Hour Reminder', brandId: 'prosperity',
    appointmentType: 'Safe Money & Retirement Consultation',
    triggerType: 'time_before_appointment', ...offsetFields(2, 'hours'),
    messageType: 'retirement_intake_2h_reminder', conditionType: 'retirement_intake_not_completed',
    messageTemplate: `Hi {{first_name}},

Your Safe Money & Retirement Consultation with Loretta Stewart of Prosperity Life & Financial Solutions is coming up in 2 hours.

We have not yet received your Retirement Intake Form. Please complete it now so we have time to review your information and prepare for your consultation:

{{intake_link}}

If you have already completed the form, no further action is needed.

– Loretta`,
  },
];

// Idempotent: run at every boot (crm/db/database.js, right after the
// `workflows` table itself is created), same philosophy as that file's own
// CREATE TABLE IF NOT EXISTS statements. INSERT OR IGNORE relies on the
// table's own unique index (brand_id, message_type, appointment_type,
// condition_type) to silently skip a row that already exists -- so this
// never overwrites a row Loretta has since edited, and never creates a
// duplicate. Every seeded row is stamped is_system_default = 1 (informational
// only -- nothing in this module treats it specially; a seeded row is
// edited/disabled exactly like any other).
function seedDefaultWorkflows(db) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO workflows (
      name, brand_id, appointment_type, trigger_type, offset_value, offset_unit, offset_minutes,
      message_type, condition_type, action_type, message_template, enabled, is_system_default
    ) VALUES (
      @name, @brand_id, @appointment_type, @trigger_type, @offset_value, @offset_unit, @offset_minutes,
      @message_type, @condition_type, @action_type, @message_template, 1, 1
    )
  `);
  for (const w of DEFAULT_WORKFLOWS) {
    validateWorkflowFields({ ...w, actionType: 'send_sms' }); // defense in depth -- seed data must pass the exact same rules a manual create would.
    stmt.run({
      name: w.name, brand_id: w.brandId, appointment_type: w.appointmentType,
      trigger_type: w.triggerType, offset_value: w.offsetValue ?? null, offset_unit: w.offsetUnit ?? null,
      offset_minutes: w.offsetMinutes ?? null, message_type: w.messageType, condition_type: w.conditionType,
      action_type: 'send_sms', message_template: w.messageTemplate,
    });
  }
}

// ── Wording corrections to an ALREADY-SEEDED default row (2026-10-02) ───
// seedDefaultWorkflows()'s INSERT OR IGNORE only ever fills in a row that
// doesn't exist yet -- it deliberately never touches one that's already
// there, so Loretta's own edits survive a re-seed. That means changing
// DEFAULT_WORKFLOWS above is NOT enough by itself to fix the wording of a
// row a previous deploy already created (Insurance Lady's Retirement
// Intake Link was seeded by the original Phase 2 deploy with no greeting).
// This is the safe, narrow, one-time-per-correction fix for exactly that:
// each entry only updates a row that (a) is still marked
// is_system_default = 1 and (b) still holds the EXACT prior default text
// -- so a row Loretta has since edited by hand is left completely alone,
// and a database that never had the old row in the first place (a fresh
// install, or one seeded for the first time after this change) never
// touches this path at all, since DEFAULT_WORKFLOWS already has the
// corrected wording from the start.
const DEFAULT_WORKFLOW_CORRECTIONS = [
  {
    brandId: 'insurance-lady', messageType: 'retirement_intake', appointmentType: null, conditionType: 'always',
    oldMessageTemplate: `Your Safe Money & Retirement consultation with Insurance Lady LLC is scheduled for {{appt_date}} at {{appt_time}}.

Please complete your Retirement Intake Form at least 2 hours before your appointment so we have time to review and prepare:

{{intake_link}}

If your intake form is not received at least 2 hours before your appointment, your consultation may need to be rescheduled.

Insurance Lady LLC`,
    newMessageTemplate: `Hi {{first_name}},

Your Safe Money & Retirement consultation with Insurance Lady LLC is scheduled for {{appt_date}} at {{appt_time}}.

Please complete your Retirement Intake Form at least 2 hours before your appointment so we have time to review and prepare:

{{intake_link}}

If your intake form is not received at least 2 hours before your appointment, your consultation may need to be rescheduled.

Insurance Lady LLC`,
  },
  {
    // 2026-10-09: second correction to the SAME row, chained onto the
    // first -- a database that already picked up the 2026-10-02 greeting
    // (oldMessageTemplate below is that correction's newMessageTemplate,
    // verbatim) now picks up this update too, in the same
    // is_system_default + exact-prior-text-match safe pattern. A row
    // Loretta has since customized (so it no longer matches EITHER old
    // text exactly) is, as always, left completely alone.
    brandId: 'insurance-lady', messageType: 'retirement_intake', appointmentType: null, conditionType: 'always',
    oldMessageTemplate: `Hi {{first_name}},

Your Safe Money & Retirement consultation with Insurance Lady LLC is scheduled for {{appt_date}} at {{appt_time}}.

Please complete your Retirement Intake Form at least 2 hours before your appointment so we have time to review and prepare:

{{intake_link}}

If your intake form is not received at least 2 hours before your appointment, your consultation may need to be rescheduled.

Insurance Lady LLC`,
    newMessageTemplate: `Hi {{first_name}},

Your Safe Money & Retirement Consultation with Loretta Stewart of Insurance Lady LLC is scheduled for {{appt_date}} at {{appt_time}}.

Please complete your Retirement Intake Form at least 2 hours before your appointment so we have time to review and prepare:

{{intake_link}}

If you have already completed the form, no further action is needed.

– Loretta`,
  },
];

function applyDefaultWorkflowCorrections(db) {
  const stmt = db.prepare(`
    UPDATE workflows SET message_template = @newMessageTemplate, updated_at = CURRENT_TIMESTAMP
    WHERE brand_id = @brandId AND message_type = @messageType
      AND COALESCE(appointment_type,'') = COALESCE(@appointmentType,'')
      AND condition_type = @conditionType
      AND is_system_default = 1
      AND message_template = @oldMessageTemplate
  `);
  for (const c of DEFAULT_WORKFLOW_CORRECTIONS) stmt.run(c);
}

module.exports = {
  VALID_BRANDS, VALID_TRIGGER_TYPES, VALID_CONDITION_TYPES, VALID_OFFSET_UNITS, VALID_ACTION_TYPES,
  MESSAGE_TYPE_OPTIONS, VALID_MESSAGE_TYPES,
  MESSAGE_TYPES_REQUIRING_INTAKE_LINK,
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow,
  evaluateCondition, renderWorkflowMessage,
  selectWorkflowsForOccurrence, selectWorkflowForOccurrence,
  DEFAULT_WORKFLOWS, seedDefaultWorkflows,
  DEFAULT_WORKFLOW_CORRECTIONS, applyDefaultWorkflowCorrections,
};
