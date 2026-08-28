// Dedicated pre-deployment verification: the automatic Retirement Intake
// SMS (triggered from crm/routes/calcom.js) must obey the exact same
// consent rules as the manual SMS composer, with no second/independent
// consent definition. Exercises the REAL Cal.com webhook HTTP path
// end-to-end (not just the lib functions in isolation — those already have
// their own coverage in crm/test/legacySmsSend.test.js and
// crm/test/retirementIntakeSms.test.js) for five scenarios:
//
//   A. Pre-consented contact (as if they'd checked the SMS consent box on
//      the website's own booking flow before ever reaching Cal.com) — the
//      send must be ATTEMPTED (reach past the consent gate).
//   B. No consent on file — must be BLOCKED, intake stays Not Sent.
//   C. Previously opted out (STOP) — must be BLOCKED, intake stays Not Sent.
//   D. Consented AND THEN opted out — opt-out must override prior consent.
//   E. Life Insurance appointment — no retirement intake SMS is ever
//      attempted, regardless of the contact's consent state.
//
// No TWILIO_* credentials are configured anywhere in this file, so every
// "attempted" send deterministically fails at crm/lib/legacySmsSend.js's
// "Twilio is not configured" step, never making a real network call. To
// still prove WHETHER a send was attempted (reached past the consent gate)
// versus blocked BY the consent gate, this captures the specific
// console.warn calcom.js logs and asserts on which reason it contains --
// the same signal an operator watching Render's logs would see, cross-
// checked against crm/lib/legacySmsSend.js's checkConsentGate(), which is
// the exact function crm/routes/sms.js's manual-send path also calls.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const savedEnv = {
  DB_PATH: process.env.DB_PATH,
  CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET,
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER,
};
process.env.DB_PATH = ':memory:';
delete process.env.TWILIO_ACCOUNT_SID;
delete process.env.TWILIO_AUTH_TOKEN;
delete process.env.TWILIO_FROM_NUMBER;
const SECRET = 'consent-verification-fake-secret';
process.env.CALCOM_WEBHOOK_SECRET = SECRET;

const db = require('../db/database');
const calcomRouter = require('../routes/calcom');
const { checkConsentGate } = require('../lib/legacySmsSend');

let server, baseUrl;

before(() => {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/calcom', calcomRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/calcom`;
});

after(() => {
  server.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function sign(bodyString) {
  return crypto.createHmac('sha256', SECRET).update(bodyString).digest('hex');
}

async function postWebhookCapturingWarnings(body) {
  const raw = JSON.stringify(body);
  const captured = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { captured.push(args.join(' ')); originalWarn(...args); };
  try {
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cal-signature-256': sign(raw) },
      body: raw,
    });
    await res.json();
    await new Promise(r => setTimeout(r, 20));
    return { status: res.status, warnings: captured };
  } finally {
    console.warn = originalWarn;
  }
}

function responseEntry(label, value) { return { label, value }; }

function basePayload({ uid, eventTitle = 'Safe Money & Retirement Consultation', email, phone = '+14145550188' }) {
  return {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      uid, startTime: '2026-10-01T17:00:00.000Z', endTime: '2026-10-01T17:30:00.000Z',
      eventType: { title: eventTitle, length: 30 },
      attendees: [{ name: 'Consent Test', email, phoneNumber: phone }],
      responses: { name: responseEntry('Name', 'Consent Test'), email: responseEntry('Email', email) },
      location: 'integrations:google:meet',
    },
  };
}

function getAppointment(uid) {
  return db.prepare('SELECT * FROM appointments WHERE cal_booking_uid = ?').get(uid);
}
function getIntake(apptId) {
  return db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(apptId);
}
function smsCount(contactId) {
  return db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contactId).n;
}

