// Brand-aware Twilio inbound-SMS webhook for the Prosperity 414 number.
// PUBLIC endpoint (no CRM API key — Twilio can't attach one), protected
// instead by a required, verified X-Twilio-Signature header
// (crm/lib/twilioSignature.js — the same, already-tested verification used
// by the existing crm/routes/twilio.js).
//
// ALIAS, not the recommended production webhook. Per the Twilio/Render
// configuration audit, the Prosperity 414 number's Messaging Service is set
// to "defer to sender's webhook," which makes the already-configured
// number-level URL — POST /api/twilio/sms/inbound
// (crm/routes/twilio.js) — the one Twilio actually calls today, and the
// one recommended to remain the single authoritative production webhook so
// activation never requires reconfiguring Twilio. /sms/inbound here calls
// the exact same shared handler (handleInboundSmsUnified,
// crm/lib/inboundSmsService.js) so both endpoints are behaviorally
// identical if either is ever hit — kept present for direct testing and as
// a documented fallback path, not because it needs separate configuration.
// NOT configured in any live Twilio console.
//
// All matching/idempotency/consent/legacy-compatibility logic lives in
// crm/lib/inboundSmsService.js (pure, unit-tested with fake signed
// fixtures) — this file only verifies the request and calls in.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireValidTwilioSignature } = require('../lib/twilioSignature');
const { handleInboundSmsUnified } = require('../lib/inboundSmsService');
const { handleOutboundSmsStatusCallback } = require('../lib/smsStatusService');

router.use((req, res, next) => {
  console.log(`[twilio-prosperity] route hit: ${req.method} ${req.path}`);
  next();
});

router.use(requireValidTwilioSignature);

router.post('/sms/inbound', (req, res) => {
  const { From, To, Body, MessageSid, MessageStatus } = req.body;
  const result = handleInboundSmsUnified(db, { From, To, Body, MessageSid, MessageStatus });
  console.log(`[twilio-prosperity/sms/inbound] MessageSid=${MessageSid || 'none'} From=${From || 'none'} outcome=${result.outcome}`);

  if (result.outcome === 'delivery_receipt_deflected') {
    res.sendStatus(204);
    return;
  }
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

// Outbound delivery-status callback — set as statusCallback when
// crm/lib/providers/liveTwilioAdapter.js creates a message. Protected by
// the SAME requireValidTwilioSignature middleware above (applied to this
// whole router), so a forged or unsigned callback never reaches
// handleOutboundSmsStatusCallback at all. The only status this route can
// ever move a message to that no other code path can reach is 'delivered'.
router.post('/sms/status', (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode } = req.body;
  const result = handleOutboundSmsStatusCallback(db, { MessageSid, MessageStatus, ErrorCode });
  console.log(`[twilio-prosperity/sms/status] MessageSid=${MessageSid || 'none'} MessageStatus=${MessageStatus || 'none'} outcome=${result.outcome}`);
  res.sendStatus(204);
});

module.exports = router;
