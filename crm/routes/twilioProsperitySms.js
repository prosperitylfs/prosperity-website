// Brand-aware Twilio inbound-SMS webhook for the Prosperity 414 number
// (Prosperity Revenue MVP, Requirement 3). PUBLIC endpoint (no CRM API key
// — Twilio can't attach one), protected instead by a required, verified
// X-Twilio-Signature header (crm/lib/twilioSignature.js — the same,
// already-tested verification used by the existing crm/routes/twilio.js).
//
// NOT wired to any real Twilio number yet — see the final checkpoint
// report for the exact console configuration a controlled live test would
// need. This route exists so that configuration is the ONLY remaining step
// when live activation is approved; nothing here needs to change.
//
// All matching/idempotency/consent logic lives in
// crm/lib/inboundSmsService.js (pure, unit-tested with fake signed
// fixtures) — this file only verifies the request and calls in.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { requireValidTwilioSignature } = require('../lib/twilioSignature');
const { handleInboundProsperitySms } = require('../lib/inboundSmsService');

router.use((req, res, next) => {
  console.log(`[twilio-prosperity] route hit: ${req.method} ${req.path}`);
  next();
});

router.use(requireValidTwilioSignature);

router.post('/sms/inbound', (req, res) => {
  const { From, To, Body, MessageSid } = req.body;
  const result = handleInboundProsperitySms(db, { From, To, Body, MessageSid });
  console.log(`[twilio-prosperity/sms/inbound] MessageSid=${MessageSid || 'none'} From=${From || 'none'} outcome=${result.outcome}`);
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

module.exports = router;
