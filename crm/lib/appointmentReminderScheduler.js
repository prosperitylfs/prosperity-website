// Automatic appointment reminder SMS -- 24 hours, 1 hour, and 15 minutes
// before an active/upcoming appointment. Runs as a periodic in-process
// timer inside the existing single Render web service (see
// startReminderScheduler / crm/server.js); no separate Render cron/worker
// service or paid external scheduling infrastructure is introduced, since
// this Node process already runs continuously (the same process that
// receives Cal.com webhooks in real time), which is all a plain
// setInterval loop needs to be reliable.
//
// ── Windowing (not an exact-second match) ──────────────────────────────────
// Each poll selects every active appointment whose start time has ALREADY
// crossed the 24-hour threshold (the widest window) but hasn't happened
// yet. Because the poll interval (crm/server.js, default 5 minutes) is far
// shorter than any of the three windows, an appointment can never sail past
// a threshold unnoticed between polls -- correctness comes from idempotency
// (below), not from a narrow window, so a slow/late poll only delays a
// reminder by a few extra minutes, never causes a miss or a duplicate.
//
// ── Exactly one reminder per appointment per BAND, never a cascade ─────────
// "Within 24h", "within 1h", and "within 15m" are nested, not disjoint -- an
// appointment 10 minutes away is trivially also "within 24h" and "within
// 1h". Deduping each type independently is NOT enough to prevent a cascade:
// a same-day/last-minute booking (or an appointment the scheduler never got
// to poll during an earlier window, e.g. after downtime) would otherwise
// become eligible for all three reminder types at once, and once the
// smallest one is sent, the other two would STILL show as "not yet sent"
// and fire on a later poll -- three separate texts, just spread out instead
// of simultaneous. To prevent that, "how far away is this appointment" maps
// to exactly ONE of three MUTUALLY EXCLUSIVE bands (0-15m, 15m-1h, 1h-24h)
// via currentReminderBand() below -- an appointment is only ever a
// candidate for the single reminder type matching whichever band it's
// currently in, never any other type, regardless of what has or hasn't
// been sent before. In normal steady-state operation (time actually
// advancing between polls) this still sends all three, once each, exactly
// like nested windows would -- the difference only shows up for the
// catch-up/last-minute case, where it correctly sends just the one most
// relevant reminder instead of all three.
//
// ── Idempotency / reschedule handling ───────────────────────────────────────
// Each (appointment, reminder type) pair is deduped by a compound key:
// appointment_id + message_type + the appointment's CURRENT appt_datetime
// (sms_messages.appointment_occurrence_at, stamped at send time -- see
// crm/lib/legacySmsSend.js). A rescheduled appointment keeps the SAME
// appointment_id (crm/routes/calcom.js updates the row in place) but gets a
// NEW appt_datetime, which changes the dedup key -- so a reminder already
// sent for the appointment's old time does not block sending it again for
// the new time, and the old time's reminder is never resent once the time
// has changed. A FAILED send (Twilio error) leaves no matching row, so it
// is naturally retried on the next poll while still inside the window --
// only a genuinely successful (or in-flight 'queued') send blocks a retry.
//
// ── Eligibility ──────────────────────────────────────────────────────────
// SQL filters to status IN ('Scheduled', 'Rescheduled') (excludes
// Cancelled/Completed/No-Show) and the time window. Consent and phone-type
// eligibility ("Text and email"/"Text only" -> SMS yes; "Email only" -> SMS
// no; missing/unknown -> no) are NOT re-implemented here -- they're
// entirely delegated to the same checkConsentGate/resolveToNumber inside
// sendLegacySms that every other automated SMS in this codebase already
// uses, so there is exactly one place that logic lives.
//
// ── Brand resolution (never guessed) ────────────────────────────────────
// See resolveReminderBrand's own comment: booking_brand first, a single
// active contact_brands relationship second, otherwise the reminder is
// SKIPPED for that appointment -- never sent under a guessed/defaulted
// brand. This fixed a real production bug where appointments predating
// booking_brand persistence (NULL column) silently sent Prosperity-branded
// reminders for Insurance Lady bookings.
//
// ── Error isolation ────────────────────────────────────────────────────────
// Each appointment is processed in its own try/catch; one failure (a
// throwing dependency, a malformed row) is logged and skipped, never
// aborting the rest of the batch or crashing the poll.

