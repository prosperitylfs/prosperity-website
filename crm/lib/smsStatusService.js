// Handles Twilio's outbound-message status callback — the ONLY code path
// anywhere in this app that is allowed to move an sms_messages row to
// 'delivered'. Pure logic, no HTTP/Express here; the route wrapper
// (crm/routes/twilioProsperitySms.js) verifies the X-Twilio-Signature
// header via the existing crm/lib/twilioSignature.js BEFORE this is ever
// called, so a forged or unsigned callback never reaches this function at
// all — the safety boundary is the middleware, not this file.
//
// Always an UPDATE, never an INSERT — there is no code path here that can
// create a new sms_messages row or duplicate an existing one. Running the
// exact same callback twice produces the exact same end state (idempotent
// by construction, since repeating an UPDATE with the same values is a
// no-op the second time).

function handleOutboundSmsStatusCallback(db, { MessageSid, MessageStatus, ErrorCode } = {}) {
  if (!MessageSid || !MessageStatus) {
    return { outcome: 'ignored_missing_fields' };
  }

  const status = MessageStatus.toLowerCase();
  const failureNote = ErrorCode ? `Twilio status callback error code ${ErrorCode}` : null;

  const result = db.prepare(`
    UPDATE sms_messages
    SET status = ?, failure_reason = COALESCE(?, failure_reason)
    WHERE twilio_sid = ?
  `).run(status, failureNote, MessageSid);

  if (result.changes === 0) {
    // No matching outbound message -- never guesses, never creates one.
    return { outcome: 'no_matching_message', messageSid: MessageSid };
  }
  return { outcome: 'updated', status, messageSid: MessageSid };
}

module.exports = { handleOutboundSmsStatusCallback };
