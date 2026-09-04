// Tests for crm/lib/existingClientOutreach.js — the Revenue MVP Existing
// Client Reconnection workflow. In-memory databases only, all data fake, no
// network calls (fake Twilio/Gmail clients injected via deps).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations: runBrandsMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { createClient } = require('../lib/clientService');
const { checkConsentGate, sendLegacySms } = require('../lib/legacySmsSend');
const {
  RECONNECTION_SMS_MESSAGE_TYPE, getReconnectionTemplates, fillFirstName,
  checkReconnectionSmsEligibility, sendReconnectionSms, sendReconnectionEmail,
  getExistingClientsForOutreach, bulkSendReconnectionOutreach,
  EXISTING_CLIENT_SMS_TEMPLATES, EXISTING_CLIENT_EMAIL_TEMPLATES, PROSPERITY_LIFE_INSURANCE_BOOKING_URL,
} = require('../lib/existingClientOutreach');

const LIFE_INSURANCE_AWARENESS_KEY = 'existingClientLifeInsuranceAwarenessSms';

function setup() {
  const db = createLegacyDb();
  runBrandsMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  runCrmCoreMigrations(db);
  runRevenueMvpMigrations(db);
  return db;
}

const TWILIO_ENV = { TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tokenfake', TWILIO_FROM_NUMBER: '+14144411177' };
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return Promise.resolve().then(fn).finally(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
}

function fakeTwilioClient(behavior = 'ok') {
  return () => ({
    messages: {
      create: async (params) => {
        if (behavior === 'fail') { const err = new Error('unreachable'); err.code = 21211; throw err; }
        return { sid: 'SMfake-' + Math.random().toString(36).slice(2), status: 'sent', ...params };
      },
    },
  });
}

function fakeGmailDeps(behavior = 'ok') {
  return {
    authedClientFactory: () => ({}),
    gmailClientFactory: () => ({
      users: {
        messages: {
          send: async () => {
            if (behavior === 'fail') throw new Error('Gmail send failed');
            return { data: { id: 'gmail-' + Math.random().toString(36).slice(2), threadId: 'thread-1' } };
          },
        },
      },
    }),
  };
}

function seedExistingClient(db, overrides = {}) {
  const result = createClient(db, {
    firstName: overrides.firstName || 'Renee', lastName: overrides.lastName || 'Jones',
    email: overrides.email !== undefined ? overrides.email : `renee-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    phone: overrides.phone !== undefined ? overrides.phone : '414-688-7619',
    relationshipType: 'active_client', brandSlug: 'prosperity',
  }, 'Loretta Stewart');
  return result.contact;
}

function seedLead(db, overrides = {}) {
  const result = createClient(db, {
    firstName: 'Test', lastName: 'Caller',
    email: `lead-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    phone: '414-367-6486',
    relationshipType: 'lead', brandSlug: 'prosperity',
    ...overrides,
  }, 'Loretta Stewart');
  return result.contact;
}

// ── Templates ────────────────────────────────────────────────────────────

test('getReconnectionTemplates returns both Prosperity SMS templates, the email template(s), the office phone, and the booking link', () => {
  const db = setup();
  const templates = getReconnectionTemplates(db);
  assert.equal(templates.smsTemplates.length, 2);
  const reconnection = templates.smsTemplates.find(t => t.templateKey === 'existingClientReconnectionSms');
  const awareness = templates.smsTemplates.find(t => t.templateKey === 'existingClientLifeInsuranceAwarenessSms');
  assert.match(reconnection.body, /Reply YES to allow text communication/);
  // Footer changed to STOP-only in the 2026-09-06 revision -- no HELP language
  // on either Existing Client Outreach SMS template.
  assert.match(reconnection.body, /Reply STOP to opt out\.$/);
  assert.doesNotMatch(reconnection.body, /HELP/);
  // 2026-09-11 rename: label only -- templateKey/smsMessageType (and
  // therefore dedup/history) are unchanged, so this is still the SAME
  // template, never a duplicate.
  assert.equal(awareness.label, 'Existing Client - Reconnect Life Insurance Awareness Month');
  // 2026-09-11 reword: opening paragraph only -- everything from "Since
  // September..." onward is unchanged.
  assert.match(awareness.body, /^Hi \{\{first_name\}\}, this is Loretta Stewart, your insurance agent\. I'm reaching out to reconnect and make sure you have my current office and texting number\. Please save this number so you'll recognize me when I call and have it whenever you need assistance with your policy\./);
  assert.doesNotMatch(awareness.body, /current office contact information/);
  assert.match(awareness.body, /Life Insurance Awareness Month/);
  assert.match(awareness.body, /I'll be reaching out by phone over the next few days to reconnect and discuss your policy with you\./);
  // {{booking_link}} was deliberately REMOVED from this SMS template in the
  // 2026-09-04 revision -- Loretta follows up by phone and sends the link
  // manually only if the client asks for it in their reply.
  assert.doesNotMatch(awareness.body, /\{\{booking_link\}\}/);
  // Footer changed to STOP-only in the 2026-09-05 revision -- no HELP language.
  assert.match(awareness.body, /Reply STOP to opt out\.$/);
  assert.doesNotMatch(awareness.body, /HELP/);

  assert.equal(templates.emailTemplates.length, 2);
  const policyReview = templates.emailTemplates.find(t => t.templateKey === 'existingClientReconnectionEmail');
  const smsPermission = templates.emailTemplates.find(t => t.templateKey === 'existingClientSmsPermissionEmail');
  assert.equal(policyReview.label, 'Existing Client – Life Insurance Awareness Month / Policy Review');
  assert.match(policyReview.subject, /Policy Review/);
  assert.match(policyReview.body, /September is Life Insurance Awareness Month/);
  assert.equal(smsPermission.label, 'Existing Client – SMS Permission / Contact Update');
  assert.match(smsPermission.subject, /Please Save My New Office Number/);
  assert.match(smsPermission.body, /NO TEXTS\./);
  assert.match(smsPermission.body, /\{\{booking_link\}\}/);

  assert.equal(templates.officePhone, '+1 414-441-1177');
  assert.equal(templates.bookingLink, 'https://cal.com/lorettastewart/life-insurance-consultation-prosperitylfs');
});

// ── Template Manager overrides (2026-09-12): a saved crm_templates row
//    changes what getReconnectionTemplates returns, WITHOUT ever touching
//    template_key/smsMessageType -- the dedup identifier every send/
//    eligibility check below is keyed to. ───────────────────────────────

test('a crm_templates override changes the label/body getReconnectionTemplates returns for a built-in SMS template', () => {
  const db = setup();
  db.prepare(`
    INSERT INTO crm_templates (template_key, brand_id, channel, label, body, sms_message_type)
    VALUES ('existingClientLifeInsuranceAwarenessSms', 'prosperity', 'sms', 'Renamed via Template Manager', 'New body text {{first_name}}.', 'existing_client_life_insurance_awareness')
  `).run();
  const templates = getReconnectionTemplates(db);
  const awareness = templates.smsTemplates.find(t => t.templateKey === 'existingClientLifeInsuranceAwarenessSms');
  assert.equal(awareness.label, 'Renamed via Template Manager');
  assert.equal(awareness.body, 'New body text {{first_name}}.');
  // The OTHER SMS template is untouched by an override on this one.
  const reconnection = templates.smsTemplates.find(t => t.templateKey === 'existingClientReconnectionSms');
  assert.match(reconnection.body, /Reply YES to allow text communication/);
});

test('renaming/rewording a template via a crm_templates override does NOT change its eligibility/dedup identity -- "already sent" still keys off the unchanged smsMessageType', () => {
  const db = setup();
  const contact = seedExistingClient(db, { firstName: 'Nia', email: 'nia.rename@example.com' });

  // Send the ORIGINAL (un-renamed) template once.
  return withEnv(TWILIO_ENV, async () => {
    await sendReconnectionSms(db, {
      contactId: contact.id, message: 'Hi Nia, original wording...', templateKey: LIFE_INSURANCE_AWARENESS_KEY,
    }, { twilioClientFactory: fakeTwilioClient('ok') });

    // Now rename/reword it via a Template Manager override.
    db.prepare(`
      INSERT INTO crm_templates (template_key, brand_id, channel, label, body, sms_message_type)
      VALUES ('existingClientLifeInsuranceAwarenessSms', 'prosperity', 'sms', 'A totally different name', 'Completely reworded body {{first_name}}.', 'existing_client_life_insurance_awareness')
    `).run();

    // The SAME contact is still correctly reported as "already sent" this
    // template -- the rename never created a second, independent template.
    const check = checkReconnectionSmsEligibility(db, db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id), LIFE_INSURANCE_AWARENESS_KEY);
    assert.equal(check.eligible, false);
    assert.equal(check.code, 'already_sent');
    assert.match(check.reason, /A totally different name/, 'the block reason reflects the CURRENT (renamed) label');
  });
});

test('a crm_templates row for a NEW template_key appears as an additional entry in getReconnectionTemplates without altering the built-in ones', () => {
  const db = setup();
  db.prepare(`
    INSERT INTO crm_templates (template_key, brand_id, channel, label, body, sms_message_type)
    VALUES ('customBirthdaySms', 'prosperity', 'sms', 'Birthday Message', 'Happy birthday, {{first_name}}!', 'customBirthdaySms')
  `).run();
  const templates = getReconnectionTemplates(db);
  assert.equal(templates.smsTemplates.length, 3, 'the two built-ins plus the one new custom template');
  const custom = templates.smsTemplates.find(t => t.templateKey === 'customBirthdaySms');
  assert.ok(custom);
  assert.equal(custom.label, 'Birthday Message');
  assert.equal(custom.body, 'Happy birthday, {{first_name}}!');
  const awareness = templates.smsTemplates.find(t => t.templateKey === 'existingClientLifeInsuranceAwarenessSms');
  assert.match(awareness.body, /Life Insurance Awareness Month/, 'the built-in template is completely unaffected by an unrelated new custom template');
});

test('fillFirstName substitutes {{first_name}}, falling back to "there" when missing', () => {
  assert.equal(fillFirstName('Hi {{first_name}},', 'Renee'), 'Hi Renee,');
  assert.equal(fillFirstName('Hi {{first_name}},', null), 'Hi there,');
});

// ── A/B/C: SMS eligibility ───────────────────────────────────────────────

test('A. Existing Client + no recorded consent + no opt-out: initial SMS CAN be sent', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = seedExistingClient(db);
  const check = checkReconnectionSmsEligibility(db, contact);
  assert.equal(check.eligible, true);

  const result = await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi Renee, may I text you?' }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(result.outcome, 'sent');
  assert.equal(result.sms.message_type, RECONNECTION_SMS_MESSAGE_TYPE);
}));

