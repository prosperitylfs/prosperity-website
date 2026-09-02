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
const { runMigrations: runBrandsMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const calcomRouter = require('../routes/calcom');

let server, baseUrl;

before(() => {
  // contact_brands/brands are provisioned by their own separate,
  // idempotent migration (not part of crm/db/database.js's unconditional
  // schema) -- run it here so the new brand-linking behavior in
  // crm/routes/calcom.js (resolveContactBrand) is genuinely exercised by
  // these tests, matching how crm/test/inboundSmsUnified.test.js's own
  // setup already does the same for its brand-aware coverage.
  runBrandsMigrations(db);
  // review_type/candidate_contact_id evidence columns on unresolved_intake
  // are added by this separate migration (not part of migrateBrands.js's
  // own unconditional schema) -- needed here now that this route stages
  // 'contact_conflict' review items (see the "New contact-matching rule"
  // tests below).
  runDashboardMigrations(db);
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

// Superseded: contact matching now cross-checks BOTH email AND phone (see
// the "New contact-matching rule (email + phone)" section below) -- a
// booking whose email matches an existing contact but whose phone
// CONTRADICTS the one on file is no longer silently treated as the same
// person. This case is now covered by that section's own test.

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

// ── New exact consent wording (as of 2026-08-31) ──────────────────────────

test('"Text and email" sets both sms_consent and email_consent to 1', async () => {
  const email = 'consent-new-both-' + Date.now() + '@example.com';
  const uid = 'consent-new-both-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'New Both Consent'),
      email: responseEntry('Email', email),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.',
        'Text and email'
      ),
    },
  }));
  const contact = getContact(email);
  assert.equal(contact.sms_consent, 1);
  assert.equal(contact.email_consent, 1);
});

test('"Text only" sets sms_consent to 1 and email_consent to 0', async () => {
  const email = 'consent-new-textonly-' + Date.now() + '@example.com';
  const uid = 'consent-new-textonly-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'New Text Only'),
      email: responseEntry('Email', email),
      consent: responseEntry(
        'May Insurance Lady LLC send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.',
        'Text only'
      ),
    },
  }));
  const contact = getContact(email);
  assert.equal(contact.sms_consent, 1);
  assert.equal(contact.email_consent, 0);
});

test('"Email only" (new exact wording, no trailing qualifier) sets sms_consent to 0 and email_consent to 1', async () => {
  const email = 'consent-new-emailonly-' + Date.now() + '@example.com';
  const uid = 'consent-new-emailonly-' + Date.now();
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'New Email Only'),
      email: responseEntry('Email', email),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email?',
        'Email only'
      ),
    },
  }));
  const contact = getContact(email);
  assert.equal(contact.sms_consent, 0);
  assert.equal(contact.email_consent, 1);
});

