// Revenue MVP: "Existing Client Reconnection" outreach — the ONE narrow
// exception to the normal SMS consent gate (crm/lib/legacySmsSend.js's
// checkConsentGate), scoped exclusively to sending the single named
// "Existing Client Reconnection / SMS Permission" template (see
// crm/config/templates.js, prosperity-only) to a contact explicitly
// classified as an Existing Client. Reuses BOTH of the CRM's existing
// classification signals (see isExistingClient below) — never a second/new
// relationship field: contacts.relationship_type === 'active_client'
// (crm/lib/clientService.js's manual entry) or contacts.lead_type ===
// 'Existing Client' (crm/lib/leadNormalize.js). Every function here is the
// ONLY call site that ever passes requireConsent: false to sendLegacySms —
// nothing in this file lets an arbitrary template or a Lead/Prospect
// contact bypass the normal consent gate.
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
// sequence — a small, fixed REGISTRY of named SMS templates (below), not an
// arbitrary picker, exactly one brand, exactly one eligibility rule.
//
// EXISTING_CLIENT_SMS_TEMPLATES is the "reusable architecture" for future
// templates (Birthday, appointment follow-up, etc.) mentioned when the
// second entry (Life Insurance Awareness Month) was added: a future one is
// exactly one more entry here, its own crm/config/templates.js body, and
// nothing else structural changes. Every entry still goes through the same
// requireConsent:false exception, still only for an Existing Client, still
// never opted out, still deduped independently per template (sms_messages.
// message_type, one distinct value per entry, so sending template A never
// blocks template B for the same contact).

const { getTemplate } = require('../config/templates');
const { BRANDS } = require('../config/brands');
const { sendLegacySms } = require('./legacySmsSend');
const { sendGmailEmail } = require('./gmailSend');

const RECONNECTION_SMS_MESSAGE_TYPE = 'existing_client_reconnection';

// The Prosperity Life Insurance Cal.com booking link -- the SAME URL
// already hardcoded on the public website (book.html, life-insurance.html,
// life-insurance-qualifier.html, schedule.html; see e.g. book.html's own
// CALCOM_LIFE_INSURANCE_URL). No shared cross-runtime config module exists
// between the static website and this Node CRM app, so this is one more,
// deliberate duplication of that same value -- if it's ever changed, it
// must be changed in all five places.
const PROSPERITY_LIFE_INSURANCE_BOOKING_URL = 'https://cal.com/lorettastewart/life-insurance-consultation-prosperitylfs';

const EXISTING_CLIENT_SMS_TEMPLATES = [
  { templateKey: 'existingClientReconnectionSms', label: 'Existing Client Reconnection / SMS Permission', smsMessageType: RECONNECTION_SMS_MESSAGE_TYPE },
  // 2026-09-11: label renamed from 'Existing Client – Life Insurance
  // Awareness Month' to 'Existing Client - Reconnect Life Insurance
  // Awareness Month' -- a rename only. templateKey and smsMessageType are
  // deliberately unchanged, so this stays the exact same template (same
  // dedup/message_type history, same crm/config/templates.js entry), never
  // a second/duplicate one.
  { templateKey: 'existingClientLifeInsuranceAwarenessSms', label: 'Existing Client - Reconnect Life Insurance Awareness Month', smsMessageType: 'existing_client_life_insurance_awareness' },
];
const DEFAULT_SMS_TEMPLATE_KEY = EXISTING_CLIENT_SMS_TEMPLATES[0].templateKey;

function smsTemplateEntry(templateKey) {
  const entry = EXISTING_CLIENT_SMS_TEMPLATES.find(t => t.templateKey === templateKey);
  if (!entry) throw new Error(`existingClientOutreach: unknown SMS templateKey '${templateKey}'`);
  return entry;
}

// Mirrors EXISTING_CLIENT_SMS_TEMPLATES exactly, for the email composer's
// own Template dropdown -- crm/config/templates.js currently has one
// approved Prosperity email (existingClientReconnectionEmail); its content
// already covers Life Insurance Awareness Month / Policy Review, so it's
// labeled that way here. Adding a genuinely distinct second email later
// (Birthday, Follow-Up, etc.) is exactly one more entry -- unlike SMS,
// sendReconnectionEmail below has no per-template dedup/message_type
// concept to extend (email was never asked to track "already sent"), so
// there is nothing else to wire up.
const EXISTING_CLIENT_EMAIL_TEMPLATES = [
  { templateKey: 'existingClientReconnectionEmail', label: 'Existing Client – Life Insurance Awareness Month / Policy Review' },
  { templateKey: 'existingClientSmsPermissionEmail', label: 'Existing Client – SMS Permission / Contact Update' },
];

// Reuses BOTH of the CRM's existing "this is an existing client" signals,
// never a new field: relationship_type === 'active_client'
// (crm/lib/clientService.js's manual entry) OR lead_type === 'Existing
// Client' (crm/lib/leadNormalize.js's formatLeadTypeLabel -- the value a
// contact ends up with when intake/import already classified them that
// way). A contact only needs ONE of the two to qualify.
function isExistingClient(contact) {
  return !!contact && (contact.relationship_type === 'active_client' || contact.lead_type === 'Existing Client');
}

