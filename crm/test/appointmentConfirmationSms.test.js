// Tests for crm/lib/appointmentConfirmationSms.js — the automatic
// appointment SMS sent for a NEW, non-Retirement Cal.com booking
// (messageType 'confirmation') and for a genuine reschedule of one
// (messageType 'reschedule'): correct body content (first name only,
// natural closing brand identification, no leading brand prefix),
// consent/opt-out enforcement, Mobile-only phone resolution (a
// landline-only contact must not be texted), brand-specific FROM number,
// and that a failed/blocked send never throws.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { buildConfirmationSmsBody, fillTemplate, resolveFromNumberForBrand, sendAppointmentConfirmationSms } = require('../lib/appointmentConfirmationSms');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });
}

function setup() {
  const db = createLegacyDb();
  runRevenueMvpMigrations(db); // adds sms_opted_out_at
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

const OK_DEPS = { sendLegacySms: async (db, { contactId, body, fromNumber }) => {
  const ins = db.prepare(`INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid) VALUES (?, 'outbound', ?, '+14143676486', ?, 'sent', 'SMfake')`).run(contactId, fromNumber || '+14144411177', body);
  return { ok: true, sms: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(ins.lastInsertRowid) };
}};

// ── Body building — new-booking confirmation ────────────────────────────

test('fillTemplate substitutes every {{placeholder}} and leaves no braces behind', () => {
  const out = fillTemplate('Hi {{name}}, your {{thing}} is at {{time}}.', { name: 'Janet', thing: 'appointment', time: '2:00 PM' });
  assert.equal(out, 'Hi Janet, your appointment is at 2:00 PM.');
  assert.doesNotMatch(out, /\{\{|\}\}/);
});

test('buildConfirmationSmsBody uses first name only, appointment type, date/time, and STOP language, with no marketing language', () => {
  const body = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  });
  assert.match(body, /^Hi Janet,/);
  assert.doesNotMatch(body, /Janet Jackson/, 'must use first name only, never the full name');
  assert.match(body, /Life Insurance Consultation/);
  assert.match(body, /confirmed for/);
  assert.match(body, /Reply HELP for help or STOP to opt out/);
  assert.doesNotMatch(body, /% off|discount|limited time|act now/i);
});

test('Insurance Lady new-booking SMS: exact wording, first name only, no leading "Insurance Lady LLC:" prefix, closing identification + STOP/HELP', () => {
  const body = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-08-31T21:00:00.000Z', brandId: 'insurance-lady',
  });
  assert.equal(
    body,
    'Hi Janet, your Life Insurance Consultation with Loretta Stewart is confirmed for Monday, August 31, 2026 at 4:00 PM CT. Loretta will call you at the scheduled time. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.'
  );
  assert.doesNotMatch(body, /^Insurance Lady LLC:/, 'must not begin with the old "Insurance Lady LLC:" prefix');
  assert.match(body, /- Insurance Lady LLC\.\s*Reply HELP/, 'must identify the business naturally near the end, before the HELP/STOP language');
  assert.doesNotMatch(body, /Prosperity/);
});

test('Prosperity new-booking SMS: same natural greeting structure, no leading "Prosperity Life & Financial Solutions:" prefix, closing identification', () => {
  const explicit = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity',
  });
  const implicit = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  });
  for (const body of [explicit, implicit]) {
    assert.match(body, /^Hi Janet,/);
    assert.doesNotMatch(body, /^Prosperity Life & Financial Solutions:/, 'must not begin with the old brand-prefix format');
    assert.match(body, /- Prosperity Life & Financial Solutions\.\s*Reply HELP/, 'must identify the business naturally near the end');
    assert.doesNotMatch(body, /Insurance Lady/);
  }
});

test('no reschedule link is fabricated in either message type -- no verified, booking-specific Cal.com reschedule URL exists in this codebase\'s webhook data for either brand (investigated; none added)', () => {
  const confirmation = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-08-31T21:00:00.000Z', brandId: 'insurance-lady',
  });
  const reschedule = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T20:00:00.000Z', brandId: 'insurance-lady', messageType: 'reschedule',
  });
  for (const body of [confirmation, reschedule]) {
    assert.doesNotMatch(body, /https?:\/\//i, 'must never include a URL -- none is available reliably from Cal.com webhook data for either brand');
    assert.doesNotMatch(body, /reschedule\?/i);
  }
});

