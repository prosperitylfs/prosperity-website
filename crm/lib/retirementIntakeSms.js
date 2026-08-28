// Automatic delivery of the Retirement Intake Form link, triggered from
// crm/routes/calcom.js when a new Safe Money & Retirement appointment is
// booked. Reuses crm/lib/legacySmsSend.js (the single Prosperity Twilio
// number, TWILIO_FROM_NUMBER) rather than crm/lib/prosperitySmsGateway.js's
// brand-aware path, because Cal.com-created/matched contacts never have a
// contact_brands link that gateway needs to resolve a sender.
//
// Idempotency: sendRetirementIntakeSms only ever sends while the intake's
// status is still 'Not Sent'. This is a SECOND, independent safeguard —
// the FIRST is that crm/routes/calcom.js only calls this from its
// isNew-appointment branch, so a duplicate/redelivered webhook or a
// reschedule of an existing appointment never reaches this function again
// for the same booking at all. Together these mean: no duplicate send on a
// redelivered webhook, no resend on a routine reschedule, and — because a
// completed intake's status is 'Completed', never 'Not Sent' again — no
// resend once the prospect has already filled it out.

const { sendLegacySms } = require('./legacySmsSend');
const { markIntakeSent } = require('./retirementIntakeService');

const PUBLIC_SITE_BASE_URL = 'https://www.prosperitylfs.com';

function buildIntakeUrl(token) {
  return `${PUBLIC_SITE_BASE_URL}/retirement-intake?token=${token}`;
}

function fmtApptDateTimeCT(appointmentDatetimeIso) {
  const d = new Date(appointmentDatetimeIso);
  const date = d.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const time = d.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' CT';
  return { date, time };
}

// Transactional, appointment-related only — no marketing language, per the
// approved copy. Kept as a single named builder so the exact wording lives
// in one place.
function buildIntakeSmsBody({ appointmentDatetimeIso, token }) {
  const { date, time } = fmtApptDateTimeCT(appointmentDatetimeIso);
  const url = buildIntakeUrl(token);
  return [
    `Your Safe Money & Retirement consultation with Loretta Stewart is scheduled for ${date} at ${time}.`,
    '',
    `Please complete your Retirement Intake Form at least 2 hours before your appointment so Loretta has time to review and prepare:`,
    '',
    url,
    '',
    `If your intake form is not received at least 2 hours before your appointment, your consultation may need to be rescheduled.`,
    '',
    `Prosperity Life & Financial Solutions`,
  ].join('\n');
}

// Returns one of:
//   { attempted: false, reason: 'not_eligible' } — intake wasn't 'Not Sent'
//     (already Sent or Completed); nothing was touched.
//   { attempted: true, sent: true, sms }         — sent; intake is now Sent.
//   { attempted: true, sent: false, reason, status } — send failed (or was
//     blocked by the consent gate); intake stays 'Not Sent'. The failure is
//     already logged in sms_messages by sendLegacySms (status='failed' with
//     a failure_reason, or simply no row at all for a gate rejection) — see
//     that module's own comment for exactly what gets written.
async function sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso }, deps = {}) {
  if (!intake || intake.status !== 'Not Sent') {
    return { attempted: false, reason: 'not_eligible' };
  }

  const body = buildIntakeSmsBody({ appointmentDatetimeIso, token: intake.token });
  const send = deps.sendLegacySms || sendLegacySms;
  const result = await send(db, { contactId, body }, deps);

  if (result.ok) {
    markIntakeSent(db, intake.id);
    return { attempted: true, sent: true, sms: result.sms };
  }
  return { attempted: true, sent: false, reason: result.error, status: result.status };
}

module.exports = { buildIntakeUrl, buildIntakeSmsBody, sendRetirementIntakeSms };
