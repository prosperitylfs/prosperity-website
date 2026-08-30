/**
 * POST /api/calcom/webhook
 *
 * Receives Cal.com booking events and syncs them to the CRM calendar.
 * Handles: BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELLED
 *
 * Deduplication: appointments are keyed on cal_booking_uid, so duplicate
 * webhook deliveries are idempotent (update in place, no duplicate rows).
 *
 * Required HMAC verification: CALCOM_WEBHOOK_SECRET must be set, matching
 * the secret configured in Cal.com → Settings → Developer → Webhooks. A
 * request with no secret configured, no signature header, or a mismatched
 * signature is rejected — verification is no longer optional/dev-skippable.
 */

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { isValidCalcomSignature } = require('../lib/calcomSignature');
const { createIntakeForAppointment } = require('../lib/retirementIntakeService');
const { sendRetirementIntakeSms } = require('../lib/retirementIntakeSms');
const { sendAppointmentConfirmationSms } = require('../lib/appointmentConfirmationSms');
const { normalizeEmail } = require('../lib/leadNormalize');

// ── Helpers ───────────────────────────────────────────────────────────────────

function verifySignature(req) {
  return isValidCalcomSignature({
    secret: process.env.CALCOM_WEBHOOK_SECRET,
    signatureHeader: req.headers['x-cal-signature-256'],
    rawBody: req.rawBody || Buffer.from(JSON.stringify(req.body)),
  });
}

function normalizePhone(raw) {
  if (!raw) return { display: null, e164: null };
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 10 ? digits
    : (digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : null);
  const e164    = ten ? `+1${ten}` : null;
  const display = ten ? `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}` : raw.trim();
  return { display, e164 };
}

function normalizeLocation(raw) {
  if (!raw) return null;
  // Cal.com may send location as object { type, value } or as a plain string.
  // The extracted value is only ever used if it's itself a string -- if a
  // future/unexpected location shape puts an object where .value/.type is
  // expected (e.g. a nested object with no string field), loc stays '' and
  // this returns null rather than crashing on .startsWith() below or, if
  // returned as-is, rendering as the literal string "[object Object]"
  // wherever the CRM UI displays appointments.location.
  let loc = '';
  if (typeof raw === 'object') {
    const v = raw.value || raw.type || '';
    loc = typeof v === 'string' ? v : '';
  } else {
    loc = String(raw);
  }
  if (!loc) return null;
  if (loc.startsWith('integrations:google:meet'))  return 'Google Meet';
  if (loc.startsWith('integrations:zoom'))          return 'Zoom (link in confirmation email)';
  if (loc.startsWith('integrations:daily'))         return 'Daily.co Video';
  if (loc.startsWith('integrations:whereby'))       return 'Whereby Video';
  if (loc === 'attendeeInPerson')                   return "Attendee's Location";
  if (loc === 'inPerson')                           return 'In Person';
  if (loc === 'phone')                              return 'Phone Call';
  if (loc.startsWith('Link_'))                      return loc.slice(5);
  return loc;
}

