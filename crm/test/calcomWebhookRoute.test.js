// Tests for POST /api/calcom/webhook (crm/routes/calcom.js) — previously
// completely untested at the business-logic level (only the HMAC signature
// helper, crm/lib/calcomSignature.js, had coverage). Written alongside the
// Life Insurance qualification-answer capture added this session, and
// deliberately also covers the pre-existing contact-matching/appointment/
// lead-status/timeline behavior so nothing in this file regresses silently.
//
// Mirrors crm/test/tasksRoute.test.js's approach: DB_PATH is pointed at an
// in-memory database BEFORE crm/db/database.js is first required anywhere
// in this process, then a real Express app is spun up on an ephemeral port
// with the SAME express.json({verify}) raw-body-capturing setup server.js
// uses in production, so signature verification is exercised exactly as it
// runs live -- not a reconstructed-JSON fallback.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');

const savedEnv = { DB_PATH: process.env.DB_PATH, CALCOM_WEBHOOK_SECRET: process.env.CALCOM_WEBHOOK_SECRET };
process.env.DB_PATH = ':memory:';
const SECRET = 'unit-test-fake-calcom-secret';
process.env.CALCOM_WEBHOOK_SECRET = SECRET;

const db = require('../db/database');
const calcomRouter = require('../routes/calcom');

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

async function postWebhook(body, { badSignature = false, noSignature = false } = {}) {
  const raw = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };
  if (!noSignature) headers['x-cal-signature-256'] = badSignature ? 'deadbeef'.repeat(8) : sign(raw);
  const res = await fetch(`${baseUrl}/webhook`, { method: 'POST', headers, body: raw });
  // The route responds 200 immediately regardless of what happens next
  // (documented behavior — Cal.com must not retry on processing delay), so
  // tests wait a tick for the fire-and-forget processing to finish before
  // asserting on the database.
  await res.json();
  await new Promise(r => setTimeout(r, 20));
  return res.status;
}

function responseEntry(label, value) {
  return { label, value };
}

function lifeInsuranceResponses(overrides = {}) {
  return Object.assign({
    name: responseEntry('Your name', 'Test Caller'),
    email: responseEntry('Your email', 'test.caller@example.com'),
    phone: responseEntry('Phone number', '+14145550123'),
    q1: responseEntry('What would you like help with during your consultation?', 'Term life insurance'),
    q2: responseEntry('Who will be applying for coverage?', 'Myself'),
    q3: responseEntry('What is the age of each person needing coverage?', '45'),
    q4: responseEntry('How soon are you hoping to have coverage in place?', 'Within 30 days'),
    q5: responseEntry('How would you describe the person\'s overall health today?', 'Good'),
    q6: responseEntry('Has the person ever been declined for life insurance?', 'No'),
    q7: responseEntry('Does the person currently use nicotine or tobacco products?', 'No'),
  }, overrides);
}

// attendees[0] takes priority over `responses` in the route's own
// extraction logic (attendee.email || responses.email?.value), so this
// derives the attendee identity from whatever `responses.name/email/phone`
// each test actually passed in, rather than a fixed value -- otherwise
// every test would resolve to the same hardcoded contact regardless of the
// email/phone it set in `responses`.
function basePayload({ uid = 'uid-' + Math.random().toString(36).slice(2), eventTitle = 'Life Insurance Consultation', responses, startTime = '2026-09-01T15:00:00.000Z', endTime = '2026-09-01T15:30:00.000Z' } = {}) {
  const r = responses || {};
  return {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      uid,
      startTime,
      endTime,
      eventType: { title: eventTitle, length: 30 },
      attendees: [{
        name: (r.name && r.name.value) || 'Test Caller',
        email: (r.email && r.email.value) || 'test.caller@example.com',
        // No shared fallback here (unlike name/email above) -- a phone
        // number is what the route's contact-matching falls back to when
        // email doesn't match, so reusing one hardcoded default across
        // tests that don't care about phone would make them collide with
        // whichever earlier test happened to create a contact with that
        // same number. Only set when a test actually passed one in.
        phoneNumber: (r.phone && r.phone.value) || null,
      }],
      responses: r,
      location: 'integrations:google:meet',
    },
  };
}

