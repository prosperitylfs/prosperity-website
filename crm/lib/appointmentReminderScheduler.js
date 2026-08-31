// Automatic appointment reminder SMS -- 24 hours, 1 hour, and 15 minutes
// before an active/upcoming appointment. Runs as a periodic in-process
// timer inside the existing single Render web service (see
// startReminderScheduler / crm/server.js); no separate Render cron/worker
// service or paid external scheduling infrastructure is introduced, since
// this Node process already runs continuously (the same process that
// receives Cal.com webhooks in real time), which is all a plain
// setInterval loop needs to be reliable.
//
// ── Windowing: narrow, disjoint windows around each target time ───────────
// Each reminder type fires only inside a narrow window around its actual
// target time, not "anywhere between now and the threshold":
//   reminder_24h -> 1435-1445 minutes away (23h55m-24h5m, ~24h +/- 5m)
//   reminder_1h  -> 55-65 minutes away     (~1h +/- 5m)
//   reminder_15m -> 10-20 minutes away     (~15m +/- 5m)
// Each window is at least 10 minutes wide against a 5-minute poll interval
// (crm/server.js, DEFAULT_POLL_INTERVAL_MS), so at least one poll always
// lands inside it -- the poll cadence can never cause a miss. Being outside
// a window is not "not sent yet", it's "not due" -- an appointment 5.5
// hours away is simply between windows and gets nothing, which is the fix
// for a real production bug where a 5:00 PM appointment received a
// "24-hour" reminder at 11:27 AM (~5.5 hours out), because the old logic
// treated reminder_24h as "anywhere from 1h to 24h away" rather than
// "around the 24h mark".
//
// ── Exactly one reminder per appointment, no cascade -- now structural ─────
// The three windows above are disjoint (10-20, 55-65, and 1435-1445 all
// have gaps between them), so a given minutesUntil value can match at most
// one spec -- findReminderSpec() below just returns whichever single window
// (if any) currently contains it. This also means a restart/deployment, or
// a same-day/last-minute booking, can never retroactively fire a stale
// reminder type: if the appointment is 30 minutes away when the process
// (re)starts, it isn't in the 1h window (55-65) or the 15m window (10-20)
// yet, so nothing sends until it actually enters one -- there is no "still
// within 24h, still eligible" fallback left to trigger it early.
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

// Listed smallest-window-first purely for readability -- the windows are
// disjoint, so match order has no effect on which spec (if any) is found.
const REMINDER_SPECS = [
  { messageType: 'reminder_15m', minMinutes: 10, maxMinutes: 20 },
  { messageType: 'reminder_1h',  minMinutes: 55, maxMinutes: 65 },
  { messageType: 'reminder_24h', minMinutes: 1435, maxMinutes: 1445 },
];

// The outer edge of the widest (24h) window -- how far out the eligibility
// query must look so appointments in the 1435-1445 minute window aren't
// excluded before they're ever considered.
const WIDEST_MAX_MINUTES = Math.max(...REMINDER_SPECS.map(spec => spec.maxMinutes));
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

// Returns the single reminder spec (if any) whose [minMinutes, maxMinutes]
// window currently contains minutesUntil. The three windows are disjoint by
// construction, so at most one can ever match -- an appointment between
// windows (e.g. 5.5 hours out) or past its window (e.g. 5 minutes out once
// the 15m window has closed at 20 minutes) simply matches nothing and gets
// no reminder, rather than falling back to a broader "still within 24h"
// match.
function findReminderSpec(minutesUntil) {
  if (minutesUntil <= 0) return null;
  return REMINDER_SPECS.find(spec => minutesUntil >= spec.minMinutes && minutesUntil <= spec.maxMinutes) || null;
}

// Runs one full pass. Returns a small summary object (mainly for tests /
// server-startup logging) -- never throws.
async function runReminderCheck(db, { now = new Date(), deps = {} } = {}) {
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() + WIDEST_MAX_MINUTES * 60000).toISOString();
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
      const spec = findReminderSpec(minutesUntil);
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
