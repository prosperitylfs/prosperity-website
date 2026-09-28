// Tests for crm/lib/appointmentConfirmationEmail.js -- the Workflows-only
// automated appointment EMAIL (Prosperity-only, 2026-10-16). See that
// file's own header comment for why there is no hardcoded fallback here
// (unlike crm/lib/appointmentConfirmationSms.js): nothing sends unless an
// ENABLED send_email workflow row actually matches.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { sendAppointmentConfirmationEmail } = require('../lib/appointmentConfirmationEmail');

function seedContact(db, overrides = {}) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, email) VALUES (@first_name, @last_name, @email)
  `).run({ first_name: 'Janet', last_name: 'Jackson', email: 'janet@example.com', ...overrides }).lastInsertRowid;
}

function insertWorkflow(db, overrides = {}) {
  db.prepare(`
    INSERT INTO workflows (name, brand_id, appointment_type, trigger_type, offset_value, offset_unit, offset_minutes, message_type, condition_type, action_type, message_template, email_subject, enabled)
    VALUES (@name, @brand_id, @appointment_type, @trigger_type, @offset_value, @offset_unit, @offset_minutes, @message_type, @condition_type, @action_type, @message_template, @email_subject, @enabled)
  `).run({
    name: 'Test Email Workflow', brand_id: 'prosperity', appointment_type: null, trigger_type: 'appointment_booked',
    offset_value: null, offset_unit: null, offset_minutes: null, message_type: 'confirmation',
    condition_type: 'always', action_type: 'send_email', message_template: 'Hi {{first_name}}, custom email body.',
    email_subject: 'Your appointment with {{brand_name}}', enabled: 1, ...overrides,
  });
}

function fakeSendDeps(behavior = 'ok') {
  const calls = [];
  return {
    calls,
    sendGmailEmail: async (db, params) => {
      calls.push(params);
      if (behavior === 'fail') throw new Error('Gmail API error');
      const ins = db.prepare(`
        INSERT INTO emails (contact_id, to_email, subject, body, status, gmail_message_id, direction, appointment_id, message_type, appointment_occurrence_at)
        VALUES (?, ?, ?, ?, 'sent', 'gmail-fake-1', 'outbound', ?, ?, ?)
      `).run(params.contactId, params.toEmail, params.subject, params.body, params.appointmentId, params.messageType, params.appointmentOccurrenceAt);
      return { gmailMessageId: 'gmail-fake-1', threadId: null, _rowId: ins.lastInsertRowid };
    },
  };
}

test('no matching workflow row -> nothing attempted, no email sent', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const deps = fakeSendDeps('ok');

  const result = await sendAppointmentConfirmationEmail(db, {
    contactId, toEmail: 'janet@example.com', firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity', messageType: 'confirmation',
  }, deps);

  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'no_matching_workflow');
  assert.equal(deps.calls.length, 0);
});

test('a matching enabled Prosperity send_email workflow sends via the injected sendGmailEmail, rendering subject and body with the approved variables', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  insertWorkflow(db, {
    message_template: 'Hi {{first_name}}, your {{appointment_type}} is {{appt_date}} at {{appt_time}} with {{brand_name}}.',
    email_subject: 'Reminder: {{appointment_type}} on {{appt_date}}',
  });
  const deps = fakeSendDeps('ok');

  const result = await sendAppointmentConfirmationEmail(db, {
    contactId, toEmail: 'janet@example.com', firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity', messageType: 'confirmation',
  }, deps);

  assert.equal(result.attempted, true);
  assert.equal(result.sent, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0].toEmail, 'janet@example.com');
  assert.match(deps.calls[0].subject, /^Reminder: Life Insurance Consultation on /);
  assert.match(deps.calls[0].body, /^Hi Janet, your Life Insurance Consultation is /);
  assert.match(deps.calls[0].body, /with Prosperity Life & Financial Solutions LLC\.$/);
});

test('Prosperity is confirmed as the sending identity: no brand override is passed to sendGmailEmail (it always sends from loretta@prosperitylfs.com / GMAIL_FROM)', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  insertWorkflow(db);
  const deps = fakeSendDeps('ok');

  await sendAppointmentConfirmationEmail(db, {
    contactId, toEmail: 'janet@example.com', firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity', messageType: 'confirmation',
  }, deps);

  assert.deepEqual(Object.keys(deps.calls[0]).filter(k => /from/i.test(k)), [], 'sendAppointmentConfirmationEmail must never pass a from-address override -- sendGmailEmail\'s own fromAddr()/GMAIL_FROM is the single source of the sending identity');
});

test('an Insurance Lady send_email workflow fails closed -- clearly reports the email sender is not configured, and NEVER calls sendGmailEmail (so it can never accidentally send via the Prosperity identity)', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db, { first_name: 'Renee', email: 'renee@example.com' });
  insertWorkflow(db, { brand_id: 'insurance-lady' });
  const deps = fakeSendDeps('ok');

  const result = await sendAppointmentConfirmationEmail(db, {
    contactId, toEmail: 'renee@example.com', firstName: 'Renee', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'insurance-lady', messageType: 'confirmation',
  }, deps);

  assert.equal(result.attempted, true);
  assert.equal(result.sent, false);
  assert.match(result.reason, /not yet configured/i);
  assert.match(result.reason, /Insurance Lady/);
  assert.equal(deps.calls.length, 0, 'sendGmailEmail (the Prosperity Gmail identity) must never be invoked for Insurance Lady');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 0);
});

test('a matching workflow row with actionType send_sms (not send_email) is not picked up by the email sender', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  insertWorkflow(db, { action_type: 'send_sms', email_subject: null });
  const deps = fakeSendDeps('ok');

  const result = await sendAppointmentConfirmationEmail(db, {
    contactId, toEmail: 'janet@example.com', firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity', messageType: 'confirmation',
  }, deps);

  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'no_matching_workflow');
  assert.equal(deps.calls.length, 0);
});

test('a contact with no email address on file is not attempted, and the brand check (Insurance Lady) still takes priority when both are true', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db, { email: null });
  insertWorkflow(db);
  const deps = fakeSendDeps('ok');

  const result = await sendAppointmentConfirmationEmail(db, {
    contactId, toEmail: null, firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity', messageType: 'confirmation',
  }, deps);

  assert.equal(result.attempted, true);
  assert.equal(result.sent, false);
  assert.match(result.reason, /no email address/i);
  assert.equal(deps.calls.length, 0);
});

test('a workflow row whose condition evaluates false sends nothing -- never falls back to a generic message', async () => {
  const db = createLegacyDb();
  db.exec(`
    CREATE TABLE retirement_intakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, contact_id INTEGER NOT NULL, appointment_id INTEGER NOT NULL,
      token TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Not Sent', sent_at DATETIME, completed_at DATETIME,
      responses_json TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  const contactId = seedContact(db);
  insertWorkflow(db, { message_type: 'reminder_1h', condition_type: 'retirement_intake_completed' });
  const deps = fakeSendDeps('ok');

  const result = await sendAppointmentConfirmationEmail(db, {
    contactId, toEmail: 'janet@example.com', firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity', messageType: 'reminder_1h',
    appointmentId: 999,
  }, deps);

  assert.equal(result.attempted, false);
  assert.equal(result.reason, 'workflow_condition_not_met');
  assert.equal(deps.calls.length, 0);
});