// ── Body building — reschedule notice ───────────────────────────────────

test('Insurance Lady reschedule SMS: exact wording, new date/time, first name only', () => {
  const body = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T20:00:00.000Z', brandId: 'insurance-lady', messageType: 'reschedule',
  });
  assert.equal(
    body,
    'Hi Janet, your Life Insurance Consultation with Loretta Stewart has been rescheduled for Tuesday, September 1, 2026 at 3:00 PM CT. Loretta will call you at the scheduled time. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.'
  );
});

test('Prosperity reschedule SMS: same structure, Prosperity identification', () => {
  const body = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T20:00:00.000Z', brandId: 'prosperity', messageType: 'reschedule',
  });
  assert.match(body, /^Hi Janet, your Life Insurance Consultation with Loretta Stewart has been rescheduled for/);
  assert.match(body, /- Prosperity Life & Financial Solutions\.\s*Reply HELP/);
  assert.doesNotMatch(body, /Insurance Lady/);
});

// ── Body building — 24h reminder reschedule note ────────────────────────
//
// "Need to reschedule? Reply RESCHEDULE." was added to the 24h reminder
// ONLY -- prompts the client to text back the RESCHEDULE keyword, which
// crm/lib/inboundSmsService.js recognizes and starts the SMS reschedule-
// request workflow (see crm/test/inboundSmsService.test.js for that side).
// Deliberately left out of the 1h/15m reminders since it's most useful
// with a day's notice, not minutes before the call. (Earlier revision
// pointed to Cal.com's own confirmation-email link instead -- superseded.)

test('Insurance Lady 24h reminder includes the reschedule note, positioned right after "Loretta will call you at the scheduled time."', () => {
  const body = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-08-31T21:00:00.000Z', brandId: 'insurance-lady', messageType: 'reminder_24h',
    now: new Date('2026-08-30T21:00:00.000Z'), // exactly 1 day before -> "tomorrow"
  });
  assert.equal(
    body,
    'Hi Janet, this is your 24-hour reminder. Your Life Insurance Consultation with Loretta Stewart is tomorrow at 4:00 PM CT. Loretta will call you at the scheduled time. Need to reschedule? Reply RESCHEDULE. - Insurance Lady LLC. Reply HELP for help or STOP to opt out.'
  );
});

test('Prosperity 24h reminder includes the same reschedule note', () => {
  const body = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-08-31T21:00:00.000Z', brandId: 'prosperity', messageType: 'reminder_24h',
    now: new Date('2026-08-30T21:00:00.000Z'),
  });
  assert.equal(
    body,
    'Hi Janet, this is your 24-hour reminder. Your Life Insurance Consultation with Loretta Stewart is tomorrow at 4:00 PM CT. Loretta will call you at the scheduled time. Need to reschedule? Reply RESCHEDULE. - Prosperity Life & Financial Solutions. Reply HELP for help or STOP to opt out.'
  );
});

test('the reschedule note is NOT present in the 1h or 15m reminders, for either brand', () => {
  for (const brandId of ['insurance-lady', 'prosperity']) {
    for (const messageType of ['reminder_1h', 'reminder_15m']) {
      const body = buildConfirmationSmsBody({
        firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
        appointmentDatetimeIso: '2026-08-31T21:00:00.000Z', brandId, messageType,
      });
      assert.doesNotMatch(body, /Need to reschedule/, `${brandId} ${messageType} must not include the 24h-only reschedule note`);
    }
  }
});

test('1h and 15m reminders explicitly name which reminder they are, and still state the actual scheduled time, for both brands', () => {
  const expectedLabel = { reminder_1h: '1-hour reminder', reminder_15m: '15-minute reminder' };
  const expectedIdentity = { 'insurance-lady': 'Insurance Lady LLC', prosperity: 'Prosperity Life & Financial Solutions' };
  for (const brandId of ['insurance-lady', 'prosperity']) {
    for (const messageType of ['reminder_1h', 'reminder_15m']) {
      const body = buildConfirmationSmsBody({
        firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
        appointmentDatetimeIso: '2026-08-31T21:00:00.000Z', brandId, messageType,
      });
      assert.match(body, new RegExp(`^Hi Janet, this is your ${expectedLabel[messageType]}\\.`), `${brandId} ${messageType} must explicitly name the reminder type`);
      assert.match(body, /\d{1,2}:\d{2} (AM|PM) CT/, `${brandId} ${messageType} must still state the actual appointment time`);
      assert.doesNotMatch(body, /in 1 hour|in 15 minutes/, `${brandId} ${messageType} must not use a vague relative-time phrase instead of the clock time`);
      assert.match(body, new RegExp(`- ${expectedIdentity[brandId].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`), `${brandId} ${messageType} must identify the correct brand`);
    }
  }
});