// ── 2026-09-13 fix: sendReconnectionSms must send from the SAME Prosperity
//    number the confirmed-working regular Text button uses
//    (BRANDS.prosperity.phone.e164 / TWILIO_FROM_NUMBER_PROSPERITY), never
//    the separate legacy TWILIO_FROM_NUMBER default -- proven here by
//    deliberately setting TWILIO_FROM_NUMBER to something ELSE (and then
//    leaving it unset entirely) and confirming the actual Twilio 'from'
//    param sent is still the correct Prosperity number regardless. ────────

function capturingFakeTwilioClient(capturedParams) {
  return () => ({
    messages: {
      create: async (params) => {
        capturedParams.push(params);
        return { sid: 'SMfake-' + Math.random().toString(36).slice(2), status: 'sent' };
      },
    },
  });
}

test('sendReconnectionSms sends from BRANDS.prosperity.phone.e164, NOT the legacy TWILIO_FROM_NUMBER default, even when that env var is set to a different number', () =>
  withEnv({ TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tokenfake', TWILIO_FROM_NUMBER: '+15555550100' }, async () => {
    const db = setup();
    const contact = seedExistingClient(db);
    const captured = [];
    const result = await sendReconnectionSms(
      db, { contactId: contact.id, message: 'Hi Renee, may I text you?' },
      { twilioClientFactory: capturingFakeTwilioClient(captured) }
    );
    assert.equal(result.outcome, 'sent');
    assert.equal(captured.length, 1);
    assert.equal(captured[0].from, '+14144411177', 'must send from the Prosperity number, not the mismatched TWILIO_FROM_NUMBER');
    assert.notEqual(captured[0].from, '+15555550100');
    assert.equal(result.sms.from_number, '+14144411177', 'the logged sms_messages row must also record the correct sender');
  })
);

