// Twilio webhook handlers — these are PUBLIC endpoints (no CRM API key).
// Twilio calls them from its own servers during a call flow.
//
// Production hardening TODO: validate X-Twilio-Signature header using
// twilio.validateRequest(authToken, sig, url, params) before processing.

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');

function escXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── POST /api/twilio/twiml ───────────────────────────────────────────────────
// Called by Twilio when the agent answers their phone.
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

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Connecting you to ${escXml(name || 'the lead')} now.</Say>
  <Dial callerId="${escXml(fromNumber)}" timeout="30" action="${escXml(dialActionUrl)}" method="POST">
    <Number>${escXml(to || '')}</Number>
  </Dial>
</Response>`;

  res.type('text/xml').send(twiml);
});

// ─── POST /api/twilio/dial-result/:call_id ────────────────────────────────────
// Twilio posts here when the <Dial> verb completes (lead leg outcome).
// DialCallStatus: completed | no-answer | busy | failed | canceled
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
  if (call) {
    db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
      .run(status, call.contact_id);
  }

  // Return empty TwiML to end the agent leg cleanly
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

// ─── POST /api/twilio/status/:call_id ────────────────────────────────────────
// Twilio status callback for the parent (agent) leg.
// Only used to catch agent no-answer / busy before <Dial> fires.
router.post('/status/:call_id', (req, res) => {
  const { CallStatus } = req.body;
  const callId = req.params.call_id;

  const terminalBeforeDial = ['no-answer', 'busy', 'failed', 'canceled'];
  if (terminalBeforeDial.includes(CallStatus)) {
    // Only update if the call never reached in-progress (agent didn't answer)
    db.prepare(
      "UPDATE comm_calls SET status = ? WHERE id = ? AND status = 'initiated'"
    ).run(CallStatus, callId);

    const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
    if (call) {
      db.prepare(
        "UPDATE contacts SET last_call_status = ? WHERE id = ? AND last_call_status = 'initiated'"
      ).run(CallStatus, call.contact_id);
    }
  }

  res.sendStatus(204);
});

module.exports = router;
