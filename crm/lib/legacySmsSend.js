// Shared "send + log" primitive for the legacy (non-brand-aware) Prosperity
// SMS path -- the single TWILIO_FROM_NUMBER Twilio number used for any
// contact, regardless of whether it has a contact_brands link (unlike
// crm/lib/prosperitySmsGateway.js, which requires one to resolve a sender).
// Cal.com-created/matched contacts never get a contact_brands row (see
// crm/routes/calcom.js), so this is the path an automated sender triggered
// from that webhook must use.
//
// Extracted from crm/routes/sms.js's POST /send handler so the exact same
// consent-gate -> resolve-phone -> insert-queued-row -> call-Twilio ->
// update-status behavior can be reused by an automated sender (the
// Retirement Intake auto-SMS, crm/lib/retirementIntakeSms.js) without
// duplicating it. crm/routes/sms.js now delegates to this module; its own
// HTTP contract (status codes, error text, response shape) is unchanged --
// see crm/test/smsSendRoute.test.js, which is left untouched and still
// passes against the refactored route.
//
// deps.twilioClientFactory lets tests substitute a fake Twilio client (same
// injection idea as crm/lib/prosperitySmsGateway.js's deps.adapter) without
// ever importing the real `twilio` package or touching a live account.

function resolveToNumber(contact) {
  if (contact.phone_e164) return contact.phone_e164;
  if (contact.phone) {
    const digits = String(contact.phone).replace(/\D/g, '');
    const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (ten.length === 10) return `+1${ten}`;
  }
  return null;
}

// Returns { blocked: true, status, error } or { blocked: false }. Opt-out
// (STOP) is authoritative and checked first, exactly like the original
// route -- a contact who has texted STOP stays blocked even if sms_consent
// is somehow still 1 on their record.
function checkConsentGate(contact) {
  if (contact.sms_opted_out_at) {
    return { blocked: true, status: 403, error: 'This contact has opted out of SMS (STOP) and cannot be texted.' };
  }
  if (!contact.sms_consent) {
    return { blocked: true, status: 403, error: 'This contact does not have SMS consent on file. Add a consent source on the Contact Detail page before texting.' };
  }
  return { blocked: false };
}

// Returns one of:
//   { ok: false, status: 404, error: 'Contact not found' }
//   { ok: false, status: 403, error: <consent/opt-out message> }
//   { ok: false, status: 400, error: 'Contact has no valid phone number for SMS' }
//   { ok: false, status: 503, error: 'Twilio is not configured ...' }
//   { ok: true, sms: <sms_messages row, status='sent' or whatever Twilio reported> }
//   { ok: false, status: 500, error, code, sms: <sms_messages row, status='failed'> }
//
// A queued sms_messages row is only ever inserted once every earlier gate
// (contact exists, consent, phone, Twilio configured) has passed -- exactly
// matching the original route's ordering, so e.g. a consent-blocked send
// never creates a row at all.
// `fromNumber` is an optional override of the sending number -- e.g. the
// Insurance Lady brand-specific Twilio number (crm/lib/appointmentConfirmationSms.js).
// Every existing caller (crm/routes/sms.js, crm/lib/retirementIntakeSms.js)
// omits it and is completely unaffected: this falls back to the original,
// unchanged process.env.TWILIO_FROM_NUMBER default exactly as before.
async function sendLegacySms(db, { contactId, body, fromNumber: fromNumberOverride }, deps = {}) {
  const contact = db.prepare(
    'SELECT id, phone, phone_e164, sms_consent, sms_opted_out_at FROM contacts WHERE id = ?'
  ).get(contactId);
  if (!contact) return { ok: false, status: 404, error: 'Contact not found' };

  const gate = checkConsentGate(contact);
  if (gate.blocked) return { ok: false, status: gate.status, error: gate.error };

  const toNumber = resolveToNumber(contact);
  if (!toNumber) return { ok: false, status: 400, error: 'Contact has no valid phone number for SMS' };

  const fromNumber = fromNumberOverride || process.env.TWILIO_FROM_NUMBER;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const publicUrl  = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');

  if (!fromNumber || !accountSid || !authToken) {
    return { ok: false, status: 503, error: 'Twilio is not configured — check TWILIO_FROM_NUMBER (or the provided sender override), TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN' };
  }

  const ins = db.prepare(`
    INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status)
    VALUES (?, 'outbound', ?, ?, ?, 'queued')
  `).run(contactId, fromNumber, toNumber, body);
  const smsId = ins.lastInsertRowid;

  console.log(`[legacySmsSend] contact_id=${contactId} sms_id=${smsId} to=${toNumber}`);

  try {
    const makeClient = deps.twilioClientFactory || (() => require('twilio')(accountSid, authToken));
    const client = makeClient();
    const msgParams = { body, from: fromNumber, to: toNumber };
    if (publicUrl) msgParams.statusCallback = `${publicUrl}/api/twilio/sms/status`;

    const msg = await client.messages.create(msgParams);
    console.log(`[legacySmsSend] sent sid=${msg.sid} status=${msg.status}`);

    db.prepare('UPDATE sms_messages SET twilio_sid = ?, status = ? WHERE id = ?')
      .run(msg.sid, msg.status || 'sent', smsId);

    return { ok: true, sms: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(smsId) };
  } catch (twilioErr) {
    console.error(`[legacySmsSend] Twilio error: ${twilioErr.message}  code=${twilioErr.code || 'none'}`);
    if (twilioErr.moreInfo) console.error(`[legacySmsSend] info: ${twilioErr.moreInfo}`);

    const errDetail = [
      twilioErr.message,
      twilioErr.code     ? `Code: ${twilioErr.code}`      : null,
      twilioErr.moreInfo ? `Info: ${twilioErr.moreInfo}` : null,
    ].filter(Boolean).join(' | ');

    db.prepare('UPDATE sms_messages SET status = ?, body = ? WHERE id = ?')
      .run('failed', `[FAILED] ${errDetail}\n\nOriginal message: ${body}`, smsId);

    return {
      ok: false, status: 500, error: twilioErr.message, code: twilioErr.code || null,
      sms: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(smsId),
    };
  }
}

module.exports = { sendLegacySms, checkConsentGate, resolveToNumber };