test('legacy wording "Yes, text and email" and "Email only, no text messages" still map correctly alongside the new wording (backward compatibility)', async () => {
  const emailBoth = 'consent-legacy-both-' + Date.now() + '@example.com';
  const uidBoth = 'consent-legacy-both-' + Date.now();
  await postWebhook(basePayload({
    uid: uidBoth,
    responses: {
      name: responseEntry('Name', 'Legacy Both'),
      email: responseEntry('Email', emailBoth),
      consent: responseEntry('May Prosperity send you appointment confirmations by text message and email?', 'Yes, text and email'),
    },
  }));
  const contactBoth = getContact(emailBoth);
  assert.equal(contactBoth.sms_consent, 1);
  assert.equal(contactBoth.email_consent, 1);

  const emailEmailOnly = 'consent-legacy-emailonly-' + Date.now() + '@example.com';
  const uidEmailOnly = 'consent-legacy-emailonly-' + Date.now();
  await postWebhook(basePayload({
    uid: uidEmailOnly,
    responses: {
      name: responseEntry('Name', 'Legacy Email Only'),
      email: responseEntry('Email', emailEmailOnly),
      consent: responseEntry('May Prosperity send you appointment confirmations by text message and email?', 'Email only, no text messages'),
    },
  }));
  const contactEmailOnly = getContact(emailEmailOnly);
  assert.equal(contactEmailOnly.sms_consent, 0);
  assert.equal(contactEmailOnly.email_consent, 1);
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

// ── Real Retell/Cal.com production payload shape (Janet Jackson booking) ──
//
// A real production booking made through Jennifer/Retell's own Cal.com
// integration (not book.html) exposed a bug the simulated tests above never
// caught: Retell's booking puts the attendee's phone directly into
// payload.location as a BARE STRING ("+14143676486"), not the
// {value:'phone', optionValue} object our own book.html prefill uses, and
// not into attendee.phoneNumber or any responses.phone/phoneNumber/cell/
// mobile key either. The old extractLocationPhone() only ever handled the
// object shape (`typeof rawLocation !== 'object'` short-circuited
// immediately for a string), so this real booking's Mobile Phone field
// stayed blank even though the phone number was RIGHT THERE in the
// appointment's own location field, and phone type + consent (which read
// from `responses`, unrelated to location) mapped correctly. This is
// confirmed by the production symptom: the appointment's stored location
// literally displayed as the raw phone number, not "Phone Call".
// Mirrors the real booking's shape exactly (Janet Jackson, phone
// +14143676486 as reported), but each test below supplies its own unique
// email/phone so it can't collide with contacts created by other tests
// sharing this file's in-memory database.
function retellRealBookingPayload({ uid = 'retell-real-' + Date.now(), email, phone, phoneType = 'Mobile', consentAnswer = 'Yes, text and email' }) {
  return {
    triggerEvent: 'BOOKING_CREATED',
    payload: {
      uid,
      startTime: '2026-09-20T19:00:00.000Z',
      endTime: '2026-09-20T19:30:00.000Z',
      type: 'life-insurance-consultation-prosperitylfs',
      eventTitle: 'Life Insurance Consultation',
      attendees: [{ name: 'Janet Jackson', email, timeZone: 'America/Chicago' }],
      responses: {
        name: { label: 'Name', value: 'Janet Jackson' },
        email: { label: 'Email', value: email },
        phoneType: { label: 'Is this a mobile phone or landline?', value: phoneType },
        consent: {
          label: 'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.',
          value: consentAnswer,
        },
      },
      // The actual real-world shape: a bare phone-number string, not an object.
      location: phone,
    },
  };
}

test('REAL Retell/Cal.com payload shape: a bare phone-number-string location maps to Mobile Phone (the exact production bug)', async () => {
  const uid = 'retell-real-mobile-' + Date.now();
  const email = 'retell-mobile-' + Date.now() + '@example.com';
  const phone = '+14145559871';
  await postWebhook(retellRealBookingPayload({ uid, email, phone }));
  const contact = getContact(email);
  assert.ok(contact, 'contact must be created');
  assert.equal(contact.phone_e164, phone, 'the phone from a bare-string location must reach Mobile Phone');
  assert.equal(contact.home_phone, null, 'must not also land in Landline Phone');
  assert.equal(contact.sms_consent, 1, 'consent mapping must keep working alongside the phone fix');
  assert.equal(contact.email_consent, 1);
  const appt = getAppointment(uid);
  assert.equal(appt.location, phone, 'location display is unchanged -- matches the production symptom exactly');
});

test('REAL Retell/Cal.com payload shape: a bare phone-number-string location maps to Landline Phone when answered Landline', async () => {
  const uid = 'retell-real-landline-' + Date.now();
  const email = 'retell-landline-' + Date.now() + '@example.com';
  const phone = '+14145559872';
  await postWebhook(retellRealBookingPayload({ uid, email, phone, phoneType: 'Landline', consentAnswer: 'Email only, no text messages' }));
  const contact = getContact(email);
  assert.equal(contact.phone_e164, null, 'must not land in Mobile Phone');
  assert.equal(contact.home_phone, '(414) 555-9872', 'the phone from a bare-string location must reach Landline Phone');
  assert.equal(contact.sms_consent, 0);
  assert.equal(contact.email_consent, 1);
});

test('a bare location string that is not phone-shaped (e.g. a street address) is never mistaken for a phone number', async () => {
  const uid = 'not-a-phone-location-' + Date.now();
  const email = 'not-a-phone-location-' + Date.now() + '@example.com';
  const payload = retellRealBookingPayload({ uid, email, phone: '+14145559873' });
  payload.payload.location = '5010 W Vliet St';
  await postWebhook(payload);
  const contact = getContact(email);
  assert.equal(contact.phone_e164, null);
  assert.equal(contact.home_phone, null);
});

// ── Activity Timeline / communications.body no longer duplicates the full
//    intake questionnaire (Issue 3: the same info was appearing in
//    Activity Timeline, Appointments, and Activity & Form Submissions) ────

test('the appointment-booked communications entry is concise and does not repeat the full Cal.com intake questionnaire', async () => {
  const uid = 'concise-body-' + Date.now();
  await postWebhook(basePayload({ uid, responses: lifeInsuranceResponses() }));
  const appt = getAppointment(uid);
  // The full intake dump still lives here, canonically, on the appointment itself.
  assert.match(appt.notes, /Life Insurance Qualification Answers:/);

  const comm = db.prepare(`SELECT * FROM communications WHERE appointment_id = ? AND comm_type = 'appointment'`).get(appt.id);
  assert.ok(comm);
  assert.doesNotMatch(comm.body, /Life Insurance Qualification Answers/, 'the timeline/activity entry must not repeat the full intake questionnaire');
  assert.doesNotMatch(comm.body, /Term life insurance/, 'must not repeat individual qualification answers either');
  assert.match(comm.body, /Life Insurance Consultation/, 'must still identify the appointment type');
});

// ── Appointment confirmation SMS (new) ────────────────────────────────────
//
// No TWILIO_* env vars are set anywhere in this test file, so any send
// attempt deterministically fails at the "not configured" step -- exactly
// the same established pattern the pre-existing Retirement Intake SMS tests
// above already rely on (see "reaches the send path...fails gracefully").
// That means sms_messages stays empty regardless of which path ran, so
// these tests capture console.warn to directly prove WHICH code path was
// invoked (proof the new SMS was actually attempted -- got past the
// consent/phone gates and reached Twilio -- vs. proof it was correctly
// skipped for a Retirement Lead booking), rather than relying only on
// absence of a database row, which can't distinguish "correctly skipped"
// from "attempted and blocked" on its own.
// Captures both console.warn (the "not sent" outcome lines) and console.log
// (the "booking brand resolved as ..." line calcom.js logs right before
// attempting the send) into one merged, chronological array -- some tests
// below need to prove WHICH brand was resolved, not just whether a send was
// attempted.
async function captureWarnings(fn) {
  const originalWarn = console.warn;
  const originalLog  = console.log;
  const lines = [];
  console.warn = (...args) => { lines.push(args.join(' ')); };
  console.log  = (...args) => { lines.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = originalWarn;
    console.log  = originalLog;
  }
  return lines;
}

test('a new Life Insurance booking with SMS consent and a mobile phone attempts the appointment confirmation SMS', async () => {
  const uid = 'confirm-sms-attempt-' + Date.now();
  const email = 'confirm-sms-' + Date.now() + '@example.com';
  const warnings = await captureWarnings(() => postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Janet Jackson'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14143676486'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email?',
        'Yes, text and email'
      ),
    },
  })));
  assert.ok(
    warnings.some(l => l.includes('appointment confirmation SMS not sent')),
    'the confirmation-SMS path must have been attempted (and, with no Twilio configured in this test file, reported as not sent) -- proving it reached the send path at all'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n, 0, 'no real Twilio call was made -- nothing configured in this test file');
});