test('sendReconnectionSms still sends from BRANDS.prosperity.phone.e164 when TWILIO_FROM_NUMBER is entirely unset', () =>
  withEnv({ TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tokenfake', TWILIO_FROM_NUMBER: undefined }, async () => {
    const db = setup();
    const contact = seedExistingClient(db);
    const captured = [];
    const result = await sendReconnectionSms(
      db, { contactId: contact.id, message: 'Hi Renee, may I text you?' },
      { twilioClientFactory: capturingFakeTwilioClient(captured) }
    );
    assert.equal(result.outcome, 'sent', 'must not be blocked as "Twilio not configured" -- the Prosperity-specific fromNumber is supplied directly, independent of TWILIO_FROM_NUMBER');
    assert.equal(captured[0].from, '+14144411177');
  })
);

test('RESEND specifically (confirmResend: true, the reported bug) also sends from the correct Prosperity number and creates a genuinely new Twilio request/SID', () =>
  withEnv({ TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tokenfake', TWILIO_FROM_NUMBER: '+15555550100' }, async () => {
    const db = setup();
    const contact = seedExistingClient(db);
    const captured = [];
    const deps = { twilioClientFactory: capturingFakeTwilioClient(captured) };

    const first = await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi Renee, first send.' }, deps);
    assert.equal(first.outcome, 'sent');

    // A second attempt without confirmResend is correctly blocked as a
    // duplicate -- the warning dialog this proves is still in place.
    const blocked = await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi Renee, resend attempt.' }, deps);
    assert.equal(blocked.outcome, 'blocked');
    assert.equal(blocked.code, 'already_sent');

    // Clicking Resend (confirmResend: true) must create a genuinely NEW
    // outbound request with its own new Twilio SID, sent from the correct
    // Prosperity number -- and it must NOT be blocked again.
    const resent = await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi Renee, resend attempt.', confirmResend: true }, deps);
    assert.equal(resent.outcome, 'sent', 'Resend must not be stopped by duplicate protection a second time');
    assert.equal(captured.length, 2, 'exactly two real outbound Twilio requests were made -- original + resend');
    assert.notEqual(resent.sms.id, first.sms.id, 'the resend is a genuinely new sms_messages row, not a reuse of the first');
    assert.notEqual(resent.sms.twilio_sid, first.sms.twilio_sid, 'the resend has its own new Twilio SID');
    assert.equal(captured[1].from, '+14144411177', 'the resend also sends from the correct Prosperity number');

    const rows = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ? ORDER BY id ASC').all(contact.id);
    assert.equal(rows.length, 2, 'both the original send and the resend are recorded in Texts history');
    assert.ok(rows.every(r => r.status === 'sent'));
  })
);

