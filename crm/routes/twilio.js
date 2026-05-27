// Twilio webhook handlers — PUBLIC endpoints (no CRM API key required).
// Twilio calls these from its own servers during every call flow.
//
// Production hardening TODO: validate X-Twilio-Signature header using
//   twilio.validateRequest(authToken, sig, fullUrl, params)
// before processing any webhook to prevent spoofed requests.

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Match an inbound caller's E.164 number to a CRM contact.
function findContactByPhone(fromE164) {
  if (!fromE164) return null;
  // Direct E.164 match on the indexed phone_e164 column
  let c = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get(fromE164);
  if (c) return c;
  // Normalise to 10 digits and match the stored "(XXX) XXX-XXXX" format
  const digits = fromE164.replace(/\D/g, '');
  const ten    = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  const formatted = `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}`;
  return db.prepare(
    'SELECT * FROM contacts WHERE phone = ? OR alt_phone = ?'
  ).get(formatted, formatted) || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INBOUND CALL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/twilio/incoming ────────────────────────────────────────────────
// Twilio Voice Webhook — set this URL in your Twilio Phone Number configuration:
//   https://<your-render-domain>/api/twilio/incoming
//
// Flow: incoming call → ring agent's personal phone for 20 s →
//       if answered: bridge; if not: play voicemail greeting + record.
//
// The agent sees the Twilio business number as caller ID so they know
// it is a business call. The actual caller number is stored in the CRM.
router.post('/incoming', (req, res) => {
  const callerNumber = req.body.From  || '';
  const callSid      = req.body.CallSid || '';
  const agentPhone   = process.env.AGENT_PHONE_NUMBER  || '';
  const twilioNumber = process.env.TWILIO_FROM_NUMBER  || '';
  const publicUrl    = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');

  if (!agentPhone || !twilioNumber) {
    // Misconfigured — play a generic message and hang up
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling. Please try again later.</Say>
  <Hangup/>
</Response>`);
    return;
  }

  // Match caller to a CRM contact if possible
  const contact     = findContactByPhone(callerNumber);
  const contactId   = contact ? contact.id : null;
  const contactName = contact
    ? [contact.first_name, contact.last_name].filter(Boolean).join(' ')
    : 'Unknown Caller';
  const now = new Date().toISOString();

  // Insert inbound call log
  const result = db.prepare(`
    INSERT INTO comm_calls
      (contact_id, contact_name, direction, from_number, to_number,
       status, provider_call_uuid, started_at)
    VALUES (?, ?, 'inbound', ?, ?, 'ringing', ?, ?)
  `).run(contactId, contactName, callerNumber, agentPhone, callSid, now);
  const callId = result.lastInsertRowid;

  // Stamp the contact card so the pipeline shows "Called Today"
  if (contactId) {
    db.prepare(
      'UPDATE contacts SET last_called_at = ?, last_call_status = ? WHERE id = ?'
    ).run(now, 'ringing', contactId);
  }

  const voicemailUrl = `${publicUrl}/api/twilio/voicemail?call_id=${callId}`;

  // Ring the agent. callerId = Twilio number so agent knows it's a business call.
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="${escXml(twilioNumber)}"
        timeout="20"
        action="${escXml(voicemailUrl)}"
        method="POST">
    <Number>${escXml(agentPhone)}</Number>
  </Dial>
</Response>`);
});

// ─── POST /api/twilio/voicemail ───────────────────────────────────────────────
// Dial action — Twilio posts here when the Dial verb finishes (agent answered,
// timed-out, or caller hung up before agent answered).
router.post('/voicemail', (req, res) => {
  const { DialCallStatus } = req.body;
  const callId    = req.query.call_id;
  const publicUrl = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');
  const now       = new Date().toISOString();

  // ── Agent answered ──────────────────────────────────────────────────────────
  if (DialCallStatus === 'completed') {
    db.prepare(
      "UPDATE comm_calls SET status = 'answered', answered_at = ?, ended_at = ? WHERE id = ?"
    ).run(now, now, callId);

    const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
    if (call?.contact_id) {
      db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
        .run('answered', call.contact_id);
    }

    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    return;
  }

  // ── Caller hung up before agent answered ────────────────────────────────────
  if (DialCallStatus === 'canceled') {
    db.prepare(
      "UPDATE comm_calls SET status = 'missed', ended_at = ? WHERE id = ?"
    ).run(now, callId);

    const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
    if (call?.contact_id) {
      db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
        .run('missed', call.contact_id);
    }

    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    return;
  }

  // ── Agent did not answer (no-answer / busy / failed) → voicemail ───────────
  db.prepare(
    "UPDATE comm_calls SET status = 'missed', ended_at = ? WHERE id = ?"
  ).run(now, callId);

  const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
  if (call?.contact_id) {
    db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
      .run('missed', call.contact_id);
  }

  const saveUrl = `${publicUrl}/api/twilio/voicemail-save?call_id=${callId}`;

  // Play professional greeting then record.
  // transcribe="false" until TRANSCRIPTION_ENABLED env var is set (Twilio charges per minute).
  // transcribeCallback is wired up so enabling transcription later requires only the env var.
  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>https://prosperity-crm.onrender.com/audio/business-voicemail.mp3</Play>
  <Record
    action="${escXml(saveUrl)}"
    method="POST"
    maxLength="120"
    playBeep="true"
    timeout="5"
    transcribe="false"
    transcribeCallback="${escXml(`${publicUrl}/api/twilio/transcription?call_id=${callId}`)}"
  />
  <Say voice="Polly.Joanna">We did not receive your message. Goodbye.</Say>
  <Hangup/>
</Response>`);
});

// ─── POST /api/twilio/voicemail-save ─────────────────────────────────────────
// Record action — Twilio posts here when the recording finishes.
// Saves the recording URL, logs a note on the contact.
router.post('/voicemail-save', (req, res) => {
  const { RecordingUrl, RecordingDuration } = req.body;
  const callId   = req.query.call_id;
  const now      = new Date().toISOString();
  const duration = RecordingDuration ? parseInt(RecordingDuration, 10) : null;
  // Twilio serves the recording as .mp3 when the format is appended
  const recUrl   = RecordingUrl ? `${RecordingUrl}.mp3` : null;

  db.prepare(
    "UPDATE comm_calls SET status = 'voicemail', recording_url = ?, duration_sec = ?, ended_at = ? WHERE id = ?"
  ).run(recUrl, duration, now, callId);

  const call = db.prepare(
    'SELECT contact_id, from_number, contact_name FROM comm_calls WHERE id = ?'
  ).get(callId);

  if (call) {
    if (call.contact_id) {
      db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
        .run('voicemail', call.contact_id);
    }
    if (call.contact_id && recUrl) {
      const durStr  = duration ? `${duration}s` : 'unknown length';
      const from    = call.from_number || 'unknown number';
      db.prepare(
        'INSERT INTO contact_notes (contact_id, body) VALUES (?, ?)'
      ).run(
        call.contact_id,
        `📞 Voicemail received (${durStr}) from ${from}. Recording saved to call log.`
      );
    }
  }

  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
});

// ─── POST /api/twilio/transcription ──────────────────────────────────────────
// Transcription callback — placeholder for when transcription is enabled.
// To activate: set transcribe="true" in the <Record> verb above and deploy.
// Twilio will call this endpoint asynchronously with TranscriptionText.
router.post('/transcription', (req, res) => {
  const { TranscriptionText, TranscriptionStatus } = req.body;
  const callId = req.query.call_id;

  if (TranscriptionStatus === 'completed' && TranscriptionText && callId) {
    db.prepare(
      'UPDATE comm_calls SET transcription = ? WHERE id = ?'
    ).run(TranscriptionText.trim(), callId);

    const call = db.prepare(
      'SELECT contact_id FROM comm_calls WHERE id = ?'
    ).get(callId);
    if (call?.contact_id) {
      db.prepare(
        'INSERT INTO contact_notes (contact_id, body) VALUES (?, ?)'
      ).run(call.contact_id, `📝 Voicemail transcription: "${TranscriptionText.trim()}"`);
    }
  }

  res.sendStatus(204);
});

// ═══════════════════════════════════════════════════════════════════════════════
// OUTBOUND CALL HANDLERS (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/twilio/twiml ───────────────────────────────────────────────────
// Called by Twilio when the agent answers their phone (outbound bridge flow).
// Returns TwiML that dials the lead and bridges both legs.
router.post('/twiml', (req, res) => {
  const { call_id, to, name } = req.query;
  const fromNumber = process.env.TWILIO_FROM_NUMBER || '';
  const publicUrl  = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');

  if (call_id) {
    db.prepare(
      "UPDATE comm_calls SET status = 'in-progress', answered_at = ? WHERE id = ?"
    ).run(new Date().toISOString(), call_id);
  }

  const dialActionUrl = `${publicUrl}/api/twilio/dial-result/${call_id || ''}`;

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Connecting you to ${escXml(name || 'the lead')} now.</Say>
  <Dial callerId="${escXml(fromNumber)}"
        timeout="30"
        action="${escXml(dialActionUrl)}"
        method="POST">
    <Number>${escXml(to || '')}</Number>
  </Dial>
</Response>`);
});

