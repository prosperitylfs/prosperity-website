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

const UNIT_TO_MINUTES = { minutes: 1, hours: 60, days: 1440 };
const MAX_OFFSET_MINUTES = 90 * 1440; // 90 days -- a sane upper bound, not a real limit anyone should need.

// message_type values whose message_template MUST retain the literal
// {{intake_link}} placeholder -- enforced on every create/update so the
// wording can be freely edited without ever silently dropping the client's
// unique link. Version 1 has exactly one: the retirement intake send
// itself. (A future 2-hour intake-check workflow, added in a later phase,
// would also require it.)
const MESSAGE_TYPES_REQUIRING_INTAKE_LINK = ['retirement_intake'];

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
  if (!toStringOrNull(fields.messageType)) throw new Error('workflowService: a message type is required');
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

module.exports = {
  VALID_BRANDS, VALID_TRIGGER_TYPES, VALID_CONDITION_TYPES, VALID_OFFSET_UNITS, VALID_ACTION_TYPES,
  MESSAGE_TYPES_REQUIRING_INTAKE_LINK,
  listWorkflows, getWorkflow, createWorkflow, updateWorkflow,
  evaluateCondition, renderWorkflowMessage,
  selectWorkflowsForOccurrence, selectWorkflowForOccurrence,
};
