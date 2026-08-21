// Orchestrates the truthful outbound-SMS lifecycle for a confirmed text
// draft: writes a real sms_messages row with status='queued' BEFORE ever
// calling a provider adapter, then updates it to exactly what the adapter
// reports ('sent' with a Message SID, 'failed' with a safe reason, or
// 'blocked' for a pre-flight rejection) — never 'delivered', which can only
// ever be set later by a verified Twilio status callback (see
// crm/lib/smsStatusService.js). Used by both the fake and live adapters
// identically; this module never knows or cares which one is active.
//
// Resolves sender context FRESH from the database at send time (never
// trusts a draft's stored, possibly-stale contact_brand_id) — a company
// reassignment or a STOP reply that arrived after the draft was created is
// still caught here, not just at draft-creation time.

const { getAdapter } = require('./providers');
const { BRANDS } = require('../config/brands');

function resolveSendContext(db, draft) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(draft.contact_id);
  const link = db.prepare(`
    SELECT cb.id AS contact_brand_id, b.slug AS brand_slug
    FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id
    WHERE cb.contact_id = ? AND cb.status = 'Active'
  `).get(draft.contact_id);
  const brandId = link ? link.brand_slug : null;
  const fromNumber = brandId && BRANDS[brandId] ? BRANDS[brandId].phone.e164 : null;

  return {
    contact,
    contactBrandId: link ? link.contact_brand_id : null,
    brandId,
    fromNumber,
    toNumber: contact ? contact.phone_e164 : null,
    hasConsent: !!(contact && contact.sms_consent),
    isOptedOut: !!(contact && contact.sms_opted_out_at),
  };
}

// deps.adapter lets tests substitute a plain mock adapter object directly,
// bypassing process.env-based selection entirely — this gateway's own
// tests never need to touch the real Twilio client or set
// COMMUNICATION_PROVIDER at all.
async function sendProsperitySmsForDraft(db, draft, actor, deps = {}) {
  if (!actor) throw new Error('sendProsperitySmsForDraft: actor is required');
  const ctx = resolveSendContext(db, draft);

  const insert = db.prepare(`
    INSERT INTO sms_messages (contact_id, contact_brand_id, case_id, direction, from_number, to_number, body, status)
    VALUES (?, ?, ?, 'outbound', ?, ?, ?, 'queued')
  `).run(draft.contact_id, ctx.contactBrandId, draft.case_id, ctx.fromNumber, ctx.toNumber, draft.body);
  const messageId = insert.lastInsertRowid;

  const adapter = deps.adapter || getAdapter();
  const result = await adapter.sendText({
    toNumber: ctx.toNumber,
    fromNumber: ctx.fromNumber,
    brandId: ctx.brandId,
    body: draft.body,
    hasConsent: ctx.hasConsent,
    isOptedOut: ctx.isOptedOut,
  });

  // 'sent' and 'failed'/'blocked' are the only statuses this function ever
  // writes — 'delivered' is never set here, by construction, regardless of
  // what an adapter returns (a well-behaved adapter never returns it
  // either, but this is not trusted blindly).
  const finalStatus = result.status === 'sent' ? 'sent' : (result.status === 'failed' ? 'failed' : 'blocked');
  const failureReason = finalStatus !== 'sent' ? (result.message || null) : null;

  db.prepare(`
    UPDATE sms_messages SET status = ?, twilio_sid = ?, failure_reason = ? WHERE id = ?
  `).run(finalStatus, result.sid || null, failureReason, messageId);

  return {
    message: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(messageId),
    providerResult: result,
  };
}

module.exports = { resolveSendContext, sendProsperitySmsForDraft };
