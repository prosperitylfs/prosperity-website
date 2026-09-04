// Tests for crm/config/templates.js — pure data, no database, no sending.

const test = require('node:test');
const assert = require('node:assert/strict');
const { TEMPLATES, REQUIRED_TEMPLATE_KEYS, getTemplate } = require('../config/templates');

test('both brands define every required template key', () => {
  for (const brandId of ['insurance-lady', 'prosperity']) {
    for (const key of REQUIRED_TEMPLATE_KEYS) {
      assert.ok(TEMPLATES[brandId][key], `${brandId} is missing template '${key}'`);
    }
  }
});

test('Insurance Lady templates reference only Insurance Lady identity, never Prosperity', () => {
  for (const [key, tmpl] of Object.entries(TEMPLATES['insurance-lady'])) {
    const text = (tmpl.body || '') + (tmpl.subject || '') + (tmpl.text || '');
    assert.doesNotMatch(text, /Prosperity/i, `insurance-lady.${key} must not mention Prosperity`);
    assert.doesNotMatch(text, /414-441-1177|prosperitylfs\.com/i, `insurance-lady.${key} must not use Prosperity's phone/site`);
  }
});

test('Prosperity templates reference only Prosperity identity, never Insurance Lady', () => {
  for (const [key, tmpl] of Object.entries(TEMPLATES.prosperity)) {
    const text = (tmpl.body || '') + (tmpl.subject || '') + (tmpl.text || '');
    assert.doesNotMatch(text, /Insurance Lady/i, `prosperity.${key} must not mention Insurance Lady`);
    assert.doesNotMatch(text, /855-930-5239|insuranceladyllc\.com/i, `prosperity.${key} must not use Insurance Lady's phone/site`);
  }
});

test('every template clearly identifies its own company by name', () => {
  const expectedName = { 'insurance-lady': /Insurance Lady/i, prosperity: /Prosperity/i };
  // 2026-09-16: existingClientLifeInsuranceAwarenessSms is Loretta's exact
  // approved copy for the live Life Insurance Awareness Month send -- a
  // short, personal "this is Loretta Stewart, your insurance agent" text
  // that deliberately never names the company. Brand safety here comes
  // from the send path itself (crm/lib/existingClientOutreach.js is
  // Prosperity-only end to end, and Insurance Lady templates are still
  // fully covered by the tests above), not from this text.
  const exemptFromCompanyName = new Set(['existingClientLifeInsuranceAwarenessSms']);
  for (const brandId of ['insurance-lady', 'prosperity']) {
    for (const [key, tmpl] of Object.entries(TEMPLATES[brandId])) {
      if (exemptFromCompanyName.has(key)) continue;
      const text = (tmpl.body || '') + (tmpl.subject || '') + (tmpl.text || '');
      assert.match(text, expectedName[brandId], `${brandId}.${key} does not name its own company`);
    }
  }
});

test('Medicare is absent from every template, in either brand', () => {
  for (const brandId of ['insurance-lady', 'prosperity']) {
    for (const [key, tmpl] of Object.entries(TEMPLATES[brandId])) {
      const text = (tmpl.body || '') + (tmpl.subject || '') + (tmpl.text || '');
      assert.doesNotMatch(text, /medicare/i, `${brandId}.${key} must not mention Medicare`);
    }
  }
});

test('SMS templates that solicit a reply include STOP language', () => {
  const smsKeysExpectingStop = ['appointmentConfirmationSms', 'reminder24hSms', 'reminder1hSms', 'reminder15mSms', 'rescheduleNoticeSms', 'cancellationNoticeSms', 'missedCallTextBack', 'helpResponseSms'];
  for (const brandId of ['insurance-lady', 'prosperity']) {
    for (const key of smsKeysExpectingStop) {
      const tmpl = TEMPLATES[brandId][key];
      assert.match(tmpl.body, /STOP/, `${brandId}.${key} must include STOP language`);
    }
  }
});

test('existingClientReconnectionSms (Prosperity-only) footer is STOP-only, no HELP language (2026-09-06 revision)', () => {
  const tmpl = TEMPLATES.prosperity.existingClientReconnectionSms;
  assert.match(tmpl.body, /Reply STOP to opt out\.$/);
  assert.doesNotMatch(tmpl.body, /HELP/);
});

test('existingClientLifeInsuranceAwarenessSms (Prosperity-only) matches Loretta\'s 2026-09-16 approved copy exactly, apart from straight apostrophes', () => {
  const tmpl = TEMPLATES.prosperity.existingClientLifeInsuranceAwarenessSms;
  assert.equal(tmpl.body, `Hi {{first_name}}, this is Loretta Stewart, your insurance agent. I'm reconnecting with my clients and wanted to give you my current office/texting number. Please save it so you'll have it whenever you need assistance with your policy.

September is Life Insurance Awareness Month, so it's a great time to make sure your policy, beneficiaries, and coverage are still up to date.

If you'd like to schedule a policy review, reply YES and I'll send you my booking link. By replying YES, you agree to receive texts regarding your policy, appointments, and service needs.

Reply STOP to opt out.`);
  // {{booking_link}} is not substituted into this initial outbound message
  // -- it is only ever sent automatically in reply to an inbound YES or
  // REVIEW text (crm/lib/inboundSmsService.js).
  assert.doesNotMatch(tmpl.body, /\{\{booking_link\}\}/);
  assert.doesNotMatch(tmpl.body, /HELP/);
  assert.deepEqual(tmpl.placeholders, ['first_name']);
  assert.equal(TEMPLATES['insurance-lady'].existingClientLifeInsuranceAwarenessSms, undefined, 'must never exist for Insurance Lady');
});