const { sendAppointmentConfirmationSms } = require('./appointmentConfirmationSms');

// Order matters: also the order the bands are listed in the header comment
// above (0-15m, 15m-1h, 1h-24h).
const REMINDER_SPECS = [
  { messageType: 'reminder_15m', offsetMinutes: 15 },
  { messageType: 'reminder_1h',  offsetMinutes: 60 },
  { messageType: 'reminder_24h', offsetMinutes: 24 * 60 },
];

const WIDEST_OFFSET_MINUTES = REMINDER_SPECS[REMINDER_SPECS.length - 1].offsetMinutes;
const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function findEligibleAppointments(db, { nowIso, cutoffIso }) {
  return db.prepare(`
    SELECT a.id AS appointment_id, a.appt_type, a.appt_datetime, a.booking_brand,
           c.id AS contact_id, c.first_name
    FROM appointments a
    JOIN contacts c ON c.id = a.contact_id
    WHERE a.status IN ('Scheduled', 'Rescheduled')
      AND datetime(a.appt_datetime) <= datetime(?)
      AND datetime(a.appt_datetime) > datetime(?)
  `).all(cutoffIso, nowIso);
}

function alreadySent(db, { appointmentId, messageType, appointmentOccurrenceAt }) {
  const row = db.prepare(`
    SELECT 1 FROM sms_messages
    WHERE appointment_id = ? AND message_type = ? AND appointment_occurrence_at = ? AND status != 'failed'
    LIMIT 1
  `).get(appointmentId, messageType, appointmentOccurrenceAt);
  return !!row;
}

// Resolves which brand a reminder must use, in the strongest-signal-first
// order: (1) the appointment's own persisted booking_brand (set by
// crm/routes/calcom.js at webhook time); (2) if that's missing --
// appointments created/last touched before booking_brand persistence
// existed -- the contact's contact_brands relationship, but ONLY when
// there is EXACTLY ONE active one (two would be genuinely ambiguous, not
// a signal to guess from). Returns null, never a default brand, when
// neither signal resolves -- the caller must skip sending rather than
// fall back to sendAppointmentConfirmationSms's own 'prosperity' default
// (its brandId default parameter only applies to `undefined`, not `null`,
// and buildConfirmationSmsBody's internal `getTemplate(brandId, ...) ||
// getTemplate('prosperity', ...)` would silently re-default even a `null`
// brandId -- so the only safe way to "not guess" is to never call it).
//
// When resolved via the contact_brands fallback, the appointment row is
// healed in place (booking_brand written, guarded to only ever fill a
// NULL value, never overwrite) so this and every other brand-dependent
// lookup on this appointment stops needing to re-derive it on every future
// poll -- the smallest safe migration for pre-existing rows, applied
// lazily/on-demand rather than as a bulk backfill.
function resolveReminderBrand(db, appt) {
  if (appt.booking_brand) return appt.booking_brand;

  const activeLinks = db.prepare(`
    SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id
    WHERE cb.contact_id = ? AND cb.status = 'Active'
  `).all(appt.contact_id);

  if (activeLinks.length === 1) {
    const brandId = activeLinks[0].slug;
    db.prepare('UPDATE appointments SET booking_brand = ? WHERE id = ? AND booking_brand IS NULL')
      .run(brandId, appt.appointment_id);
    return brandId;
  }

  return null;
}

// Maps "minutes until the appointment" to the single reminder type whose
// band it currently falls in -- REMINDER_SPECS is ordered smallest-offset
// first, so the first spec whose offsetMinutes the appointment is still
// inside IS that band (0-15m matches reminder_15m, 15m-1h falls through to
// reminder_1h, 1h-24h falls through to reminder_24h). Returns null if the
// appointment has already happened (minutesUntil <= 0) or isn't due for
// any reminder yet (more than 24h away).
function currentReminderBand(minutesUntil) {
  if (minutesUntil <= 0) return null;
  for (const spec of REMINDER_SPECS) {
    if (minutesUntil <= spec.offsetMinutes) return spec;
  }
  return null;
}