test('B. Lead/Prospect + no consent: special Existing Client SMS workflow is BLOCKED', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const lead = seedLead(db);
  const check = checkReconnectionSmsEligibility(db, lead);
  assert.equal(check.eligible, false);
  assert.equal(check.code, 'not_existing_client');

  const result = await sendReconnectionSms(db, { contactId: lead.id, message: 'Hi there' }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.code, 'not_existing_client');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(lead.id).n, 0, 'nothing sent, no row created');
}));

test('C. Existing Client previously opted out (STOP): initial SMS is BLOCKED', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = seedExistingClient(db);
  db.prepare(`UPDATE contacts SET sms_opted_out_at = CURRENT_TIMESTAMP WHERE id = ?`).run(contact.id);

  const result = await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi Renee' }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.code, 'opted_out');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contact.id).n, 0);
}));

test('a contact with no valid mobile phone cannot receive the initial SMS', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = seedExistingClient(db, { phone: null });
  const result = await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi' }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.code, 'no_phone');
}));

test('the initial message cannot be sent twice unless confirmResend is explicitly true', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = seedExistingClient(db);
  const first = await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi Renee' }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(first.outcome, 'sent');

  const second = await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi Renee again' }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(second.outcome, 'blocked');
  assert.equal(second.code, 'already_sent');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contact.id).n, 1);

  const resend = await sendReconnectionSms(db, { contactId: contact.id, message: 'Resent', confirmResend: true }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(resend.outcome, 'sent');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contact.id).n, 2);
}));