test('existingClientSmsPermissionEmail (Prosperity-only) matches Loretta\'s approved copy exactly, apart from straight apostrophes', () => {
  const tmpl = TEMPLATES.prosperity.existingClientSmsPermissionEmail;
  assert.equal(tmpl.channel, 'email');
  assert.equal(tmpl.subject, 'A Quick Update From Loretta — Please Save My New Office Number');
  assert.match(tmpl.text, /YES, you may text me at \[your mobile number\]\./);
  assert.match(tmpl.text, /NO TEXTS\./);
  assert.match(tmpl.text, /\{\{booking_link\}\}/);
  assert.match(tmpl.text, /\{\{office_phone\}\}/);
  assert.equal(TEMPLATES['insurance-lady'].existingClientSmsPermissionEmail, undefined, 'must never exist for Insurance Lady');
});

test('existingClientReconnectionSms, existingClientLifeInsuranceAwarenessSms, existingClientReconnectionEmail, and existingClientSmsPermissionEmail exist ONLY for Prosperity, never Insurance Lady', () => {
  assert.ok(TEMPLATES.prosperity.existingClientReconnectionSms);
  assert.ok(TEMPLATES.prosperity.existingClientLifeInsuranceAwarenessSms);
  assert.ok(TEMPLATES.prosperity.existingClientReconnectionEmail);
  assert.ok(TEMPLATES.prosperity.existingClientSmsPermissionEmail);
  assert.equal(TEMPLATES['insurance-lady'].existingClientReconnectionSms, undefined);
  assert.equal(TEMPLATES['insurance-lady'].existingClientLifeInsuranceAwarenessSms, undefined);
  assert.equal(TEMPLATES['insurance-lady'].existingClientReconnectionEmail, undefined);
  assert.equal(TEMPLATES['insurance-lady'].existingClientSmsPermissionEmail, undefined);
});

test('every template is marked operational, not marketing', () => {
  for (const brandId of ['insurance-lady', 'prosperity']) {
    for (const [key, tmpl] of Object.entries(TEMPLATES[brandId])) {
      assert.equal(tmpl.category, 'operational', `${brandId}.${key} should be category 'operational'`);
    }
  }
});

test('getTemplate returns the requested brand/key pair and null for unknown ones', () => {
  const tmpl = getTemplate('insurance-lady', 'appointmentConfirmationSms');
  assert.ok(tmpl);
  assert.equal(tmpl.channel, 'sms');
  assert.equal(getTemplate('insurance-lady', 'doesNotExist'), null);
  assert.equal(getTemplate('unknown-brand', 'appointmentConfirmationSms'), null);
});

// GSM-7 default alphabet (basic + extension table), per 3GPP TS 23.038.
// Anything outside this set (curly quotes, em dashes, etc.) forces UCS-2
// encoding, which cuts the per-segment character budget roughly in half.
const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€';

test('every SMS template uses only GSM-7-compatible characters (no curly quotes, em dashes, or other Unicode punctuation)', () => {
  for (const brandId of ['insurance-lady', 'prosperity']) {
    for (const [key, tmpl] of Object.entries(TEMPLATES[brandId])) {
      if (tmpl.channel !== 'sms') continue;
      const nonGsm7 = [...tmpl.body].filter(ch => !GSM7_BASIC.includes(ch) && !GSM7_EXT.includes(ch));
      assert.deepEqual(nonGsm7, [], `${brandId}.${key} contains non-GSM-7 character(s): ${JSON.stringify(nonGsm7)}`);
    }
  }
});

test('the revised missed-call templates fit in a single GSM-7 segment with realistic sample data', () => {
  const samplesByBrand = {
    'insurance-lady': {},
    prosperity: {},
  };
  for (const brandId of ['insurance-lady', 'prosperity']) {
    const tmpl = TEMPLATES[brandId].missedCallTextBack;
    // missedCallTextBack has no placeholders, so the body itself is the final text.
    assert.equal(tmpl.placeholders.length, 0);
    assert.ok(tmpl.body.length <= 160, `${brandId}.missedCallTextBack is ${tmpl.body.length} chars, exceeds one GSM-7 segment (160)`);
  }
});

test('templates use only the documented placeholders', () => {
  const allowed = new Set(['attendee_name', 'appointment_type', 'date', 'time', 'time_zone', 'day_phrase', 'first_name', 'office_phone', 'booking_link']);
  const placeholderPattern = /\{\{(\w+)\}\}/g;
  for (const brandId of ['insurance-lady', 'prosperity']) {
    for (const [key, tmpl] of Object.entries(TEMPLATES[brandId])) {
      const text = (tmpl.body || '') + (tmpl.subject || '') + (tmpl.text || '');
      let match;
      while ((match = placeholderPattern.exec(text))) {
        assert.ok(allowed.has(match[1]), `${brandId}.${key} uses undocumented placeholder {{${match[1]}}}`);
      }
    }
  }
});