// ── Brand resolution (Insurance Lady vs Prosperity) ──────────────────────
//
// crm/routes/calcom.js resolves the booking's brand from the consent
// question's own label text (see inferBookingBrand's file comment for why
// that's the only reliable, already-present signal) and logs
// "booking brand resolved as <brand>" right before attempting the send --
// captured here via captureWarnings to prove the correct brand was chosen,
// since no sms_messages row is ever written in this Twilio-less test file.

test('a booking whose consent question names Insurance Lady resolves brand=insurance-lady', async () => {
  const uid = 'brand-il-' + Date.now();
  const email = 'brand-il-' + Date.now() + '@example.com';
  const lines = await captureWarnings(() => postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Renee Jones'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+18145550100'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Insurance Lady LLC send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.',
        'Yes, text and email'
      ),
    },
  })));
  assert.ok(lines.some(l => l.includes('booking brand resolved as insurance-lady')));
  assert.ok(!lines.some(l => l.includes('booking brand resolved as prosperity')));
  assert.equal(getAppointment(uid).booking_brand, 'insurance-lady', 'must be persisted onto the appointment row for the reminder scheduler to use later');
});

test('a booking whose consent question names Prosperity resolves brand=prosperity', async () => {
  const uid = 'brand-prosperity-' + Date.now();
  const email = 'brand-prosperity-' + Date.now() + '@example.com';
  const lines = await captureWarnings(() => postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Janet Jackson'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14143676486'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email?',
        'Yes, text and email'
      ),
    },
  })));
  assert.ok(lines.some(l => l.includes('booking brand resolved as prosperity')));
  assert.ok(!lines.some(l => l.includes('booking brand resolved as insurance-lady')));
  assert.equal(getAppointment(uid).booking_brand, 'prosperity');
});

test('booking_brand set on the original booking is preserved across a reschedule, even if the reschedule payload omits the consent question', async () => {
  const uid = 'brand-persist-resched-' + Date.now();
  const email = 'brand-persist-resched-' + Date.now() + '@example.com';
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Brand Persist'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14143678888'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Insurance Lady LLC send you appointment confirmations, reminders, and related communications by text message and email?',
        'Yes, text and email'
      ),
    },
    startTime: '2026-09-01T15:00:00.000Z', endTime: '2026-09-01T15:30:00.000Z',
  }));
  assert.equal(getAppointment(uid).booking_brand, 'insurance-lady');

  // Reschedule payload with NO consent question at all -- would resolve to
  // the 'prosperity' default if re-evaluated, but must not overwrite what
  // was already correctly detected on the original booking.
  const rescheduled = basePayload({
    uid: uid + '-v2',
    responses: {
      name: responseEntry('Name', 'Brand Persist'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14143678888'),
    },
    startTime: '2026-09-05T16:00:00.000Z', endTime: '2026-09-05T16:30:00.000Z',
  });
  rescheduled.triggerEvent = 'BOOKING_RESCHEDULED';
  rescheduled.payload.rescheduleUid = uid;
  await postWebhook(rescheduled);

  const appt = getAppointment(uid + '-v2') || getAppointment(uid);
  assert.equal(appt.booking_brand, 'insurance-lady', 'must still be insurance-lady -- never silently reset to the prosperity default by a reschedule with no consent question');
});

test('a booking with no consent question at all defaults to brand=prosperity (unchanged, pre-existing behavior)', async () => {
  const uid = 'brand-no-consent-' + Date.now();
  const email = 'brand-no-consent-' + Date.now() + '@example.com';
  const lines = await captureWarnings(() => postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'No Consent Person'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14143677777'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
    },
  })));
  assert.ok(lines.some(l => l.includes('booking brand resolved as prosperity')));
});

test('a Retirement Lead booking does NOT also trigger the generic appointment confirmation SMS (no duplicate on top of the intake SMS)', async () => {
  const uid = 'no-duplicate-sms-' + Date.now();
  const email = 'no-duplicate-sms-' + Date.now() + '@example.com';
  const warnings = await captureWarnings(() => postWebhook(basePayload({
    uid, eventTitle: 'Safe Money & Retirement Consultation',
    responses: {
      name: responseEntry('Name', 'Rita Retirement'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14143676999'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email?',
        'Yes, text and email'
      ),
    },
  })));
  assert.ok(
    warnings.some(l => l.includes('retirement intake SMS not sent')),
    'the retirement intake SMS path must still run for a Retirement Lead booking'
  );
  assert.ok(
    !warnings.some(l => l.includes('appointment confirmation SMS not sent')),
    'the generic appointment confirmation SMS must NEVER also be attempted for a Retirement Lead booking -- that would be a duplicate message'
  );
  const appt = getAppointment(uid);
  const intakeCount = db.prepare('SELECT COUNT(*) AS n FROM retirement_intakes WHERE appointment_id = ?').get(appt.id).n;
  assert.equal(intakeCount, 1, 'exactly one intake record, never two, and no separate confirmation attempt alongside it');
});

test('a contact with no SMS consent on this booking never attempts the confirmation SMS at all', async () => {
  const uid = 'no-consent-no-sms-' + Date.now();
  const email = 'no-consent-no-sms-' + Date.now() + '@example.com';
  const warnings = await captureWarnings(() => postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'No Consent Person'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14143677000'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      // No consent question answered at all.
    },
  })));
  // The send IS still attempted (sendAppointmentConfirmationSms has no
  // independent eligibility check of its own -- consent is enforced inside
  // sendLegacySms), so this asserts on the REASON, not on whether the
  // warning appears at all -- proving the consent gate is what stopped it,
  // not that the whole feature silently no-oped.
  assert.ok(
    warnings.some(l => l.includes('appointment confirmation SMS not sent') && l.includes('does not have SMS consent')),
    'must be blocked specifically by the missing-consent gate'
  );
});

