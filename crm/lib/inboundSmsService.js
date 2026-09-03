// Inbound-SMS handling. Pure logic, no Express/HTTP/network here — takes an
// explicit better-sqlite3 `db` handle and a plain params object, so it's
// fully testable with fake signed webhook fixtures and never contacts
// Twilio itself. crm/routes/twilio.js and crm/routes/twilioProsperitySms.js
// are the thin route wrappers that verify the X-Twilio-Signature header
// (reusing the existing, already-tested crm/lib/twilioSignature.js) before
// calling in.
//
// handleInboundSmsUnified() (added for the local compatibility checkpoint,
// see its own doc comment below) is now the ONE authoritative
// implementation both routes call — it never imports
// crm/lib/autoTasks.js, which opens the live database as a side effect of
// being required; every legacy behavior it reproduces (contact
// match-or-create, the SMS-reply follow-up task) is reimplemented here
// against the explicit `db` handle instead, so this file stays fully
// testable against an in-memory database.
//
// handleInboundProsperitySms() (below, unchanged from the prior
// checkpoint) remains exported and tested in its own right — it is no
// longer wired into either route, but its matching rule (an inbound
// message is attached to a contact ONLY if exactly one contact has that
// phone number AND an ACTIVE Prosperity contact_brands relationship; zero
// matches, or a match whose active company is Insurance Lady, both route
// to Review Required, and NOTHING about any contact is touched otherwise —
// no auto-created contact, no message row, no task, no consent change) is
// the exact same rule handleProsperityInboundSms() (further below) applies
// for the Prosperity-number branch of handleInboundSmsUnified().

const { normalizePhone } = require('./leadNormalize');
const { BRANDS } = require('../config/brands');
const { stageUnresolvedIntake } = require('./caseMatching');
const { isRescheduleRequest, processRescheduleRequest } = require('./rescheduleRequestService');

const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_KEYWORDS = new Set(['start', 'yes', 'unstop']);
const HELP_KEYWORDS = new Set(['help', 'info']);
// NO: an explicit "not right now" reply -- distinct from STOP. Sets
// sms_consent = 0 (blocks ordinary future SMS the same way START/YES sets
// it to 1) but deliberately does NOT set sms_opted_out_at -- that column is
// the authoritative TCPA opt-out record STOP alone controls; conflating the
// two would make a plain "no" as hard to reverse as a real STOP, which
// Revenue MVP explicitly treats as a separate, lighter-weight signal
// (crm/lib/existingClientOutreach.js's Existing Client Reconnection
// workflow is what SMS_CONSENT_SOURCE 'Inbound SMS' typically records this
// for). Matched via the exact same whole-message, trimmed+lowercased
// comparison every other keyword set here already uses -- see
// isConsentCommand -- so "no thanks" or "no, not interested" do NOT match;
// only a message whose ENTIRE body is (case/whitespace-insensitively) "no"
// does.
const NO_KEYWORDS = new Set(['no']);

// The exact consent-audit values crm/lib/clientService.js's manual-entry
// path already writes for smsConsentSource -- reused verbatim (never a new
// vocabulary) so "Inbound SMS" reads identically everywhere in the CRM
// regardless of which path set it.
const INBOUND_SMS_CONSENT_SOURCE = 'Inbound SMS';

function findActiveProsperityContactByPhone(db, e164) {
  if (!e164) return null;
  const rows = db.prepare(`
    SELECT c.*, cb.id AS contact_brand_id, b.slug AS brand_slug
    FROM contacts c
    JOIN contact_brands cb ON cb.contact_id = c.id AND cb.status = 'Active'
    JOIN brands b          ON b.id = cb.brand_id
    WHERE c.phone_e164 = ?
  `).all(e164);
  const prosperityMatches = rows.filter(r => r.brand_slug === 'prosperity');
  // Exactly one active Prosperity match required — zero or an ambiguous
  // multi-match (which should never happen given the UNIQUE(contact_id,
  // brand_id) constraint, but is handled defensively) both fall through to
  // Review Required rather than guessing.
  return prosperityMatches.length === 1 ? prosperityMatches[0] : null;
}

