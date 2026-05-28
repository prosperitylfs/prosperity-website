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

module.exports = router;
