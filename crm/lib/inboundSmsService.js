// Inbound-SMS handling for the Prosperity 414 number (Prosperity Revenue
// MVP, Requirement 3). Pure logic, no Express/HTTP/network here — takes an
// explicit better-sqlite3 `db` handle and a plain params object, so it's
// fully testable with fake signed webhook fixtures and never contacts
// Twilio itself. crm/routes/twilioProsperitySms.js is the thin route
// wrapper that verifies the X-Twilio-Signature header (reusing the
// existing, already-tested crm/lib/twilioSignature.js) before calling in.
//
// This is a NEW, brand-aware webhook path — it does not touch or replace
// crm/routes/twilio.js's existing single-number inbound handler, which
// stays exactly as it is for the already-live legacy number.
//
// Matching rule: an inbound message is attached to a contact ONLY if
// exactly one contact has that phone number AND an ACTIVE Prosperity
// contact_brands relationship. Zero matches, or a match whose active
// company is Insurance Lady (or unresolved), both route to Review Required
// — a reply is never attached to an Insurance Lady client, and an unclear
// match is never guessed at.

const { normalizePhone } = require('./leadNormalize');
const { BRANDS } = require('../config/brands');
const { stageUnresolvedIntake } = require('./caseMatching');

const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const START_KEYWORDS = new Set(['start', 'yes', 'unstop']);
const HELP_KEYWORDS = new Set(['help', 'info']);

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

module.exports = {
  handleInboundProsperitySms,
  findActiveProsperityContactByPhone,
  STOP_KEYWORDS,
  START_KEYWORDS,
  HELP_KEYWORDS,
};
