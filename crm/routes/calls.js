const express  = require('express');
const router   = express.Router();
const db       = require('../db/database');

// ─── POST /api/calls/outbound ─────────────────────────────────────────────────
// Initiates click-to-call: Twilio calls the agent first, then bridges to lead.
// Future extension point: swap this for Twilio Client SDK token flow to support
// browser-based calling (no agent phone required). See routes/twilio.js for the
// TwiML side. Twilio Client would call /api/twilio/client-token instead.
router.post('/outbound', async (req, res) => {
  const { contact_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const toPhone = contact.phone_e164
    || (contact.phone ? '+1' + contact.phone.replace(/\D/g, '') : null);
  if (!toPhone) return res.status(400).json({ error: 'Contact has no phone number' });

  const agentPhone = process.env.AGENT_PHONE_NUMBER;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const publicUrl  = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');

  if (!agentPhone || !fromNumber) {
    return res.status(503).json({
      error: 'Twilio not configured — set AGENT_PHONE_NUMBER and TWILIO_FROM_NUMBER in .env',
    });
  }

  const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || 'the lead';
  const now = new Date().toISOString();

  // Insert call log before dialing so we have an ID for the TwiML callback URL
  const result = db.prepare(`
    INSERT INTO comm_calls
      (contact_id, contact_name, direction, from_number, to_number, status, started_at)
    VALUES (?, ?, 'outbound', ?, ?, 'initiated', ?)
  `).run(contact_id, contactName, fromNumber, toPhone, now);
  const callId = result.lastInsertRowid;

  // Stamp contact so pipeline cards can show "Called Today"
  db.prepare('UPDATE contacts SET last_called_at = ?, last_call_status = ? WHERE id = ?')
    .run(now, 'initiated', contact_id);

  try {
    const twilio = require('twilio');
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

    const twimlUrl  = `${publicUrl}/api/twilio/twiml?call_id=${callId}&to=${encodeURIComponent(toPhone)}&name=${encodeURIComponent(contactName)}`;
    const statusUrl = `${publicUrl}/api/twilio/status/${callId}`;

    const call = await client.calls.create({
      to:                   agentPhone,
      from:                 fromNumber,
      url:                  twimlUrl,
      method:               'POST',
      statusCallback:       statusUrl,
      statusCallbackEvent:  ['initiated', 'ringing', 'in-progress', 'completed', 'no-answer', 'busy', 'failed', 'canceled'],
      statusCallbackMethod: 'POST',
      timeout:              30,
    });

    db.prepare('UPDATE comm_calls SET provider_call_uuid = ? WHERE id = ?').run(call.sid, callId);
    res.json({ ok: true, call_id: callId, call_sid: call.sid });

  } catch (err) {
    db.prepare('UPDATE comm_calls SET status = ? WHERE id = ?').run('failed', callId);
    db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?').run('failed', contact_id);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/calls/contact/:contact_id ──────────────────────────────────────
router.get('/contact/:contact_id', (req, res) => {
  const logs = db.prepare(
    'SELECT * FROM comm_calls WHERE contact_id = ? ORDER BY started_at DESC LIMIT 50'
  ).all(req.params.contact_id);
  res.json(logs);
});

// ─── GET /api/calls/:id/recording ────────────────────────────────────────────
// Proxies the Twilio recording through the CRM backend so the browser never
// needs Twilio credentials. Twilio credentials stay server-side only.
router.get('/:id/recording', async (req, res) => {
  const call = db.prepare('SELECT recording_url FROM comm_calls WHERE id = ?').get(req.params.id);
  if (!call || !call.recording_url) {
    return res.status(404).json({ error: 'No recording found for this call' });
  }

  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token } = process.env;
  if (!sid || !token) {
    return res.status(503).json({ error: 'Twilio credentials not configured on server' });
  }

  try {
    const upstream = await fetch(call.recording_url, {
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      },
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Twilio returned HTTP ${upstream.status}` });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buffer);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/calls/:id ─────────────────────────────────────────────────────
// Used to mark voicemail left or add notes after a call.
router.patch('/:id', (req, res) => {
  const call = db.prepare('SELECT id, contact_id FROM comm_calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Not found' });

  const allowed = ['notes', 'status'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const clauses = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  updates.id = call.id;
  db.prepare(`UPDATE comm_calls SET ${clauses} WHERE id = @id`).run(updates);

  // If agent marks voicemail, mirror that to the contact for pipeline card indicator
  if (req.body.notes === 'voicemail_left') {
    db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
      .run('voicemail_left', call.contact_id);
  }

  res.json(db.prepare('SELECT * FROM comm_calls WHERE id = ?').get(call.id));
});

module.exports = router;
