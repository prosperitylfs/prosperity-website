// Single shared "resolve brand, then send" primitive for outbound email --
// reused by BOTH the manual regular Email button (crm/routes/email.js's
// POST /send) and the redesigned app's Draft Email confirm-send step
// (crm/lib/communicationDraftService.js's confirmSend, via
// sendEmailForDraft below). There is exactly ONE brand-resolution +
// sender-dispatch implementation for email in this codebase; neither
// caller re-implements or duplicates it, and there is no second email
// sending system anywhere.
//
// Resolves the contact's brand FRESH from the database at send time via
// the same defaultManualBrandForContact() helper already used elsewhere
// (crm/lib/prosperitySmsGateway.js's resolveSendContext does the identical
// thing for SMS) -- only resolves when the contact has EXACTLY ONE active
// brand relationship; ambiguous or missing throws, is never guessed, and
// this module never falls back to either brand's provider on the other's
// failure.

const { sendGmailEmail } = require('./gmailSend');
const { sendMsGraphEmail } = require('./msGraphSend');
const { defaultManualBrandForContact } = require('./senderGuardrail');

const SENDER_FOR_BRAND = {
  prosperity: { depsKey: 'sendGmailEmail', fn: sendGmailEmail },
  'insurance-lady': { depsKey: 'sendMsGraphEmail', fn: sendMsGraphEmail },
};

// Throws (never returns without either a result or a thrown error) on any
// failure to resolve a brand or to send:
//   - status 409 -- no contactId's brand is ambiguous or has no active
//     relationship at all (see defaultManualBrandForContact).
//   - status 503 -- defensive only: a brandId with no mapped sender
//     (cannot happen today -- see SENDER_FOR_BRAND).
//   - whatever status the underlying sender's own thrown error carries
//     (e.g. crm/lib/msGraphAuth.js sets .status=503 for "not configured"/
//     "not authorized"; crm/lib/gmailSend.js's errors carry no .status,
//     so callers should treat a missing one as a generic failure).
// Returns { brandId, result } on success, where `result` is whatever the
// underlying sender returned (sendGmailEmail's {gmailMessageId, threadId}
// or sendMsGraphEmail's {sentAt}).
//
// contactId is optional (mirrors sendGmailEmail's own optional contactId --
// omitting it sends without a brand to resolve, defaulting to Prosperity,
// matching this codebase's pre-existing "no real caller does this" case).
async function sendBrandRoutedEmail(db, { contactId = null, toEmail, subject, body }, deps = {}) {
  let brandId = 'prosperity';
  if (contactId) {
    brandId = defaultManualBrandForContact(db, contactId);
    if (!brandId) {
      const err = new Error(
        "Cannot determine this contact's brand (no single active brand relationship) -- refusing to guess which email identity to send from."
      );
      err.status = 409;
      throw err;
    }
  }

  const sender = SENDER_FOR_BRAND[brandId];
  if (!sender) {
    const err = new Error(`Email sending is not configured for brand '${brandId}'.`);
    err.status = 503;
    throw err;
  }

  const send = deps[sender.depsKey] || sender.fn;
  const result = await send(db, { contactId, toEmail, subject, body }, deps);
  return { brandId, result };
}

// Draft/confirm-flow wrapper -- mirrors crm/lib/prosperitySmsGateway.js's
// sendProsperitySmsForDraft shape for the email channel, so
// crm/lib/communicationDraftService.js's confirmSend can treat both
// channels uniformly. draft.to_address is the contact's email address,
// captured at draft-creation time by createDraft(); this function does not
// re-derive it. Never throws -- resolution/send failures are reported as
// a normal { ok:false, status:'blocked', message } result, exactly like
// the provider adapters' own shape, so the existing frontend confirm-send
// handling (crm/public/app/client.html's showSendConfirmation) needs no
// special-casing for email vs. text.
async function sendEmailForDraft(db, draft, actor, deps = {}) {
  if (!actor) throw new Error('sendEmailForDraft: actor is required');
  try {
    const { brandId, result } = await sendBrandRoutedEmail(db, {
      contactId: draft.contact_id, toEmail: draft.to_address, subject: draft.subject, body: draft.body,
    }, deps);
    return { ok: true, status: 'sent', brandId, result };
  } catch (err) {
    return { ok: false, status: 'blocked', message: err.message, brandId: null };
  }
}

module.exports = { sendBrandRoutedEmail, sendEmailForDraft };
