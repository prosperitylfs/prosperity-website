const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

// GET /api/sms/contact/:id — SMS history for a contact
// Merges sms_messages table (primary) with legacy communications rows (comm_type='sms').
router.get('/contact/:id', (req, res) => {
  try {
    const cid = parseInt(req.params.id, 10);
    if (isNaN(cid)) return res.status(400).json({ error: 'Invalid contact id' });

    const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(cid);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // Primary: dedicated sms_messages table
    const fromSms = db.prepare(`
      SELECT id, contact_id, direction, from_number, to_number,
             body, status, twilio_sid, call_id, sent_at
      FROM sms_messages
      WHERE contact_id = ?
      ORDER BY sent_at DESC
      LIMIT 100
    `).all(cid);

    // Legacy: communications with comm_type='sms' (written before sms_messages existed)
    const fromComms = db.prepare(`
      SELECT id, contact_id, direction,
             NULL AS from_number, NULL AS to_number,
             body, status, external_id AS twilio_sid, NULL AS call_id,
             created_at AS sent_at
      FROM communications
      WHERE contact_id = ? AND comm_type = 'sms'
      ORDER BY created_at DESC
      LIMIT 100
    `).all(cid);

    // Deduplicate: skip legacy rows whose twilio_sid already appears in sms_messages
    const seenSids = new Set(fromSms.map(s => s.twilio_sid).filter(Boolean));
    const legacyOnly = fromComms.filter(c => !c.twilio_sid || !seenSids.has(c.twilio_sid));

    const merged = [...fromSms, ...legacyOnly]
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))
      .slice(0, 100);

    res.json(merged);
  } catch (err) {
    console.error('[sms/contact] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