test('a duplicate/redelivered webhook for the same new booking never attempts the confirmation SMS twice', async () => {
  const uid = 'no-dup-sms-redelivery-' + Date.now();
  const email = 'no-dup-sms-redelivery-' + Date.now() + '@example.com';
  const payload = basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Redelivered Person'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14143677001'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Prosperity send you appointment confirmations, reminders, and related communications by text message and email?',
        'Yes, text and email'
      ),
    },
  });
  const warnings = await captureWarnings(async () => {
    await postWebhook(payload);
    await postWebhook(payload);
  });
  const attempts = warnings.filter(l => l.includes('appointment confirmation SMS not sent')).length;
  assert.equal(attempts, 1, 'the isNew gate must prevent a second attempt on a redelivered webhook');
});

// ── Reschedule confirmation SMS (new) ─────────────────────────────────────
//
// Root cause of the reported bug: the entire appointment-SMS block was
// gated exclusively on `isNew`. A BOOKING_RESCHEDULED event updates the
// EXISTING appointment row in place (found via the rescheduleUid fallback
// lookup), so isNew is always false for a reschedule -- meaning no SMS code
// path was ever reached for one, regardless of consent/phone/brand. The fix
// adds a third branch keyed on `event === 'BOOKING_RESCHEDULED' &&
// statusChanged` (the SAME signal already used for the Activity Timeline
// entry above), so a redelivered reschedule webhook -- whose second
// delivery finds status already 'Rescheduled' -- never re-sends.

// Each call needs its own unique phone number -- reusing a fixed number
// across tests (e.g. the real +14143676486 from the production bug report)
// risks matching an EARLIER test's contact by phone_e164 when this test's
// own booking has no consent question, silently inheriting that other
// contact's already-set sms_consent instead of exercising a fresh contact.
let reschedulePhoneCounter = 0;
function uniqueTestPhone() {
  reschedulePhoneCounter += 1;
  return '+1414' + String(6000000 + reschedulePhoneCounter).padStart(7, '0');
}

function bookThenReschedule({ uid, phoneType = 'Mobile', consentAnswer = 'Yes, text and email', consentBrandLabel = 'Prosperity', newStartTime = '2026-09-05T20:00:00.000Z', newEndTime = '2026-09-05T20:30:00.000Z' } = {}) {
  const email = uid + '@example.com';
  const phone = uniqueTestPhone();
  const consentLabel = consentBrandLabel === 'Insurance Lady'
    ? 'May Insurance Lady LLC send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.'
    : 'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email?';
  const responses = {
    name: responseEntry('Name', 'Janet Jackson'),
    email: responseEntry('Email', email),
    phone: responseEntry('Phone', phone),
    phoneType: responseEntry('Is this a mobile phone or landline?', phoneType),
    consent: responseEntry(consentLabel, consentAnswer),
  };
  const original = basePayload({ uid, responses, startTime: '2026-09-01T15:00:00.000Z', endTime: '2026-09-01T15:30:00.000Z' });
  const rescheduled = basePayload({ uid: uid + '-v2', responses, startTime: newStartTime, endTime: newEndTime });
  rescheduled.triggerEvent = 'BOOKING_RESCHEDULED';
  rescheduled.payload.rescheduleUid = uid;
  return { email, phone, original, rescheduled };
}

test('a successful reschedule of an Insurance Lady booking attempts a reschedule confirmation SMS using the new date/time', async () => {
  const uid = 'resched-sms-il-' + Date.now();
  const { original, rescheduled } = bookThenReschedule({ uid, consentBrandLabel: 'Insurance Lady', newStartTime: '2026-09-01T20:00:00.000Z', newEndTime: '2026-09-01T20:30:00.000Z' });

  await postWebhook(original);
  const warnings = await captureWarnings(() => postWebhook(rescheduled));

  assert.ok(
    warnings.some(l => l.includes('booking brand resolved as insurance-lady') && l.includes('reschedule')),
    'brand resolution must run for the reschedule path too'
  );
  assert.ok(
    warnings.some(l => l.includes('reschedule confirmation SMS not sent')),
    'the reschedule SMS path must have been attempted (reported not-sent only because no Twilio is configured in this test file)'
  );
  const appt = getAppointment(uid + '-v2') || getAppointment(uid);
  assert.equal(appt.status, 'Rescheduled');
  assert.equal(appt.appt_datetime, '2026-09-01T20:00:00.000Z', 'the reschedule SMS attempt must use the NEW appointment time, which this same appointment row now holds');
});

test('a Prosperity reschedule resolves brand=prosperity for the reschedule SMS', async () => {
  const uid = 'resched-sms-prosperity-' + Date.now();
  const { original, rescheduled } = bookThenReschedule({ uid, consentBrandLabel: 'Prosperity' });

  await postWebhook(original);
  const warnings = await captureWarnings(() => postWebhook(rescheduled));

  assert.ok(warnings.some(l => l.includes('booking brand resolved as prosperity') && l.includes('reschedule')));
  assert.ok(!warnings.some(l => l.includes('booking brand resolved as insurance-lady')));
});

