// Revenue MVP: "Existing Client Reconnection" outreach — the ONE narrow
// exception to the normal SMS consent gate (crm/lib/legacySmsSend.js's
// checkConsentGate), scoped exclusively to sending the single named
// "Existing Client Reconnection / SMS Permission" template (see
// crm/config/templates.js, prosperity-only) to a contact explicitly
// classified as an Existing Client (contacts.relationship_type ===
// 'active_client', reused verbatim from crm/lib/clientService.js — no
// second relationship field). Every function here is the ONLY call site
// that ever passes requireConsent: false to sendLegacySms — nothing in
// this file lets an arbitrary template or a Lead/Prospect contact bypass
// the normal consent gate.
//
// Reuses existing infrastructure throughout:
//   - crm/lib/legacySmsSend.js's sendLegacySms for the actual Twilio
//     send + sms_messages logging (same Prosperity TWILIO_FROM_NUMBER
//     every other Prosperity SMS in this CRM already uses).
//   - crm/lib/gmailSend.js's sendGmailEmail for the actual Gmail send +
//     emails/communications logging (same Prosperity Gmail identity every
//     other CRM email already uses).
//   - The already-existing inbound YES/NO keyword handling in
//     crm/lib/inboundSmsService.js records the resulting consent — this
//     module only ever SENDS the initial message; it never itself sets
//     sms_consent.
//   - sms_messages.message_type (already used to classify
//     confirmation/reschedule/reminder_* SMS) is reused, set to
//     RECONNECTION_SMS_MESSAGE_TYPE below, as the "already sent this
//     initial message" marker — no new tracking table.
//
// Does NOT build a marketing platform: there is no scheduling, no drip
// sequence, no arbitrary template picker — exactly two fixed templates,
// exactly one brand, exactly one eligibility rule.

const { getTemplate } = require('../config/templates');
const { BRANDS } = require('../config/brands');
const { sendLegacySms } = require('./legacySmsSend');
const { sendGmailEmail } = require('./gmailSend');

const RECONNECTION_SMS_MESSAGE_TYPE = 'existing_client_reconnection';

function isExistingClient(contact) {
  return !!contact && contact.relationship_type === 'active_client';
}

// Raw (unsubstituted) templates + the Prosperity office phone, for the
// compose/preview UI — {{first_name}} is filled in per-recipient (see
// fillFirstName below), {{office_phone}} is the same for everyone.
function getReconnectionTemplates() {
  const sms = getTemplate('prosperity', 'existingClientReconnectionSms');
  const email = getTemplate('prosperity', 'existingClientReconnectionEmail');
  return {
    sms: { templateKey: 'existingClientReconnectionSms', body: sms.body },
    email: { templateKey: 'existingClientReconnectionEmail', subject: email.subject, body: email.text },
    officePhone: BRANDS.prosperity.phone.display,
  };
}

function fillFirstName(text, firstName) {
  return String(text || '').replace(/\{\{first_name\}\}/g, firstName || 'there');
}

// Eligibility for the Existing Client Reconnection SMS ONLY — never a gate
// for any other SMS. Returns { eligible: true } or
// { eligible: false, code, reason }, where `code` is one of
// 'not_existing_client' | 'no_phone' | 'opted_out' | 'already_sent' so the
// caller can decide programmatically (e.g. only 'already_sent' is ever
// offered a "confirm resend" option).
function checkReconnectionSmsEligibility(db, contact) {
  if (!contact) return { eligible: false, code: 'not_found', reason: 'Contact not found.' };
  if (!isExistingClient(contact)) {
    return { eligible: false, code: 'not_existing_client', reason: 'This message is only available for contacts classified as Existing Client.' };
  }
  if (!contact.phone_e164) {
    return { eligible: false, code: 'no_phone', reason: 'This contact has no valid mobile phone number on file.' };
  }
  if (contact.sms_opted_out_at) {
    return { eligible: false, code: 'opted_out', reason: 'This contact has opted out of SMS (STOP) and cannot be texted.' };
  }
  const alreadySent = !!db.prepare(`
    SELECT 1 FROM sms_messages WHERE contact_id = ? AND message_type = ? AND status != 'failed' LIMIT 1
  `).get(contact.id, RECONNECTION_SMS_MESSAGE_TYPE);
  if (alreadySent) {
    return { eligible: false, code: 'already_sent', reason: 'This contact already received the Existing Client Reconnection message.' };
  }
  return { eligible: true };
}

// Returns { outcome: 'sent', sms } | { outcome: 'blocked', code, reason } |
// { outcome: 'failed', reason } (Twilio not configured / send error).
// `message` is the FINAL text to send (already previewed/edited by
// Loretta) — this never re-derives it from the template itself, so what
// was approved is exactly what goes out.
async function sendReconnectionSms(db, { contactId, message, confirmResend = false }, deps = {}) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  const check = checkReconnectionSmsEligibility(db, contact);
  if (!check.eligible && !(check.code === 'already_sent' && confirmResend)) {
    return { outcome: 'blocked', code: check.code, reason: check.reason };
  }

  const result = await sendLegacySms(db, {
    contactId, body: message, messageType: RECONNECTION_SMS_MESSAGE_TYPE, requireConsent: false,
  }, deps);
  if (result.ok) return { outcome: 'sent', sms: result.sms };
  // A 503 (Twilio not configured) or a Twilio API error is an operational
  // failure, not an eligibility block — surfaced distinctly so the bulk UI
  // can tell "this recipient wasn't allowed" from "sending itself broke."
  return { outcome: result.status === 503 || result.status === 500 ? 'failed' : 'blocked', reason: result.error };
}

