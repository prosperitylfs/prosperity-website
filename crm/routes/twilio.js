// Twilio webhook handlers — PUBLIC endpoints (no CRM API key required).
// Twilio calls these from its own servers during every call flow.
//
// Production hardening TODO: validate X-Twilio-Signature header using
//   twilio.validateRequest(authToken, sig, fullUrl, params)
// before processing any webhook to prevent spoofed requests.

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { createAutoTask, ctDueDateAndTime } = require('../lib/autoTasks');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SMS_BODY =
  'Hi, this is Loretta with Prosperity Life & Financial Solutions. Sorry I missed your call. How can I help?';

// Returns TwiML greeting for the voicemail prompt.
// Set VOICEMAIL_GREETING_URL env var to use a hosted MP3; defaults to <Say>.
function greetingTwiml() {
  const url = process.env.VOICEMAIL_GREETING_URL;
  console.log(`[twilio/voicemail] greeting url = ${url || '(not set — VOICEMAIL_GREETING_URL env var missing)'}`);
  if (url) {
    console.log('[twilio/voicemail] using custom MP3 greeting');
    return `<Play>${escXml(url)}</Play>`;
  }
  console.log('[twilio/voicemail] using fallback Say greeting');
  return `<Say voice="Polly.Joanna">Hi, you've reached Loretta at Prosperity Life and Financial Solutions. I'm unavailable right now. Please leave your name, number, and a brief message after the beep and I'll call you back as soon as possible. Thank you.</Say>`;
}

async function sendMissedCallSms(callId) {
  const call = db.prepare('SELECT * FROM comm_calls WHERE id = ?').get(callId);
  if (!call) {
    console.warn(`[twilio/sms] call #${callId}: comm_call record not found — skipping`);
    return;
  }
  if (call.auto_sms_sent) {
    console.log(`[twilio/sms] call #${callId}: auto_sms_sent=1 — skipping duplicate`);
    return;
  }

  const toNumber   = call.from_number;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;

  console.log(`[twilio/sms] trigger fired  call_id=${callId}`);
  console.log(`[twilio/sms]   to   = ${toNumber  || 'MISSING — no caller number on record'}`);
  console.log(`[twilio/sms]   from = ${fromNumber || 'NOT SET — add TWILIO_FROM_NUMBER to Render env'}`);
  console.log(`[twilio/sms]   SID  = ${accountSid ? 'set' : 'NOT SET — add TWILIO_ACCOUNT_SID to Render env'}`);
  console.log(`[twilio/sms]   AUTH = ${authToken  ? 'set' : 'NOT SET — add TWILIO_AUTH_TOKEN to Render env'}`);

  if (!toNumber) {
    console.error(`[twilio/sms] ABORT — caller number is blank, cannot send SMS`);
    return;
  }
  if (!fromNumber || !accountSid || !authToken) {
    console.error(`[twilio/sms] ABORT — one or more required env vars are missing (see above)`);
    return;
  }

  // Pre-insert with status=queued so the row appears in SMS History immediately,
  // before the Twilio API call. Updated to sent/failed on the result.
  console.log(`[twilio/sms] inserting queued sms  contact_id=${call.contact_id || 'none'} to=${toNumber}`);
  const smsInsert = db.prepare(`
    INSERT INTO sms_messages
      (contact_id, direction, from_number, to_number, body, status, call_id)
    VALUES (?, 'outbound', ?, ?, ?, 'queued', ?)
  `).run(call.contact_id || null, fromNumber, toNumber, SMS_BODY, callId);
  const smsId = smsInsert.lastInsertRowid;

  console.log(`[twilio/sms] attempting send  sms_id=${smsId} to=${toNumber} from=${fromNumber}`);

  try {
    const client    = require('twilio')(accountSid, authToken);
    const publicUrl = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');
    const msgParams = { body: SMS_BODY, from: fromNumber, to: toNumber };
    if (publicUrl) msgParams.statusCallback = `${publicUrl}/api/twilio/sms/status`;

    const message = await client.messages.create(msgParams);

    console.log(`[twilio/sms] sent sid=${message.sid}  status=${message.status}`);

    db.prepare('UPDATE sms_messages SET twilio_sid = ?, status = ? WHERE id = ?')
      .run(message.sid, message.status || 'sent', smsId);
    db.prepare('UPDATE comm_calls SET auto_sms_sent = 1 WHERE id = ?').run(callId);

    // Auto follow-up task: remind to call the lead back after the auto-text.
    // Skips if an open "Missed call auto-text" Call task already exists.
    if (call.contact_id) {
      createAutoTask(
        call.contact_id, 'Call', 30,
        'Missed call auto-text sent. Call this lead back.',
        'Missed call auto-text'
      );
    }
  } catch (err) {
    console.error(`[twilio/sms] failed=${err.message}  code=${err.code || 'none'}`);
    if (err.status)   console.error(`[twilio/sms] failed http=${err.status}`);
    if (err.moreInfo) console.error(`[twilio/sms] failed info=${err.moreInfo}`);

    // Save failure to SMS History with full error detail in body
    const errDetail = [
      err.message,
      err.code     ? `Code: ${err.code}`     : null,
      err.moreInfo ? `Info: ${err.moreInfo}` : null,
    ].filter(Boolean).join(' | ');
    db.prepare('UPDATE sms_messages SET status = ?, body = ? WHERE id = ?')
      .run('failed', `[FAILED] ${errDetail}\n\nOriginal message: ${SMS_BODY}`, smsId);

    // Create a Call task so the missed call is not lost when SMS is undeliverable
    if (call.contact_id) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      db.prepare(`
        INSERT INTO follow_up_tasks (contact_id, task_type, due_date, notes, priority)
        VALUES (?, 'Call', ?, ?, 'High')
      `).run(call.contact_id, today, 'Missed call from non-SMS-capable number. Call back.');
      console.log(`[twilio/sms] failed - created call task  contact_id=${call.contact_id} due=${today}`);
    } else {
      console.warn(`[twilio/sms] failed - no contact_id, could not create call task`);
    }
  }
}

