const express  = require('express');
const router   = express.Router();
const db       = require('../db/database');
const { resolveVoiceCallerId } = require('../lib/senderResolution');

// ─── GET /api/calls/stats ────────────────────────────────────────────────────
// Badge counts: unread voicemails + unreviewed missed inbound calls.
router.get('/stats', (req, res) => {
  const unread_voicemails = db.prepare(
    "SELECT COUNT(*) AS n FROM comm_calls WHERE status = 'voicemail' AND listened_at IS NULL"
  ).get().n;
  const missed_calls = db.prepare(
    "SELECT COUNT(*) AS n FROM comm_calls WHERE direction = 'inbound' AND status IN ('missed','no-answer','busy','canceled') AND listened_at IS NULL"
  ).get().n;
  res.json({ unread_voicemails, missed_calls });
});

// ─── GET /api/calls ───────────────────────────────────────────────────────────
// Paginated call log across all contacts, with optional filter.
// filter: inbound | missed | voicemail | unknown
router.get('/', (req, res) => {
  const { filter, limit = 200, offset = 0 } = req.query;

  const filters = {
    inbound:  "c.direction = 'inbound'",
    missed:   "c.direction = 'inbound' AND c.status IN ('missed','no-answer','busy','canceled')",
    voicemail: "c.status = 'voicemail'",
    unknown:  "(ct.lead_type = 'Unknown Caller' OR (c.direction = 'inbound' AND c.contact_id IS NULL))",
  };

  const where = filters[filter] ? `WHERE ${filters[filter]}` : '';

  const rows = db.prepare(`
    SELECT c.*,
      ct.first_name, ct.last_name, ct.email,
      ct.lead_type AS contact_lead_type
    FROM comm_calls c
    LEFT JOIN contacts ct ON ct.id = c.contact_id
    ${where}
    ORDER BY c.started_at DESC
    LIMIT ? OFFSET ?
  `).all(Number(limit), Number(offset));

  res.json(rows);
});

// ─── POST /api/calls/outbound ─────────────────────────────────────────────────
// Initiates click-to-call: Twilio calls the agent first, then bridges to lead.
// Future extension point: swap this for Twilio Client SDK token flow to support
// browser-based calling (no agent phone required). See routes/twilio.js for the
// TwiML side. Twilio Client would call /api/twilio/client-token instead.
router.post('/outbound', async (req, res) => {
  const { contact_id, case_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });

  const toPhone = contact.phone_e164
    || (contact.phone ? '+1' + contact.phone.replace(/\D/g, '') : null);
  if (!toPhone) return res.status(400).json({ error: 'Contact has no phone number' });

  // Brand-aware caller ID: prefer an explicit case_id, else the contact's
  // own active brand relationship. A contact with NO resolvable brand
  // relationship at all (a legacy, pre-two-brand contact) falls through
  // to the original single-number behavior below, unchanged — this stays
  // fully backward compatible for the old contact.js interface and any
  // contact that predates the two-brand model. Once a brand IS resolved,
  // its number is required and exact — never a silent fallback to the
  // legacy number or the other brand's number.
  let fromNumber = process.env.TWILIO_FROM_NUMBER;
  const activeBrand = db.prepare(`SELECT id FROM contact_brands WHERE contact_id = ? AND status = 'Active'`).get(contact_id);
  const brandContext = case_id ? { caseId: Number(case_id) } : (activeBrand ? { contactBrandId: activeBrand.id } : null);
  if (brandContext) {
    const callerId = resolveVoiceCallerId(db, brandContext);
    if (callerId.blocked) {
      return res.status(503).json({ error: callerId.reason });
    }
    fromNumber = callerId.fromNumber;
  }

  const agentPhone = process.env.AGENT_PHONE_NUMBER;
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

    // from= carries the brand-resolved caller ID through to /api/twilio/twiml
    // (a stateless webhook) so the second, bridged leg to the lead uses the
    // SAME number as the first leg — /twiml falls back to the legacy
    // TWILIO_FROM_NUMBER when this param is absent, for old call flows.
    const twimlUrl  = `${publicUrl}/api/twilio/twiml?call_id=${callId}&to=${encodeURIComponent(toPhone)}&name=${encodeURIComponent(contactName)}&from=${encodeURIComponent(fromNumber)}`;
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
  const callId = req.params.id;
  console.log(`[calls/recording] playback requested call_id=${callId}`);

  const call = db.prepare('SELECT recording_url FROM comm_calls WHERE id = ?').get(callId);
  if (!call || !call.recording_url) {
    console.warn(`[calls/recording] no recording found call_id=${callId}`);
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
      console.error(`[calls/recording] Twilio returned HTTP ${upstream.status} call_id=${callId}`);
      return res.status(upstream.status).json({ error: `Twilio returned HTTP ${upstream.status}` });
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    console.log(`[calls/recording] playback served call_id=${callId} bytes=${buffer.length}`);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(buffer);
  } catch (err) {
    console.error(`[calls/recording] playback failed call_id=${callId}: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ─── PATCH /api/calls/:id ─────────────────────────────────────────────────────
// Used to mark/unmark voicemail left, add notes, or mark listened.
router.patch('/:id', (req, res) => {
  const call = db.prepare('SELECT id, contact_id FROM comm_calls WHERE id = ?').get(req.params.id);
  if (!call) return res.status(404).json({ error: 'Not found' });

  const allowed = ['notes', 'status', 'listened_at'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });

  const now = new Date().toISOString();
  const markingVm   = req.body.notes === 'voicemail_left';
  const clearingNotes = 'notes' in req.body && !req.body.notes;

  if (markingVm) {
    updates.voicemail_left_at = now;
    updates.voicemail_left_by = 'agent';
    console.log(`[calls/voicemail] marked  call_id=${call.id} contact_id=${call.contact_id || 'none'} by=agent at=${now}`);
  } else if (clearingNotes) {
    updates.voicemail_left_at = null;
    updates.voicemail_left_by = null;
    console.log(`[calls/voicemail] cleared  call_id=${call.id} contact_id=${call.contact_id || 'none'} at=${now}`);
  }

  const clauses = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  updates.id = call.id;
  db.prepare(`UPDATE comm_calls SET ${clauses} WHERE id = @id`).run(updates);

  // Mirror voicemail status to contact for pipeline card indicator
  if (markingVm && call.contact_id) {
    db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
      .run('voicemail_left', call.contact_id);
  } else if (clearingNotes && call.contact_id) {
    db.prepare("UPDATE contacts SET last_call_status = 'completed' WHERE id = ? AND last_call_status = 'voicemail_left'")
      .run(call.contact_id);
  }

  res.json(db.prepare('SELECT * FROM comm_calls WHERE id = ?').get(call.id));
});

module.exports = router;