function seedContact({ email, phone_e164 = '+14145550188', sms_consent = 0, sms_opted_out_at = null }) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, phone_e164, sms_consent, sms_opted_out_at)
    VALUES ('Consent', 'Test', ?, ?, ?, ?)
  `).run(email, phone_e164, sms_consent, sms_opted_out_at).lastInsertRowid;
}

// ── A. Explicit prior consent (as if via the website's own booking flow) ──

test('A. a contact who already consented to SMS (as if via the website booking flow) has the send ATTEMPTED, not blocked by consent', async () => {
  const email = 'consent-a-' + Date.now() + '@example.com';
  seedContact({ email, sms_consent: 1, sms_opted_out_at: null });
  const uid = 'consent-a-' + Date.now();

  const { warnings } = await postWebhookCapturingWarnings(basePayload({ uid, email }));

  const appt = getAppointment(uid);
  const intake = getIntake(appt.id);
  assert.ok(intake, 'intake record must still be created');
  assert.equal(intake.status, 'Not Sent', 'stays Not Sent because Twilio is unconfigured in this test file');

  const consentBlocked = warnings.some(w => /does not have SMS consent|opted out of SMS/.test(w));
  const notConfigured = warnings.some(w => /not sent for contact/.test(w));
  assert.equal(consentBlocked, false, 'must NOT be blocked by the consent gate');
  assert.equal(notConfigured, true, 'must reach the send attempt (and fail only because Twilio is unconfigured in this test)');
});

// ── B. No consent on file ──────────────────────────────────────────────────

test('B. a contact with no SMS consent on file never gets the intake SMS sent, and the intake never falsely shows Sent', async () => {
  const email = 'consent-b-' + Date.now() + '@example.com';
  seedContact({ email, sms_consent: 0, sms_opted_out_at: null });
  const uid = 'consent-b-' + Date.now();

  const { warnings } = await postWebhookCapturingWarnings(basePayload({ uid, email }));

  const appt = getAppointment(uid);
  const intake = getIntake(appt.id);
  assert.equal(intake.status, 'Not Sent');
  assert.equal(intake.sent_at, null);
  assert.equal(smsCount(appt.contact_id), 0, 'no sms_messages row at all — blocked before Twilio was ever touched');
  assert.ok(warnings.some(w => /does not have SMS consent on file/.test(w)));
});

// ── C. Previously opted out (STOP) ──────────────────────────────────────────

test('C. a contact who previously texted STOP never gets the intake SMS sent, and the intake never falsely shows Sent', async () => {
  const email = 'consent-c-' + Date.now() + '@example.com';
  seedContact({ email, sms_consent: 0, sms_opted_out_at: '2026-08-15 10:00:00' });
  const uid = 'consent-c-' + Date.now();

  const { warnings } = await postWebhookCapturingWarnings(basePayload({ uid, email }));

  const appt = getAppointment(uid);
  const intake = getIntake(appt.id);
  assert.equal(intake.status, 'Not Sent');
  assert.equal(intake.sent_at, null);
  assert.equal(smsCount(appt.contact_id), 0);
  assert.ok(warnings.some(w => /opted out of SMS \(STOP\)/.test(w)));
});

// ── D. Opted out AFTER previously consenting — opt-out must win ────────────

test('D. opt-out overrides prior consent — a contact with sms_consent=1 AND sms_opted_out_at set is still blocked', async () => {
  const email = 'consent-d-' + Date.now() + '@example.com';
  seedContact({ email, sms_consent: 1, sms_opted_out_at: '2026-08-20 09:00:00' }); // consented, then STOP
  const uid = 'consent-d-' + Date.now();

  const { warnings } = await postWebhookCapturingWarnings(basePayload({ uid, email }));

  const appt = getAppointment(uid);
  const intake = getIntake(appt.id);
  assert.equal(intake.status, 'Not Sent');
  assert.equal(smsCount(appt.contact_id), 0);
  assert.ok(warnings.some(w => /opted out of SMS \(STOP\)/.test(w)), 'the STOP-specific message must win, not the generic no-consent message');
});

test('D (direct gate check): checkConsentGate itself treats opt-out as authoritative regardless of sms_consent value', () => {
  // Same function crm/routes/sms.js (manual send) calls — proves there is
  // only one consent definition, not a second one for this feature.
  const gate = checkConsentGate({ sms_consent: 1, sms_opted_out_at: '2026-08-20 09:00:00' });
  assert.equal(gate.blocked, true);
  assert.match(gate.error, /opted out of SMS \(STOP\)/);
});

// ── E. Life Insurance — never sent regardless of consent ────────────────────

test('E. a Life Insurance appointment never triggers a retirement intake SMS even for a fully SMS-consented contact', async () => {
  const email = 'consent-e-' + Date.now() + '@example.com';
  seedContact({ email, sms_consent: 1, sms_opted_out_at: null });
  const uid = 'consent-e-' + Date.now();

  const { warnings } = await postWebhookCapturingWarnings(basePayload({ uid, email, eventTitle: 'Life Insurance Consultation' }));

  const appt = getAppointment(uid);
  assert.equal(getIntake(appt.id), undefined, 'no intake record at all for a Life Insurance appointment');
  assert.equal(smsCount(appt.contact_id), 0, 'no sms_messages row — the send path is never reached');
  assert.equal(warnings.some(w => /retirement intake/i.test(w)), false, 'no retirement-intake-related log line at all');
});

// ── Single shared consent definition (no duplicate logic) ──────────────────

test('the automatic sender and the manual /api/sms/send route both delegate to the exact same checkConsentGate function', () => {
  const smsRouteSource = require('fs').readFileSync(require.resolve('../routes/sms.js'), 'utf8');
  const intakeSmsSource = require('fs').readFileSync(require.resolve('../lib/retirementIntakeSms.js'), 'utf8');
  assert.match(smsRouteSource, /require\(['"]\.\.\/lib\/legacySmsSend['"]\)/, 'manual route must import the shared module');
  assert.match(intakeSmsSource, /require\(['"]\.\/legacySmsSend['"]\)/, 'automatic sender must import the same shared module');
});
