const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

// GET /api/sms/contact/:id — SMS history for a contact
// sms_messages is the sole authoritative source. The communications table is
// never merged here — doing so caused every message to appear twice because
// communications rows lacked twilio_sid and always passed the old dedup filter.
router.get('/contact/:id', (req, res) => {
  try {
    const cid = parseInt(req.params.id, 10);
    if (isNaN(cid)) return res.status(400).json({ error: 'Invalid contact id' });

    const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(cid);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    const messages = db.prepare(`
      SELECT id, contact_id, direction, from_number, to_number,
             body, status, twilio_sid, call_id, sent_at
      FROM sms_messages
      WHERE contact_id = ?
      ORDER BY sent_at DESC
      LIMIT 100
    `).all(cid);

    res.json(messages);
  } catch (err) {
    console.error('[sms/contact] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sms/send — send a manual outbound SMS to a contact
router.post('/send', async (req, res) => {
  try {
    const { contact_id, message } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });
    const body = String(message || '').trim();
    if (!body) return res.status(400).json({ error: 'message is required' });

    const cid = parseInt(contact_id, 10);
    if (isNaN(cid)) return res.status(400).json({ error: 'Invalid contact_id' });

    const contact = db.prepare(
      'SELECT id, phone, phone_e164, sms_consent, sms_opted_out_at FROM contacts WHERE id = ?'
    ).get(cid);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // SMS consent enforcement -- server-side, before anything else happens
    // (no sms_messages row inserted, Twilio never required/called below).
    // STOP/opt-out is checked FIRST and is always authoritative: a contact
    // who has texted STOP must stay blocked even if sms_consent is somehow
    // still 1 on their record. sms_opted_out_at/sms_consent themselves are
    // untouched here -- this route only reads them; crm/lib/inboundSmsService.js
    // remains the sole place STOP/START ever writes these columns.
    if (contact.sms_opted_out_at) {
      return res.status(403).json({ error: 'This contact has opted out of SMS (STOP) and cannot be texted.' });
    }
    if (!contact.sms_consent) {
      return res.status(403).json({ error: 'This contact does not have SMS consent on file. Add a consent source on the Contact Detail page before texting.' });
    }

    // Resolve destination: prefer stored E.164, otherwise derive from display phone
    let toNumber = contact.phone_e164;
    if (!toNumber && contact.phone) {
      const digits = String(contact.phone).replace(/\D/g, '');
      const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
      if (ten.length === 10) toNumber = `+1${ten}`;
    }
    if (!toNumber) return res.status(400).json({ error: 'Contact has no valid phone number for SMS' });

    const fromNumber = process.env.TWILIO_FROM_NUMBER;
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const publicUrl  = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');

    if (!fromNumber || !accountSid || !authToken) {
      return res.status(503).json({ error: 'Twilio is not configured — check TWILIO_FROM_NUMBER, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN' });
    }

    // Pre-insert with status=queued so it appears in SMS History immediately
    const ins = db.prepare(`
      INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status)
      VALUES (?, 'outbound', ?, ?, ?, 'queued')
    `).run(cid, fromNumber, toNumber, body);
    const smsId = ins.lastInsertRowid;

    console.log(`[sms/send] contact_id=${cid} sms_id=${smsId} to=${toNumber}`);

    try {
      const client = require('twilio')(accountSid, authToken);
      const msgParams = { body, from: fromNumber, to: toNumber };
      if (publicUrl) msgParams.statusCallback = `${publicUrl}/api/twilio/sms/status`;

      const msg = await client.messages.create(msgParams);
      console.log(`[sms/send] sent sid=${msg.sid} status=${msg.status}`);

      db.prepare('UPDATE sms_messages SET twilio_sid = ?, status = ? WHERE id = ?')
        .run(msg.sid, msg.status || 'sent', smsId);

      res.json({ ok: true, sms: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(smsId) });

    } catch (twilioErr) {
      console.error(`[sms/send] Twilio error: ${twilioErr.message}  code=${twilioErr.code || 'none'}`);
      if (twilioErr.moreInfo) console.error(`[sms/send] info: ${twilioErr.moreInfo}`);

      const errDetail = [
        twilioErr.message,
        twilioErr.code     ? `Code: ${twilioErr.code}`      : null,
        twilioErr.moreInfo ? `Info: ${twilioErr.moreInfo}` : null,
      ].filter(Boolean).join(' | ');

      db.prepare('UPDATE sms_messages SET status = ?, body = ? WHERE id = ?')
        .run('failed', `[FAILED] ${errDetail}\n\nOriginal message: ${body}`, smsId);

      res.status(500).json({ error: twilioErr.message, code: twilioErr.code || null });
    }

  } catch (err) {
    console.error('[sms/send] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