// ── Second SMS template: Existing Client - Reconnect Life Insurance Awareness Month ──
// (the "reusable architecture" registry, EXISTING_CLIENT_SMS_TEMPLATES)

test('the Life Insurance Awareness Month template can be sent via templateKey, uses its own message_type, and is deduped independently of the Reconnection template', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = seedExistingClient(db);

  const result = await sendReconnectionSms(db, {
    contactId: contact.id, message: 'Hi Renee, Life Insurance Awareness Month...', templateKey: LIFE_INSURANCE_AWARENESS_KEY,
  }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(result.outcome, 'sent');
  assert.equal(result.sms.message_type, 'existing_client_life_insurance_awareness');
  assert.notEqual(result.sms.message_type, RECONNECTION_SMS_MESSAGE_TYPE);

  // Having received THIS template does not block the OTHER one for the same contact.
  const reconnectionResult = await sendReconnectionSms(db, {
    contactId: contact.id, message: 'Hi Renee, may I text you?',
  }, { twilioClientFactory: fakeTwilioClient('ok') }); // default templateKey = Reconnection
  assert.equal(reconnectionResult.outcome, 'sent');

  // A second send of the SAME (awareness) template is blocked as already_sent, independently.
  const repeat = await sendReconnectionSms(db, {
    contactId: contact.id, message: 'again', templateKey: LIFE_INSURANCE_AWARENESS_KEY,
  }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(repeat.outcome, 'blocked');
  assert.equal(repeat.code, 'already_sent');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages WHERE contact_id = ?').get(contact.id).n, 2, 'both distinct templates were sent, no duplicate of either');
}));

test('sendReconnectionSms rejects an unknown templateKey', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = seedExistingClient(db);
  await assert.rejects(
    () => sendReconnectionSms(db, { contactId: contact.id, message: 'Hi', templateKey: 'not_a_real_template' }, { twilioClientFactory: fakeTwilioClient('ok') }),
    /unknown SMS templateKey/
  );
}));

test('the Life Insurance Awareness Month template is also blocked for a Lead/Prospect and for a contact who opted out', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const lead = seedLead(db);
  const leadResult = await sendReconnectionSms(db, { contactId: lead.id, message: 'Hi', templateKey: LIFE_INSURANCE_AWARENESS_KEY }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(leadResult.outcome, 'blocked');
  assert.equal(leadResult.code, 'not_existing_client');

  const optedOut = seedExistingClient(db, { phone: '414-555-9601' });
  db.prepare('UPDATE contacts SET sms_opted_out_at = CURRENT_TIMESTAMP WHERE id = ?').run(optedOut.id);
  const optedOutResult = await sendReconnectionSms(db, { contactId: optedOut.id, message: 'Hi', templateKey: LIFE_INSURANCE_AWARENESS_KEY }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(optedOutResult.outcome, 'blocked');
  assert.equal(optedOutResult.code, 'opted_out');
}));