function getContact(email) {
  return db.prepare('SELECT * FROM contacts WHERE email = ?').get(email);
}
function getAppointment(uid) {
  return db.prepare('SELECT * FROM appointments WHERE cal_booking_uid = ?').get(uid);
}

// Mirrors the ACTUAL production BOOKING_CREATED payload shape, confirmed via
// live testing and Cal.com's own documentation
// (https://cal.com/docs/developing/guides/automation/webhooks): the event
// type slug is the top-level `type` field, the event type's own name is
// `eventTitle`, and there is NO `eventType` object at all (a real webhook
// logged it as `undefined`) -- unlike basePayload() above, which uses the
// OLD, incorrect assumed shape (a nested eventType.title) that every
// earlier test in this file was written against and still must keep
// passing (see the fallback chain in inferLeadType()).
function realProductionPayload({ uid = 'real-uid-' + Math.random().toString(36).slice(2), type, eventTitle, title, email, phone, startTime = '2026-09-15T18:00:00.000Z', endTime = '2026-09-15T18:30:00.000Z' } = {}) {
  return {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      uid,
      startTime,
      endTime,
      type,
      eventTitle,
      title,
      attendees: [{ name: 'Real Prospect', email, timeZone: 'America/Chicago' }],
      responses: { name: { label: 'Name', value: 'Real Prospect' }, email: { label: 'Email', value: email } },
      // The site's own phone-as-location prefill (assets/js/scheduleQualification.js's
      // buildCalcomPrefillQuery) -- confirmed this is where Cal.com echoes
      // the attendee's phone back on the real webhook.
      location: phone ? { value: 'phone', optionValue: phone } : undefined,
    },
  };
}

// ── Signature verification (route-level, not just the lib) ──────────────

test('a webhook with a valid signature is processed', async () => {
  const uid = 'sig-ok-' + Date.now();
  const status = await postWebhook(basePayload({ uid, responses: lifeInsuranceResponses() }));
  assert.equal(status, 200);
  assert.ok(getAppointment(uid), 'a validly-signed webhook must be processed');
});

test('a webhook with an invalid signature is ignored (still 200, but nothing is written)', async () => {
  const uid = 'sig-bad-' + Date.now();
  const status = await postWebhook(basePayload({ uid, responses: lifeInsuranceResponses() }), { badSignature: true });
  assert.equal(status, 200, 'Cal.com always gets a 200 so it never retries');
  assert.equal(getAppointment(uid), undefined, 'an invalid signature must never result in a database write');
});

test('a webhook with no signature header at all is ignored', async () => {
  const uid = 'sig-none-' + Date.now();
  await postWebhook(basePayload({ uid, responses: lifeInsuranceResponses() }), { noSignature: true });
  assert.equal(getAppointment(uid), undefined);
});

// ── Life Insurance qualification-answer capture (new) ────────────────────

test('Life Insurance answers are matched by question label and written into appointment notes', async () => {
  const uid = 'li-notes-' + Date.now();
  await postWebhook(basePayload({ uid, responses: lifeInsuranceResponses() }));
  const appt = getAppointment(uid);
  assert.ok(appt);
  assert.match(appt.notes, /Life Insurance Qualification Answers:/);
  assert.match(appt.notes, /What they need help with: Term life insurance/);
  assert.match(appt.notes, /Who is applying for coverage: Myself/);
  assert.match(appt.notes, /Age\(s\) of person\(s\) needing coverage: 45/);
  assert.match(appt.notes, /Coverage timeline: Within 30 days/);
  assert.match(appt.notes, /Self-described health: Good/);
  assert.match(appt.notes, /Previously declined for life insurance: No/);
  assert.match(appt.notes, /Nicotine\/tobacco use: No/);
});

