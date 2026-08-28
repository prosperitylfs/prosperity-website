const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { sendLegacySms } = require('../lib/legacySmsSend');

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

// POST /api/sms/send — send a manual outbound SMS to a contact.
// The actual consent-gate -> resolve-phone -> insert-queued -> call-Twilio
// -> update-status logic lives in crm/lib/legacySmsSend.js (shared with the
// automatic Retirement Intake SMS in crm/lib/retirementIntakeSms.js) — this
// route is now a thin adapter from that shared result shape to this
// endpoint's existing HTTP contract, unchanged from before the extraction.
router.post('/send', async (req, res) => {
  try {
    const { contact_id, message } = req.body;
    if (!contact_id) return res.status(400).json({ error: 'contact_id is required' });
    const body = String(message || '').trim();
    if (!body) return res.status(400).json({ error: 'message is required' });

    const cid = parseInt(contact_id, 10);
    if (isNaN(cid)) return res.status(400).json({ error: 'Invalid contact_id' });

    const result = await sendLegacySms(db, { contactId: cid, body });

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, code: result.code });
    }
    res.json({ ok: true, sms: result.sms });

  } catch (err) {
    console.error('[sms/send] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