test('the bulk-select list\'s SMS Eligible column reflects template-independent eligibility -- having already received one template does not mark a contact ineligible in the list', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = seedExistingClient(db);
  await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi Renee, may I text you?' }, { twilioClientFactory: fakeTwilioClient('ok') });

  const list = getExistingClientsForOutreach(db, {});
  const row = list.find(c => c.contactId === contact.id);
  assert.equal(row.smsEligible, true, 'already having received the Reconnection template must not show as globally ineligible');
}));

test('bulkSendReconnectionOutreach passes templateKey through so selected recipients get the Life Insurance Awareness Month template', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const a = seedExistingClient(db, { firstName: 'Renee', phone: '414-555-9602' });
  const b = seedExistingClient(db, { firstName: 'Marcus', phone: '414-555-9603' });

  const results = await bulkSendReconnectionOutreach(db, {
    contactIds: [a.id, b.id], channel: 'sms', message: 'Hi {{first_name}}, Life Insurance Awareness Month...',
    templateKey: LIFE_INSURANCE_AWARENESS_KEY,
  }, { twilioClientFactory: fakeTwilioClient('ok') });

  assert.equal(results.filter(r => r.outcome === 'sent').length, 2);
  const rowA = db.prepare('SELECT message_type, body FROM sms_messages WHERE contact_id = ?').get(a.id);
  assert.equal(rowA.message_type, 'existing_client_life_insurance_awareness');
  assert.match(rowA.body, /Hi Renee,/);
}));

test('EXISTING_CLIENT_SMS_TEMPLATES registry and PROSPERITY_LIFE_INSURANCE_BOOKING_URL are exported for the compose UI', () => {
  assert.equal(EXISTING_CLIENT_SMS_TEMPLATES.length, 2);
  assert.ok(EXISTING_CLIENT_SMS_TEMPLATES.some(t => t.templateKey === LIFE_INSURANCE_AWARENESS_KEY));
  assert.equal(PROSPERITY_LIFE_INSURANCE_BOOKING_URL, 'https://cal.com/lorettastewart/life-insurance-consultation-prosperitylfs');
});

test('EXISTING_CLIENT_EMAIL_TEMPLATES registry is exported for the compose UI, mirroring the SMS registry shape', () => {
  assert.ok(Array.isArray(EXISTING_CLIENT_EMAIL_TEMPLATES));
  assert.ok(EXISTING_CLIENT_EMAIL_TEMPLATES.length >= 1);
  for (const entry of EXISTING_CLIENT_EMAIL_TEMPLATES) {
    assert.ok(entry.templateKey);
    assert.ok(entry.label);
  }
});

// ── H: initial email ─────────────────────────────────────────────────────

test('H. the initial Existing Client email sends correctly and logs to history', async () => {
  const db = setup();
  const contact = seedExistingClient(db);
  const result = await sendReconnectionEmail(db, {
    contactId: contact.id, subject: "It's Time for Your Life Insurance Policy Review", body: 'Hi Renee, ...',
  }, fakeGmailDeps('ok'));
  assert.equal(result.outcome, 'sent');
  assert.ok(result.gmailMessageId);

  const emailRow = db.prepare('SELECT * FROM emails WHERE contact_id = ?').get(contact.id);
  assert.ok(emailRow);
  assert.equal(emailRow.direction, 'outbound');
  assert.equal(emailRow.status, 'sent');
  const commRow = db.prepare(`SELECT * FROM communications WHERE contact_id = ? AND comm_type = 'email'`).get(contact.id);
  assert.ok(commRow, 'must also land in the communications timeline');
});