test('a reschedule is not attempted when the contact never had SMS consent', async () => {
  const uid = 'resched-sms-noconsent-' + Date.now();
  const email = uid + '@example.com';
  const responses = {
    name: responseEntry('Name', 'No Consent Person'),
    email: responseEntry('Email', email),
    phone: responseEntry('Phone', uniqueTestPhone()),
    phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
    // No consent question answered on the original booking or the reschedule.
  };
  const original = basePayload({ uid, responses, startTime: '2026-09-01T15:00:00.000Z', endTime: '2026-09-01T15:30:00.000Z' });
  const rescheduled = basePayload({ uid: uid + '-v2', responses, startTime: '2026-09-05T20:00:00.000Z', endTime: '2026-09-05T20:30:00.000Z' });
  rescheduled.triggerEvent = 'BOOKING_RESCHEDULED';
  rescheduled.payload.rescheduleUid = uid;

  await postWebhook(original);
  const warnings = await captureWarnings(() => postWebhook(rescheduled));

  assert.ok(
    warnings.some(l => l.includes('reschedule confirmation SMS not sent') && l.includes('does not have SMS consent')),
    'must be blocked specifically by the missing-consent gate, same as the new-booking path'
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n, 0);
});

test('a redelivered reschedule webhook never attempts the reschedule SMS twice, and never creates a duplicate appointment', async () => {
  const uid = 'resched-sms-redelivery-' + Date.now();
  const { original, rescheduled } = bookThenReschedule({ uid });

  await postWebhook(original);
  const warnings = await captureWarnings(async () => {
    await postWebhook(rescheduled);
    await postWebhook(rescheduled); // redelivered
  });

  const attempts = warnings.filter(l => l.includes('reschedule confirmation SMS not sent')).length;
  assert.equal(attempts, 1, 'statusChanged is false on the second delivery (status is already Rescheduled), so no second attempt is made');

  const totalAppointments = db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE cal_booking_uid IN (?, ?)').get(uid, uid + '-v2').n;
  assert.equal(totalAppointments, 1, 'the reschedule must update the same appointment row in place, never create a duplicate');
});

test('a second reschedule that changes the time again does not re-fire the SMS (status stays Rescheduled -> Rescheduled) -- known, pre-existing limitation shared with the Activity Timeline logging', async () => {
  const uid = 'resched-sms-double-' + Date.now();
  const { original, rescheduled } = bookThenReschedule({ uid });
  await postWebhook(original);
  await postWebhook(rescheduled);

  const rescheduledAgain = basePayload({
    uid: uid + '-v3',
    responses: rescheduled.payload.responses,
    startTime: '2026-09-10T18:00:00.000Z', endTime: '2026-09-10T18:30:00.000Z',
  });
  rescheduledAgain.triggerEvent = 'BOOKING_RESCHEDULED';
  rescheduledAgain.payload.rescheduleUid = uid + '-v2';

  const warnings = await captureWarnings(() => postWebhook(rescheduledAgain));
  assert.ok(
    !warnings.some(l => l.includes('reschedule confirmation SMS not sent')),
    'documented limitation: a second reschedule does not currently re-trigger the SMS, since status does not change (Rescheduled -> Rescheduled)'
  );
  const appt = getAppointment(uid + '-v3') || getAppointment(uid + '-v2') || getAppointment(uid);
  assert.equal(appt.appt_datetime, '2026-09-10T18:00:00.000Z', 'the appointment date/time itself is still updated correctly even though no second SMS fires');
});

// ── contact_brands linking (new) ──────────────────────────────────────────
//
// Reuses the existing contact_brands mechanism (crm/lib/caseMatching.js's
// resolveContactBrand) unchanged -- only WHEN inferBookingBrandStrict finds
// a reliable signal (the consent question explicitly naming a brand).
// Fixes the limitation flagged in the previous round: Cal.com-originated
// contacts previously never got a contact_brands row at all, which meant
// they could never match crm/lib/inboundSmsService.js's
// findActiveProsperityContactByPhone (the strict Prosperity-number
// matching rule the RESCHEDULE workflow depends on for that number).

function getContactBrandLinks(contactId) {
  return db.prepare(`
    SELECT cb.*, b.slug AS brand_slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id
    WHERE cb.contact_id = ?
  `).all(contactId);
}

test('an Insurance Lady Cal.com booking links the contact to Insurance Lady in contact_brands', async () => {
  const uid = 'brandlink-il-' + Date.now();
  const email = 'brandlink-il-' + Date.now() + '@example.com';
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Renee Jones'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14145559301'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Insurance Lady LLC send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.',
        'Yes, text and email'
      ),
    },
  }));
  const contact = getContact(email);
  const links = getContactBrandLinks(contact.id);
  assert.equal(links.length, 1);
  assert.equal(links[0].brand_slug, 'insurance-lady');
  assert.equal(links[0].status, 'Active');
});

test('a Prosperity Cal.com booking links the contact to Prosperity in contact_brands', async () => {
  const uid = 'brandlink-prosperity-' + Date.now();
  const email = 'brandlink-prosperity-' + Date.now() + '@example.com';
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Janet Jackson'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14145559302'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email?',
        'Yes, text and email'
      ),
    },
  }));
  const contact = getContact(email);
  const links = getContactBrandLinks(contact.id);
  assert.equal(links.length, 1);
  assert.equal(links[0].brand_slug, 'prosperity');
});

test('an existing valid brand link is not removed or overwritten by a later booking for a different brand -- a contact may retain multiple links', async () => {
  const uid1 = 'brandlink-multi-1-' + Date.now();
  const uid2 = 'brandlink-multi-2-' + Date.now();
  const email = 'brandlink-multi-' + Date.now() + '@example.com';
  const phone = '+14145559303';

  await postWebhook(basePayload({
    uid: uid1,
    responses: {
      name: responseEntry('Name', 'Multi Brand'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', phone),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Insurance Lady LLC send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.',
        'Yes, text and email'
      ),
    },
  }));
  const contact = getContact(email);
  assert.equal(getContactBrandLinks(contact.id).length, 1);

  // A second, later booking for the SAME contact (matched by email),
  // reliably identified as Prosperity this time.
  await postWebhook(basePayload({
    uid: uid2,
    responses: {
      name: responseEntry('Name', 'Multi Brand'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', phone),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email?',
        'Yes, text and email'
      ),
    },
  }));

  const links = getContactBrandLinks(contact.id);
  assert.equal(links.length, 2, 'both brand relationships must coexist');
  const slugs = links.map(l => l.brand_slug).sort();
  assert.deepEqual(slugs, ['insurance-lady', 'prosperity']);
  assert.ok(links.every(l => l.status === 'Active'), 'the original link must not be deactivated by the second booking');
});