// A bare location string counts as a phone number only if it actually looks
// like one after stripping non-digits (10 digits, or 11 starting with '1')
// -- distinguishes a Retell-style "+14143676486" location from a genuine
// location string like 'integrations:google:meet' or a street address.
function looksLikePhoneNumber(str) {
  if (typeof str !== 'string') return false;
  const digits = str.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

// Fallback phone source, covering TWO different shapes production has
// actually sent for payload.location:
//
// 1. Object form {value:'phone', optionValue:'<E.164 number>'} -- the
//    site's own prefill mechanism (assets/js/scheduleQualification.js's
//    buildCalcomPrefillQuery), echoed back by Cal.com on the webhook.
//    Confirmed via live production testing of a booking made through
//    book.html.
//
// 2. Bare phone-number STRING, e.g. "+14143676486" -- confirmed via a real
//    production booking made through Jennifer/Retell's own Cal.com
//    integration (not our book.html form), which does not use the
//    {value,optionValue} object convention at all and instead puts the
//    attendee's phone directly into payload.location as a plain string.
//    This is why that real booking's appointment correctly showed
//    "+14143676486" as its location (normalizeLocation's plain-string
//    branch returns it as-is) while the CRM's Mobile Phone field stayed
//    blank -- the old version of this function only ever checked the
//    object shape, typeof rawLocation !== 'object' short-circuited
//    immediately for a bare string, so this fallback silently contributed
//    nothing and no other source in the rawPhone chain below had the
//    number either.
function extractLocationPhone(rawLocation) {
  if (!rawLocation) return null;
  if (typeof rawLocation === 'object') {
    if (rawLocation.value !== 'phone') return null;
    return rawLocation.optionValue || null;
  }
  return looksLikePhoneNumber(rawLocation) ? rawLocation : null;
}

// Known Cal.com event slugs (Cal.com's documented top-level BOOKING_CREATED
// field `payload.type` -- https://cal.com/docs/developing/guides/automation/webhooks,
// NOT nested under an `eventType` object). Kept in sync with
// CALCOM_RETIREMENT_URL / CALCOM_LIFE_INSURANCE_URL in book.html and
// schedule.html -- each URL's final path segment is the slug listed here.
//
// Preferred over any title-based matching: a real production webhook
// confirmed `payload.eventType` is not populated at all (logged as
// `undefined` by the temporary [DIAG] line this replaces), so the earlier
// eventType.title-based detection silently classified every real Retirement
// booking as a generic "Contact Form Lead" and no retirement_intakes record
// or SMS was ever created. The slug is a stable identifier Cal.com actually
// sends; a display title is not.
const RETIREMENT_EVENT_SLUGS = ['retirement-safemoney-consultation-prosperitylfs'];
const LIFE_INSURANCE_EVENT_SLUGS = ['life-insurance-consultation-prosperitylfs'];

function inferLeadTypeFromSlug(slug) {
  const s = (slug || '').toLowerCase();
  if (RETIREMENT_EVENT_SLUGS.includes(s)) return 'Retirement Lead';
  if (LIFE_INSURANCE_EVENT_SLUGS.includes(s)) return 'Life Insurance Lead';
  return null;
}

// Fallback only -- used when payload.type is missing or doesn't match a
// known slug (e.g. a new event type not yet added above). Preserves the
// original title-substring behavior for anything not explicitly listed, so
// existing Life Insurance/Roth/other detection keeps working even if a
// title-like field is all that's available.
function inferLeadTypeFromTitle(titleText) {
  const t = (titleText || '').toLowerCase();
  if (t.includes('roth'))                             return 'Roth Conversion Lead';
  if (t.includes('retire') || t.includes('rollover'))  return 'Retirement Lead';
  if (t.includes('life') || t.includes('insurance'))   return 'Life Insurance Lead';
  return 'Contact Form Lead';
}

// payload.eventTitle is Cal.com's documented top-level field for the event
// type's own name (distinct from payload.title, which is the specific
// booking's generated display name, e.g. "30 Min Meeting between X and Y").
// payload.eventType?.title is checked last purely for forward/backward
// compatibility in case Cal.com ever does send that shape for some event.
function inferLeadType(payload) {
  const fromSlug = inferLeadTypeFromSlug(payload.type);
  if (fromSlug) return fromSlug;

  const titleText = payload.eventTitle || payload.title || (payload.eventType && payload.eventType.title) || '';
  const fromTitle = inferLeadTypeFromTitle(titleText);

  if (fromTitle === 'Contact Form Lead' && payload.type) {
    console.warn(`Cal.com webhook: booking ${payload.uid} did not match a known event slug (type="${payload.type}") or any title pattern (title="${titleText}") -- classified as generic Contact Form Lead. If this is a new Prosperity event type, add its slug to RETIREMENT_EVENT_SLUGS/LIFE_INSURANCE_EVENT_SLUGS in crm/routes/calcom.js.`);
  }
  return fromTitle;
}

function fmtCT(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }) + ' CT';
}