// Runs one full pass. Returns a small summary object (mainly for tests /
// server-startup logging) -- never throws.
async function runReminderCheck(db, { now = new Date(), deps = {} } = {}) {
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() + WIDEST_OFFSET_MINUTES * 60000).toISOString();
  const summary = { checked: 0, sent: 0, skipped: 0, failed: 0, errors: [] };

  let candidates;
  try {
    candidates = findEligibleAppointments(db, { nowIso, cutoffIso });
  } catch (err) {
    console.error('[appointmentReminderScheduler] query failed:', err.message);
    summary.errors.push({ error: err.message });
    return summary;
  }

  for (const appt of candidates) {
    summary.checked += 1;
    try {
      const minutesUntil = (new Date(appt.appt_datetime).getTime() - now.getTime()) / 60000;
      const spec = currentReminderBand(minutesUntil);
      if (!spec || alreadySent(db, { appointmentId: appt.appointment_id, messageType: spec.messageType, appointmentOccurrenceAt: appt.appt_datetime })) {
        summary.skipped += 1;
        continue;
      }

      const brandId = resolveReminderBrand(db, appt);
      if (!brandId) {
        summary.skipped += 1;
        console.warn(`[appointmentReminderScheduler] skipping ${spec.messageType} for appointment #${appt.appointment_id} -- brand could not be reliably determined (no booking_brand, and contact_brands has no single active relationship). Never guessed as Prosperity.`);
        continue;
      }
      const smsResult = await sendAppointmentConfirmationSms(db, {
        contactId: appt.contact_id,
        firstName: appt.first_name,
        appointmentType: appt.appt_type,
        appointmentDatetimeIso: appt.appt_datetime,
        brandId,
        messageType: spec.messageType,
        appointmentId: appt.appointment_id,
        now,
      }, deps);

      if (smsResult.sent) {
        summary.sent += 1;
      } else if (smsResult.attempted) {
        summary.skipped += 1;
        // Not an error-log-worthy event by itself (e.g. missing consent is
        // an expected, routine outcome) -- logged at the same level the
        // confirmation/reschedule sends already use for a not-sent result.
        console.warn(`[appointmentReminderScheduler] ${spec.messageType} not sent for appointment #${appt.appointment_id}: ${smsResult.reason}`);
      }
    } catch (err) {
      // One appointment's failure must never stop the batch. No contact
      // PII (name/phone/email) is included in this log line -- only the
      // internal appointment id and the error message.
      summary.failed += 1;
      summary.errors.push({ appointmentId: appt.appointment_id, error: err.message });
      console.error(`[appointmentReminderScheduler] unexpected error for appointment #${appt.appointment_id}:`, err.message);
    }
  }

  return summary;
}

// Wires runReminderCheck to a periodic in-process timer. Called once from
// crm/server.js at startup with the real `db`; never called by any test
// (no test file requires crm/server.js), so this never runs during `npm test`.
// Returns the interval handle (only so a caller could clearInterval it in a
// graceful-shutdown path in the future -- not currently used for that).
function startReminderScheduler(db, { intervalMs = DEFAULT_POLL_INTERVAL_MS, deps = {} } = {}) {
  console.log(`[appointmentReminderScheduler] starting -- checking every ${Math.round(intervalMs / 60000)} minute(s)`);
  const tick = () => {
    runReminderCheck(db, { deps }).catch(err => {
      console.error('[appointmentReminderScheduler] runReminderCheck threw unexpectedly:', err.message);
    });
  };
  const handle = setInterval(tick, intervalMs);
  if (typeof handle.unref === 'function') handle.unref(); // never keeps the process alive on its own
  return handle;
}

module.exports = { REMINDER_SPECS, runReminderCheck, startReminderScheduler };