test('messageType defaults to "confirmation" wording when omitted', () => {
  const body = buildConfirmationSmsBody({
    firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity',
  });
  assert.match(body, /is confirmed for/);
  assert.doesNotMatch(body, /rescheduled/);
});

// ── FROM-number resolution ─────────────────────────────────────────────────

test('resolveFromNumberForBrand reads INSURANCE_LADY_TWILIO_PHONE_NUMBER for insurance-lady', () => withEnv(
  { INSURANCE_LADY_TWILIO_PHONE_NUMBER: '+18559305239' },
  () => {
    assert.equal(resolveFromNumberForBrand('insurance-lady'), '+18559305239');
  }
));

test('resolveFromNumberForBrand returns null for prosperity -- sendLegacySms applies its own TWILIO_FROM_NUMBER default', () => {
  assert.equal(resolveFromNumberForBrand('prosperity'), null);
  assert.equal(resolveFromNumberForBrand(undefined), null);
});

// ── Send behavior — new-booking confirmation ────────────────────────────

test('a consenting contact with a valid mobile phone gets exactly one SMS logged in sms_messages', async () => {
  const db = setup();
  const contactId = seedContact(db);

  const result = await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  }, OK_DEPS);

  assert.equal(result.attempted, true);
  assert.equal(result.sent, true);
  const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').all(contactId);
  assert.equal(rows.length, 1);
  assert.match(rows[0].body, /^Hi Janet,/);
});

test('an Insurance Lady booking sends the natural-greeting Insurance Lady wording FROM the Insurance Lady number, logged in SMS History', () => withEnv(
  { INSURANCE_LADY_TWILIO_PHONE_NUMBER: '+18559305239' },
  async () => {
    const db = setup();
    const contactId = seedContact(db, { first_name: 'Renee', last_name: 'Jones' });

    const result = await sendAppointmentConfirmationSms(db, {
      contactId, firstName: 'Renee', appointmentType: 'Life Insurance Consultation',
      appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'insurance-lady',
    }, OK_DEPS);

    assert.equal(result.sent, true);
    const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').all(contactId);
    assert.equal(rows.length, 1, 'SMS History (sms_messages) must log exactly the one sent confirmation');
    assert.match(rows[0].body, /^Hi Renee,/);
    assert.match(rows[0].body, /- Insurance Lady LLC\./);
    assert.equal(rows[0].from_number, '+18559305239', 'must send FROM the Insurance Lady number, not the Prosperity default');
  }
));

test('a Prosperity booking keeps sending Prosperity wording FROM the existing TWILIO_FROM_NUMBER default', () => withEnv(
  { INSURANCE_LADY_TWILIO_PHONE_NUMBER: '+18559305239' }, // present but must be ignored for this brand
  async () => {
    const db = setup();
    const contactId = seedContact(db);

    const result = await sendAppointmentConfirmationSms(db, {
      contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
      appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity',
    }, OK_DEPS);

    assert.equal(result.sent, true);
    const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').all(contactId);
    assert.equal(rows.length, 1);
    assert.match(rows[0].body, /- Prosperity Life & Financial Solutions\./);
    assert.notEqual(rows[0].from_number, '+18559305239');
  }
));

test('an Insurance Lady booking is blocked (fails closed, never falls back to the Prosperity number) when INSURANCE_LADY_TWILIO_PHONE_NUMBER is not configured', () => withEnv(
  { INSURANCE_LADY_TWILIO_PHONE_NUMBER: undefined },
  async () => {
    const db = setup();
    const contactId = seedContact(db);

    let called = false;
    const countingDeps = { sendLegacySms: async (...args) => { called = true; return OK_DEPS.sendLegacySms(...args); } };

    const result = await sendAppointmentConfirmationSms(db, {
      contactId, firstName: 'Renee', appointmentType: 'Life Insurance Consultation',
      appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'insurance-lady',
    }, countingDeps);

    assert.equal(result.sent, false);
    assert.match(result.reason, /INSURANCE_LADY_TWILIO_PHONE_NUMBER/);
    assert.equal(called, false, 'must never attempt to send (and so never risk the Prosperity number) when the brand sender is not configured');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contactId).n, 0);
  }
));

