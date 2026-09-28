// Automatic appointment SMS -- new-booking confirmation, reschedule notice,
// and the 24h/1h/15m reminders -- triggered from crm/routes/calcom.js (new
// booking + reschedule) and crm/lib/appointmentReminderScheduler.js
// (reminders) for a non-Retirement-Lead Cal.com appointment. Retirement
// Lead bookings are deliberately excluded at both call sites for the
// confirmation/reschedule messages: they get their own confirmation-
// equivalent message instead (the Retirement Intake Form link, see
// crm/lib/retirementIntakeSms.js), which already states the appointment
// date/time -- sending this SMS as well would be a duplicate, redundant
// second text for the same booking or reschedule. Reminders are NOT
// excluded for Retirement Lead appointments -- the intake-link message is a
// one-time send at booking time, not a recurring reminder system, so there
// is nothing to duplicate.
//
// Reuses crm/lib/legacySmsSend.js rather than crm/lib/prosperitySmsGateway.js's
// brand-aware path, for the exact same reason crm/lib/retirementIntakeSms.js
// does: Cal.com-created/matched contacts never have a contact_brands link
// that gateway needs to resolve a sender. Brand selection here (template
// wording AND the Twilio sending number) is instead driven by the caller-
// supplied `brandId` -- see crm/routes/calcom.js's inferBookingBrand() for
// how that's resolved from the webhook payload and persisted onto
// appointments.booking_brand for later use by the reminder scheduler.
//
// Consent/opt-out enforcement is entirely delegated to sendLegacySms ->
// checkConsentGate: STOP opt-out and missing sms_consent both block the
// send, and resolveToNumber only ever reads phone/phone_e164 (the Mobile
// Phone fields) -- a landline-only contact (home_phone only) resolves to no
// phone number and is silently, safely skipped, matching the existing
// Mobile-vs-Landline routing already in crm/routes/calcom.js. None of that
// gating logic is touched here.
//
// Idempotency:
//   - New booking / reschedule: see crm/routes/calcom.js's own comment at
//     each call site (isNew gate / statusChanged gate).
//   - Reminders: crm/lib/appointmentReminderScheduler.js dedupes by
//     appointment_id + messageType + the appointment's CURRENT
//     appt_datetime (via sms_messages.appointment_id/message_type) -- see
//     that module's own comment for why keying on the current appt_datetime
//     automatically handles reschedules correctly.

const { sendLegacySms } = require('./legacySmsSend');
const { getTemplate } = require('../config/templates');
const { BRANDS } = require('../config/brands');
const { selectWorkflowForOccurrence, evaluateCondition, renderWorkflowMessage } = require('./workflowService');
// From retirementIntakeService.js, NOT retirementIntakeSms.js -- this file
// already gets resolveFromNumberForBrand exported FROM here BY
// retirementIntakeSms.js, so requiring retirementIntakeSms.js back from
// here would be circular. retirementIntakeService.js is pure business
// logic with no crm/lib dependencies of its own, so this is a safe,
// one-directional import. buildIntakeUrl is pure/side-effect-free (no
// token/short-link GENERATION here, just formatting the URL for a token
// that already exists) -- see this file's own {{intake_link}} comment
// below for why a scheduler-polled workflow message (e.g. the 2-hour
// retirement intake reminder) needs it too, not just the booking-time
// send lib/retirementIntakeSms.js already handles.
const { buildIntakeUrl } = require('./retirementIntakeService');

const DEFAULT_BRAND = 'prosperity';

const TEMPLATE_KEY_BY_MESSAGE_TYPE = {
  confirmation: 'appointmentConfirmationSms',
  reschedule: 'rescheduleNoticeSms',
  reminder_24h: 'reminder24hSms',
  reminder_1h: 'reminder1hSms',
  reminder_15m: 'reminder15mSms',
};

function fillTemplate(body, vars) {
  return body.replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] != null ? String(vars[key]) : ''));
}

function fmtApptDateTimeCT(appointmentDatetimeIso) {
  const d = new Date(appointmentDatetimeIso);
  const date = d.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const time = d.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return { date, time };
}

