// Tests for crm/lib/appointmentReminderScheduler.js -- the 24h/1h/15m
// automated appointment reminder SMS. Uses the REAL sendLegacySms (via a
// fake Twilio client, mirroring crm/test/legacySmsSend.test.js's own
// pattern) rather than a fake sendLegacySms, so the dedup logic is
// exercised against the actual sms_messages rows the real send path
// writes -- this is the part most worth getting right end-to-end.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { runMigrations: runBrandsMigrations } = require('../db/migrateBrands');
const { runReminderCheck, REMINDER_SPECS } = require('../lib/appointmentReminderScheduler');

function setup() {
  const db = createLegacyDb();
  runRevenueMvpMigrations(db); // adds sms_opted_out_at
  // contact_brands/brands are a separate migration (not part of
  // crm/db/database.js's own unconditional schema) -- needed here for the
  // brand-resolution fallback tests (resolveReminderBrand falls back to
  // contact_brands when booking_brand is NULL).
  runBrandsMigrations(db);
  return db;
}

function seedContact(db, overrides = {}) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164, sms_consent, sms_opted_out_at)
    VALUES (@first_name, @last_name, @phone, @phone_e164, @sms_consent, @sms_opted_out_at)
  `).run({
    first_name: 'Janet', last_name: 'Jackson', phone: '(414) 367-6486', phone_e164: '+14143676486',
    sms_consent: 1, sms_opted_out_at: null, ...overrides,
  }).lastInsertRowid;
}

// Links a contact to a brand in contact_brands, the same way
// crm/lib/caseMatching.js's resolveContactBrand does in production.
function linkContactToBrand(db, contactId, brandSlug) {
  const brandRow = db.prepare('SELECT id FROM brands WHERE slug = ?').get(brandSlug);
  db.prepare('INSERT INTO contact_brands (contact_id, brand_id) VALUES (?, ?)').run(contactId, brandRow.id);
}

function seedAppointment(db, contactId, overrides = {}) {
  return db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status, booking_brand)
    VALUES (@contact_id, @appt_type, @appt_datetime, @status, @booking_brand)
  `).run({
    contact_id: contactId, appt_type: 'Life Insurance Consultation',
    appt_datetime: '2026-09-01T18:00:00.000Z', status: 'Scheduled', booking_brand: 'prosperity',
    ...overrides,
  }).lastInsertRowid;
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
}

const TWILIO_ENV = { TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tokenfake', TWILIO_FROM_NUMBER: '+14144411177' };
const INSURANCE_LADY_ENV = { ...TWILIO_ENV, INSURANCE_LADY_TWILIO_PHONE_NUMBER: '+18559305239' };

function fakeClient(behavior = 'ok') {
  return () => ({
    messages: {
      create: async (params) => {
        if (behavior === 'fail') {
          const err = new Error('The number is unreachable');
          err.code = 21211;
          throw err;
        }
        return { sid: 'SMfake-' + Math.random().toString(36).slice(2), status: 'sent', ...params };
      },
    },
  });
}

const NOW = new Date('2026-08-31T18:00:00.000Z'); // fixed reference instant for every test

function minutesFromNow(mins) {
  return new Date(NOW.getTime() + mins * 60000).toISOString();
}

function smsRowsFor(db, contactId) {
  return db.prepare('SELECT * FROM sms_messages WHERE contact_id = ? ORDER BY id').all(contactId);
}

// ── 1-3: each reminder type sends ──────────────────────────────────────────

test('24-hour reminder sends to an SMS-consented contact around the 24h mark', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(24 * 60) }); // exactly 24h away

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_type, 'reminder_24h');
  assert.match(rows[0].body, /^Hi Janet, this is your 24-hour reminder\./);
  assert.match(rows[0].body, /Reply RESCHEDULE/, '24h reminder must offer RESCHEDULE');
  assert.match(rows[0].body, /\d{1,2}:\d{2} (AM|PM) CT/, 'must state the actual scheduled appointment time, not just "tomorrow"');
}));

test('an appointment 5.5 hours away does NOT qualify for the 24-hour reminder (regression: the 11:27 AM-for-a-5:00-PM-appointment bug)', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  // Reproduces the reported production bug directly: a 5:00 PM appointment
  // polled at 11:27 AM is (17:00 - 11:27 =) 5h33m = 333 minutes away --
  // nowhere near the 1435-1445 minute reminder_24h window, and also not in
  // the 1h or 15m windows. The old broad-band logic incorrectly matched
  // reminder_24h here because 333 <= 1440.
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(333) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0, 'a 5.5-hour-away appointment must not receive a "24-hour" reminder');
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