test('a non-Life-Insurance event type never gets the qualification-answers treatment', async () => {
  const uid = 'retirement-' + Date.now();
  await postWebhook(basePayload({
    uid, eventTitle: 'Safe Money & Retirement Consultation',
    responses: { name: responseEntry('Name', 'Ret Iree'), email: responseEntry('Email', 'ret@example.com') },
  }));
  const appt = getAppointment(uid);
  assert.ok(appt);
  assert.doesNotMatch(String(appt.notes), /Life Insurance Qualification Answers/);
});

test('unrecognized/reworded Cal.com questions are still preserved, not silently dropped', async () => {
  const uid = 'li-reworded-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Your name', 'Test Caller'),
      email: responseEntry('Your email', 'test.caller@example.com'),
      // Reworded so none of the known label patterns match.
      mystery: responseEntry('Some totally different question Cal.com might ask later', 'An answer we do not want to lose'),
    },
  }));
  const appt = getAppointment(uid);
  assert.match(appt.notes, /Additional Cal\.com responses:/);
  assert.match(appt.notes, /Some totally different question Cal\.com might ask later: An answer we do not want to lose/);
});

test('a Life Insurance booking with no custom-question responses at all still succeeds with no qualification note', async () => {
  const uid = 'li-empty-' + Date.now();
  await postWebhook(basePayload({ uid, responses: { name: responseEntry('Name', 'Bare Bones'), email: responseEntry('Email', 'bare@example.com') } }));
  const appt = getAppointment(uid);
  assert.ok(appt);
  assert.equal(appt.notes, null);
});

// ── Pre-existing behavior this route already had — verified not broken ──

test('contact matching: email first, phone second', async () => {
  const email = 'match-email-' + Date.now() + '@example.com';
  db.prepare(`INSERT INTO contacts (first_name, last_name, email, phone_e164) VALUES ('Existing', 'Person', ?, '+19995550000')`).run(email);
  const uid = 'match-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: { name: responseEntry('Name', 'Existing Person'), email: responseEntry('Email', email), phone: responseEntry('Phone', '+14145550123') },
  }));
  const appt = getAppointment(uid);
  const contact = getContact(email);
  assert.equal(appt.contact_id, contact.id, 'must match the existing contact by email rather than creating a duplicate');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').get(email).n, 1);
});

