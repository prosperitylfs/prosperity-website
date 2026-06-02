/**
 * POST /api/calcom/webhook
 *
 * Receives Cal.com booking events and syncs them to the CRM calendar.
 * Handles: BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELLED
 *
 * Deduplication: appointments are keyed on cal_booking_uid, so duplicate
 * webhook deliveries are idempotent (update in place, no duplicate rows).
 *
 * Optional HMAC verification: set CALCOM_WEBHOOK_SECRET env var in Render
 * to match the secret configured in Cal.com → Settings → Developer → Webhooks.
 */

const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db/database');

// ── Helpers ───────────────────────────────────────────────────────────────────

function verifySignature(req) {
  const secret = process.env.CALCOM_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured — skip in dev
  const sig = (req.headers['x-cal-signature-256'] || '').trim();
  if (!sig) return false;
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body));
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(sig.toLowerCase()),
      Buffer.from(expected.toLowerCase())
    );
  } catch {
    return false;
  }
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

  const notes = payload.additionalNotes
    || responses.notes?.value
    || responses.message?.value
    || responses.description?.value
    || null;

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
