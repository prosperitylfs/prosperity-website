// Draft-and-confirm workflow for Call/Text/Email, up to but not including
// contacting a provider. Every function takes an explicit better-sqlite3
// `db` handle — never opens a connection itself, never imports
// crm/db/database.js.
//
// Resolves the sender via the existing, already-tested sender guardrail
// (crm/lib/senderGuardrail.js) — this module never re-implements or
// second-guesses that resolution, and never falls back to the other
// brand's identity if the resolved brand's channel isn't configured.

const { getSenderGuardrailForCase } = require('./senderGuardrail');
const { getAdapter } = require('./providers');
const { toStringOrNull } = require('./leadNormalize');
const { BRANDS } = require('../config/brands');

function contactBrandIdFor(db, contactId) {
  const link = db.prepare(`SELECT id FROM contact_brands WHERE contact_id = ? AND status = 'Active'`).get(contactId);
  return link ? link.id : null;
}

// Returns the same shape crm/routes/crmApp.js's existing sender-preview
// endpoint already returns — reused here so drafting and the plain
// Call/Text/Email preview button always agree.
function resolveSenderForContact(db, { contactId, caseId }) {
  return getSenderGuardrailForCase(db, { caseId: caseId || null });
}

function createDraft(db, fields, actor) {
  if (!actor) throw new Error('createDraft: actor is required');
  if (!fields.contactId) throw new Error('createDraft: contactId is required');
  if (!['text', 'email'].includes(fields.channel)) throw new Error(`createDraft: unsupported channel '${fields.channel}' (only text/email drafts are stored — a call has nothing to draft)`);

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(fields.contactId);
  if (!contact) throw new Error(`createDraft: contact ${fields.contactId} does not exist`);

  // STOP suppression (Prosperity Revenue MVP, Requirement 3), checked
  // BEFORE the generic consent check below so a client who replied STOP
  // always gets the specific, accurate reason — inboundSmsService.js always
  // clears sms_consent at the same time it sets sms_opted_out_at, so the
  // generic check would otherwise mask this one. sms_opted_out_at is the
  // authoritative STOP record.
  if (fields.channel === 'text' && contact.sms_opted_out_at) {
    throw new Error('createDraft: this client replied STOP and must not receive nonessential texts');
  }
  // Consent validation -- required before a text/email draft can even be
  // saved, matching "Validate consent and required fields."
  if (fields.channel === 'text' && !contact.sms_consent) {
    throw new Error('createDraft: this client has not given SMS consent — cannot draft a text');
  }
  if (fields.channel === 'email' && !contact.email_consent) {
    throw new Error('createDraft: this client has not given email consent — cannot draft an email');
  }
  if (fields.channel === 'email' && !toStringOrNull(fields.subject)) {
    throw new Error('createDraft: an email draft requires a subject');
  }
  if (!toStringOrNull(fields.body)) {
    throw new Error('createDraft: draft body is required');
  }

  const result = db.prepare(`
    INSERT INTO communication_drafts (contact_id, contact_brand_id, case_id, channel, template_key, to_address, subject, body, status)
    VALUES (@contact_id, @contact_brand_id, @case_id, @channel, @template_key, @to_address, @subject, @body, 'draft')
  `).run({
    contact_id: fields.contactId,
    contact_brand_id: contactBrandIdFor(db, fields.contactId),
    case_id: fields.caseId || null,
    channel: fields.channel,
    template_key: toStringOrNull(fields.templateKey),
    to_address: toStringOrNull(fields.channel === 'text' ? contact.phone_e164 : contact.email),
    subject: toStringOrNull(fields.subject),
    body: toStringOrNull(fields.body),
  });
  return db.prepare('SELECT * FROM communication_drafts WHERE id = ?').get(result.lastInsertRowid);
}

// The final confirmation step. Always routes through getAdapter() (always
// the fake adapter in this checkpoint — see crm/lib/providers/index.js),
// which never contacts a provider and always returns status:'blocked'. The
// draft is marked 'blocked', NEVER 'sent' or 'delivered' — there is no code
// path in this module that can set either of those statuses.
// Resolves the e164 FROM number for a resolved contact_brand row, purely
// for display/storage on the resulting sms_messages row — never used to
// decide WHETHER to send (that's already been decided by the guardrail
// before the draft was ever created).
function fromNumberForContactBrand(db, contactBrandId) {
  if (!contactBrandId) return null;
  const link = db.prepare('SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.id = ?').get(contactBrandId);
  return link && BRANDS[link.slug] ? BRANDS[link.slug].phone.e164 : null;
}

async function confirmSend(db, draftId, actor) {
  if (!actor) throw new Error('confirmSend: actor is required');
  const draft = db.prepare('SELECT * FROM communication_drafts WHERE id = ?').get(draftId);
  if (!draft) throw new Error(`confirmSend: draft ${draftId} does not exist`);

  const adapter = getAdapter();
  const result = draft.channel === 'text'
    ? await adapter.sendText({ toNumber: draft.to_address, body: draft.body })
    : await adapter.sendEmail({ toAddress: draft.to_address, subject: draft.subject, body: draft.body });

  db.prepare("UPDATE communication_drafts SET status = 'blocked', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(draftId);

  // Text drafts, once confirmed, are also persisted into sms_messages — the
  // same table the inbound-reply webhook writes to — so the threaded text
  // conversation (Requirement 4) has a real outbound row with its delivery
  // status, not just a draft that disappears after confirmation. Never
  // 'sent'/'delivered': the fake adapter's result.status is always
  // 'blocked', and that's exactly what's stored.
  let smsMessage = null;
  if (draft.channel === 'text') {
    const insert = db.prepare(`
      INSERT INTO sms_messages (contact_id, contact_brand_id, case_id, direction, from_number, to_number, body, status)
      VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?)
    `).run(draft.contact_id, draft.contact_brand_id, draft.case_id, fromNumberForContactBrand(db, draft.contact_brand_id), draft.to_address, draft.body, result.status);
    smsMessage = db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(insert.lastInsertRowid);
  }

  return { draft: db.prepare('SELECT * FROM communication_drafts WHERE id = ?').get(draftId), providerResult: result, smsMessage };
}

// A Call has no draft to store -- this just resolves + previews via the
// fake adapter's placeCall, exactly like confirmSend does for text/email,
// without ever writing a communication_drafts row.
async function previewCall(db, { contactId, caseId }) {
  const guardrail = resolveSenderForContact(db, { contactId, caseId });
  const adapter = getAdapter();
  const providerResult = await adapter.placeCall({});
  return { guardrail, providerResult };
}

module.exports = { resolveSenderForContact, createDraft, confirmSend, previewCall };