test('the initial email is blocked for a Lead/Prospect and for a contact with no email on file', async () => {
  const db = setup();
  const lead = seedLead(db);
  const leadResult = await sendReconnectionEmail(db, { contactId: lead.id, subject: 'S', body: 'B' }, fakeGmailDeps('ok'));
  assert.equal(leadResult.outcome, 'blocked');
  assert.equal(leadResult.code, 'not_existing_client');

  const noEmailContact = seedExistingClient(db, { email: null, phone: '414-555-9001' });
  const noEmailResult = await sendReconnectionEmail(db, { contactId: noEmailContact.id, subject: 'S', body: 'B' }, fakeGmailDeps('ok'));
  assert.equal(noEmailResult.outcome, 'blocked');
  assert.equal(noEmailResult.code, 'no_email');
});

// ── I: bulk / selected-contact outreach ─────────────────────────────────

test('I. selected Existing Clients receive the SMS with individual personalization and individual status reporting; one blocked recipient does not stop the others', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const good1 = seedExistingClient(db, { firstName: 'Renee', phone: '414-555-9101' });
  const good2 = seedExistingClient(db, { firstName: 'Marcus', phone: '414-555-9102' });
  const lead = seedLead(db, { phone: '414-555-9103' });

  const results = await bulkSendReconnectionOutreach(db, {
    contactIds: [good1.id, good2.id, lead.id], channel: 'sms', message: 'Hi {{first_name}}, may I text you?',
  }, { twilioClientFactory: fakeTwilioClient('ok') });

  const byId = Object.fromEntries(results.map(r => [r.contactId, r]));
  assert.equal(byId[good1.id].outcome, 'sent');
  assert.equal(byId[good2.id].outcome, 'sent');
  assert.equal(byId[lead.id].outcome, 'blocked');

  const row1 = db.prepare('SELECT body FROM sms_messages WHERE contact_id = ?').get(good1.id);
  const row2 = db.prepare('SELECT body FROM sms_messages WHERE contact_id = ?').get(good2.id);
  assert.match(row1.body, /Hi Renee,/, 'each recipient gets their OWN name substituted');
  assert.match(row2.body, /Hi Marcus,/);
}));

test('I. selected Existing Clients receive the email individually, with independent personalization and status', async () => {
  const db = setup();
  const a = seedExistingClient(db, { firstName: 'Renee', phone: '414-555-9401' });
  const b = seedExistingClient(db, { firstName: 'Marcus', phone: '414-555-9402' });

  const results = await bulkSendReconnectionOutreach(db, {
    contactIds: [a.id, b.id], channel: 'email', subject: 'Policy Review', body: 'Hi {{first_name}}, reconnecting.',
  }, fakeGmailDeps('ok'));

  assert.equal(results.filter(r => r.outcome === 'sent').length, 2);
  const emailA = db.prepare('SELECT body FROM emails WHERE contact_id = ?').get(a.id);
  const emailB = db.prepare('SELECT body FROM emails WHERE contact_id = ?').get(b.id);
  assert.match(emailA.body, /Hi Renee,/);
  assert.match(emailB.body, /Hi Marcus,/);
});

test('a Twilio failure for one bulk recipient is reported as failed without preventing the others from sending', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const good = seedExistingClient(db, { phone: '414-555-9201' });
  const alsoGood = seedExistingClient(db, { phone: '414-555-9202' });

  let call = 0;
  const flakyFactory = () => ({
    messages: {
      create: async (params) => {
        call += 1;
        if (call === 1) { const err = new Error('down'); err.code = 30001; throw err; }
        return { sid: 'SMfake-ok', status: 'sent', ...params };
      },
    },
  });

  const results = await bulkSendReconnectionOutreach(db, {
    contactIds: [good.id, alsoGood.id], channel: 'sms', message: 'Hi {{first_name}}',
  }, { twilioClientFactory: flakyFactory });

  assert.equal(results.length, 2);
  assert.ok(results.some(r => r.outcome === 'failed'));
  assert.ok(results.some(r => r.outcome === 'sent'), 'the second recipient must still succeed');
}));