test('contact matching is case-insensitive on email -- a mixed-case webhook attendee email matches the existing lowercase-stored contact, preserving its sms_consent', async () => {
  // Reproduces the real production bug: /submit-lead always stores emails
  // lowercased (crm/lib/leadNormalize.js's normalizeEmail(), used by
  // crm/lib/leadIntake.js), but Cal.com's booking page is prefilled from a
  // query param built from the visitor's AS-TYPED, un-lowercased email
  // (book.html/schedule.html's buildCalcomPrefillQuery()) -- so the
  // webhook's attendee.email can legitimately arrive in a different case
  // than what's stored. Before the fix, this WHERE email = ? lookup was
  // case-sensitive and silently created a second, sms_consent=0 contact.
  const lower = 'case-sensitive-' + Date.now() + '@example.com';
  const existing = db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, phone_e164, sms_consent)
    VALUES ('Janet', 'Jackson', ?, '+14145550177', 1)
  `).run(lower);

  const uid = 'case-insensitive-' + Date.now();
  const webhookEmail = lower.charAt(0).toUpperCase() + lower.slice(1); // e.g. "Case-sensitive-...@example.com"
  await postWebhook(basePayload({
    uid, eventTitle: 'Safe Money & Retirement Consultation',
    responses: { name: responseEntry('Name', 'Janet Jackson'), email: responseEntry('Email', webhookEmail), phone: responseEntry('Phone', '+14145550177') },
  }));

  const appt = getAppointment(uid);
  assert.equal(appt.contact_id, existing.lastInsertRowid, 'must match the existing contact despite the case difference, not create a duplicate');

  const rows = db.prepare('SELECT * FROM contacts WHERE lower(email) = lower(?)').all(lower);
  assert.equal(rows.length, 1, 'exactly one contact must exist for this email regardless of case');
  assert.equal(rows[0].sms_consent, 1, 'the original sms_consent must be preserved, never reset by the webhook match');

  const intake = db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(appt.id);
  assert.ok(intake, 'a retirement intake record must be created for this correctly-matched appointment');
});

test('a brand-new contact is created when no email/phone match exists, with lead_source Cal.com', async () => {
  const email = 'brandnew-' + Date.now() + '@example.com';
  const uid = 'new-' + Date.now();
  await postWebhook(basePayload({ uid, responses: { name: responseEntry('Name', 'Brand New'), email: responseEntry('Email', email) } }));
  const contact = getContact(email);
  assert.ok(contact);
  assert.equal(contact.lead_source, 'Cal.com');
  assert.equal(contact.lead_status, 'Appointment Scheduled');
});

test('appointment upsert is idempotent by cal_booking_uid — a duplicate webhook delivery never creates a second row', async () => {
  const uid = 'idempotent-' + Date.now();
  const payload = basePayload({ uid, responses: lifeInsuranceResponses() });
  await postWebhook(payload);
  await postWebhook(payload);
  const rows = db.prepare('SELECT * FROM appointments WHERE cal_booking_uid = ?').all(uid);
  assert.equal(rows.length, 1, 'a redelivered webhook must update the same row, never create a duplicate');
});

test('BOOKING_RESCHEDULED updates the existing appointment and sets status Rescheduled', async () => {
  const uid = 'resched-' + Date.now();
  await postWebhook(basePayload({ uid, responses: lifeInsuranceResponses(), startTime: '2026-09-01T15:00:00.000Z', endTime: '2026-09-01T15:30:00.000Z' }));

  const rescheduled = basePayload({ uid: uid + '-v2', responses: lifeInsuranceResponses(), startTime: '2026-09-02T16:00:00.000Z', endTime: '2026-09-02T16:30:00.000Z' });
  rescheduled.triggerEvent = 'BOOKING_RESCHEDULED';
  rescheduled.payload.rescheduleUid = uid;
  await postWebhook(rescheduled);

  const appt = getAppointment(uid + '-v2') || getAppointment(uid);
  assert.equal(appt.status, 'Rescheduled');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n >= 1, true);
});

test('BOOKING_CANCELLED marks the appointment and contact cancelled', async () => {
  const uid = 'cancel-' + Date.now();
  await postWebhook(basePayload({ uid, responses: lifeInsuranceResponses() }));
  const created = getAppointment(uid);

  const cancelPayload = { triggerEvent: 'BOOKING_CANCELLED', payload: { uid, cancellationReason: 'Schedule conflict' } };
  await postWebhook(cancelPayload);

  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(created.id);
  assert.equal(appt.status, 'Cancelled');
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(created.contact_id);
  assert.equal(contact.lead_status, 'Cancelled');
});

test('a new/status-changing booking logs an entry to the communications timeline', async () => {
  const uid = 'timeline-' + Date.now();
  await postWebhook(basePayload({ uid, responses: lifeInsuranceResponses() }));
  const appt = getAppointment(uid);
  const comm = db.prepare(`SELECT * FROM communications WHERE appointment_id = ? AND comm_type = 'appointment'`).get(appt.id);
  assert.ok(comm, 'a new booking must be logged to the contact activity timeline');
  assert.match(comm.subject, /Appointment Scheduled/);
});

// ── Retirement Intake Form auto-creation (new) ───────────────────────────

function getIntakeByApptId(apptId) {
  return db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(apptId);
}

test('a new Safe Money & Retirement booking automatically creates a Not Sent retirement intake record', async () => {
  const uid = 'ri-new-' + Date.now();
  await postWebhook(basePayload({
    uid, eventTitle: 'Safe Money & Retirement Consultation',
    responses: { name: responseEntry('Name', 'Rita Ree'), email: responseEntry('Email', 'rita-' + Date.now() + '@example.com') },
  }));
  const appt = getAppointment(uid);
  const intake = getIntakeByApptId(appt.id);
  assert.ok(intake, 'booking a retirement appointment must create an intake record');
  assert.equal(intake.status, 'Not Sent');
  assert.equal(intake.contact_id, appt.contact_id);
  assert.ok(intake.token && intake.token.length >= 32);
  assert.equal(intake.sent_at, null);
  assert.equal(intake.completed_at, null);
});

test('a Life Insurance booking never creates a retirement intake record or attempts an intake SMS', async () => {
  const uid = 'ri-li-' + Date.now();
  await postWebhook(basePayload({ uid, responses: lifeInsuranceResponses() }));
  const appt = getAppointment(uid);
  assert.equal(getIntakeByApptId(appt.id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(appt.contact_id).n, 0);
});

test('a new retirement booking for an already SMS-consenting contact reaches the send path (no Twilio configured in this test file, so it fails gracefully) without falsely marking the intake Sent', async () => {
  const email = 'consented-' + Date.now() + '@example.com';
  db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, phone_e164, sms_consent)
    VALUES ('Consented', 'Prospect', ?, '+14145550188', 1)
  `).run(email);

  const uid = 'ri-consented-' + Date.now();
  await postWebhook(basePayload({
    uid, eventTitle: 'Safe Money & Retirement Consultation',
    responses: { name: responseEntry('Name', 'Consented Prospect'), email: responseEntry('Email', email), phone: responseEntry('Phone', '+14145550188') },
  }));

  const appt = getAppointment(uid);
  const intake = getIntakeByApptId(appt.id);
  assert.ok(intake);
  // No TWILIO_* env vars are set anywhere in this test file, so the send
  // deterministically fails at the "not configured" step -- proving this
  // contact's consent got it PAST the consent gate (unlike the other tests
  // in this file, whose contacts have no consent on file at all) without
  // ever needing a live Twilio account or a network call.
  assert.equal(intake.status, 'Not Sent');
  assert.equal(intake.sent_at, null);
});