test('a booking with no consent question (unknown/unreliable brand) creates no guessed contact_brands relationship', async () => {
  const uid = 'brandlink-unknown-' + Date.now();
  const email = 'brandlink-unknown-' + Date.now() + '@example.com';
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'No Signal'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', '+14145559304'),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      // No consent question at all -- inferBookingBrand would default to
      // 'prosperity' for SMS purposes, but that must NOT be guessed here.
    },
  }));
  const contact = getContact(email);
  assert.equal(getContactBrandLinks(contact.id).length, 0, 'must not silently link to Prosperity just because that is the SMS-wording default');
});

// ── End-to-end: a Cal.com-created contact can now be matched for RESCHEDULE ──
//
// The actual scenario the previous round's limitation blocked: a Cal.com
// booking creates a contact with no contact_brands row, so a later
// RESCHEDULE reply to the Prosperity number was staged for review instead
// of triggering the automated workflow. Confirms that's fixed, using the
// SAME shared `db` this whole file already operates against.

test('a Cal.com-created Prosperity contact can subsequently text RESCHEDULE to the Prosperity number and get the automated reply', async () => {
  const { handleInboundSmsUnified } = require('../lib/inboundSmsService');
  const { BRANDS } = require('../config/brands');

  const uid = 'e2e-prosperity-reschedule-' + Date.now();
  const email = 'e2e-prosperity-reschedule-' + Date.now() + '@example.com';
  const phone = '+14145559305';
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Janet Jackson'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', phone),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email?',
        'Yes, text and email'
      ),
    },
    startTime: '2026-09-20T18:00:00.000Z', endTime: '2026-09-20T18:30:00.000Z',
  }));
  const contact = getContact(email);
  assert.equal(getContactBrandLinks(contact.id)[0].brand_slug, 'prosperity');

  const OK_DEPS = { sendLegacySms: async (db2, { contactId, body, fromNumber, appointmentId, messageType }) => {
    const twilioSid = 'SMfake-' + Math.random().toString(36).slice(2);
    const ins = db2.prepare(`
      INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid, appointment_id, message_type)
      VALUES (?, 'outbound', ?, ?, ?, 'sent', ?, ?, ?)
    `).run(contactId, fromNumber, phone, body, twilioSid, appointmentId, messageType);
    return { ok: true, sms: db2.prepare('SELECT * FROM sms_messages WHERE id = ?').get(ins.lastInsertRowid) };
  }};

  const result = handleInboundSmsUnified(db, {
    From: phone, To: BRANDS.prosperity.phone.e164, Body: 'RESCHEDULE', MessageSid: 'SM_e2e_prosperity_1',
  }, OK_DEPS);

  assert.equal(result.outcome, 'processed', 'must be matched and processed now, not staged for review');
  assert.equal(result.rescheduleRequested, true);
  const sendOutcome = await result.rescheduleRequestPromise;
  assert.equal(sendOutcome.sent, true);
  const row = db.prepare(`SELECT * FROM sms_messages WHERE contact_id = ? AND direction = 'outbound'`).get(contact.id);
  assert.match(row.body, /Absolutely\. What day and time/);
});

test('a Cal.com-created Insurance Lady contact can subsequently text RESCHEDULE to the Insurance Lady number and get the automated reply', async () => {
  const { handleInboundSmsUnified } = require('../lib/inboundSmsService');
  const { BRANDS } = require('../config/brands');

  const uid = 'e2e-il-reschedule-' + Date.now();
  const email = 'e2e-il-reschedule-' + Date.now() + '@example.com';
  const phone = '+14145559306';
  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Renee Jones'),
      email: responseEntry('Email', email),
      phone: responseEntry('Phone', phone),
      phoneType: responseEntry('Is this a mobile phone or landline?', 'Mobile'),
      consent: responseEntry(
        'May Insurance Lady LLC send you appointment confirmations, reminders, and related communications by text message and email? Message and data rates may apply.',
        'Yes, text and email'
      ),
    },
    startTime: '2026-09-21T18:00:00.000Z', endTime: '2026-09-21T18:30:00.000Z',
  }));
  const contact = getContact(email);
  assert.equal(getContactBrandLinks(contact.id)[0].brand_slug, 'insurance-lady');

  const OK_DEPS = { sendLegacySms: async (db2, { contactId, body, fromNumber, appointmentId, messageType }) => {
    const twilioSid = 'SMfake-' + Math.random().toString(36).slice(2);
    const ins = db2.prepare(`
      INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid, appointment_id, message_type)
      VALUES (?, 'outbound', ?, ?, ?, 'sent', ?, ?, ?)
    `).run(contactId, fromNumber, phone, body, twilioSid, appointmentId, messageType);
    return { ok: true, sms: db2.prepare('SELECT * FROM sms_messages WHERE id = ?').get(ins.lastInsertRowid) };
  }};

  // Insurance Lady's number is not the Prosperity number, so this flows
  // through handleLegacyOnlyInboundSms's broad phone match -- the
  // contact_brands link isn't strictly required for THIS case to work
  // (findContactByPhoneAnyBrand already matches on phone alone), but the
  // link is still confirmed above and is what enables the Prosperity-
  // number case in the previous test.
  const result = handleInboundSmsUnified(db, {
    From: phone, To: BRANDS['insurance-lady'].phone.e164, Body: 'Reschedule', MessageSid: 'SM_e2e_il_1',
  }, OK_DEPS);

  assert.equal(result.outcome, 'processed');
  assert.equal(result.rescheduleRequested, true);
  const sendOutcome = await result.rescheduleRequestPromise;
  assert.equal(sendOutcome.sent, true);
  const row = db.prepare(`SELECT * FROM sms_messages WHERE contact_id = ? AND direction = 'outbound'`).get(contact.id);
  assert.equal(row.from_number, BRANDS['insurance-lady'].phone.e164);
});