// Creates or upgrades the voicemail callback task when a real voicemail is saved.
//
// Priority order:
//   1. If an open "Voicemail received" Call task already exists → skip (dedup).
//   2. If an open "Missed call" Call task exists → upgrade it in-place:
//        priority = High, notes = voicemail text, due = now+15 min (CT).
//   3. Otherwise → insert a fresh High-priority Call task due in 15 min (CT).
//
// Always appends an Activity Timeline note when a task is created or upgraded.
function createOrUpgradeVoicemailTask(contactId) {
  const { date: vmDate, time: vmTime } = ctDueDateAndTime(15);
  const NOTES = 'Voicemail received. Listen to voicemail and return call.';

  // ── Dedup: open voicemail callback already exists ──────────────────────────
  const existingVm = db.prepare(`
    SELECT id FROM follow_up_tasks
    WHERE contact_id = ? AND task_type = 'Call' AND status = 'Pending'
      AND notes LIKE '%Voicemail received%'
    LIMIT 1
  `).get(contactId);

  if (existingVm) {
    console.log(`[auto-task] skip duplicate voicemail callback  contact_id=${contactId} existing_id=${existingVm.id}`);
    return;
  }

  // ── Upgrade open missed-call task if one exists ────────────────────────────
  const missedTask = db.prepare(`
    SELECT id FROM follow_up_tasks
    WHERE contact_id = ? AND task_type = 'Call' AND status = 'Pending'
      AND notes LIKE '%Missed call%'
    LIMIT 1
  `).get(contactId);

  if (missedTask) {
    db.prepare(`
      UPDATE follow_up_tasks
      SET priority = 'High', notes = ?, due_date = ?, due_time = ?
      WHERE id = ?
    `).run(NOTES, vmDate, vmTime, missedTask.id);
    console.log(`[auto-task] upgraded missed-call task id=${missedTask.id} → High voicemail callback  contact_id=${contactId} due=${vmDate} ${vmTime}`);
  } else {
    // ── Create fresh voicemail callback task ───────────────────────────────
    const r = db.prepare(`
      INSERT INTO follow_up_tasks (contact_id, task_type, due_date, due_time, notes, priority)
      VALUES (?, 'Call', ?, ?, ?, 'High')
    `).run(contactId, vmDate, vmTime, NOTES);
    console.log(`[auto-task] created voicemail callback  contact_id=${contactId} id=${r.lastInsertRowid} due=${vmDate} ${vmTime}`);
  }

  // ── Activity Timeline entry ────────────────────────────────────────────────
  db.prepare('INSERT INTO contact_notes (contact_id, body) VALUES (?, ?)')
    .run(contactId, '⚡ High Priority Call Task Created — Voicemail Received');
}

function escXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Deferred missed-call SMS timers, keyed by call_id string.
// /voicemail clears these if /voicemail-save fires first.
const pendingSmsByCall = new Map();

// Match an inbound caller's E.164 number to a CRM contact.
function findContactByPhone(fromE164) {
  if (!fromE164) return null;
  let c = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get(fromE164);
  if (c) return c;
  const digits = fromE164.replace(/\D/g, '');
  const ten    = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return null;
  const formatted = `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}`;
  return db.prepare(
    'SELECT * FROM contacts WHERE phone = ? OR alt_phone = ?'
  ).get(formatted, formatted) || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Request logger — fires for every request that reaches /api/twilio/*
// ═══════════════════════════════════════════════════════════════════════════════
router.use((req, res, next) => {
  console.log(`[twilio] route hit: ${req.method} ${req.path}`);
  next();
});

// ═══════════════════════════════════════════════════════════════════════════════
// INBOUND CALL HANDLERS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── POST /api/twilio/incoming ────────────────────────────────────────────────
// Twilio Voice Webhook — set this URL in your Twilio Phone Number configuration.
//
// Flow: incoming call → ring agent's personal phone for 20 s →
//   if answered → bridge (DialCallStatus=completed in /voicemail)
//   if not answered → play Twilio voicemail greeting + record (/voicemail-save)
//   if caller hung up before agent answered → SMS sent immediately (canceled branch)
//
// IMPORTANT: Twilio reports DialCallStatus='completed' even when the agent's
// PERSONAL PHONE VOICEMAIL answers (not a human). We cannot distinguish this
// from a real answer using DialCallStatus alone. The /call-ended StatusCallback
// (registered via REST API below) fires after the whole call ends and sends SMS
// if no Twilio recording was saved — this covers the personal-voicemail case.
router.post('/incoming', (req, res) => {
  const callerNumber = req.body.From    || '';
  const callSid      = req.body.CallSid || '';
  const agentPhone   = process.env.AGENT_PHONE_NUMBER || '';
  const twilioNumber = process.env.TWILIO_FROM_NUMBER || '';
  const publicUrl    = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');

  console.log(`[twilio/incoming] CallSid=${callSid} From=${callerNumber || '(unknown)'} agentPhone=${agentPhone || 'NOT SET'}`);
  console.log(`[twilio/incoming] CRM_PUBLIC_URL = '${process.env.CRM_PUBLIC_URL || 'NOT SET — voicemail/call-ended callbacks will be broken'}'`);

  if (!agentPhone || !twilioNumber) {
    console.error('[twilio/incoming] AGENT_PHONE_NUMBER or TWILIO_FROM_NUMBER not set — cannot route call');
    res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thank you for calling. Please try again later.</Say>
  <Hangup/>
</Response>`);
    return;
  }

  let contact = findContactByPhone(callerNumber);
  if (!contact && callerNumber) {
    const digits    = callerNumber.replace(/\D/g, '');
    const ten       = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    const dispPhone = ten.length === 10
      ? `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}`
      : callerNumber;
    const e164Phone = ten.length === 10 ? `+1${ten}` : null;
    const ins = db.prepare(`
      INSERT INTO contacts
        (first_name, last_name, phone, phone_e164, lead_type, lead_status, lead_source, updated_at)
      VALUES (?, ?, ?, ?, 'Unknown Caller', 'New Lead', 'Inbound Call', ?)
    `).run('Unknown Caller', dispPhone, dispPhone, e164Phone || callerNumber,
           new Date().toISOString());
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ins.lastInsertRowid);
    console.log(`[twilio/incoming] Created new contact id=${contact.id} phone=${dispPhone}`);
  } else if (contact) {
    console.log(`[twilio/incoming] Matched contact id=${contact.id} name="${contact.first_name} ${contact.last_name}"`);
  }

  const contactId   = contact ? contact.id   : null;
  const contactName = contact
    ? [contact.first_name, contact.last_name].filter(Boolean).join(' ')
    : 'Unknown Caller';
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT INTO comm_calls
      (contact_id, contact_name, direction, from_number, to_number,
       status, provider_call_uuid, started_at)
    VALUES (?, ?, 'inbound', ?, ?, 'ringing', ?, ?)
  `).run(contactId, contactName, callerNumber, agentPhone, callSid, now);
  const callId = result.lastInsertRowid;

  console.log(`[twilio/incoming] call_id=${callId} contact_id=${contactId || 'none'} contact="${contactName}" ringing agent`);

  if (contactId) {
    db.prepare(
      'UPDATE contacts SET last_called_at = ?, last_call_status = ? WHERE id = ?'
    ).run(now, 'ringing', contactId);
  }

  const voicemailUrl = `${publicUrl}/api/twilio/voicemail?call_id=${callId}`;
  const callEndedUrl = `${publicUrl}/api/twilio/call-ended?call_id=${callId}`;

  // Register a StatusCallback on the PARENT call (the caller's leg).
  // Fires when the entire call ends — used to send missed-call SMS if no recording
  // was saved (catches the agent's personal-voicemail intercept case).
  // Fire-and-forget: do not block the TwiML response.
  const acctSid   = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (acctSid && authToken && callSid) {
    require('twilio')(acctSid, authToken)
      .calls(callSid)
      .update({ statusCallback: callEndedUrl, statusCallbackMethod: 'POST' })
      .then(() => console.log(`[twilio/incoming] call_id=${callId}: StatusCallback registered → ${callEndedUrl}`))
      .catch(err  => console.warn(`[twilio/incoming] call_id=${callId}: StatusCallback registration failed: ${err.message}`));
  } else {
    console.warn(`[twilio/incoming] call_id=${callId}: cannot register StatusCallback — TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set`);
  }

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
// Dial action — Twilio posts here when the <Dial> verb finishes.
//
// DialCallStatus values for the agent's phone leg:
//   completed — agent answered (OR agent's personal voicemail answered — indistinguishable
//               without AMD). /call-ended will handle SMS for the voicemail intercept case.
//   canceled  — caller hung up before agent answered. Send SMS immediately.
//   no-answer/busy/failed — agent unavailable. Play Twilio voicemail + record.
router.post('/voicemail', (req, res) => {
  const { DialCallStatus, DialCallDuration } = req.body;
  const callId    = req.query.call_id;
  const publicUrl = (process.env.CRM_PUBLIC_URL || '').replace(/\/$/, '');
  const now       = new Date().toISOString();

  console.log(`[twilio/voicemail] call_id=${callId} DialCallStatus=${DialCallStatus} DialCallDuration=${DialCallDuration || '0'}s`);

  // ── Agent answered (or agent's personal voicemail intercepted) ──────────────
  if (DialCallStatus === 'completed') {
    const dur = parseInt(DialCallDuration || '0', 10);
    // A real conversation will be > 45 s. A personal-voicemail intercept typically
    // ends in < 45 s (greeting + caller decides not to leave a message).
    // We cannot use AMD, so duration is the only available signal here.
    if (dur > 45) {
      console.log(`[twilio/voicemail] call_id=${callId}: completed ${dur}s → real answer, marking answered, no SMS`);
      db.prepare(
        "UPDATE comm_calls SET status = 'answered', answered_at = ?, ended_at = ? WHERE id = ?"
      ).run(now, now, callId);
      const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
      if (call?.contact_id) {
        db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
          .run('answered', call.contact_id);
      }
    } else {
      console.log(`[twilio/voicemail] call_id=${callId}: completed ${dur}s → likely personal voicemail intercept, marking missed, sending SMS`);
      db.prepare(
        "UPDATE comm_calls SET status = 'missed', ended_at = ? WHERE id = ?"
      ).run(now, callId);
      const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
      if (call?.contact_id) {
        db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
          .run('missed', call.contact_id);
      }
      sendMissedCallSms(callId).catch(err =>
        console.error(`[twilio/sms] completed-branch error call_id=${callId}:`, err.message)
      );
    }
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    return;
  }

  // ── Caller hung up before agent answered ────────────────────────────────────
  if (DialCallStatus === 'canceled') {
    console.log(`[twilio/voicemail] call_id=${callId}: caller hung up before agent answered — marking missed`);
    db.prepare(
      "UPDATE comm_calls SET status = 'missed', ended_at = ? WHERE id = ?"
    ).run(now, callId);

    const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
    if (call?.contact_id) {
      db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
        .run('missed', call.contact_id);
    }

    console.log(`[twilio/sms] missed call before voicemail - send sms  call_id=${callId}`);
    sendMissedCallSms(callId).catch(err =>
      console.error(`[twilio/sms] canceled-branch error for call #${callId}:`, err.message)
    );

    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    return;
  }

  // ── Agent did not answer (no-answer / busy / failed) → Twilio voicemail ─────
  console.log(`[twilio/voicemail] call_id=${callId}: DialCallStatus=${DialCallStatus} → agent unavailable, marking missed`);
  db.prepare(
    "UPDATE comm_calls SET status = 'missed', ended_at = ? WHERE id = ?"
  ).run(now, callId);

  const call = db.prepare('SELECT contact_id FROM comm_calls WHERE id = ?').get(callId);
  if (call?.contact_id) {
    db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
      .run('missed', call.contact_id);
  }

  // Do NOT send SMS here — the greeting has not played yet.
  // /voicemail-save cancels the timer below and decides immediately:
  //   real recording → suppress SMS; no recording → send SMS.
  // If the caller hangs up DURING the greeting (before <Record> starts), Twilio
  // never calls /voicemail-save. The timer fires after 3 minutes as a reliable
  // fallback: re-checks the DB and sends SMS only if no voicemail was recorded.
  const smsTimer = setTimeout(() => {
    pendingSmsByCall.delete(String(callId));
    const fresh = db.prepare('SELECT recording_url, auto_sms_sent FROM comm_calls WHERE id = ?').get(callId);
    if (!fresh) return;
    if (fresh.recording_url) {
      console.log(`[twilio/sms] voicemail recording exists - skip sms  call_id=${callId} (deferred check)`);
      return;
    }
    if (fresh.auto_sms_sent) return;
    console.log(`[twilio/sms] voicemail completed with no recording - send sms  call_id=${callId} (deferred check)`);
    sendMissedCallSms(callId).catch(err =>
      console.error(`[twilio/sms] deferred SMS error call_id=${callId}:`, err.message)
    );
  }, 3 * 60 * 1000);
  pendingSmsByCall.set(String(callId), smsTimer);

  const saveUrl = `${publicUrl}/api/twilio/voicemail-save?call_id=${callId}`;
  console.log(`[twilio/voicemail] call_id=${callId}: playing greeting, recording to ${saveUrl}`);

  res.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greetingTwiml()}
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
// Record action — Twilio posts here when the <Record> verb ends.
// RecordingUrl + RecordingDuration > 0 = real voicemail left, no SMS.
// RecordingUrl absent or duration = 0 = caller hung up before/during recording, send SMS.
router.post('/voicemail-save', (req, res) => {
  const { RecordingUrl, RecordingDuration, RecordingSid } = req.body;
  const callId   = req.query.call_id;
  const now      = new Date().toISOString();

  // Cancel the deferred SMS timer set in /voicemail — we handle SMS here now.
  const timer = pendingSmsByCall.get(String(callId));
  if (timer) { clearTimeout(timer); pendingSmsByCall.delete(String(callId)); }
  const duration = RecordingDuration ? parseInt(RecordingDuration, 10) : null;
  const recUrl   = RecordingUrl ? `${RecordingUrl}.mp3` : null;

  console.log(
    `[twilio/voicemail-save] call_id=${callId} ` +
    `RecordingSid=${RecordingSid || 'none'} ` +
    `RecordingUrl=${RecordingUrl || 'none'} ` +
    `duration=${duration ?? 'null'}s`
  );

  // A real voicemail requires both a URL and a non-zero duration.
  const hasRealVoicemail = !!(recUrl && duration && duration > 0);
  const status = hasRealVoicemail ? 'voicemail' : 'missed';

  console.log(`[twilio/voicemail-save] call_id=${callId}: hasRealVoicemail=${hasRealVoicemail} → status=${status}`);

  db.prepare(
    `UPDATE comm_calls SET status = ?, recording_url = ?, recording_sid = ?, duration_sec = ?, ended_at = ? WHERE id = ?`
  ).run(status, recUrl, RecordingSid || null, duration, now, callId);

  const call = db.prepare(
    'SELECT contact_id, from_number, contact_name FROM comm_calls WHERE id = ?'
  ).get(callId);

  if (call?.contact_id) {
    db.prepare('UPDATE contacts SET last_call_status = ? WHERE id = ?')
      .run(status, call.contact_id);

    if (hasRealVoicemail) {
      db.prepare(
        'INSERT INTO contact_notes (contact_id, body) VALUES (?, ?)'
      ).run(
        call.contact_id,
        `📞 Voicemail received (${duration}s) from ${call.from_number || 'unknown'}. Recording saved to call log.`
      );

      // Create or upgrade voicemail callback task (High priority, deduped).
      createOrUpgradeVoicemailTask(call.contact_id);
    }
  }

  if (hasRealVoicemail) {
    console.log(`[twilio/voicemail] recording created  call_id=${callId} duration=${duration}s sid=${RecordingSid}`);
    console.log(`[twilio/sms] voicemail recording exists - skip sms  call_id=${callId}`);
  } else {
    console.log(`[twilio/voicemail] no recording  call_id=${callId} RecordingUrl=${RecordingUrl || 'null'} duration=${duration ?? 'null'}`);
    console.log(`[twilio/sms] voicemail completed with no recording - send sms  call_id=${callId}`);
    sendMissedCallSms(callId).catch(err =>
      console.error(`[twilio/sms] voicemail-save error for call #${callId}:`, err.message)
    );
  }

  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
});

// ─── POST /api/twilio/call-ended ──────────────────────────────────────────────
// Parent call StatusCallback — registered dynamically from /incoming via REST API.
// Fires on every parent call status change; we only act on CallStatus=completed.
//
// Purpose: catch missed-call SMS cases that slip through the webhook-based branches:
//   - Agent's personal voicemail intercepts call (DialCallStatus=completed, no Twilio recording)
//   - Caller hangs up during voicemail greeting (before <Record> fires /voicemail-save)
//
// Decision: if no recording_url AND auto_sms_sent=0 → send SMS.
// The auto_sms_sent flag prevents duplicates when SMS was already sent in /voicemail.
router.post('/call-ended', (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  const callId = req.query.call_id;

  console.log(
    `[twilio/call-ended] call_id=${callId} ` +
    `CallSid=${CallSid || 'none'} ` +
    `CallStatus=${CallStatus} ` +
    `CallDuration=${CallDuration || '0'}s`
  );

  // StatusCallback fires for multiple events (initiated, ringing, in-progress,
  // completed, canceled). Only act on terminal states that need SMS.
  if (CallStatus !== 'completed' && CallStatus !== 'canceled') {
    res.sendStatus(204);
    return;
  }

  if (!callId) {
    console.warn('[twilio/call-ended] missing call_id query param — cannot process');
    res.sendStatus(204);
    return;
  }

  const call = db.prepare('SELECT * FROM comm_calls WHERE id = ?').get(callId);
  if (!call) {
    console.warn(`[twilio/call-ended] call_id=${callId}: no comm_call record found`);
    res.sendStatus(204);
    return;
  }

  console.log(
    `[twilio/call-ended] call_id=${callId}: ` +
    `db_status=${call.status} ` +
    `recording_url=${call.recording_url ? 'SET' : 'null'} ` +
    `recording_sid=${call.recording_sid || 'null'} ` +
    `auto_sms_sent=${call.auto_sms_sent}`
  );

  // Real answered call — never send missed-call SMS.
  if (call.status === 'answered') {
    console.log(`[twilio/call-ended] call_id=${callId}: call was answered — no SMS`);
    res.sendStatus(204);
    return;
  }

  if (call.recording_url) {
    console.log(`[twilio/sms] voicemail recording exists - skip sms  call_id=${callId}`);
    res.sendStatus(204);
    return;
  }

  if (call.auto_sms_sent) {
    console.log(`[twilio/call-ended] call_id=${callId}: SMS already sent (auto_sms_sent=1) — no duplicate`);
    res.sendStatus(204);
    return;
  }

  // Determine which log line to emit based on how the call ended.
  if (CallStatus === 'canceled') {
    console.log(`[twilio/sms] missed call before voicemail - send sms  call_id=${callId} (call-ended safety net)`);
  } else {
    console.log(`[twilio/sms] voicemail completed with no recording - send sms  call_id=${callId} (call-ended safety net)`);
  }
  sendMissedCallSms(callId).catch(err =>
    console.error(`[twilio/sms] call-ended error for call #${callId}:`, err.message)
  );

  res.sendStatus(204);
});

// ─── POST /api/twilio/sms/inbound ────────────────────────────────────────────
// Twilio Messaging webhook — configure this URL in Twilio console:
//   Messaging → Phone Numbers → Active Numbers → your number → "A MESSAGE COMES IN"
//   URL: https://prosperity-crm.onrender.com/api/twilio/sms/inbound
//   HTTP: POST
//
// NOTE: if you previously used this URL as a status callback too, Twilio may
// POST delivery receipts here (MessageStatus present, Body absent). Those are
// deflected below to the status-update path so they cannot create duplicate rows.
router.post('/sms/inbound', (req, res) => {
  const { From, To, Body, MessageSid, MessageStatus } = req.body;

  // Delivery receipts arrive with MessageStatus instead of a real Body.
  // Route them to the status-update logic so they UPDATE the existing row.
  if (MessageStatus && !Body) {
    console.log(`[twilio/sms/inbound] deflecting delivery receipt → MessageSid=${MessageSid} status=${MessageStatus}`);
    if (MessageSid && MessageStatus) {
      db.prepare('UPDATE sms_messages SET status = ? WHERE twilio_sid = ?')
        .run(MessageStatus.toLowerCase(), MessageSid);
    }
    res.sendStatus(204);
    return;
  }

  console.log(`[twilio/sms/inbound] MessageSid=${MessageSid} From=${From} To=${To} body="${(Body || '').slice(0, 60)}"`);

  // Find or create contact by From number
  let contact = findContactByPhone(From);
  if (!contact && From) {
    const digits    = From.replace(/\D/g, '');
    const ten       = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    const dispPhone = ten.length === 10
      ? `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}`
      : From;
    const e164Phone = ten.length === 10 ? `+1${ten}` : null;
    const ins = db.prepare(`
      INSERT INTO contacts
        (first_name, last_name, phone, phone_e164, lead_type, lead_status, lead_source, updated_at)
      VALUES (?, ?, ?, ?, 'Unknown Caller', 'New Lead', 'Inbound SMS', ?)
    `).run('Unknown', dispPhone, dispPhone, e164Phone || From, new Date().toISOString());
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ins.lastInsertRowid);
    console.log(`[twilio/sms/inbound] Created new contact id=${contact.id} for ${From}`);
  } else if (contact) {
    console.log(`[twilio/sms/inbound] Matched contact id=${contact.id} name="${contact.first_name} ${contact.last_name}"`);
  } else {
    console.warn('[twilio/sms/inbound] No From number — cannot match contact');
  }

  const contactId = contact ? contact.id : null;

  // sms_messages is the sole authoritative store for SMS history.
  // INSERT OR IGNORE deduplicates by the unique index on twilio_sid.
  const smsInsertResult = db.prepare(`
    INSERT OR IGNORE INTO sms_messages
      (contact_id, direction, from_number, to_number, body, status, twilio_sid)
    VALUES (?, 'inbound', ?, ?, ?, 'received', ?)
  `).run(contactId, From || null, To || null, Body || '', MessageSid || null);

  console.log(`[twilio/sms/inbound] Saved — contact_id=${contactId} MessageSid=${MessageSid}`);

  // Auto follow-up task: remind to reply. Only fires for genuinely new messages
  // (changes=0 means it was a duplicate twilio_sid — no task needed).
  if (smsInsertResult.changes > 0 && contactId) {
    createAutoTask(
      contactId, 'SMS', 15,
      'New inbound SMS received. Reply to this lead.',
      'New inbound SMS'
    );
  }

  // Respond with empty TwiML (no auto-reply to inbound SMS)
  res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

// ─── POST /api/twilio/sms/status ─────────────────────────────────────────────
// Twilio delivery-status callback for outbound SMS.
// Configured automatically via statusCallback in messages.create().
// Always UPDATEs the existing sms_messages row — never inserts a new row.
router.post('/sms/status', (req, res) => {
  const { MessageSid, MessageStatus, ErrorCode } = req.body;
  if (!MessageSid || !MessageStatus) { res.sendStatus(204); return; }

  const status = MessageStatus.toLowerCase();
  const result = db.prepare('UPDATE sms_messages SET status = ? WHERE twilio_sid = ?')
    .run(status, MessageSid);

  if (result.changes) {
    console.log(`[twilio/sms/status] ${MessageSid} → ${status}${ErrorCode ? '  error=' + ErrorCode : ''}`);
  } else {
    console.warn(`[twilio/sms/status] no sms_messages row found for sid=${MessageSid}`);
  }

  res.sendStatus(204);
});

// ─── POST /api/twilio/transcription ──────────────────────────────────────────
// Transcription callback — fires when transcription is enabled on <Record>.
// To activate: set transcribe="true" in the <Record> verb above and deploy.
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

console.log('[twilio] routes loaded');

module.exports = router;
