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
const { markIntakeSent, shortCodeForToken } = require('./retirementIntakeService');
// Reused rather than reimplemented: crm/lib/appointmentConfirmationSms.js
// already has the exact tested "which brand's Twilio number sends this"
// logic (fails closed if INSURANCE_LADY_TWILIO_PHONE_NUMBER isn't
// configured, never substitutes Prosperity's number) -- see that module's
// own comment on resolveFromNumberForBrand.
const { resolveFromNumberForBrand } = require('./appointmentConfirmationSms');
const { BRANDS } = require('../config/brands');

const PUBLIC_SITE_BASE_URL = 'https://www.prosperitylfs.com';

// Insurance Lady's own public site (crm/config/brands.js's single source of
// truth for that domain -- never hardcoded a second time here). Added
// 2026-09-17 so an Insurance Lady retirement booking (event slug
// retirement-safemoney-consultation-insurancelady) sends its intake link to
// Insurance Lady's own domain instead of Prosperity's. NOTE: as of this
// change, insuranceladyllc.com does not yet have a retirement-intake page of
// its own -- that page lives entirely outside this repo (see
// retirement-intake.html's own header comment) and still needs to be built
// there, mirroring this repo's retirement-intake.html with Insurance Lady's
// branding. The CRM's own API (crm/routes/retirementIntake.js) is already
// brand-agnostic (token-keyed only) and needs no further changes once that
// page exists.
function baseUrlForBrand(brandId) {
  if (brandId === 'insurance-lady') return BRANDS['insurance-lady'].website;
  return PUBLIC_SITE_BASE_URL;
}

// Insurance Lady gets a short /i/<code> link (its own Cloudflare Worker
// resolves the code server-side back to this same full token and
// redirects into the exact same /retirement-intake?token=... flow --
// see InsuranceLady-v4/src/worker.js). Prosperity's own branch is
// completely untouched -- still the same long-form token URL as before,
// byte-for-byte identical output for that branch.
function buildIntakeUrl(token, brandId = 'prosperity') {
  if (brandId === 'insurance-lady') {
    return `${baseUrlForBrand(brandId)}/i/${shortCodeForToken(token)}`;
  }
  return `${baseUrlForBrand(brandId)}/retirement-intake?token=${token}`;
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
//
// The Insurance Lady branch below is untouched (deliberately not
// personalized yet -- 2026-09-17 decision: Prosperity only for now, tested
// and addressed separately). The Prosperity branch gains a "Hi {firstName},"
// greeting line, prepended in front of the SAME message text that was
// already tested and confirmed working in production -- every line after
// the greeting is byte-identical to before. Not derived from
// crm/config/brands.js's legalName (which is "...LLC", a slightly different
// string), specifically so this already-approved copy can never drift.
// brandId defaults to 'prosperity' so every existing caller (all of them,
// before this change) is completely unaffected. firstName is optional --
// a contact with no first name on file gets the exact pre-2026-09-17
// message with no greeting line at all, rather than a broken "Hi ,".
function buildIntakeSmsBody({ appointmentDatetimeIso, token, brandId = 'prosperity', firstName }) {
  const { date, time } = fmtApptDateTimeCT(appointmentDatetimeIso);
  const url = buildIntakeUrl(token, brandId);

  if (brandId === 'insurance-lady') {
    return [
      `Your Safe Money & Retirement consultation with Insurance Lady LLC is scheduled for ${date} at ${time}.`,
      '',
      `Please complete your Retirement Intake Form at least 2 hours before your appointment so we have time to review and prepare:`,
      '',
      url,
      '',
      `If your intake form is not received at least 2 hours before your appointment, your consultation may need to be rescheduled.`,
      '',
      `Insurance Lady LLC`,
    ].join('\n');
  }

  const message = [
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

  return firstName ? `Hi ${firstName},\n\n${message}` : message;
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
// `brandId` ('prosperity' | 'insurance-lady', defaults to 'prosperity' so
// every pre-existing caller is unaffected) selects the SMS wording, the
// intake-form domain (buildIntakeUrl/buildIntakeSmsBody above), and the
// sending Twilio number. Fails closed exactly like
// crm/lib/appointmentConfirmationSms.js's sendAppointmentConfirmationSms —
// an Insurance Lady booking must never silently go out under Prosperity's
// number just because INSURANCE_LADY_TWILIO_PHONE_NUMBER isn't configured in
// this environment yet.
async function sendRetirementIntakeSms(db, { intake, contactId, appointmentDatetimeIso, brandId = 'prosperity', firstName }, deps = {}) {
  if (!intake || intake.status !== 'Not Sent') {
    return { attempted: false, reason: 'not_eligible' };
  }

  if (brandId === 'insurance-lady' && !process.env.INSURANCE_LADY_TWILIO_PHONE_NUMBER) {
    return { attempted: true, sent: false, reason: 'INSURANCE_LADY_TWILIO_PHONE_NUMBER is not configured', status: 503 };
  }

  const body = buildIntakeSmsBody({ appointmentDatetimeIso, token: intake.token, brandId, firstName });
  const fromNumber = resolveFromNumberForBrand(brandId);
  const send = deps.sendLegacySms || sendLegacySms;
  const result = await send(db, { contactId, body, fromNumber: fromNumber || undefined }, deps);

  if (result.ok) {
    markIntakeSent(db, intake.id);
    return { attempted: true, sent: true, sms: result.sms };
  }
  return { attempted: true, sent: false, reason: result.error, status: result.status };
}

module.exports = { buildIntakeUrl, buildIntakeSmsBody, sendRetirementIntakeSms };