// ── New contact-matching rule (email + phone) ───────────────────────────────
//
// A Cal.com booking is only ever treated as an EXISTING contact when
// neither identifier it actually supplied contradicts what's already on
// file for the matched contact (crm/routes/calcom.js's
// matchContactForBooking). An identifier that contradicts the existing
// record -- not merely absent, an actual different value -- means a
// genuinely NEW contact is created from the incoming booking's own data,
// and the mismatch is staged as a 'contact_conflict' Review Required item
// (crm/public/app/review.html) for manual verification. Nothing is ever
// silently merged, and the existing contact's phone/email are never
// overwritten by a possible match.

function getPendingContactConflicts() {
  return db.prepare(`
    SELECT * FROM unresolved_intake WHERE review_type = 'contact_conflict' AND status = 'Pending' ORDER BY id DESC
  `).all();
}

test('1. same email + same phone: matches the existing contact normally, no conflict staged', async () => {
  const email = 'match-both-' + Date.now() + '@example.com';
  const phone = '+14145551001';
  const existing = db.prepare(`INSERT INTO contacts (first_name, last_name, email, phone_e164) VALUES ('Renee', 'Jones', ?, ?)`).run(email, phone);
  const uid = 'match-both-' + Date.now();
  const before = getPendingContactConflicts().length;

  await postWebhook(basePayload({
    uid,
    responses: { name: responseEntry('Name', 'Renee Jones'), email: responseEntry('Email', email), phone: responseEntry('Phone', phone) },
  }));

  const appt = getAppointment(uid);
  assert.equal(appt.contact_id, existing.lastInsertRowid, 'must attach the appointment to the existing contact');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').get(email).n, 1, 'no duplicate contact created');
  assert.equal(getPendingContactConflicts().length, before, 'no possible-match review item staged for a clean match');
});

test('2. same email + different phone: possible-match flagged, no silent merge, existing contact untouched', async () => {
  const email = 'match-email-only-' + Date.now() + '@example.com';
  const oldPhone = '+14145552001';
  const newPhone = '+14145552002';
  const existing = db.prepare(`INSERT INTO contacts (first_name, last_name, email, phone, phone_e164) VALUES ('Renee', 'Jones', ?, ?, ?)`).run(email, oldPhone, oldPhone);
  const uid = 'match-email-only-' + Date.now();

  await postWebhook(basePayload({
    uid,
    responses: { name: responseEntry('Name', 'Renee Jones'), email: responseEntry('Email', email), phone: responseEntry('Phone', newPhone) },
  }));

  // The existing contact must be completely untouched.
  const existingAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.lastInsertRowid);
  assert.equal(existingAfter.phone_e164, oldPhone, 'the existing contact\'s phone must never be overwritten by a possible match');
  assert.equal(existingAfter.email, email);

  // The appointment must attach to a genuinely NEW, separate contact --
  // never silently merged into the existing one.
  const appt = getAppointment(uid);
  assert.notEqual(appt.contact_id, existing.lastInsertRowid, 'must not silently merge into the existing contact');
  const newContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(appt.contact_id);
  assert.equal(newContact.phone_e164, newPhone, 'the new contact keeps the incoming booking\'s own phone');

  // A review item must be staged with both records preserved.
  const [intake] = getPendingContactConflicts();
  assert.ok(intake, 'a contact_conflict review item must be staged');
  assert.equal(intake.candidate_contact_id, existing.lastInsertRowid);
  assert.match(intake.reason, /email matches, but phone number is different/i);
  const payload = JSON.parse(intake.raw_payload);
  assert.equal(payload.conflict_type, 'email_match_phone_diff');
  assert.equal(payload.existing.phone, oldPhone);
  // incoming.phone is the DISPLAY-formatted number (crm/routes/calcom.js's
  // normalizePhone), same convention as every other contact.phone value in
  // this CRM -- not the E.164 form.
  assert.equal(payload.incoming.phone, '(414) 555-2002');
  assert.equal(payload.incoming.email, email, 'the incoming email is preserved in the review item even though it was left off the new contact row (email is UNIQUE)');
  assert.equal(payload.new_contact_id, newContact.id);
});

test('3. same phone + different email: possible-match flagged, no silent merge, existing contact untouched', async () => {
  const oldEmail = 'match-phone-old-' + Date.now() + '@example.com';
  const newEmail = 'match-phone-new-' + Date.now() + '@example.com';
  const phone = '+14145553001';
  const existing = db.prepare(`INSERT INTO contacts (first_name, last_name, email, phone_e164) VALUES ('Renee', 'Jones', ?, ?)`).run(oldEmail, phone);
  const uid = 'match-phone-only-' + Date.now();

  await postWebhook(basePayload({
    uid,
    responses: { name: responseEntry('Name', 'Renee Jones'), email: responseEntry('Email', newEmail), phone: responseEntry('Phone', phone) },
  }));

  const existingAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.lastInsertRowid);
  assert.equal(existingAfter.email, oldEmail, 'the existing contact\'s email must never be overwritten by a possible match');

  const appt = getAppointment(uid);
  assert.notEqual(appt.contact_id, existing.lastInsertRowid);
  const newContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(appt.contact_id);
  assert.equal(newContact.email, newEmail);

  const [intake] = getPendingContactConflicts();
  assert.ok(intake);
  assert.match(intake.reason, /phone number matches, but email address is different/i);
  const payload = JSON.parse(intake.raw_payload);
  assert.equal(payload.conflict_type, 'phone_match_email_diff');
  assert.equal(payload.existing.email, oldEmail);
  assert.equal(payload.incoming.email, newEmail);
});