test('1-hour reminder sends around the 1h mark', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(60) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows[0].message_type, 'reminder_1h');
  assert.match(rows[0].body, /^Hi Janet, this is your 1-hour reminder\./);
  assert.doesNotMatch(rows[0].body, /RESCHEDULE/, '1h reminder must not offer RESCHEDULE');
  assert.match(rows[0].body, /\d{1,2}:\d{2} (AM|PM) CT/, 'must state the actual scheduled appointment time, not just "in 1 hour"');
}));

test('an appointment 30 minutes away does NOT qualify for the 1-hour reminder', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(30) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0, '30 minutes away is between the 15m (10-20) and 1h (55-65) windows -- not due for either');
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

test('an appointment 5 minutes away does NOT retroactively qualify for the 15-minute reminder once that window has passed', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  // The 15m window is 10-20 minutes away; 5 minutes away means that window
  // has already closed. This must NOT fire late just because it's "close".
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(5) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0, 'a missed 15m window must not fire late');
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

test('a restart/deployment 5 hours before a 5:00 PM appointment does not trigger a 24-hour reminder, and 30 minutes before does not trigger a 1-hour reminder', () => withEnv(TWILIO_ENV, async () => {
  // Simulates the exact reported scenario: the process (re)starts and polls
  // at a point that is well inside "the next 24 hours" and "the next hour"
  // respectively, but not actually near either target window.
  const fiveHoursOut = await (async () => {
    const db = setup();
    const contactId = seedContact(db);
    seedAppointment(db, contactId, { appt_datetime: minutesFromNow(5 * 60) }); // 5h away
    const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
    assert.equal(summary.sent, 0, 'a restart 5 hours out must not fire a stale 24-hour reminder');
    return smsRowsFor(db, contactId).length;
  })();
  assert.equal(fiveHoursOut, 0);

  const thirtyMinOut = await (async () => {
    const db = setup();
    const contactId = seedContact(db);
    seedAppointment(db, contactId, { appt_datetime: minutesFromNow(30) }); // 30m away
    const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
    assert.equal(summary.sent, 0, 'a restart 30 minutes out must not fire a stale 1-hour reminder');
    return smsRowsFor(db, contactId).length;
  })();
  assert.equal(thirtyMinOut, 0);
}));

test('the three reminder windows never overlap', () => {
  const sorted = [...REMINDER_SPECS].sort((a, b) => a.minMinutes - b.minMinutes);
  for (let i = 0; i < sorted.length; i += 1) {
    assert.ok(sorted[i].minMinutes <= sorted[i].maxMinutes, `${sorted[i].messageType} has an inverted window`);
    if (i > 0) {
      assert.ok(sorted[i - 1].maxMinutes < sorted[i].minMinutes,
        `${sorted[i - 1].messageType} (max ${sorted[i - 1].maxMinutes}) overlaps ${sorted[i].messageType} (min ${sorted[i].minMinutes})`);
    }
  }
});

test('15-minute reminder sends within the 15m window', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows[0].message_type, 'reminder_15m');
  assert.match(rows[0].body, /^Hi Janet, this is your 15-minute reminder\./);
  assert.doesNotMatch(rows[0].body, /RESCHEDULE/, '15m reminder must not offer RESCHEDULE');
  assert.match(rows[0].body, /\d{1,2}:\d{2} (AM|PM) CT/, 'must state the actual scheduled appointment time, not just "in 15 minutes"');
}));

test('an appointment more than 24 hours away receives no reminder yet', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(25 * 60) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

test('only the single most-imminent due reminder fires for a same-day/last-minute booking, never a cascade of all three', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  // Booked with only 10 minutes' notice -- technically within the 24h, 1h,
  // AND 15m windows simultaneously on its very first ever poll.
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1, 'must send exactly one reminder, not three');
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message_type, 'reminder_15m', 'the most-imminent applicable type wins');
}));

// ── 4-7: consent eligibility ────────────────────────────────────────────────

test('SMS Consent = Yes (representing "Text and email" or "Text only") qualifies for reminders', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_consent: 1 });
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
}));

test('SMS Consent = No (representing "Email only") never receives a reminder', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_consent: 0 });
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

