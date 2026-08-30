// Automatic appointment SMS -- new-booking confirmation AND reschedule
// notice -- triggered from crm/routes/calcom.js for a NEW or rescheduled,
// non-Retirement-Lead Cal.com appointment. Retirement Lead bookings are
// deliberately excluded at the call site for BOTH message types: they get
// their own confirmation-equivalent message instead (the Retirement Intake
// Form link, see crm/lib/retirementIntakeSms.js), which already states the
// appointment date/time -- sending this SMS as well would be a duplicate,
// redundant second text for the same booking or reschedule.
//
// Reuses crm/lib/legacySmsSend.js rather than crm/lib/prosperitySmsGateway.js's
// brand-aware path, for the exact same reason crm/lib/retirementIntakeSms.js
// does: Cal.com-created/matched contacts never have a contact_brands link
// that gateway needs to resolve a sender. Brand selection here (template
// wording AND the Twilio sending number) is instead driven by the caller-
// supplied `brandId` -- see crm/routes/calcom.js's inferBookingBrand() for
// how that's resolved from the webhook payload.
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
//   - New booking: crm/routes/calcom.js only calls this (messageType
//     'confirmation', the default) from its isNew-appointment branch, so a
//     duplicate/redelivered BOOKING_CREATED webhook never reaches this
//     function again for the same booking.
//   - Reschedule: crm/routes/calcom.js only calls this (messageType
//     'reschedule') when an EXISTING appointment's status actually
//     transitions to 'Rescheduled' (the same statusChanged signal already
//     used for the Activity Timeline entry) -- a redelivered
//     BOOKING_RESCHEDULED webhook finds the status already 'Rescheduled'
//     and does not re-enter. Known limitation, matching the pre-existing
//     Activity Timeline logging's own same limitation: a SECOND reschedule
//     of an already-rescheduled appointment does not re-fire either, since
//     status stays 'Rescheduled' -> 'Rescheduled' (no change to detect).
//     Not addressed here -- out of scope for this fix.

const { sendLegacySms } = require('./legacySmsSend');
const { getTemplate } = require('../config/templates');

const DEFAULT_BRAND = 'prosperity';

const TEMPLATE_KEY_BY_MESSAGE_TYPE = {
  confirmation: 'appointmentConfirmationSms',
  reschedule: 'rescheduleNoticeSms',
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

// `firstName` fills the template's {{attendee_name}} placeholder -- the
// greeting is first-name-only ("Hi Janet,"), never the full name.
function buildConfirmationSmsBody({ firstName, appointmentType, appointmentDatetimeIso, brandId = DEFAULT_BRAND, messageType = 'confirmation' }) {
  const templateKey = TEMPLATE_KEY_BY_MESSAGE_TYPE[messageType] || TEMPLATE_KEY_BY_MESSAGE_TYPE.confirmation;
  const template = getTemplate(brandId, templateKey) || getTemplate(DEFAULT_BRAND, templateKey);
  const { date, time } = fmtApptDateTimeCT(appointmentDatetimeIso);
  return fillTemplate(template.body, {
    attendee_name: firstName || 'there',
    appointment_type: appointmentType,
    date, time, time_zone: 'CT',
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

// `messageType`: 'confirmation' (default, new booking) or 'reschedule'.
// Returns one of:
//   { attempted: true, sent: true, sms }                     — sent.
//   { attempted: true, sent: false, reason, status }          — blocked
//     (no consent, opted out, no valid mobile number, the brand's Twilio
//     sender not configured) or a Twilio send failure. Already logged in
//     sms_messages by sendLegacySms where applicable — see that module's
//     own comment.
async function sendAppointmentConfirmationSms(db, { contactId, firstName, appointmentType, appointmentDatetimeIso, brandId = DEFAULT_BRAND, messageType = 'confirmation' }, deps = {}) {
  // Fails closed rather than silently falling back to Prosperity's number:
  // an Insurance Lady booking must never go out under the wrong brand's
  // sender just because its dedicated number isn't configured in this
  // environment yet.
  if (brandId === 'insurance-lady' && !process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER) {
    return { attempted: true, sent: false, reason: 'INSURANCE_LADY_TWILIO_PHONE_NUMBER is not configured', status: 503 };
  }

  const body = buildConfirmationSmsBody({ firstName, appointmentType, appointmentDatetimeIso, brandId, messageType });
  const fromNumber = resolveFromNumberForBrand(brandId);
  const send = deps.sendLegacySms || sendLegacySms;
  const result = await send(db, { contactId, body, fromNumber: fromNumber || undefined }, deps);

  if (result.ok) return { attempted: true, sent: true, sms: result.sms };
  return { attempted: true, sent: false, reason: result.error, status: result.status };
}

module.exports = { buildConfirmationSmsBody, fillTemplate, resolveFromNumberForBrand, sendAppointmentConfirmationSms };