// Returns { outcome: 'sent', gmailMessageId } | { outcome: 'blocked', code, reason } |
// { outcome: 'failed', reason }. No SMS-style consent gate — email sending
// in this CRM has never had one (crm/routes/email.js), unchanged here.
async function sendReconnectionEmail(db, { contactId, subject, body }, deps = {}) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!contact) return { outcome: 'blocked', code: 'not_found', reason: 'Contact not found.' };
  if (!isExistingClient(contact)) {
    return { outcome: 'blocked', code: 'not_existing_client', reason: 'This message is only available for contacts classified as Existing Client.' };
  }
  if (!contact.email) return { outcome: 'blocked', code: 'no_email', reason: 'This contact has no email address on file.' };

  try {
    const result = await sendGmailEmail(db, { contactId, toEmail: contact.email, subject, body }, deps);
    return { outcome: 'sent', gmailMessageId: result.gmailMessageId };
  } catch (err) {
    return { outcome: 'failed', reason: err.message };
  }
}

// Dedicated, simple listing for the bulk-select UI — deliberately NOT
// crm/lib/dashboardQueries.js's getCaseList, which requires a case to
// already exist (a brand-new Existing Client added today via "Add Client"
// has no case yet and would never appear there). Scoped to Prosperity only
// (brand safety, Revenue MVP section 11) via the contact_brands join.
function getExistingClientsForOutreach(db, { search = '' } = {}) {
  const clauses = [`ct.relationship_type = 'active_client'`, `ct.archived_at IS NULL`];
  const params = [];
  const trimmed = (search || '').trim();
  if (trimmed) {
    const like = `%${trimmed.replace(/[%_]/g, ch => `\\${ch}`)}%`;
    clauses.push(`(
      (ct.first_name || ' ' || ct.last_name) LIKE ? ESCAPE '\\' OR
      ct.email LIKE ? ESCAPE '\\' OR ct.phone LIKE ? ESCAPE '\\' OR ct.phone_e164 LIKE ? ESCAPE '\\'
    )`);
    params.push(like, like, like, like);
  }

  const rows = db.prepare(`
    SELECT DISTINCT ct.id, ct.first_name, ct.last_name, ct.email, ct.phone, ct.phone_e164,
           ct.sms_consent, ct.sms_opted_out_at, ct.relationship_type
    FROM contacts ct
    JOIN contact_brands cb ON cb.contact_id = ct.id AND cb.status = 'Active'
    JOIN brands b          ON b.id = cb.brand_id AND b.slug = 'prosperity'
    WHERE ${clauses.join(' AND ')}
    ORDER BY ct.last_name COLLATE NOCASE, ct.first_name COLLATE NOCASE, ct.id
  `).all(...params);

  return rows.map(r => {
    const smsCheck = checkReconnectionSmsEligibility(db, r);
    return {
      contactId: r.id,
      contactName: [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || 'Unnamed',
      firstName: r.first_name || null,
      email: r.email || null,
      phone: r.phone || null,
      hasEmail: !!r.email,
      smsEligible: smsCheck.eligible,
      smsBlockedCode: smsCheck.eligible ? null : smsCheck.code,
      smsBlockedReason: smsCheck.eligible ? null : smsCheck.reason,
    };
  });
}

// Sends to each selected contact independently — one failure/block never
// stops the rest (Revenue MVP section 8). `message`/`body` are the FINAL,
// already-previewed/edited template text with {{first_name}} still present
// — personalized per-recipient right here, right before sending, so each
// recipient gets their own name (never a shared/batch-wide substitution).
async function bulkSendReconnectionOutreach(db, { contactIds, channel, message, subject, body, confirmResend = false }, deps = {}) {
  if (!['sms', 'email'].includes(channel)) {
    throw new Error(`bulkSendReconnectionOutreach: unknown channel '${channel}' (must be 'sms' or 'email')`);
  }
  const results = [];
  for (const contactId of contactIds) {
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
    const contactName = contact
      ? ([contact.first_name, contact.last_name].filter(Boolean).join(' ').trim() || 'Unnamed')
      : 'Unknown contact';
    try {
      let outcome;
      if (channel === 'sms') {
        const personalized = fillFirstName(message, contact ? contact.first_name : null);
        outcome = await sendReconnectionSms(db, { contactId, message: personalized, confirmResend }, deps);
      } else {
        const personalizedBody = fillFirstName(body, contact ? contact.first_name : null);
        outcome = await sendReconnectionEmail(db, { contactId, subject, body: personalizedBody }, deps);
      }
      results.push({ contactId, contactName, ...outcome });
    } catch (err) {
      results.push({ contactId, contactName, outcome: 'failed', reason: err.message });
    }
  }
  return results;
}

module.exports = {
  RECONNECTION_SMS_MESSAGE_TYPE,
  isExistingClient,
  getReconnectionTemplates,
  fillFirstName,
  checkReconnectionSmsEligibility,
  sendReconnectionSms,
  sendReconnectionEmail,
  getExistingClientsForOutreach,
  bulkSendReconnectionOutreach,
};
