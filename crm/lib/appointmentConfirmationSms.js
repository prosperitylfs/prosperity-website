// Automatic appointment-confirmation SMS, triggered from crm/routes/calcom.js
// when a NEW, non-Retirement-Lead Cal.com appointment is booked. Retirement
// Lead bookings are deliberately excluded at the call site: they already get
// their own confirmation-equivalent message (the Retirement Intake Form
// link, see crm/lib/retirementIntakeSms.js), which already states the
// appointment date/time -- sending this SMS as well would be a duplicate,
// redundant second text for the same booking.
//
// Reuses crm/lib/legacySmsSend.js (the single Prosperity Twilio number)
// rather than crm/lib/prosperitySmsGateway.js's brand-aware path, for the
// exact same reason crm/lib/retirementIntakeSms.js does: Cal.com-created/
// matched contacts never have a contact_brands link that gateway needs to
// resolve a sender. The 'prosperity' template is used unconditionally,
// matching that same established, pre-existing precedent -- a known
// limitation (an Insurance Lady Cal.com booking would still text from the
// Prosperity number), not introduced here and out of scope for this fix.
//
// Consent/opt-out/phone-type enforcement is entirely delegated to
// sendLegacySms -> checkConsentGate: STOP opt-out and missing sms_consent
// both block the send, and resolveToNumber only ever reads phone/phone_e164
// (the Mobile Phone fields) -- a landline-only contact (home_phone only)
// resolves to no phone number and is silently, safely skipped, matching the
// existing Mobile-vs-Landline routing already in crm/routes/calcom.js.
//
// Idempotency: crm/routes/calcom.js only ever calls this from its
// isNew-appointment branch (the same branch/guard already proven for the
// Retirement Intake SMS), so a duplicate/redelivered webhook or a reschedule
// of an existing appointment never reaches this function again for the same
// booking.

const { sendLegacySms } = require('./legacySmsSend');
const { getTemplate } = require('../config/templates');

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

function buildConfirmationSmsBody({ attendeeName, appointmentType, appointmentDatetimeIso }) {
  const template = getTemplate('prosperity', 'appointmentConfirmationSms');
  const { date, time } = fmtApptDateTimeCT(appointmentDatetimeIso);
  return fillTemplate(template.body, {
    attendee_name: attendeeName || 'there',
    appointment_type: appointmentType,
    date, time, time_zone: 'CT',
  });
}

// Returns one of:
//   { attempted: true, sent: true, sms }                     — sent.
//   { attempted: true, sent: false, reason, status }          — blocked
//     (no consent, opted out, no valid mobile number, Twilio not
//     configured) or a Twilio send failure. Already logged in sms_messages
//     by sendLegacySms where applicable — see that module's own comment.
async function sendAppointmentConfirmationSms(db, { contactId, attendeeName, appointmentType, appointmentDatetimeIso }, deps = {}) {
  const body = buildConfirmationSmsBody({ attendeeName, appointmentType, appointmentDatetimeIso });
  const send = deps.sendLegacySms || sendLegacySms;
  const result = await send(db, { contactId, body }, deps);

  if (result.ok) return { attempted: true, sent: true, sms: result.sms };
  return { attempted: true, sent: false, reason: result.error, status: result.status };
}

module.exports = { buildConfirmationSmsBody, fillTemplate, sendAppointmentConfirmationSms };
