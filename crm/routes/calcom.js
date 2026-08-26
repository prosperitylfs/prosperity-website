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
  // Cal.com may send location as object { type, value } or as a plain string
  const loc = typeof raw === 'object' ? (raw.value || raw.type || '') : String(raw);
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

function inferLeadType(eventTypeTitle) {
  const t = (eventTypeTitle || '').toLowerCase();
  if (t.includes('roth'))                          return 'Roth Conversion Lead';
  if (t.includes('retire') || t.includes('rollover')) return 'Retirement Lead';
  if (t.includes('life') || t.includes('insurance')) return 'Life Insurance Lead';
  return 'Contact Form Lead';
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
    const found = Object.entries(responses).find(([, r]) => {
      const l = String((r && r.label) || '').toLowerCase();
      return patterns.some(p => l.includes(p));
    });
    if (!found) continue;
    const [respKey, entry] = found;
    if (entry.value === undefined || entry.value === null || entry.value === '') continue;
    matched.push({ label, value: entry.value });
    consumedResponseKeys.add(respKey);
  }

  // Everything else Cal.com sent back, so a wording change that breaks a
  // label match above still shows up here instead of vanishing.
  const rawExtras = [];
  for (const [respKey, entry] of Object.entries(responses)) {
    if (ALREADY_HANDLED_RESPONSE_KEYS.has(respKey) || consumedResponseKeys.has(respKey)) continue;
    if (!entry || entry.value === undefined || entry.value === null || entry.value === '') continue;
    rawExtras.push(entry.label ? `${entry.label}: ${entry.value}` : `${respKey}: ${entry.value}`);
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

function handleCreatedOrRescheduled(event, payload) {
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

  const email = attendee.email
    || responses.email?.value
    || null;

  const rawPhone = attendee.phoneNumber
    || responses.phone?.value
    || responses.phoneNumber?.value
    || responses.cell?.value
    || responses.mobile?.value
    || null;
  const { display: phoneDisplay, e164: phoneE164 } = normalizePhone(rawPhone);

  const baseNotes = payload.additionalNotes
    || responses.notes?.value
    || responses.message?.value
    || responses.description?.value
    || null;

  // Life Insurance qualification answers -- see extractLifeInsuranceAnswers'
  // own comment above for why this matches by question label rather than a
  // guessed internal identifier, and always preserves anything it can't
  // confidently label.
  let notes = baseNotes;
  if (inferLeadType(eventType.title) === 'Life Insurance Lead') {
    console.log(`Cal.com webhook: Life Insurance booking ${uid} — raw responses:`, JSON.stringify(responses));
    const lifeInsuranceAnswers = extractLifeInsuranceAnswers(payload);
    const qualificationNote = buildLifeInsuranceNote(lifeInsuranceAnswers);
    notes = [baseNotes, qualificationNote].filter(Boolean).join('\n\n') || null;
  }

  const location   = normalizeLocation(payload.location);
  const apptType   = eventType.title || 'Consultation';
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
  const leadType = inferLeadType(apptType);

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

  if (!contact) {
    const r = db.prepare(`
      INSERT INTO contacts
        (first_name, last_name, email, phone, phone_e164, lead_type, lead_status, lead_source, updated_at)
      VALUES
        (@first_name, @last_name, @email, @phone, @phone_e164, @lead_type, @lead_status, @lead_source, @now)
    `).run({
      first_name:  firstName,
      last_name:   lastName,
      email:       email       || null,
      phone:       phoneDisplay,
      phone_e164:  phoneE164,
      lead_type:   leadType,
      lead_status: targetLeadStatus,
      lead_source: 'Cal.com',
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
        first_name  = COALESCE(first_name,  @first_name),
        last_name   = COALESCE(last_name,   @last_name),
        phone       = COALESCE(phone,       @phone),
        phone_e164  = COALESCE(phone_e164,  @phone_e164),
        lead_status = @lead_status,
        lead_source = COALESCE(lead_source, @lead_source),
        updated_at  = @now
      WHERE id = @id
    `).run({
      first_name:  firstName,
      last_name:   lastName,
      phone:       phoneDisplay,
      phone_e164:  phoneE164,
      lead_status: newStatus,
      lead_source: 'Cal.com',
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
    const body = [
      `${apptType} — ${fmtCT(apptDatetime)}`,
      location   ? `Location: ${location}`   : null,
      notes      ? `Notes: ${notes}`          : null,
      `Cal.com Booking: ${uid}`,
    ].filter(Boolean).join('\n');

    db.prepare(`
      INSERT INTO communications (contact_id, comm_type, direction, subject, body, appointment_id)
      VALUES (?, 'appointment', 'inbound', ?, ?, ?)
    `).run(contact.id, subject, body, apptId);
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

router.post('/webhook', (req, res) => {
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
      handleCreatedOrRescheduled(triggerEvent, payload);
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