// ─── POST /api/twilio/dial-result/:call_id ────────────────────────────────────
// Twilio posts here when the outbound <Dial> verb completes (lead leg outcome).
router.post('/dial-result/:call_id', (req, res) => {
  const { DialCallStatus, DialCallDuration } = req.body;
  const callId = req.params.call_id;

  const statusMap = {
    'completed': 'completed',
    'no-answer': 'no-answer',
    'busy':      'busy',
    'failed':    'failed',
    'canceled':  'canceled',
  };
  const status   = statusMap[DialCallStatus] || DialCallStatus || 'unknown';
  const duration = DialCallDuration ? parseInt(DialCallDuration, 10) : null;
  const now      = new Date().toISOString();

  db.prepare(
    'UPDATE comm_calls SET status = ?, duration_sec = ?, ended_at = ? WHERE id = ?'
  ).run(status, duration, now, callId);

  const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
  if (call?.contact_id) {
    db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
      .run(status, call.contact_id);
  }

  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

// ─── POST /api/twilio/status/:call_id ────────────────────────────────────────
// Twilio status callback for the outbound parent (agent) leg.
// Tracks ringing → catches agent no-answer/busy before <Dial> fires.
router.post('/status/:call_id', (req, res) => {
  const { CallStatus } = req.body;
  const callId = req.params.call_id;

  if (CallStatus === 'ringing') {
    db.prepare(
      "UPDATE comm_calls SET status = 'ringing' WHERE id = ? AND status = 'initiated'"
    ).run(callId);
    const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
    if (call?.contact_id) {
      db.prepare(
        "UPDATE contacts SET last_call_status = 'ringing' WHERE id = ? AND last_call_status = 'initiated'"
      ).run(call.contact_id);
    }
  }

  const terminalBeforeDial = ['no-answer', 'busy', 'failed', 'canceled'];
  if (terminalBeforeDial.includes(CallStatus)) {
    db.prepare(
      "UPDATE comm_calls SET status = ? WHERE id = ? AND status IN ('initiated','ringing')"
    ).run(CallStatus, callId);
    const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
    if (call?.contact_id) {
      db.prepare(
        "UPDATE contacts SET last_call_status = ? WHERE id = ? AND last_call_status IN ('initiated','ringing')"
      ).run(CallStatus, call.contact_id);
    }
  }

  res.sendStatus(204);
});

module.exports = router;