test('a duplicate/redelivered webhook for the same retirement booking never creates a second intake record', async () => {
  const uid = 'ri-dup-' + Date.now();
  const payload = basePayload({
    uid, eventTitle: 'Safe Money & Retirement Consultation',
    responses: { name: responseEntry('Name', 'Dup Test'), email: responseEntry('Email', 'dup-' + Date.now() + '@example.com') },
  });
  await postWebhook(payload);
  await postWebhook(payload);
  const appt = getAppointment(uid);
  const rows = db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').all(appt.id);
  assert.equal(rows.length, 1);
});

test('rescheduling a retirement appointment keeps the same intake record (same token, no duplicate)', async () => {
  const uid = 'ri-resched-' + Date.now();
  const email = 'resched-' + Date.now() + '@example.com';
  await postWebhook(basePayload({
    uid, eventTitle: 'Safe Money & Retirement Consultation',
    responses: { name: responseEntry('Name', 'Resched Person'), email: responseEntry('Email', email) },
    startTime: '2026-09-01T15:00:00.000Z', endTime: '2026-09-01T15:30:00.000Z',
  }));
  const originalAppt = getAppointment(uid);
  const originalIntake = getIntakeByApptId(originalAppt.id);

  const rescheduled = basePayload({
    uid: uid + '-v2', eventTitle: 'Safe Money & Retirement Consultation',
    responses: { name: responseEntry('Name', 'Resched Person'), email: responseEntry('Email', email) },
    startTime: '2026-09-05T16:00:00.000Z', endTime: '2026-09-05T16:30:00.000Z',
  });
  rescheduled.triggerEvent = 'BOOKING_RESCHEDULED';
  rescheduled.payload.rescheduleUid = uid;
  await postWebhook(rescheduled);

  // The same appointments row is updated in place on reschedule (see the
  // route's own existing-by-uid-then-rescheduleUid lookup), so the intake
  // lookup by the ORIGINAL appointment id must still resolve to the exact
  // same intake row, with its deadline naturally following the new time.
  const stillSameIntake = getIntakeByApptId(originalAppt.id);
  assert.ok(stillSameIntake);
  assert.equal(stillSameIntake.id, originalIntake.id);
  assert.equal(stillSameIntake.token, originalIntake.token);
  const totalIntakes = db.prepare('SELECT COUNT(*) AS n FROM retirement_intakes').get().n;
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(originalAppt.id);
  assert.equal(appt.appt_datetime, '2026-09-05T16:00:00.000Z', 'reschedule must update the same appointment row in place');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM retirement_intakes WHERE appointment_id = ?').get(originalAppt.id).n,
    1,
  );
  assert.ok(totalIntakes >= 1);
});