// Returns one of:
//   { outcome: 'ignored_wrong_number', reason }
//   { outcome: 'already_staged', unresolvedIntakeId }
//   { outcome: 'staged_for_review', unresolvedIntakeId }
//   { outcome: 'duplicate_ignored', contactId }
//   { outcome: 'matched', contactId, consentAction: null | 'opted_out' | 'opted_in' | 'help_requested' }
function handleInboundProsperitySms(db, { From, To, Body, MessageSid }) {
  const prosperityE164 = BRANDS.prosperity.phone.e164;
  if (To !== prosperityE164) {
    return { outcome: 'ignored_wrong_number', reason: `To (${To || 'missing'}) does not match the Prosperity number (${prosperityE164})` };
  }

  const { e164: fromE164 } = normalizePhone(From);
  const bodyTrimmed = (Body || '').trim();
  const bodyLower = bodyTrimmed.toLowerCase();

  const match = findActiveProsperityContactByPhone(db, fromE164);

  if (!match) {
    if (MessageSid) {
      const already = db.prepare(
        `SELECT id FROM unresolved_intake WHERE review_type = 'unknown_sms_sender' AND ref_value = ?`
      ).get(MessageSid);
      if (already) return { outcome: 'already_staged', unresolvedIntakeId: already.id };
    }
    const staged = stageUnresolvedIntake(db, {
      source: 'twilio_sms_inbound_prosperity',
      rawPayload: { From: From || null, To: To || null, Body: Body || '', MessageSid: MessageSid || null },
      reason: fromE164
        ? `No active Prosperity client matches ${fromE164} — this number is either unknown or belongs to an Insurance Lady client`
        : `From number '${From || ''}' could not be normalized to a valid phone number`,
      reviewType: 'unknown_sms_sender',
      refType: 'twilio_message_sid',
      refValue: MessageSid || null,
    });
    return { outcome: 'staged_for_review', unresolvedIntakeId: staged.id };
  }

  const insertResult = db.prepare(`
    INSERT OR IGNORE INTO sms_messages (contact_id, contact_brand_id, direction, from_number, to_number, body, status, twilio_sid)
    VALUES (?, ?, 'inbound', ?, ?, ?, 'received', ?)
  `).run(match.id, match.contact_brand_id, From || null, To || null, Body || '', MessageSid || null);

  if (insertResult.changes === 0) {
    // Duplicate webhook delivery for a MessageSid we already stored —
    // idempotent no-op, never a second message row, never a second
    // consent-keyword side effect.
    return { outcome: 'duplicate_ignored', contactId: match.id };
  }

  let consentAction = null;
  if (STOP_KEYWORDS.has(bodyLower)) {
    db.prepare(`UPDATE contacts SET sms_consent = 0, sms_opted_out_at = CURRENT_TIMESTAMP WHERE id = ?`).run(match.id);
    consentAction = 'opted_out';
  } else if (START_KEYWORDS.has(bodyLower)) {
    db.prepare(`UPDATE contacts SET sms_consent = 1, sms_opted_out_at = NULL WHERE id = ?`).run(match.id);
    consentAction = 'opted_in';
  } else if (HELP_KEYWORDS.has(bodyLower)) {
    consentAction = 'help_requested';
  }

  return { outcome: 'matched', contactId: match.id, consentAction };
}