// ── Life Insurance custom-question capture ──────────────────────────────
//
// There is no captured sample of a real Cal.com webhook payload for this
// event to build against, and no existing test coverage of this route's
// business logic at all (only crm/lib/calcomSignature.js's HMAC check was
// previously tested) — so this deliberately does NOT hardcode against
// guessed field/identifier names. Instead it relies on the one part of
// Cal.com's webhook payload shape this codebase already depends on and has
// working code for: `payload.responses` is an object whose values are
// `{ label, value, ... }` (the built-in name/email/phone/notes extraction
// above already reads `.value` off entries like `responses.name`,
// `responses.email`) — so questions are matched by their human-readable
// `label` text (the exact wording Loretta provided for each Cal.com
// question), never by an internal identifier/slug that could differ from
// what's actually configured in Cal.com.
//
// Matching by label is inherently best-effort — if Cal.com's question
// wording changes, a label may stop matching. To guarantee no data is ever
// silently lost even then, extractLifeInsuranceAnswers also returns the
// complete raw `responses` object (minus the fields already handled
// elsewhere: name/email/phone/notes/message/description) for inclusion in
// the appointment notes, and the route logs the full raw payload for any
// Life Insurance booking so the actual shape is directly visible in
// Render's logs the first time this runs against a real booking —
// satisfying "inspect/log the actual structure" without needing dashboard
// access to Cal.com from here.
function normalizeLabel(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// A Cal.com response entry's .value is normally a plain string, but this
// guards against any question type that could return something else (a
// nested {label,value} object, an array from a multi-select, a number) so a
// value never gets stringified into the literal "[object Object]" wherever
// it ends up displayed (appointment notes, the raw-extras dump, etc).
function toSafeString(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(toSafeString).filter(Boolean).join(', ');
  if (typeof value === 'object') return String(value.label || value.value || '');
  return String(value);
}

// Finds the first payload.responses entry whose .label matches one of the
// given lowercased substring patterns. Shared by the Life Insurance
// qualification questions and the phone-type/consent questions below --
// matching by human-readable label text (not a guessed internal
// identifier) so this tolerates Cal.com wording differing slightly between
// the two brands' otherwise-identical booking forms.
function findResponseByLabelPattern(responses, patterns) {
  const found = Object.entries(responses).find(([, r]) => {
    const l = normalizeLabel(r && r.label);
    return patterns.some(p => l.includes(p));
  });
  return found ? found[1] : null; // { label, value }
}

// Same idea as findResponseByLabelPattern, but matches a label by an
// arbitrary predicate over the normalized text rather than a fixed
// substring list -- used where an exact phrase is too brittle (e.g. "…a
// mobile phone or landline…" vs "…a mobile phone or a landline…" would both
// need to be listed as separate substrings otherwise). Checking that the
// key normalized WORDS are all present, regardless of the connecting words
// around them, tolerates that kind of minor rewording automatically.
function findResponseByLabelPredicate(responses, predicate) {
  const found = Object.entries(responses).find(([, r]) => predicate(normalizeLabel(r && r.label)));
  return found ? found[1] : null; // { label, value }
}

// New standardized administrative question added to BOTH brands' Cal.com
// booking forms (not just Life Insurance): "Is this a mobile phone or
// landline?" Determines whether the attendee's phone number is routed into
// the mobile fields (phone/phone_e164) or the home_phone field -- never
// both, per the CRM's phone-field convention (see the home_phone addCol
// comment in crm/db/database.js). Absent/unrecognized answer intentionally
// returns null, so the existing mobile-by-default routing is unchanged for
// any booking that doesn't have this question yet.
function isPhoneTypeQuestionLabel(l) {
  return l.includes('mobile') && l.includes('landline');
}

function extractPhoneType(responses) {
  const entry = findResponseByLabelPredicate(responses, isPhoneTypeQuestionLabel);
  if (!entry) return null;
  const answer = normalizeLabel(toSafeString(entry.value));
  if (answer.includes('mobile'))   return 'mobile';
  if (answer.includes('landline')) return 'landline';
  return null;
}

// New standardized consent question added to both brands' Cal.com booking
// forms, worded identically apart from the brand's own legal name (e.g.
// "May Insurance Lady LLC send you appointment confirmations, reminders,
// and related communications by text message and email? Message and data
// rates may apply."). Matched by predicate (both key phrases present)
// rather than the full sentence, so it tolerates the brand name AND any
// other minor rewording, not just the brand name. Returns null (never a
// default) when the question is missing or its answer doesn't match either
// known option -- callers must never write sms_consent/email_consent when
// this returns null, so consent is never inferred or assumed.
function isConsentQuestionLabel(l) {
  return l.includes('text message') && l.includes('email') && l.includes('appointment confirmation');
}

function extractCommunicationConsent(responses) {
  const entry = findResponseByLabelPredicate(responses, isConsentQuestionLabel);
  if (!entry) return null;
  const answer = normalizeLabel(toSafeString(entry.value));
  if (answer.includes('text and email')) return { sms: true,  email: true };
  if (answer.includes('email only'))     return { sms: false, email: true };
  return null;
}

// Which brand a Cal.com booking belongs to -- 'insurance-lady' | 'prosperity'.
// Checked, in order, and ruled out before landing on this fallback:
//   1. No explicit brand field exists anywhere in a Cal.com webhook payload.
//   2. Cal.com-created/matched contacts never get a contact_brands row (see
//      crm/lib/retirementIntakeSms.js's own comment for why), so there is no
//      CRM brand mapping to read for a brand-new booking at webhook time.
//   3. RETIREMENT_EVENT_SLUGS/LIFE_INSURANCE_EVENT_SLUGS above, and every
//      Cal.com URL referenced anywhere in this repo (book.html, schedule.html,
//      life-insurance.html, life-insurance-qualifier.html), only ever name
//      Prosperity's own lorettastewart Cal.com account/slugs. Insurance
//      Lady's booking flow (Jennifer/Retell) is configured entirely outside
//      this repo, so there is no verified event slug/ID to key off of here.
//   4. crm/config/brands.js has no Cal.com-related field to map from either.
// The consent question's own label IS already brand-parameterized and
// already flows through this same payload for consent purposes (see
// isConsentQuestionLabel above: "May Insurance Lady LLC send you..." vs
// "May Prosperity Life & Financial Solutions send you..."), making it the
// one reliable, already-present signal. Defaults to 'prosperity' -- the
// previously-hardcoded, working behavior -- whenever the consent question is
// missing or doesn't name a brand, so nothing already working regresses.
function inferBookingBrand(responses) {
  const entry = findResponseByLabelPredicate(responses, isConsentQuestionLabel);
  const label = normalizeLabel(entry && entry.label);
  if (label.includes('insurance lady')) return 'insurance-lady';
  return 'prosperity';
}

const LIFE_INSURANCE_QUESTIONS = [
  { key: 'help_with',       label: 'What they need help with',              patterns: ['what would you like help with'] },
  { key: 'applicant',       label: 'Who is applying for coverage',          patterns: ['who will be applying for coverage'] },
  { key: 'ages',            label: 'Age(s) of person(s) needing coverage',  patterns: ['age of each person', 'what is the age'] },
  { key: 'timeline',        label: 'Coverage timeline',                     patterns: ['how soon are you hoping to have coverage'] },
  { key: 'health',          label: 'Self-described health',                 patterns: ['overall health today', 'how would you describe'] },
  { key: 'declined_before', label: 'Previously declined for life insurance', patterns: ['ever been declined for life insurance'] },
  { key: 'tobacco',         label: 'Nicotine/tobacco use',                  patterns: ['nicotine or tobacco'] },
];
// Response object keys Cal.com uses for the fields this route already
// extracts by other means -- excluded from the raw-answers fallback dump
// below so it isn't a redundant re-listing of name/email/phone/notes.
const ALREADY_HANDLED_RESPONSE_KEYS = new Set(['name', 'email', 'phone', 'phoneNumber', 'notes', 'message', 'description']);

function extractLifeInsuranceAnswers(payload) {
  const responses = payload.responses || {};
  const matched = [];
  const consumedResponseKeys = new Set();

  for (const { label, patterns } of LIFE_INSURANCE_QUESTIONS) {
    const entry = findResponseByLabelPattern(responses, patterns);
    if (!entry) continue;
    if (entry.value === undefined || entry.value === null || entry.value === '') continue;
    const respKey = Object.entries(responses).find(([, r]) => r === entry)[0];
    matched.push({ label, value: toSafeString(entry.value) });
    consumedResponseKeys.add(respKey);
  }

  // Everything else Cal.com sent back, so a wording change that breaks a
  // label match above still shows up here instead of vanishing.
  const rawExtras = [];
  for (const [respKey, entry] of Object.entries(responses)) {
    if (ALREADY_HANDLED_RESPONSE_KEYS.has(respKey) || consumedResponseKeys.has(respKey)) continue;
    if (!entry || entry.value === undefined || entry.value === null || entry.value === '') continue;
    const safeValue = toSafeString(entry.value);
    rawExtras.push(entry.label ? `${entry.label}: ${safeValue}` : `${respKey}: ${safeValue}`);
  }

  return { matched, rawExtras };
}

function buildLifeInsuranceNote({ matched, rawExtras }) {
  const parts = [];
  if (matched.length) parts.push('Life Insurance Qualification Answers:\n' + matched.map(m => `${m.label}: ${m.value}`).join('\n'));
  if (rawExtras.length) parts.push('Additional Cal.com responses:\n' + rawExtras.join('\n'));
  return parts.length ? parts.join('\n\n') : null;
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handleCreatedOrRescheduled(event, payload) {
  const uid           = payload.uid;
  const rescheduleUid = payload.rescheduleUid || null;
  const startTime     = payload.startTime;
  const endTime       = payload.endTime;
  const eventType     = payload.eventType || {};
  const attendee      = (payload.attendees || [])[0] || {};
  const responses     = payload.responses || {};

  // ── Extract attendee details ───────────────────────────────────────────────
  const fullName  = attendee.name || responses.name?.value || '';
  const nameParts = fullName.trim().split(/\s+/);
  const firstName = nameParts[0]         || null;
  const lastName  = nameParts.slice(1).join(' ') || null;

  // Normalized (trimmed + lowercased) via the SAME normalizeEmail() the
  // /api/leads pipeline (crm/lib/leadIntake.js) already uses to store every
  // contact's email -- without this, a webhook whose attendee email arrives
  // in a different case than what was submitted through /book (Cal.com's
  // booking page is prefilled from a query param that was never lowercased
  // client-side) fails the WHERE email = ? lookup below (SQLite's default
  // text comparison is case-sensitive; contacts.email has no COLLATE
  // NOCASE), silently creating a second, separate contact instead of
  // matching the one /submit-lead already created -- and that new contact's
  // INSERT never sets sms_consent, so it defaults to 0 even when the
  // visitor genuinely consented on the original contact record.
  const email = normalizeEmail(attendee.email || responses.email?.value || null);

  const rawPhone = attendee.phoneNumber
    || responses.phone?.value
    || responses.phoneNumber?.value
    || responses.cell?.value
    || responses.mobile?.value
    || extractLocationPhone(payload.location)
    || null;
  const { display: phoneDisplay, e164: phoneE164 } = normalizePhone(rawPhone);

  // New standardized "Is this a mobile phone or a landline?" question (both
  // brands). Routes the SAME number into exactly one of the two phone
  // fields -- never both -- per the home_phone addCol comment in
  // crm/db/database.js. phoneE164 (used just below for CONTACT MATCHING) is
  // deliberately left untouched by this routing: matching an existing
  // contact by whatever number Cal.com sent must keep working the same way
  // regardless of the mobile/landline answer, only where the number gets
  // STORED is affected.
  const phoneType = extractPhoneType(responses); // 'mobile' | 'landline' | null
  const isLandline = phoneType === 'landline';
  const mobilePhone     = isLandline ? null : phoneDisplay;
  const mobilePhoneE164 = isLandline ? null : phoneE164;
  const homePhone       = isLandline ? phoneDisplay : null;

  // New standardized communication-consent question (both brands, identical
  // wording apart from the brand's own legal name). null means the
  // question was absent or unanswered -- see extractCommunicationConsent's
  // own comment for why that must never be treated as consent.
  const consent = extractCommunicationConsent(responses); // {sms, email} | null

  const baseNotes = payload.additionalNotes
    || responses.notes?.value
    || responses.message?.value
    || responses.description?.value
    || null;

  // Computed once, from the payload directly (slug-first, see
  // inferLeadType's own comment) -- reused below both for the Life
  // Insurance qualification-answer capture and the Retirement Intake
  // gating, so the two can never resolve to different classifications.
  const leadType = inferLeadType(payload);

  // Life Insurance qualification answers -- see extractLifeInsuranceAnswers'
  // own comment above for why this matches by question label rather than a
  // guessed internal identifier, and always preserves anything it can't
  // confidently label.
  let notes = baseNotes;
  if (leadType === 'Life Insurance Lead') {
    console.log(`Cal.com webhook: Life Insurance booking ${uid} — raw responses:`, JSON.stringify(responses));
    const lifeInsuranceAnswers = extractLifeInsuranceAnswers(payload);
    const qualificationNote = buildLifeInsuranceNote(lifeInsuranceAnswers);
    notes = [baseNotes, qualificationNote].filter(Boolean).join('\n\n') || null;
  }

  const location   = normalizeLocation(payload.location);
  // payload.eventTitle is Cal.com's documented field for the event type's
  // own name; payload.title is the specific booking's generated display
  // name (e.g. "30 Min Meeting between X and Y") and eventType.title is
  // checked last only for forward/backward compatibility -- see
  // inferLeadType's own comment for why none of these are used for
  // CLASSIFICATION, only for this display/storage value.
  const apptType   = payload.eventTitle || payload.title || eventType.title || 'Consultation';
  const durationMin = eventType.length
    || (startTime && endTime
        ? Math.round((new Date(endTime) - new Date(startTime)) / 60000)
        : 60);

  const apptDatetime = startTime ? new Date(startTime).toISOString() : null;
  if (!apptDatetime) {
    console.warn('Cal.com webhook: no startTime in payload, skipping');
    return;
  }

  // ── Upsert contact ─────────────────────────────────────────────────────────
  let contact = null;
  if (email)    contact = db.prepare('SELECT * FROM contacts WHERE email = ?').get(email);
  if (!contact && phoneE164)
    contact = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get(phoneE164);

  const now      = new Date().toISOString();

  // BOOKING_RESCHEDULED sets "Appointment Rescheduled"; BOOKING_CREATED sets "Appointment Scheduled"
  const targetLeadStatus = event === 'BOOKING_RESCHEDULED'
    ? 'Appointment Rescheduled'
    : 'Appointment Scheduled';
  // Statuses eligible for automatic upgrade on a new/rescheduled booking
  const upgradeStatuses = [
    'New Lead', 'Attempted Contact', 'Contacted',
    'Follow-Up Needed', 'Long-Term Nurture',
    'Appointment Scheduled', 'Appointment Rescheduled', 'Needs Outcome',
  ];

  // Consent is only ever written when explicitly answered on THIS booking
  // (consent !== null); consentKnown gates both the INSERT default and the
  // UPDATE's CASE below so an absent/unrecognized answer never touches an
  // existing contact's consent columns, and a brand-new contact with no
  // answer gets the same 0/"not confirmed" default the schema itself
  // already applies (INSERT already left these columns unset entirely
  // before this feature existed, so this is purely additive).
  const consentKnown = consent !== null;
  const smsConsentVal   = consentKnown ? (consent.sms   ? 1 : 0) : 0;
  const emailConsentVal = consentKnown ? (consent.email ? 1 : 0) : 0;

  if (!contact) {
    const r = db.prepare(`
      INSERT INTO contacts
        (first_name, last_name, email, phone, phone_e164, home_phone, lead_type, lead_status, lead_source,
         sms_consent, email_consent, sms_consent_source, sms_consent_at, updated_at)
      VALUES
        (@first_name, @last_name, @email, @phone, @phone_e164, @home_phone, @lead_type, @lead_status, @lead_source,
         @sms_consent, @email_consent, @sms_consent_source, @sms_consent_at, @now)
    `).run({
      first_name:  firstName,
      last_name:   lastName,
      email:       email       || null,
      phone:       mobilePhone,
      phone_e164:  mobilePhoneE164,
      home_phone:  homePhone,
      lead_type:   leadType,
      lead_status: targetLeadStatus,
      lead_source: 'Cal.com',
      sms_consent:         smsConsentVal,
      email_consent:       emailConsentVal,
      sms_consent_source:  consentKnown ? 'Cal.com booking' : null,
      sms_consent_at:      consentKnown ? now : null,
      now,
    });
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
    console.log(`Cal.com: created new contact #${contact.id} — ${fullName}`);
  } else {
    const newStatus = upgradeStatuses.includes(contact.lead_status)
      ? targetLeadStatus
      : contact.lead_status;
    db.prepare(`
      UPDATE contacts SET
        first_name    = COALESCE(first_name,   @first_name),
        last_name     = COALESCE(last_name,    @last_name),
        phone         = COALESCE(phone,        @phone),
        phone_e164    = COALESCE(phone_e164,   @phone_e164),
        home_phone    = COALESCE(home_phone,   @home_phone),
        lead_status   = @lead_status,
        lead_source   = COALESCE(lead_source,  @lead_source),
        sms_consent         = CASE WHEN @consent_known = 1 THEN @sms_consent   ELSE sms_consent   END,
        email_consent       = CASE WHEN @consent_known = 1 THEN @email_consent ELSE email_consent END,
        sms_consent_source  = CASE WHEN @consent_known = 1 THEN @sms_consent_source ELSE sms_consent_source END,
        sms_consent_at      = CASE WHEN @consent_known = 1 THEN @sms_consent_at     ELSE sms_consent_at     END,
        updated_at    = @now
      WHERE id = @id
    `).run({
      first_name:  firstName,
      last_name:   lastName,
      phone:       mobilePhone,
      phone_e164:  mobilePhoneE164,
      home_phone:  homePhone,
      lead_status: newStatus,
      lead_source: 'Cal.com',
      consent_known:       consentKnown ? 1 : 0,
      sms_consent:         smsConsentVal,
      email_consent:       emailConsentVal,
      sms_consent_source:  'Cal.com booking',
      sms_consent_at:      now,
      now,
      id: contact.id,
    });
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
    console.log(`Cal.com: matched existing contact #${contact.id} — ${fullName}`);
  }

  // ── Upsert appointment ─────────────────────────────────────────────────────
  const apptStatus = event === 'BOOKING_RESCHEDULED' ? 'Rescheduled' : 'Scheduled';

  // Look up by new UID first, then by the reschedule UID (old booking)
  let existing = db.prepare('SELECT * FROM appointments WHERE cal_booking_uid = ?').get(uid);
  if (!existing && rescheduleUid) {
    existing = db.prepare('SELECT * FROM appointments WHERE cal_booking_uid = ?').get(rescheduleUid);
  }

  const isNew        = !existing;
  const statusChanged = existing && existing.status !== apptStatus;

  let apptId;
  if (existing) {
    db.prepare(`
      UPDATE appointments SET
        contact_id      = @contact_id,
        appt_type       = @appt_type,
        appt_datetime   = @appt_datetime,
        duration_min    = @duration_min,
        status          = @status,
        location        = @location,
        notes           = @notes,
        cal_booking_uid = @cal_booking_uid,
        updated_at      = @updated_at
      WHERE id = @id
    `).run({
      contact_id:      contact.id,
      appt_type:       apptType,
      appt_datetime:   apptDatetime,
      duration_min:    durationMin,
      status:          apptStatus,
      location:        location || null,
      notes:           notes    || null,
      cal_booking_uid: uid,
      updated_at:      now,
      id:              existing.id,
    });
    apptId = existing.id;
    console.log(`Cal.com: updated appointment #${apptId} (status=${apptStatus})`);
  } else {
    const r = db.prepare(`
      INSERT INTO appointments
        (contact_id, appt_type, appt_datetime, duration_min, status, location, notes, cal_booking_uid)
      VALUES
        (@contact_id, @appt_type, @appt_datetime, @duration_min, @status, @location, @notes, @cal_booking_uid)
    `).run({
      contact_id:      contact.id,
      appt_type:       apptType,
      appt_datetime:   apptDatetime,
      duration_min:    durationMin,
      status:          apptStatus,
      location:        location || null,
      notes:           notes    || null,
      cal_booking_uid: uid,
    });
    apptId = r.lastInsertRowid;
    console.log(`Cal.com: created appointment #${apptId} (${apptType})`);
  }

  // ── Log to contact activity timeline (only on new booking or status change) ─
  if (isNew || statusChanged) {
    const subject = event === 'BOOKING_RESCHEDULED'
      ? 'Appointment Rescheduled (Cal.com)'
      : 'Appointment Scheduled (Cal.com)';
    // Deliberately concise -- this becomes both the Activity Timeline entry's
    // description AND (via GET /api/contacts/:id) what Activity & Form
    // Submissions renders for this same row, so it must not repeat the full
    // Cal.com intake questionnaire (that already lives, in full, in this
    // appointment's own `notes` column -- see appointments.notes above --
    // which the Appointments card renders as the canonical detailed view).
    const body = [
      `${apptType} — ${fmtCT(apptDatetime)}`,
      location   ? `Location: ${location}`   : null,
      `Cal.com Booking: ${uid}`,
    ].filter(Boolean).join('\n');

    db.prepare(`
      INSERT INTO communications (contact_id, comm_type, direction, subject, body, appointment_id)
      VALUES (?, 'appointment', 'inbound', ?, ?, ?)
    `).run(contact.id, subject, body, apptId);
  }

  // ── Appointment SMS: exactly one automated message per NEW booking, and
  // exactly one more per genuine reschedule ────────────────────────────────
  // Retirement Lead bookings get the Retirement Intake Form link instead
  // (below) -- that message already states the appointment date/time, so it
  // serves as this booking's confirmation; sending both would duplicate.
  // Every other lead type (Life Insurance, Roth Conversion, generic Contact
  // Form, etc.) gets the generic appointment SMS here, in one of two forms:
  //   - isNew: a NEW-booking confirmation (messageType 'confirmation').
  //   - !isNew && statusChanged && event is a reschedule: a reschedule
  //     notice (messageType 'reschedule'), using the SAME statusChanged
  //     signal already used for the Activity Timeline entry above, so a
  //     redelivered BOOKING_RESCHEDULED webhook (status already
  //     'Rescheduled') never re-sends. This branch never creates or
  //     duplicates an appointment row -- the upsert above already ran; this
  //     only decides whether to notify.
  // All three branches catch/log rather than throw -- a messaging failure
  // must never affect the booking/contact/appointment data already written
  // above. Neither sendAppointmentConfirmationSms nor sendRetirementIntakeSms
  // ever lets a Twilio error propagate either (see crm/lib/legacySmsSend.js).
  if (isNew && leadType === 'Retirement Lead') {
    // Create the (idempotent) intake record and send the prospect their
    // link. This isNew gate is the FIRST of two independent safeguards
    // against a duplicate send; see crm/lib/retirementIntakeSms.js's
    // file-level comment for the second (status must still be 'Not Sent').
    const intake = createIntakeForAppointment(db, { contactId: contact.id, appointmentId: apptId });
    try {
      const smsResult = await sendRetirementIntakeSms(db, {
        intake, contactId: contact.id, appointmentDatetimeIso: apptDatetime,
      });
      if (smsResult.attempted && !smsResult.sent) {
        console.warn(`Cal.com: retirement intake SMS not sent for contact #${contact.id} (intake #${intake.id}): ${smsResult.reason}`);
      }
    } catch (smsErr) {
      console.error(`Cal.com: retirement intake SMS threw unexpectedly for contact #${contact.id}:`, smsErr.message);
    }
  } else if (isNew) {
    const bookingBrand = inferBookingBrand(responses);
    console.log(`Cal.com: booking brand resolved as ${bookingBrand} for contact #${contact.id}`);
    try {
      const smsResult = await sendAppointmentConfirmationSms(db, {
        contactId: contact.id, firstName, appointmentType: apptType, appointmentDatetimeIso: apptDatetime,
        brandId: bookingBrand,
      });
      if (smsResult.attempted && !smsResult.sent) {
        console.warn(`Cal.com: appointment confirmation SMS not sent for contact #${contact.id}: ${smsResult.reason}`);
      }
    } catch (smsErr) {
      console.error(`Cal.com: appointment confirmation SMS threw unexpectedly for contact #${contact.id}:`, smsErr.message);
    }
  } else if (event === 'BOOKING_RESCHEDULED' && statusChanged && leadType !== 'Retirement Lead') {
    const bookingBrand = inferBookingBrand(responses);
    console.log(`Cal.com: booking brand resolved as ${bookingBrand} for contact #${contact.id} (reschedule)`);
    try {
      const smsResult = await sendAppointmentConfirmationSms(db, {
        contactId: contact.id, firstName, appointmentType: apptType, appointmentDatetimeIso: apptDatetime,
        brandId: bookingBrand, messageType: 'reschedule',
      });
      if (smsResult.attempted && !smsResult.sent) {
        console.warn(`Cal.com: reschedule confirmation SMS not sent for contact #${contact.id}: ${smsResult.reason}`);
      }
    } catch (smsErr) {
      console.error(`Cal.com: reschedule confirmation SMS threw unexpectedly for contact #${contact.id}:`, smsErr.message);
    }
  }
}

function handleCancelled(payload) {
  const uid = payload.uid;
  if (!uid) return;

  const appt = db.prepare('SELECT * FROM appointments WHERE cal_booking_uid = ?').get(uid);
  if (!appt) {
    console.warn(`Cal.com CANCELLED: booking ${uid} not found — may not have been synced`);
    return;
  }

  if (appt.status === 'Cancelled') {
    console.log(`Cal.com CANCELLED: appointment #${appt.id} already cancelled, skipping`);
    return;
  }

  const now = new Date().toISOString();
  db.prepare('UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?')
    .run('Cancelled', now, appt.id);

  db.prepare('UPDATE contacts SET lead_status = ?, updated_at = ? WHERE id = ?')
    .run('Cancelled', now, appt.contact_id);

  // Replace any previous outcome record with the cancellation event
  db.prepare(`
    DELETE FROM communications
    WHERE appointment_id = ?
      AND subject IN (
        'Appointment Completed',
        'Appointment No-Show',
        'Appointment Cancelled',
        'Appointment Rescheduled'
      )
  `).run(appt.id);

  const body = [
    `${appt.appt_type} — ${fmtCT(appt.appt_datetime)}`,
    payload.cancellationReason ? `Reason: ${payload.cancellationReason}` : null,
  ].filter(Boolean).join('\n');

  db.prepare(`
    INSERT INTO communications (contact_id, comm_type, direction, subject, body, appointment_id)
    VALUES (?, 'appointment', 'inbound', 'Appointment Cancelled (Cal.com)', ?, ?)
  `).run(appt.contact_id, body, appt.id);

  console.log(`Cal.com: cancelled appointment #${appt.id}`);
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Liveness check — lets you confirm the URL is reachable
router.get('/webhook', (_req, res) => {
  res.json({ ok: true, message: 'Cal.com webhook endpoint is active' });
});

router.post('/webhook', async (req, res) => {
  // Respond 200 immediately so Cal.com does not retry on processing delay
  res.json({ ok: true });

  try {
    if (!verifySignature(req)) {
      console.warn('Cal.com webhook: HMAC signature mismatch — request ignored');
      return;
    }

    const { triggerEvent, payload } = req.body || {};
    if (!payload?.uid) {
      console.warn('Cal.com webhook: missing payload or uid');
      return;
    }

    console.log(`Cal.com webhook received: ${triggerEvent}`);

    if (triggerEvent === 'BOOKING_CREATED' || triggerEvent === 'BOOKING_RESCHEDULED') {
      await handleCreatedOrRescheduled(triggerEvent, payload);
    } else if (triggerEvent === 'BOOKING_CANCELLED') {
      handleCancelled(payload);
    } else {
      console.log(`Cal.com webhook: unhandled event type ${triggerEvent}`);
    }
  } catch (err) {
    console.error('Cal.com webhook processing error:', err);
  }
});

module.exports = router;