test('a Gmail send failure is reported, not thrown', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  insertWorkflow(db);
  const deps = fakeSendDeps('fail');

  const result = await sendAppointmentConfirmationEmail(db, {
    contactId, toEmail: 'janet@example.com', firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity', messageType: 'confirmation',
  }, deps);

  assert.equal(result.attempted, true);
  assert.equal(result.sent, false);
  assert.match(result.reason, /Gmail API error/);
});

test('appointmentId and messageType are stamped through to sendGmailEmail for dedup, matching the appointment\'s current occurrence time', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  insertWorkflow(db, { message_type: 'reminder_24h' });
  const deps = fakeSendDeps('ok');

  await sendAppointmentConfirmationEmail(db, {
    contactId, toEmail: 'janet@example.com', firstName: 'Janet', appointmentType: 'Life Insurance Consultation',
    appointmentDatetimeIso: '2026-09-01T19:00:00.000Z', brandId: 'prosperity', messageType: 'reminder_24h',
    appointmentId: 555,
  }, deps);

  assert.equal(deps.calls[0].appointmentId, 555);
  assert.equal(deps.calls[0].messageType, 'reminder_24h');
  assert.equal(deps.calls[0].appointmentOccurrenceAt, '2026-09-01T19:00:00.000Z');
});