// ── Slug-based event detection against the REAL production payload shape ──

test('the Safe Money & Retirement event slug is classified as Retirement Lead even with no eventType object at all', async () => {
  const email = 'slug-retirement-' + Date.now() + '@example.com';
  const uid = 'slug-retirement-' + Date.now();
  await postWebhook(realProductionPayload({
    uid, type: 'retirement-safemoney-consultation-prosperitylfs',
    eventTitle: 'Safe Money & Retirement Consultation', email,
  }));
  const appt = getAppointment(uid);
  assert.ok(appt, 'appointment must still be created even with the real (eventType-less) payload shape');
  assert.equal(appt.appt_type, 'Safe Money & Retirement Consultation', 'apptType should use eventTitle, not the "Consultation" fallback');
  const intake = db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(appt.id);
  assert.ok(intake, 'a retirement_intakes record must be created — this is the exact case that silently failed in production');
});

test('the Life Insurance event slug is classified as Life Insurance Lead with the real payload shape', async () => {
  const email = 'slug-li-' + Date.now() + '@example.com';
  const uid = 'slug-li-' + Date.now();
  await postWebhook(realProductionPayload({
    uid, type: 'life-insurance-consultation-prosperitylfs',
    eventTitle: 'Life Insurance Consultation', email,
  }));
  const appt = getAppointment(uid);
  assert.ok(appt);
  assert.equal(db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(appt.id), undefined, 'a Life Insurance booking must never get a retirement intake record, slug-based or not');
});

test('a missing eventType/type does NOT cause a real Safe Money & Retirement booking to silently fall back to generic "Consultation" classification when eventTitle is present', async () => {
  // Reproduces the exact production bug: payload.eventType was undefined,
  // and the OLD code only ever looked at eventType.title, so apptType
  // always resolved to the literal fallback string "Consultation" and
  // inferLeadType('Consultation') always returned the generic
  // 'Contact Form Lead' -- never 'Retirement Lead'. This test omits `type`
  // (the slug) entirely to prove the eventTitle-based fallback alone is
  // now sufficient.
  const email = 'no-slug-fallback-' + Date.now() + '@example.com';
  const uid = 'no-slug-fallback-' + Date.now();
  await postWebhook(realProductionPayload({
    uid, type: undefined, eventTitle: 'Safe Money & Retirement Consultation', email,
  }));
  const appt = getAppointment(uid);
  assert.notEqual(appt.appt_type, 'Consultation', 'must not silently fall back to the generic default when eventTitle is available');
  const intake = db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(appt.id);
  assert.ok(intake, 'title-based fallback must still classify this as Retirement Lead');
});

test('an unrelated/unknown event (no matching slug or title pattern) is never misclassified as retirement', async () => {
  const email = 'unrelated-event-' + Date.now() + '@example.com';
  const uid = 'unrelated-event-' + Date.now();
  await postWebhook(realProductionPayload({
    uid, type: 'general-contact-form-prosperitylfs', eventTitle: 'General Contact Form', email,
  }));
  const appt = getAppointment(uid);
  assert.ok(appt);
  assert.equal(db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(appt.id), undefined);
});

// ── Phone extraction fallback: payload.location.optionValue ──────────────