test('missing/unknown SMS consent (schema default 0) never receives a reminder', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  // sms_consent omitted entirely -- relies on the contacts table's own DEFAULT 0.
  const contactId = db.prepare(`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164) VALUES ('No', 'Consent', '(414) 555-0199', '+14145550199')
  `).run().lastInsertRowid;
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

// ── 8: cancelled appointments ───────────────────────────────────────────────

test('a cancelled appointment receives no reminders even though it is inside the window', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), status: 'Cancelled' });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

// ── 9-10, 12: reschedule handling ───────────────────────────────────────────

test('a rescheduled appointment uses the NEW appointment time for reminders', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(25 * 60), status: 'Rescheduled' });

  // Not due yet at the original (25h-away) time.
  let summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);

  // Rescheduled to 10 minutes away -- same appointment row, new time.
  db.prepare('UPDATE appointments SET appt_datetime = ? WHERE id = ?').run(minutesFromNow(10), apptId);

  summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows[0].message_type, 'reminder_15m');
  assert.equal(rows[0].appointment_occurrence_at, minutesFromNow(10), 'must be stamped with the NEW time, not the old one');
}));

test('the old appointment time never triggers a reminder after a reschedule moves it out of every window', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  // Reschedule far into the future, well outside all three windows, BEFORE
  // any poll ever ran against the original (imminent) time.
  db.prepare('UPDATE appointments SET appt_datetime = ? WHERE id = ?').run(minutesFromNow(48 * 60), apptId);

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0, 'the appointment is now 48h away -- no reminder is due for the new time, and none should fire for the old one either');
}));

test('rescheduling AFTER a reminder was already sent for the old time still sends fresh reminders for the new time', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  let summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  assert.equal(smsRowsFor(db, contactId)[0].message_type, 'reminder_15m');

  // Reschedule to 60 minutes away (now inside the 1h window instead).
  db.prepare('UPDATE appointments SET appt_datetime = ? WHERE id = ?').run(minutesFromNow(60), apptId);

  summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1, 'the 1h reminder for the NEW time must still send, despite a 15m reminder already having been sent for the old time');
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].message_type, 'reminder_1h');
}));

// ── 11: no duplicate for the same occurrence ────────────────────────────────

test('each reminder type sends only once for the same appointment occurrence, even across repeated polls', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });

  assert.equal(smsRowsFor(db, contactId).length, 1, 'three polls of the same unchanged appointment must still log exactly one SMS');
}));

// ── 13-14: brand routing ────────────────────────────────────────────────────

test('Insurance Lady appointment uses Insurance Lady branding and sender', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { first_name: 'Renee' });
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), booking_brand: 'insurance-lady' });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.match(row.body, /- Insurance Lady LLC\./);
  assert.equal(row.from_number, '+18559305239');
}));

test('Prosperity appointment retains Prosperity branding and sender', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), booking_brand: 'prosperity' });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.match(row.body, /- Prosperity Life & Financial Solutions\./);
  assert.notEqual(row.from_number, '+18559305239');
}));

// ── Brand resolution: booking_brand -> contact_brands -> never guessed ────
//
// Fixes a real production bug: appointments created before booking_brand
// persistence existed have booking_brand = NULL, and the old code did
// `appt.booking_brand || 'prosperity'` -- silently sending Prosperity-
// branded reminders for Insurance Lady appointments. The fix never
// defaults; it falls back to a single active contact_brands relationship,
// and skips the reminder entirely (never guessing Prosperity) when even
// that isn't available.

test('an older Insurance Lady appointment with missing booking_brand resolves correctly via its contact_brands relationship', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { first_name: 'Renee' });
  linkContactToBrand(db, contactId, 'insurance-lady');
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), booking_brand: null });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 1);
  const row = smsRowsFor(db, contactId)[0];
  assert.match(row.body, /- Insurance Lady LLC\./);
  assert.equal(row.from_number, '+18559305239');

  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(apptId);
  assert.equal(appt.booking_brand, 'insurance-lady', 'the row must be healed so future lookups do not need to re-derive it');
}));

test('an older Prosperity appointment with missing booking_brand resolves correctly via its contact_brands relationship', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  linkContactToBrand(db, contactId, 'prosperity');
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), booking_brand: null });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.match(row.body, /- Prosperity Life & Financial Solutions\./);
}));