// "tomorrow" if the appointment's Central-time CALENDAR DATE is exactly one
// day after today's Central-time calendar date (at `now`); otherwise falls
// back to "on <full date>" so the message stays accurate. Comparing
// calendar dates (not an exact 24h offset) is deliberately tolerant of the
// scheduler's own polling imprecision (it doesn't check at the exact
// second) -- a few minutes of drift around the 24h mark never flips this,
// only a genuine day-boundary edge case does.
function computeDayPhrase(appointmentDatetimeIso, now = new Date()) {
  const tz = 'America/Chicago';
  const apptDateStr = new Date(appointmentDatetimeIso).toLocaleDateString('en-CA', { timeZone: tz });
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000);
  const tomorrowDateStr = tomorrow.toLocaleDateString('en-CA', { timeZone: tz });
  if (apptDateStr === tomorrowDateStr) return 'tomorrow';
  const { date } = fmtApptDateTimeCT(appointmentDatetimeIso);
  return `on ${date}`;
}

// `firstName` fills the template's {{attendee_name}} placeholder -- the
// greeting is first-name-only ("Hi Janet,"), never the full name. `now` is
// only used for the 24h reminder's "tomorrow" vs "on <date>" computation;
// tests may pass a fixed value for determinism.
//
// Returns null (2026-10-09) for a messageType with no hardcoded fallback
// template at all -- e.g. 'retirement_intake_2h_reminder', a scheduler-
// polled messageType that exists ONLY as a crm/lib/workflowService.js
// workflow row, never as a config/templates.js entry. Every messageType
// this function has EVER been called with before this change (confirmation,
// reschedule, reminder_24h/1h/15m) has a real entry in
// TEMPLATE_KEY_BY_MESSAGE_TYPE, so this is unreachable for any existing
// caller -- it only matters for the new scheduler window below, where it's
// what keeps an appointment/brand with no matching workflow row (i.e.
// every appointment except the one the 2-hour reminder is actually
// configured for) from silently getting a fallback confirmation message
// instead of nothing at all. See sendAppointmentConfirmationSms's own
// comment for the caller-side half of this.
function buildConfirmationSmsBody({ firstName, appointmentType, appointmentDatetimeIso, brandId = DEFAULT_BRAND, messageType = 'confirmation', now = new Date() }) {
  const templateKey = TEMPLATE_KEY_BY_MESSAGE_TYPE[messageType];
  if (!templateKey) return null;
  const template = getTemplate(brandId, templateKey) || getTemplate(DEFAULT_BRAND, templateKey);
  const { date, time } = fmtApptDateTimeCT(appointmentDatetimeIso);
  return fillTemplate(template.body, {
    attendee_name: firstName || 'there',
    appointment_type: appointmentType,
    date, time, time_zone: 'CT',
    day_phrase: messageType === 'reminder_24h' ? computeDayPhrase(appointmentDatetimeIso, now) : undefined,
  });
}

// Insurance Lady has its own dedicated Twilio sending number
// (INSURANCE_LADY_TWILIO_PHONE_NUMBER); Prosperity keeps using
// legacySmsSend's own existing TWILIO_FROM_NUMBER default -- returning null
// here (not a fallback number) is what makes that happen, since
// sendLegacySms only overrides its default when given a truthy fromNumber.
function resolveFromNumberForBrand(brandId) {
  if (brandId === 'insurance-lady') return process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER || null;
  return null;
}