// ─── Unified handler (local compatibility checkpoint, corrected) ──────────
//
// Twilio's Messaging Service for the Prosperity 414 number is configured to
// "defer to sender's webhook," which makes the NUMBER-level webhook —
// POST /api/twilio/sms/inbound — the one Twilio actually calls today. This
// function is the single, shared implementation both
// crm/routes/twilio.js's /sms/inbound and crm/routes/twilioProsperitySms.js's
// /sms/inbound (kept as a thin alias) call into, so activating brand-aware
// Prosperity matching never requires touching that already-configured
// Twilio webhook URL.
//
// This function fully BRANCHES on whether the message's To number is the
// Prosperity 414 number:
//
//   NOT the Prosperity number → handleLegacyOnlyInboundSms(): the ORIGINAL,
//     unconditional legacy behavior from crm/routes/twilio.js, completely
//     unchanged (brand-agnostic contact match-or-create including the
//     "Unknown Caller" auto-create, unconditional message storage, an
//     unconditional deduplicated "reply to this lead" task). This path is
//     dead code in production today (there is only one live number, the
//     414 line), kept correct for whenever a second number is ever routed
//     through this shared handler. Nothing here was changed in this
//     correction. Voice/voicemail/call-ended handling for unknown callers
//     is separate code entirely (crm/routes/twilio.js's /incoming etc.)
//     and is untouched by this file either way.
//
//   IS the Prosperity number → handleProsperityInboundSms(): a message is
//     ONLY attached to a contact, threaded, or task-created when the
//     sender matches EXACTLY ONE contact with an ACTIVE Prosperity
//     contact_brands relationship (findActiveProsperityContactByPhone,
//     exact phone_e164 match). Nothing else — not an Insurance-Lady-only
//     client, not a contact with no brand at all, not a totally unknown
//     number — ever gets a contact created, a message attached to any
//     Texts tab, a contact_brand_id set, a follow-up task, or a consent
//     change. Those cases are staged ONLY as a raw record in
//     unresolved_intake for a human reviewer to resolve explicitly (see
//     crm/lib/reviewResolution.js's resolveUnknownSmsReview, which
//     implements the three explicit actions: attach to an existing active
//     Prosperity client, create a genuinely new Prosperity client, or
//     archive/test). STOP/START/HELP are recognized ONLY for a confirmed
//     active Prosperity match, and NEVER create a follow-up task (an
//     ordinary reply task only fires for a genuine, non-command message).

function findContactByPhoneAnyBrand(db, fromE164) {
  if (!fromE164) return null;
  let c = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get(fromE164);
  if (c) return c;
  const digits = fromE164.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  const formatted = `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  return db.prepare('SELECT * FROM contacts WHERE phone = ? OR alt_phone = ?').get(formatted, formatted) || null;
}

function createUnknownCallerContact(db, From) {
  const digits = (From || '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const dispPhone = ten.length === 10 ? `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}` : From;
  const e164Phone = ten.length === 10 ? `+1${ten}` : null;
  const ins = db.prepare(`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164, lead_type, lead_status, lead_source, updated_at)
    VALUES (?, ?, ?, ?, 'Unknown Caller', 'New Lead', 'Inbound SMS', ?)
  `).run('Unknown', dispPhone, dispPhone, e164Phone || From, new Date().toISOString());
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(ins.lastInsertRowid);
}

// Duplicated from crm/lib/autoTasks.js's ctDueDateAndTime() rather than
// imported — that file's `const db = require('../db/database')` at module
// scope opens the live database as a side effect of merely being required,
// which this testable module must never do. This copy is pure (no db
// access) and kept in sync by inspection; it's ~15 lines and unlikely to
// drift.
function ctDueDateAndTimeLocal(minutesFromNow) {
  const dt = new Date(Date.now() + minutesFromNow * 60 * 1000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(dt).map(({ type, value }) => [type, value])
  );
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${hour}:${parts.minute}` };
}

const LEGACY_SMS_TASK_DEDUP_KEYWORD = 'New inbound SMS';

// Mirrors crm/lib/autoTasks.js's createAutoTask(contactId, 'SMS', 15,
// 'New inbound SMS received. Reply to this lead.', 'New inbound SMS')
// exactly — same dedup rule (an open Pending SMS task whose notes already
// contain the keyword), same due-in-15-minutes-CT, same priority. Used for
// BOTH the legacy-only path and a genuine (non-command) Prosperity-matched
// reply — never for STOP/START/HELP.
function createLegacySmsReplyTask(db, contactId) {
  const existing = db.prepare(`
    SELECT id FROM follow_up_tasks WHERE contact_id = ? AND task_type = 'SMS' AND status = 'Pending' AND notes LIKE ?
  `).get(contactId, `%${LEGACY_SMS_TASK_DEDUP_KEYWORD}%`);
  if (existing) return null;
  const { date, time } = ctDueDateAndTimeLocal(15);
  const result = db.prepare(`
    INSERT INTO follow_up_tasks (contact_id, task_type, due_date, due_time, notes, priority)
    VALUES (?, 'SMS', ?, ?, 'New inbound SMS received. Reply to this lead.', 'Medium')
  `).run(contactId, date, time);
  return result.lastInsertRowid;
}