test('4. neither email nor phone matches: a new contact is created normally, no conflict staged', async () => {
  const email = 'match-neither-' + Date.now() + '@example.com';
  const phone = '+14145554001';
  const uid = 'match-neither-' + Date.now();
  const before = getPendingContactConflicts().length;

  await postWebhook(basePayload({
    uid,
    responses: { name: responseEntry('Name', 'Brand New'), email: responseEntry('Email', email), phone: responseEntry('Phone', phone) },
  }));

  const appt = getAppointment(uid);
  const contact = getContact(email);
  assert.ok(contact, 'a new contact must be created');
  assert.equal(appt.contact_id, contact.id);
  assert.equal(getPendingContactConflicts().length, before, 'no possible-match review item for a genuinely new contact');
});

test('5. different name + only email matching: flagged with name_mismatch for a more prominent warning', async () => {
  const email = 'match-namecheck-' + Date.now() + '@example.com';
  const oldPhone = '+14145555001';
  const newPhone = '+14145555002';
  const existing = db.prepare(`INSERT INTO contacts (first_name, last_name, email, phone_e164) VALUES ('Renee', 'Jones', ?, ?)`).run(email, oldPhone);
  const uid = 'match-namecheck-' + Date.now();

  await postWebhook(basePayload({
    uid,
    responses: { name: responseEntry('Name', 'Test Caller'), email: responseEntry('Email', email), phone: responseEntry('Phone', newPhone) },
  }));

  const [intake] = getPendingContactConflicts();
  assert.ok(intake);
  assert.equal(intake.candidate_contact_id, existing.lastInsertRowid);
  const payload = JSON.parse(intake.raw_payload);
  assert.equal(payload.name_mismatch, true, 'Renee Jones vs Test Caller must be flagged as a name mismatch, never assumed to be the same person just because the email matches');
  assert.equal(payload.existing.first_name, 'Renee');
  assert.equal(payload.incoming.first_name, 'Test');
});

test('6. existing contact has an old phone on file; a new Cal.com booking with a different phone sends the immediate confirmation to the NEW booking\'s phone, not the old stored one', async () => {
  const email = 'match-smsphone-' + Date.now() + '@example.com';
  const oldPhone = '+14145556001';
  const newPhone = '+14145556002';
  const existing = db.prepare(`INSERT INTO contacts (first_name, last_name, email, phone_e164) VALUES ('Renee', 'Jones', ?, ?)`).run(email, oldPhone);
  const uid = 'match-smsphone-' + Date.now();

  await postWebhook(basePayload({
    uid,
    responses: {
      name: responseEntry('Name', 'Renee Jones'), email: responseEntry('Email', email), phone: responseEntry('Phone', newPhone),
      consent: responseEntry(
        'May Prosperity Life & Financial Solutions send you appointment confirmations, reminders, and related communications by text message and email?',
        'Yes, text and email'
      ),
    },
  }));

  const appt = getAppointment(uid);
  const newContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(appt.contact_id);
  // sendAppointmentConfirmationSms (crm/lib/appointmentConfirmationSms.js)
  // resolves the SMS recipient from the appointment's OWN contact_id --
  // this new contact carries the NEW booking's phone and consent, so the
  // confirmation goes there, never to the old stored number.
  assert.notEqual(appt.contact_id, existing.lastInsertRowid);
  assert.equal(newContact.phone_e164, newPhone, 'the confirmation-eligible contact must carry the NEW booking\'s phone number');
  assert.equal(newContact.sms_consent, 1, 'the NEW booking\'s own consent answer must be preserved on the new contact');
  const oldContactAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.lastInsertRowid);
  assert.equal(oldContactAfter.phone_e164, oldPhone, 'the old contact\'s stored phone must never be substituted in or overwritten');
});

test('an unrelated contact sharing the incoming phone number (e.g. a household) never turns a clean email match into a false conflict', async () => {
  // Phone numbers are not unique in this schema (a household can share
  // one) -- once email has already identified exactly one contact, a
  // DIFFERENT contact happening to have the same phone on file must never
  // be treated as a contradiction. Only whether the EMAIL-matched contact's
  // OWN phone disagrees matters.
  const email = 'shared-phone-email-' + Date.now() + '@example.com';
  const sharedPhone = '+14145557001';
  db.prepare(`INSERT INTO contacts (first_name, last_name, phone_e164) VALUES ('Household', 'Member', ?)`).run(sharedPhone);
  const existing = db.prepare(`INSERT INTO contacts (first_name, last_name, email) VALUES ('Renee', 'Jones', ?)`).run(email);
  const uid = 'match-sharedphone-' + Date.now();
  const before = getPendingContactConflicts().length;

  await postWebhook(basePayload({
    uid,
    responses: { name: responseEntry('Name', 'Renee Jones'), email: responseEntry('Email', email), phone: responseEntry('Phone', sharedPhone) },
  }));

  const appt = getAppointment(uid);
  assert.equal(appt.contact_id, existing.lastInsertRowid, 'must match the email-identified contact, not flag a conflict just because another contact shares the phone');
  assert.equal(getPendingContactConflicts().length, before, 'no possible-match review item staged');
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.lastInsertRowid);
  assert.equal(contact.phone_e164, sharedPhone, 'the previously-unknown phone is filled in, same as any other null field');
});