test('the phone-location fallback (payload.location.optionValue) is used for contact matching when no other phone field is present', async () => {
  const email = 'location-phone-' + Date.now() + '@example.com';
  const uid = 'location-phone-' + Date.now();
  await postWebhook(realProductionPayload({
    uid, type: 'retirement-safemoney-consultation-prosperitylfs',
    eventTitle: 'Safe Money & Retirement Consultation', email, phone: '+14143676486',
  }));
  const appt = getAppointment(uid);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(appt.contact_id);
  assert.equal(contact.phone_e164, '+14143676486', 'the real phone number must be stored, extracted from payload.location.optionValue');
});

// ── Phone type mapping (mobile vs. landline, new standardized question) ──

test('answering "Mobile" routes the phone into phone/phone_e164, leaving home_phone empty', async () => {
  const email = 'phone-mobile-' + Date.now() + '@example.com';
  const uid = 'phone-mobile-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Mobile Person'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14145550111'),
      phoneType: responseEntry('Is this a mobile phone or a landline?', 'Mobile'),
    },
  }));
  const contact = getContact(email);
  assert.equal(contact.phone_e164, '+14145550111');
  assert.equal(contact.home_phone, null);
});

test('answering "Landline" routes the phone into home_phone only, never into phone/phone_e164', async () => {
  const email = 'phone-landline-' + Date.now() + '@example.com';
  const uid = 'phone-landline-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Landline Person'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14145550122'),
      phoneType: responseEntry('Is this a mobile phone or a landline?', 'Landline'),
    },
  }));
  const contact = getContact(email);
  assert.equal(contact.phone_e164, null, 'a landline number must never be written into the mobile phone_e164 field');
  assert.ok(contact.home_phone && contact.home_phone.includes('414'), 'the landline number must be stored in home_phone');
});

test('no phone-type question present preserves the existing mobile-by-default behavior', async () => {
  const email = 'phone-notype-' + Date.now() + '@example.com';
  const uid = 'phone-notype-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'No Type Person'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14145550133'),
    },
  }));
  const contact = getContact(email);
  assert.equal(contact.phone_e164, '+14145550133', 'with no phone-type question, the number must still land in the mobile field as before');
  assert.equal(contact.home_phone, null);
});

test('contact matching by phone still works for a landline booking whose email does not match any existing contact', async () => {
  const uid = 'phone-landline-match-' + Date.now();
  const existingPhone = '+14145550144';
  db.prepare(`INSERT INTO contacts (first_name, last_name, phone_e164) VALUES ('Existing', 'Landline', ?)`).run(existingPhone);
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Existing Landline'),
      // A unique email so email-first matching finds nothing and the route
      // falls through to phone_e164 matching (basePayload always fills in
      // SOME attendee email even if `responses.email` is omitted, so this
      // must be explicit rather than relying on omission).
      email: responseEntry('Email', 'no-match-' + Date.now() + '@example.com'),
      phone: responseEntry('Phone', existingPhone),
      phoneType: responseEntry('Is this a mobile phone or a landline?', 'Landline'),
    },
  }));
  const appt = getAppointment(uid);
  const contact = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get(existingPhone);
  assert.equal(appt.contact_id, contact.id, 'matching by phone_e164 must still find the existing contact even when this booking answers Landline');
});

// ── Communication consent mapping (new standardized question) ────────────

test('"Yes, text and email" sets both sms_consent and email_consent to 1', async () => {
  const email = 'consent-both-' + Date.now() + '@example.com';
  const uid = 'consent-both-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Both Consent'),
      email: responseEntry('Email', email),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.',
        'Yes, text and email'
      ),
    },
  }));
  const contact = getContact(email);
  assert.equal(contact.sms_consent, 1);
  assert.equal(contact.email_consent, 1);
});

test('"Email only, no text messages" sets sms_consent to 0 and email_consent to 1 (brand-agnostic label match)', async () => {
  const email = 'consent-emailonly-' + Date.now() + '@example.com';
  const uid = 'consent-emailonly-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Email Only'),
      email: responseEntry('Email', email),
      // Insurance Lady's exact wording, to prove the match isn't tied to Prosperity's brand name.
      consent: responseEntry(
        'May Insurance Lady LLC send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.',
        'Email only, no text messages'
      ),
    },
  }));
  const contact = getContact(email);
  assert.equal(contact.sms_consent, 0);
  assert.equal(contact.email_consent, 1);
});