function isConsentCommand(body) {
  const lower = (body || '').trim().toLowerCase();
  return STOP_KEYWORDS.has(lower) || START_KEYWORDS.has(lower) || HELP_KEYWORDS.has(lower) || NO_KEYWORDS.has(lower);
}

// Kicks off the reschedule-request workflow WITHOUT awaiting it here --
// handleInboundSmsUnified and everything above it in the call chain
// (crm/routes/twilio.js, crm/routes/twilioProsperitySms.js) are
// synchronous today, and converting that chain to async would mean
// updating every one of the 30+ existing synchronous callers across
// crm/test/inboundSmsUnified.test.js and crm/test/inboundSmsService.test.js
// -- exactly the kind of unrelated-code churn this task said not to do.
// The reschedule-request follow-up TASK is still created deterministically
// before this function returns (a JS async function body runs
// synchronously up to its first `await` -- see
// processRescheduleRequest's own comment); only the actual Twilio SEND
// happens after this returns. The returned promise is exposed on the
// result object as `rescheduleRequestPromise` purely so tests can await it
// deterministically -- production callers ignore it, matching the existing
// fire-and-forget pattern already used for Cal.com webhook SMS sends
// (crm/routes/calcom.js responds to Cal.com immediately, then processes
// async in the background).
function triggerRescheduleRequest(db, { contactId, To }, deps) {
  const promise = processRescheduleRequest(db, { contactId, inboundToNumber: To }, deps)
    .catch(err => {
      console.error(`[inboundSmsService] reschedule request processing failed for contact #${contactId}:`, err.message);
      return { attempted: true, sent: false, reason: err.message };
    });
  return promise;
}

// Delivery-receipt deflection — shared by both branches, since Twilio can
// send a status callback to either path regardless of which number it's
// for.
function deflectDeliveryReceiptIfApplicable(db, { Body, MessageSid, MessageStatus }) {
  if (!(MessageStatus && !Body)) return null;
  if (MessageSid) {
    db.prepare('UPDATE sms_messages SET status = ? WHERE twilio_sid = ?').run(MessageStatus.toLowerCase(), MessageSid);
  }
  return { outcome: 'delivery_receipt_deflected' };
}

// The ORIGINAL, unconditional legacy behavior — completely unchanged by
// this correction. Only reached for a To number that is NOT the Prosperity
// 414 line.
function handleLegacyOnlyInboundSms(db, { From, To, Body, MessageSid }, deps = {}) {
  let contact = findContactByPhoneAnyBrand(db, From);
  let contactCreated = false;
  if (!contact && From) {
    contact = createUnknownCallerContact(db, From);
    contactCreated = true;
  }
  const contactId = contact ? contact.id : null;

  const insertResult = db.prepare(`
    INSERT OR IGNORE INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid)
    VALUES (?, 'inbound', ?, ?, ?, 'received', ?)
  `).run(contactId, From || null, To || null, Body || '', MessageSid || null);

  if (insertResult.changes === 0) {
    return { outcome: 'duplicate_ignored', contactId };
  }

  // A RESCHEDULE reply replaces the generic "reply to this lead" task with
  // its own dedicated one (crm/lib/rescheduleRequestService.js) -- never both.
  if (contactId && isRescheduleRequest(Body)) {
    const rescheduleRequestPromise = triggerRescheduleRequest(db, { contactId, To }, deps);
    return {
      outcome: 'processed', contactId, contactCreated, contactBrandId: null, autoTaskId: null,
      consentAction: null, reviewStaged: null, isProsperityNumber: false,
      rescheduleRequested: true, rescheduleRequestPromise,
    };
  }

  const autoTaskId = contactId ? createLegacySmsReplyTask(db, contactId) : null;
  return { outcome: 'processed', contactId, contactCreated, contactBrandId: null, autoTaskId, consentAction: null, reviewStaged: null, isProsperityNumber: false };
}