// `messageType`: 'confirmation' (default, new booking) | 'reschedule' |
// 'reminder_24h' | 'reminder_1h' | 'reminder_15m'. `appointmentId` (optional)
// is stamped onto the logged sms_messages row for SMS History classification.
// Returns one of:
//   { attempted: true, sent: true, sms }                     — sent.
//   { attempted: true, sent: false, reason, status }          — blocked
//     (no consent, opted out, no valid mobile number, the brand's Twilio
//     sender not configured) or a Twilio send failure. Already logged in
//     sms_messages by sendLegacySms where applicable — see that module's
//     own comment.
//   { attempted: false, reason: 'workflow_condition_not_met' }  — a Workflows
//     (crm/lib/workflowService.js) row matched this brand/appointment
//     type/message type, but its condition evaluated false (e.g. a future
//     "only if retirement intake is still incomplete" row) -- nothing is
//     sent, and this is NOT a fallback-to-hardcoded case: a specific
//     workflow match, once found, is authoritative for this send even when
//     its own condition says "don't send".
//
// Workflows integration (2026-09-28, Version 1): before building the
// message, checks for an enabled crm/lib/workflowService.js row matching
// (brandId, appointmentType, messageType). No row (the table is empty in
// every environment until Loretta creates one) -> falls through to
// buildConfirmationSmsBody below, completely unchanged from before this
// feature existed. A row exists -> its own condition (default 'always') is
// evaluated; true renders that row's own editable message_template instead
// of config/templates.js's hardcoded one, false sends nothing at all.
async function sendAppointmentConfirmationSms(db, { contactId, firstName, appointmentType, appointmentDatetimeIso, brandId = DEFAULT_BRAND, messageType = 'confirmation', appointmentId = null, now }, deps = {}) {
  // Fails closed rather than silently falling back to Prosperity's number:
  // an Insurance Lady booking must never go out under the wrong brand's
  // sender just because its dedicated number isn't configured in this
  // environment yet.
  if (brandId === 'insurance-lady' && !process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER) {
    return { attempted: true, sent: false, reason: 'INSURANCE_LADY_TWILIO_PHONE_NUMBER is not configured', status: 503 };
  }

  let body;
  const workflow = selectWorkflowForOccurrence(db, { brandId, appointmentType, messageType });
  if (workflow) {
    if (!evaluateCondition(db, workflow.conditionType, { appointmentId })) {
      return { attempted: false, reason: 'workflow_condition_not_met' };
    }
    const { date, time } = fmtApptDateTimeCT(appointmentDatetimeIso);
    const brand = BRANDS[brandId];
    // {{intake_link}} support (2026-10-09) -- a scheduler-polled workflow
    // message (e.g. the Insurance Lady 2-hour retirement intake reminder)
    // needs the SAME real, unique link lib/retirementIntakeSms.js's
    // booking-time send already provides, not a blank/missing one. Only
    // queried when the template actually references {{intake_link}} --
    // never generates a new token, only formats the URL for whichever one
    // already exists (buildIntakeUrl is pure/stateless). Conditioned on
    // the template text (not just "workflow exists") so every
    // confirmation/reminder workflow -- which never references
    // {{intake_link}} -- never touches the retirement_intakes table at
    // all, exactly as before this change.
    const needsIntakeLink = workflow.messageTemplate.includes('{{intake_link}}');
    const intakeRow = needsIntakeLink && appointmentId
      ? db.prepare('SELECT token FROM retirement_intakes WHERE appointment_id = ?').get(appointmentId)
      : null;
    body = renderWorkflowMessage(workflow.messageTemplate, {
      first_name: firstName || 'there', appt_date: date, appt_time: `${time} CT`,
      appointment_type: appointmentType,
      brand_name: brand ? brand.legalName : brandId,
      intake_link: intakeRow ? buildIntakeUrl(intakeRow.token, brandId) : undefined,
      // Only meaningful for a 24-hour-reminder workflow -- same
      // computeDayPhrase() the pre-Workflows hardcoded reminder_24h
      // template already uses, so a seeded 24h-reminder workflow can
      // reproduce "tomorrow" vs "on <date>" exactly. Omitted (renders as
      // empty string) for every other messageType, matching
      // buildConfirmationSmsBody's own day_phrase: undefined for anything
      // other than 'reminder_24h'.
      day_phrase: messageType === 'reminder_24h' ? computeDayPhrase(appointmentDatetimeIso, now || new Date()) : undefined,
    });
  } else {
    body = buildConfirmationSmsBody({ firstName, appointmentType, appointmentDatetimeIso, brandId, messageType, ...(now ? { now } : {}) });
    // No workflow row matched AND no hardcoded fallback template exists for
    // this messageType (buildConfirmationSmsBody returns null) -- e.g. a
    // scheduler-polled messageType like 'retirement_intake_2h_reminder'
    // reaching this for a brand/appointment it has no configured workflow
    // for. Nothing is sent; this is not an error, just "not applicable
    // here" -- see buildConfirmationSmsBody's own comment.
    if (body == null) return { attempted: false, reason: 'no_matching_workflow_or_template' };
  }
  const fromNumber = resolveFromNumberForBrand(brandId);
  const send = deps.sendLegacySms || sendLegacySms;
  const result = await send(db, {
    contactId, body, fromNumber: fromNumber || undefined, appointmentId, messageType,
    appointmentOccurrenceAt: appointmentId ? appointmentDatetimeIso : null,
  }, deps);

  if (result.ok) return { attempted: true, sent: true, sms: result.sms };
  return { attempted: true, sent: false, reason: result.error, status: result.status };
}

module.exports = { buildConfirmationSmsBody, computeDayPhrase, fillTemplate, resolveFromNumberForBrand, sendAppointmentConfirmationSms };