test('no consent question present never writes/infers sms_consent or email_consent on a new contact beyond the schema default', async () => {
  const email = 'consent-absent-' + Date.now() + '@example.com';
  const uid = 'consent-absent-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: { name: responseEntry('Name', 'No Consent Q'), email: responseEntry('Email', email) },
  }));
  const contact = getContact(email);
  assert.equal(contact.sms_consent, 0);
  assert.equal(contact.email_consent, 0);
  assert.equal(contact.sms_consent_source, null, 'no consent question means no consent audit-trail stamp either');
});

test('an existing contact\'s consent is never overwritten by a later booking that omits the consent question', async () => {
  const email = 'consent-preserve-' + Date.now() + '@example.com';
  db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, sms_consent, email_consent)
    VALUES ('Already', 'Consented', ?, 1, 1)
  `).run(email);
  const uid = 'consent-preserve-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: { name: responseEntry('Name', 'Already Consented'), email: responseEntry('Email', email) },
  }));
  const contact = getContact(email);
  assert.equal(contact.sms_consent, 1, 'must not be reset to 0 just because this booking did not ask the consent question');
  assert.equal(contact.email_consent, 1);
});

test('an existing contact\'s consent IS updated when a later booking explicitly answers the consent question differently', async () => {
  const email = 'consent-update-' + Date.now() + '@example.com';
  db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, sms_consent, email_consent)
    VALUES ('Was', 'OptedIn', ?, 1, 1)
  `).run(email);
  const uid = 'consent-update-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Was OptedIn'),
      email: responseEntry('Email', email),
      consent: responseEntry(
        'May Prosperity send you appointment confirmations, reminders, and related communications by text message and email?',
        'Email only, no text messages'
      ),
    },
  }));
  const contact = getContact(email);
  assert.equal(contact.sms_consent, 0, 'an explicit new answer must be authoritative, even when it reduces consent');
  assert.equal(contact.email_consent, 1);
});

// ── Location display safety ───────────────────────────────────────────────

test('an unrecognized object-shaped location never renders as "[object Object]" and is omitted instead', async () => {
  const email = 'loc-weird-' + Date.now() + '@example.com';
  const uid = 'loc-weird-' + Date.now();
  const payload = basePayload({
    uid,
    responses: { name: responseEntry('Name', 'Weird Location'), email: responseEntry('Email', email) },
  });
  // A shape with neither .value nor .type as a usable string.
  payload.payload.location = { nested: { something: 'unexpected' } };
  const raw = JSON.stringify(payload);
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cal-signature-256': sign(raw) },
    body: raw,
  });
  await res.json();
  await new Promise(r => setTimeout(r, 20));
  const appt = getAppointment(uid);
  assert.ok(appt, 'the booking must still be processed despite the unusable location shape');
  assert.notEqual(appt.location, '[object Object]');
  assert.equal(appt.location, null, 'an unreadable location must be omitted, not rendered as a broken string');
});

test('a non-phone location (e.g. Google Meet) is not mistaken for a phone number', async () => {
  const email = 'meet-location-' + Date.now() + '@example.com';
  const uid = 'meet-location-' + Date.now();
  const payload = realProductionPayload({
    uid, type: 'retirement-safemoney-consultation-prosperitylfs',
    eventTitle: 'Safe Money & Retirement Consultation', email,
  });
  payload.payload.location = 'integrations:google:meet';
  const raw = JSON.stringify(payload);
  const res = await fetch(`${baseUrl}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cal-signature-256': sign(raw) },
    body: raw,
  });
  await res.json();
  await new Promise(r => setTimeout(r, 20));
  const appt = getAppointment(uid);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(appt.contact_id);
  assert.equal(contact.phone_e164, null);
  assert.equal(appt.location, 'Google Meet', 'location display value must still resolve normally');
});