// The corrected Prosperity-number-specific behavior. Never creates a
// contact, a contact_brands relationship, or a case. Never attaches a
// message to any contact's Texts tab, sets a follow-up task, or changes
// consent UNLESS the sender matches exactly one contact with an ACTIVE
// Prosperity relationship (findActiveProsperityContactByPhone). Everything
// else is staged, read-only with respect to contacts, in unresolved_intake.
function handleProsperityInboundSms(db, { From, To, Body, MessageSid }, deps = {}) {
  const { e164: fromE164 } = normalizePhone(From);
  const isCommand = isConsentCommand(Body);

  const match = findActiveProsperityContactByPhone(db, fromE164);

  if (match) {
    const insertResult = db.prepare(`
      INSERT OR IGNORE INTO sms_messages (contact_id, contact_brand_id, direction, from_number, to_number, body, status, twilio_sid)
      VALUES (?, ?, 'inbound', ?, ?, ?, 'received', ?)
    `).run(match.id, match.contact_brand_id, From || null, To || null, Body || '', MessageSid || null);

    if (insertResult.changes === 0) {
      return { outcome: 'duplicate_ignored', contactId: match.id };
    }

    // A RESCHEDULE reply replaces the generic "reply to this lead" task
    // with its own dedicated one (crm/lib/rescheduleRequestService.js) --
    // never both, and never a consent-keyword side effect either (the
    // word doesn't overlap with STOP/START/HELP).
    if (isRescheduleRequest(Body)) {
      const rescheduleRequestPromise = triggerRescheduleRequest(db, { contactId: match.id, To }, deps);
      return {
        outcome: 'processed', contactId: match.id, contactCreated: false, contactBrandId: match.contact_brand_id,
        autoTaskId: null, consentAction: null, reviewStaged: null, isProsperityNumber: true,
        rescheduleRequested: true, rescheduleRequestPromise,
      };
    }

    let consentAction = null;
    const bodyLower = (Body || '').trim().toLowerCase();
    if (STOP_KEYWORDS.has(bodyLower)) {
      db.prepare(`UPDATE contacts SET sms_consent = 0, sms_opted_out_at = CURRENT_TIMESTAMP WHERE id = ?`).run(match.id);
      consentAction = 'opted_out';
    } else if (START_KEYWORDS.has(bodyLower)) {
      // sms_consent_source/_at are stamped here too (not just sms_consent
      // itself) so the audit trail crm/lib/clientService.js's manual entry
      // already writes for a human-recorded consent grant is equally
      // complete for an inbound one -- "SMS Consent: YES / Consent Method:
      // Inbound SMS / Consent Date: <this exact reply's timestamp>" reads
      // the same regardless of which path set it. Always re-stamped on
      // every YES/START (even if already 1) since each reply is itself a
      // fresh, explicit re-affirmation worth its own timestamp.
      db.prepare(`
        UPDATE contacts
        SET sms_consent = 1, sms_opted_out_at = NULL,
            sms_consent_source = ?, sms_consent_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(INBOUND_SMS_CONSENT_SOURCE, match.id);
      consentAction = 'opted_in';
    } else if (NO_KEYWORDS.has(bodyLower)) {
      // Deliberately mirrors the START/YES branch's audit stamping, minus
      // sms_opted_out_at -- see NO_KEYWORDS' own comment for why NO and
      // STOP stay two distinct signals.
      db.prepare(`
        UPDATE contacts
        SET sms_consent = 0, sms_consent_source = ?, sms_consent_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(INBOUND_SMS_CONSENT_SOURCE, match.id);
      consentAction = 'declined';
    } else if (HELP_KEYWORDS.has(bodyLower)) {
      consentAction = 'help_requested';
    }

    // A follow-up task is only ever created for a genuine, non-command
    // reply — STOP/START/HELP must never generate a "reply to this lead"
    // task.
    const autoTaskId = !isCommand ? createLegacySmsReplyTask(db, match.id) : null;

    return {
      outcome: 'processed', contactId: match.id, contactCreated: false, contactBrandId: match.contact_brand_id,
      autoTaskId, consentAction, reviewStaged: null, isProsperityNumber: true,
    };
  }

  // No confirmed active Prosperity relationship. Nothing about any contact
  // is touched — no creation, no attachment, no consent change, no task —
  // only a raw record is staged for a human to resolve. candidateContactId
  // is informational only (shown to the reviewer, e.g. "this may be an
  // existing Insurance Lady client") and is never treated as an
  // attachment.
  if (MessageSid) {
    const already = db.prepare(
      `SELECT id FROM unresolved_intake WHERE review_type = 'unknown_sms_sender' AND ref_value = ?`
    ).get(MessageSid);
    if (already) return { outcome: 'already_staged', unresolvedIntakeId: already.id };
  }

  const candidate = findContactByPhoneAnyBrand(db, fromE164);
  let reason;
  if (candidate) {
    const ilLink = db.prepare(`
      SELECT 1 FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id
      WHERE cb.contact_id = ? AND cb.status = 'Active' AND b.slug = 'insurance-lady'
    `).get(candidate.id);
    reason = ilLink
      ? `This number matches an Insurance Lady-only client and cannot be automatically attached to Prosperity.`
      : `This number matches an existing contact with no active Prosperity relationship — cannot be automatically attached.`;
  } else {
    reason = fromE164
      ? `No contact matches ${fromE164} — this is a completely unknown sender.`
      : `From number '${From || ''}' could not be normalized to a valid phone number.`;
  }

  const staged = stageUnresolvedIntake(db, {
    source: 'twilio_sms_inbound',
    rawPayload: { From: From || null, To: To || null, Body: Body || '', MessageSid: MessageSid || null },
    candidateContactId: candidate ? candidate.id : null,
    reason,
    reviewType: 'unknown_sms_sender',
    refType: 'twilio_message_sid',
    refValue: MessageSid || null,
  });
  return { outcome: 'staged_for_review', unresolvedIntakeId: staged.id, candidateContactId: candidate ? candidate.id : null };
}

// Returns one of:
//   { outcome: 'delivery_receipt_deflected' }
//   { outcome: 'duplicate_ignored', contactId }
//   { outcome: 'already_staged', unresolvedIntakeId }
//   { outcome: 'staged_for_review', unresolvedIntakeId, candidateContactId }
//   { outcome: 'processed', contactId, contactCreated, contactBrandId, autoTaskId, consentAction, reviewStaged, isProsperityNumber, rescheduleRequested?, rescheduleRequestPromise? }
//
// This function itself remains fully SYNCHRONOUS (see triggerRescheduleRequest's
// own comment for why) -- `deps` is an optional 3rd param (every existing
// caller omits it, unaffected) that only matters when a RESCHEDULE reply
// triggers processRescheduleRequest's async send; tests can await the
// returned `rescheduleRequestPromise` for deterministic assertions.
function handleInboundSmsUnified(db, { From, To, Body, MessageSid, MessageStatus }, deps = {}) {
  const deflected = deflectDeliveryReceiptIfApplicable(db, { Body, MessageSid, MessageStatus });
  if (deflected) return deflected;

  const isProsperityNumber = To === BRANDS.prosperity.phone.e164;
  return isProsperityNumber
    ? handleProsperityInboundSms(db, { From, To, Body, MessageSid }, deps)
    : handleLegacyOnlyInboundSms(db, { From, To, Body, MessageSid }, deps);
}

module.exports = {
  handleInboundProsperitySms,
  handleInboundSmsUnified,
  findActiveProsperityContactByPhone,
  STOP_KEYWORDS,
  START_KEYWORDS,
  HELP_KEYWORDS,
  NO_KEYWORDS,
  INBOUND_SMS_CONSENT_SOURCE,
};