test('an appointment with no booking_brand AND no contact_brands relationship is SKIPPED, never sent under a guessed Prosperity brand', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  // No linkContactToBrand call -- genuinely no reliable signal at all.
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), booking_brand: null });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped, 1);
  assert.equal(smsRowsFor(db, contactId).length, 0, 'must never send under a guessed/default brand');
}));

test('an appointment with no booking_brand and TWO active contact_brands relationships is also SKIPPED -- genuinely ambiguous, not a signal to guess from', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  linkContactToBrand(db, contactId, 'insurance-lady');
  linkContactToBrand(db, contactId, 'prosperity');
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10), booking_brand: null });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(summary.sent, 0);
  assert.equal(smsRowsFor(db, contactId).length, 0);
}));

// ── Additional appointment types (Insurance Lady) ─────────────────────────

test('an Insurance Lady Cancer Insurance Consultation reminder uses Insurance Lady branding and sender', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db, { first_name: 'Renee' });
  seedAppointment(db, contactId, {
    appt_datetime: minutesFromNow(10), booking_brand: 'insurance-lady', appt_type: 'Cancer Insurance Consultation',
  });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.match(row.body, /Cancer Insurance Consultation/);
  assert.match(row.body, /- Insurance Lady LLC\./);
  assert.equal(row.from_number, '+18559305239');
}));

test('a Prosperity Safe Money & Retirement Consultation reminder uses Prosperity branding and sender', () => withEnv(INSURANCE_LADY_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, {
    appt_datetime: minutesFromNow(10), booking_brand: 'prosperity', appt_type: 'Safe Money & Retirement Consultation',
  });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.match(row.body, /Safe Money & Retirement Consultation/);
  assert.match(row.body, /- Prosperity Life & Financial Solutions\./);
  assert.notEqual(row.from_number, '+18559305239');
}));

// ── 15: Twilio failure ──────────────────────────────────────────────────────

test('a Twilio failure does not mark the reminder as sent, and does not block a later retry', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  const failSummary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('fail') } });
  assert.equal(failSummary.sent, 0);
  const failedRows = smsRowsFor(db, contactId);
  assert.equal(failedRows.length, 1);
  assert.equal(failedRows[0].status, 'failed');

  // Next poll (e.g. 5 minutes later, Twilio recovered) retries successfully.
  const okSummary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  assert.equal(okSummary.sent, 1);
  const rows = smsRowsFor(db, contactId);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].status, 'sent');
}));

// ── 16: one appointment's failure doesn't block others ──────────────────────

test('an unexpected error while processing one appointment does not prevent reminders for other eligible appointments', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const badContactId = seedContact(db, { first_name: 'Broken' });
  seedAppointment(db, badContactId, { appt_datetime: minutesFromNow(10) });
  const goodContactId = seedContact(db, { first_name: 'Fine', phone: '(414) 555-0177', phone_e164: '+14145550177' });
  seedAppointment(db, goodContactId, { appt_datetime: minutesFromNow(11) });

  let callCount = 0;
  const throwingClientFactory = () => ({
    messages: {
      create: async (params) => {
        callCount += 1;
        if (params.to === '+14143676486') throw new Error('Simulated unexpected failure');
        return { sid: 'SMfake-good', status: 'sent', ...params };
      },
    },
  });

  const summary = await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: throwingClientFactory } });
  assert.equal(summary.sent, 1, 'the good appointment must still succeed');
  assert.equal(smsRowsFor(db, goodContactId).length, 1);
  // The "bad" one fails via the normal Twilio-error path (caught inside
  // sendLegacySms itself, not an uncaught throw) -- still logged as failed,
  // not silently dropped, and does not abort the batch either way.
  assert.equal(smsRowsFor(db, badContactId)[0].status, 'failed');
}));

// ── 17: SMS History ──────────────────────────────────────────────────────

test('a successfully sent reminder is recorded in SMS History (sms_messages) with the correct classification', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contactId = seedContact(db);
  const apptId = seedAppointment(db, contactId, { appt_datetime: minutesFromNow(10) });

  await runReminderCheck(db, { now: NOW, deps: { twilioClientFactory: fakeClient('ok') } });
  const row = smsRowsFor(db, contactId)[0];
  assert.equal(row.appointment_id, apptId);
  assert.equal(row.message_type, 'reminder_15m');
  assert.equal(row.status, 'sent');
  assert.ok(row.twilio_sid);
}));