// ── Send behavior — reschedule notice ───────────────────────────────────

test('an Insurance Lady reschedule sends the reschedule wording FROM the Insurance Lady number, logged in SMS History', () => withEnv(
  { INSURANCE_LADY_TWILIO_PHONE_NUMBER: '+18559305239' },
  async () => {
    const db = setup();
    const contactId = seedContact(db, { first_name: 'Renee', last_name: 'Jones' });

    const result = await sendAppointmentConfirmationSms(db, {
      contactId, firstName: 'Renee', appointmentType: 'Life Insurance Consultation',
      appointmentDatetimeIso: '2026-09-01T20:00:00.000Z', brandId: 'insurance-lady', messageType: 'reschedule',
    }, OK_DEPS);

    assert.equal(result.sent, true);
    const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').all(contactId);
    assert.equal(rows.length, 1, 'the reschedule SMS must log to SMS History via the exact same mechanism as the booking confirmation');
    assert.match(rows[0].body, /^Hi Renee,/);
    assert.match(rows[0].body, /has been rescheduled for/);
    assert.match(rows[0].body, /- Insurance Lady LLC\./);
    assert.equal(rows[0].from_number, '+18559305239');
  }
));

test('a Prosperity reschedule retains the Prosperity sender', () => withEnv(
  { INSURANCE_LADY_TWILIO_PHONE_NUMBER: '+18559305239' },
  async () => {
    const db = setup();
    const contactId = seedContact(db);

    const result = await sendAppointmentConfirmationSms(db, {
      contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
      appointmentDatetimeIso: '2026-09-01T20:00:00.000Z', brandId: 'prosperity', messageType: 'reschedule',
    }, OK_DEPS);

    assert.equal(result.sent, true);
    const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').all(contactId);
    assert.match(rows[0].body, /- Prosperity Life & Financial Solutions\./);
    assert.notEqual(rows[0].from_number, '+18559305239');
  }
));

test('a reschedule is not sent when SMS consent is not allowed', async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_consent: 0 });

  const result = await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T20:00:00.000Z', messageType: 'reschedule',
  });

  assert.equal(result.sent, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contactId).n, 0);
});

// ── Consent / opt-out / phone-type gating (shared by both message types) ──

test('a contact with SMS Consent = No is never texted', async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_consent: 0 });

  // No deps override -- the consent gate lives INSIDE the real
  // sendLegacySms (crm/lib/legacySmsSend.js), so this must exercise that
  // real gate, not a fake that would just bypass it. checkConsentGate
  // returns before ever constructing a Twilio client, so this makes no
  // real network call.
  const result = await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  });

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'This contact does not have SMS consent on file. Add a consent source on the Contact Detail page before texting.');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contactId).n, 0);
});

test('a landline-only contact (no phone/phone_e164, only Landline Phone stored elsewhere) is never texted', async () => {
  const db = setup();
  // Mirrors what crm/routes/calcom.js writes for a Landline-answered booking:
  // phone/phone_e164 stay null; the number lives only in home_phone, which
  // sendLegacySms's resolveToNumber() never reads.
  const contactId = seedContact(db, { phone: null, phone_e164: null, sms_consent: 1 });

  const result = await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  });

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'Contact has no valid phone number for SMS');
});

test('an opted-out contact (STOP) is never texted even if sms_consent is still 1', async () => {
  const db = setup();
  const contactId = seedContact(db, { sms_opted_out_at: '2026-08-01 12:00:00' });

  // No deps override -- same reasoning as the SMS-Consent=No test above:
  // opt-out is checked inside the real sendLegacySms, before any network call.
  const result = await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  });

  assert.equal(result.sent, false);
  assert.match(result.reason, /opted out/);
  const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ?').all(contactId);
  assert.equal(rows.length, 0);
});

test('a Twilio failure is reported, not thrown', async () => {
  const db = setup();
  const contactId = seedContact(db);
  const FAIL_DEPS = { sendLegacySms: async () => ({ ok: false, status: 500, error: 'The number is unreachable' }) };

  const result = await sendAppointmentConfirmationSms(db, {
    contactId, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z',
  }, FAIL_DEPS);

  assert.equal(result.attempted, true);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'The number is unreachable');
});