// Raw (unsubstituted) templates + the Prosperity office phone and Life
// Insurance booking link, for the compose/preview UI — {{first_name}} is
// filled in per-recipient (see fillFirstName below); {{office_phone}} and
// {{booking_link}} are the same for everyone, so the UI substitutes those
// once, before display.
function getReconnectionTemplates() {
  const smsTemplates = EXISTING_CLIENT_SMS_TEMPLATES.map(entry => {
    const tmpl = getTemplate('prosperity', entry.templateKey);
    return { templateKey: entry.templateKey, label: entry.label, body: tmpl.body };
  });
  const emailTemplates = EXISTING_CLIENT_EMAIL_TEMPLATES.map(entry => {
    const tmpl = getTemplate('prosperity', entry.templateKey);
    return { templateKey: entry.templateKey, label: entry.label, subject: tmpl.subject, body: tmpl.text };
  });
  return {
    smsTemplates,
    emailTemplates,
    officePhone: BRANDS.prosperity.phone.display,
    bookingLink: PROSPERITY_LIFE_INSURANCE_BOOKING_URL,
  };
}

function fillFirstName(text, firstName) {
  return String(text || '').replace(/\{\{first_name\}\}/g, firstName || 'there');
}

// Template-INDEPENDENT eligibility: is this contact an Existing Client with
// a valid mobile number who hasn't opted out? Used for the bulk-select
// list's general "SMS Eligible" column (crm/public/app/clients.html), which
// isn't tied to any one specific template. Returns { eligible: true } or
// { eligible: false, code, reason }.
function checkReconnectionSmsBaseEligibility(contact) {
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
  return { eligible: true };
}

// Full eligibility for ONE specific SMS template — base eligibility above,
// plus "hasn't already received THIS template" (checked independently per
// template via sms_messages.message_type, so having already received one
// Existing Client template never blocks a different one). `code` is one of
// 'not_existing_client' | 'no_phone' | 'opted_out' | 'already_sent' so the
// caller can decide programmatically (only 'already_sent' is ever offered
// a "confirm resend" option).
function checkReconnectionSmsEligibility(db, contact, templateKey = DEFAULT_SMS_TEMPLATE_KEY) {
  const base = checkReconnectionSmsBaseEligibility(contact);
  if (!base.eligible) return base;

  const entry = smsTemplateEntry(templateKey);
  const alreadySent = !!db.prepare(`
    SELECT 1 FROM sms_messages WHERE contact_id = ? AND message_type = ? AND status != 'failed' LIMIT 1
  `).get(contact.id, entry.smsMessageType);
  if (alreadySent) {
    return { eligible: false, code: 'already_sent', reason: `This contact already received the ${entry.label} message.` };
  }
  return { eligible: true };
}

// Returns { outcome: 'sent', sms } | { outcome: 'blocked', code, reason } |
// { outcome: 'failed', reason } (Twilio not configured / send error).
// `message` is the FINAL text to send (already previewed/edited by
// Loretta) — this never re-derives it from the template itself, so what
// was approved is exactly what goes out. `templateKey` (default: the
// original Reconnection/SMS-Permission template, for backward
// compatibility) selects which EXISTING_CLIENT_SMS_TEMPLATES entry this
// send counts against for "already sent" dedup/logging.
async function sendReconnectionSms(db, { contactId, message, confirmResend = false, templateKey = DEFAULT_SMS_TEMPLATE_KEY }, deps = {}) {
  const entry = smsTemplateEntry(templateKey);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  const check = checkReconnectionSmsEligibility(db, contact, templateKey);
  if (!check.eligible && !(check.code === 'already_sent' && confirmResend)) {
    return { outcome: 'blocked', code: check.code, reason: check.reason };
  }

  const result = await sendLegacySms(db, {
    contactId, body: message, messageType: entry.smsMessageType, requireConsent: false,
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
  const clauses = [`(ct.relationship_type = 'active_client' OR ct.lead_type = 'Existing Client')`, `ct.archived_at IS NULL`];
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
           ct.sms_consent, ct.sms_opted_out_at, ct.relationship_type, ct.lead_type
    FROM contacts ct
    JOIN contact_brands cb ON cb.contact_id = ct.id AND cb.status = 'Active'
    JOIN brands b          ON b.id = cb.brand_id AND b.slug = 'prosperity'
    WHERE ${clauses.join(' AND ')}
    ORDER BY ct.last_name COLLATE NOCASE, ct.first_name COLLATE NOCASE, ct.id
  `).all(...params);

  return rows.map(r => {
    // Template-independent eligibility for the list column -- see
    // checkReconnectionSmsBaseEligibility's own comment. Whether a
    // specific template was already sent to this contact is checked at
    // actual send time instead (with the resend-confirm flow), since it
    // now depends on WHICH of the (possibly several) templates is chosen.
    const smsCheck = checkReconnectionSmsBaseEligibility(r);
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
async function bulkSendReconnectionOutreach(db, { contactIds, channel, message, subject, body, confirmResend = false, templateKey = DEFAULT_SMS_TEMPLATE_KEY }, deps = {}) {
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
        outcome = await sendReconnectionSms(db, { contactId, message: personalized, confirmResend, templateKey }, deps);
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
  EXISTING_CLIENT_SMS_TEMPLATES,
  EXISTING_CLIENT_EMAIL_TEMPLATES,
  DEFAULT_SMS_TEMPLATE_KEY,
  PROSPERITY_LIFE_INSURANCE_BOOKING_URL,
  isExistingClient,
  getReconnectionTemplates,
  fillFirstName,
  checkReconnectionSmsBaseEligibility,
  checkReconnectionSmsEligibility,
  sendReconnectionSms,
  sendReconnectionEmail,
  getExistingClientsForOutreach,
  bulkSendReconnectionOutreach,
};