test('getExistingClientsForOutreach lists only Prosperity Existing Clients, never a Lead/Prospect or an Insurance Lady client', () => {
  const db = setup();
  const prosperityClient = seedExistingClient(db, { firstName: 'Renee' });
  seedLead(db, { firstName: 'SomeLead' });
  createClient(db, {
    firstName: 'IL', lastName: 'Client', email: `il-${Date.now()}@example.com`, phone: '414-555-9301',
    relationshipType: 'active_client', brandSlug: 'insurance-lady',
  }, 'Loretta Stewart');

  const list = getExistingClientsForOutreach(db, {});
  const names = list.map(c => c.contactName);
  assert.ok(names.includes('Renee Jones'));
  assert.ok(!names.some(n => n.includes('SomeLead')));
  assert.ok(!names.some(n => n.includes('IL Client')));
  const rennee = list.find(c => c.contactId === prosperityClient.id);
  assert.equal(rennee.smsEligible, true);
});

// ── Eligibility also honors lead_type = 'Existing Client', the CRM's OTHER
// pre-existing "this is an existing client" signal (crm/lib/leadNormalize.js)
// -- never a new field, and a contact only needs ONE of the two. ──────────

test('a contact with lead_type "Existing Client" (but relationship_type still unset) is treated as an Existing Client for outreach', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = createClient(db, {
    firstName: 'Pat', lastName: 'Nguyen', email: `pat-${Date.now()}@example.com`, phone: '414-555-9501', brandSlug: 'prosperity',
  }, 'Loretta Stewart').contact;
  // Simulates a contact classified via lead_type (e.g. import/intake) --
  // relationship_type is deliberately left unset.
  db.prepare(`UPDATE contacts SET lead_type = 'Existing Client' WHERE id = ?`).run(contact.id);
  const refreshed = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
  assert.equal(refreshed.relationship_type, null);

  const check = checkReconnectionSmsEligibility(db, refreshed);
  assert.equal(check.eligible, true);

  const result = await sendReconnectionSms(db, { contactId: contact.id, message: 'Hi Pat' }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(result.outcome, 'sent');

  const list = getExistingClientsForOutreach(db, {});
  assert.ok(list.some(c => c.contactId === contact.id), 'must appear in the outreach list via lead_type alone');
}));

test('a contact with neither relationship_type "active_client" nor lead_type "Existing Client" is NOT eligible', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = createClient(db, {
    firstName: 'Not', lastName: 'Eligible', email: `notelig-${Date.now()}@example.com`, phone: '414-555-9502', brandSlug: 'prosperity',
  }, 'Loretta Stewart').contact; // relationship_type/lead_type both unset

  const check = checkReconnectionSmsEligibility(db, contact);
  assert.equal(check.eligible, false);
  assert.equal(check.code, 'not_existing_client');

  const list = getExistingClientsForOutreach(db, {});
  assert.ok(!list.some(c => c.contactId === contact.id));
}));

// ── J: the exception cannot be used to bypass consent for arbitrary
// templates or Lead/Prospect contacts ───────────────────────────────────

test('J. the consent-gate exception is scoped to this workflow only -- an ordinary sendLegacySms call still requires consent by default', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const contact = seedExistingClient(db); // sms_consent is 0/false by default
  assert.equal(!!contact.sms_consent, false);

  // The generic gate function, called the normal way (no requireConsent
  // override), must still block -- proves the default is unchanged.
  const gate = checkConsentGate({ sms_consent: 0, sms_opted_out_at: null });
  assert.equal(gate.blocked, true);

  const ordinaryResult = await sendLegacySms(db, { contactId: contact.id, body: 'Some arbitrary message' }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(ordinaryResult.ok, false, 'an arbitrary/ordinary SMS must NOT bypass consent just because this module exists');
  assert.match(ordinaryResult.error, /does not have SMS consent/);
}));

test('J. the same Lead/Prospect contact is blocked from the Existing Client SMS even with a phone and no opt-out', () => withEnv(TWILIO_ENV, async () => {
  const db = setup();
  const lead = seedLead(db);
  const result = await sendReconnectionSms(db, { contactId: lead.id, message: 'Hi' }, { twilioClientFactory: fakeTwilioClient('ok') });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.code, 'not_existing_client');
}));
