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
function buildConfirmationSmsBody({ firstName, appointmentType, appointmentDatetimeIso, brandId = DEFAULT_BRAND, messageType = 'confirmation', now = new Date() }) {
  const templateKey = TEMPLATE_KEY_BY_MESSAGE_TYPE[messageType] || TEMPLATE_KEY_BY_MESSAGE_TYPE.confirmation;
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
async function sendAppointmentConfirmationSms(db, { contactId, firstName, appointmentType, appointmentDatetimeIso, brandId = DEFAULT_BRAND, messageType = 'confirmation', appointmentId = null, now }, deps = {}) {
  // Fails closed rather than silently falling back to Prosperity's number:
  // an Insurance Lady booking must never go out under the wrong brand's
  // sender just because its dedicated number isn't configured in this
  // environment yet.
  if (brandId === 'insurance-lady' && !process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER) {
    return { attempted: true, sent: false, reason: 'INSURANCE_LADY_TWILIO_PHONE_NUMBER is not configured', status: 503 };
  }

  const body = buildConfirmationSmsBody({ firstName, appointmentType, appointmentDatetimeIso, brandId, messageType, ...(now ? { now } : {}) });
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
