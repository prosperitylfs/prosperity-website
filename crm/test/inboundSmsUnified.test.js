// Regression tests for crm/lib/inboundSmsService.js's handleInboundSmsUnified
// — the one shared handler both crm/routes/twilio.js's authoritative
// /sms/inbound and crm/routes/twilioProsperitySms.js's alias /sms/inbound
// now call. In-memory dbs only, all data fake, no network calls.
//
// Two fully separate code paths are covered:
//   - handleLegacyOnlyInboundSms (via a To number that is NOT the
//     Prosperity 414 line): the ORIGINAL, unconditional legacy behavior,
//     unchanged by this correction.
//   - handleProsperityInboundSms (via the Prosperity 414 number): the
//     corrected behavior — a contact, a contact_brands relationship, a
//     Texts-tab attachment, or a follow-up task are ONLY ever created for a
//     sender that matches exactly one contact with an ACTIVE Prosperity
//     relationship. Everything else is staged, read-only with respect to
//     contacts, in the Unrecognized Text Senders review queue.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { handleInboundSmsUnified, PROSPERITY_LIFE_INSURANCE_SHORT_BOOKING_URL } = require('../lib/inboundSmsService');
const { resolveUnknownSmsReview, archiveReviewItem } = require('../lib/reviewResolution');
const { getClientDetail } = require('../lib/dashboardQueries');
const { createClient } = require('../lib/clientService');
const { createDraft } = require('../lib/communicationDraftService');
const { updateTemplate } = require('../lib/templateManagerService');
const { BRANDS } = require('../config/brands');

function setup() {
  const db = createLegacyDb();
  runMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db); runRevenueMvpMigrations(db);
  return db;
}
const PROSPERITY_NUMBER = BRANDS.prosperity.phone.e164; // +14144411177
const OTHER_NUMBER = '+18005551234'; // stands in for a number that isn't the Prosperity 414 line

function contactCount(db) { return db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n; }
function messageCount(db) { return db.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n; }
function taskCount(db) { return db.prepare('SELECT COUNT(*) AS n FROM follow_up_tasks').get().n; }
function reviewCount(db) { return db.prepare(`SELECT COUNT(*) AS n FROM unresolved_intake WHERE review_type = 'unknown_sms_sender'`).get().n; }

// ── Scenario 1: known active Prosperity client ─────────────────────────────

test('SCENARIO 1: a known active Prosperity client\'s reply attaches exactly once to the correct Texts thread', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Nadia', lastName: 'Ott', phone: '4145559010', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'Sounds good!', MessageSid: 'SM_known_1' });
  assert.equal(result.outcome, 'processed');
  assert.equal(result.contactId, client.contact.id);
  assert.equal(result.contactCreated, false);
  assert.equal(result.contactBrandId, client.contactBrand.id, 'must carry the resolved Prosperity contact_brand_id');
  assert.equal(result.isProsperityNumber, true);
  const detail = getClientDetail(db, client.contact.id);
  const matches = detail.smsThread.filter(m => m.body === 'Sounds good!');
  assert.equal(matches.length, 1);
  assert.equal(taskCount(db), 1, 'at most one ordinary reply follow-up task');
  assert.equal(contactCount(db), 1, 'no case is created or selected -- confirm no case-related tables gained rows');
  const caseCountAfter = db.prepare('SELECT COUNT(*) AS n FROM cases').get().n;
  assert.equal(caseCountAfter, 0, 'a reply must never select or create a case merely because the contact has cases');
});

test('SCENARIO 1: MessageSid idempotency -- a retry does not duplicate the message or the task', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Otis', lastName: 'Pratt', phone: '4145559011', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const params = { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'Retry me', MessageSid: 'SM_known_retry_1' };
  handleInboundSmsUnified(db, params);
  const second = handleInboundSmsUnified(db, params);
  assert.equal(second.outcome, 'duplicate_ignored');
  const detail = getClientDetail(db, client.contact.id);
  assert.equal(detail.smsThread.filter(m => m.body === 'Retry me').length, 1);
  assert.equal(taskCount(db), 1);
});

// ── Scenario 2: Insurance Lady-only sender ──────────────────────────────────

test('SCENARIO 2: an Insurance-Lady-only number does not attach to any client thread and enters review', () => {
  const db = setup();
  const ilClient = createClient(db, { firstName: 'Priya', lastName: 'Quinn', phone: '4145559014', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  const result = handleInboundSmsUnified(db, { From: ilClient.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'hello?', MessageSid: 'SM_il_only_1' });
  assert.equal(result.outcome, 'staged_for_review');
  assert.equal(result.candidateContactId, ilClient.contact.id, 'the IL contact is surfaced as an informational candidate only, never an attachment');
  const detail = getClientDetail(db, ilClient.contact.id);
  assert.equal(detail.smsThread.length, 0, 'the message must not appear on the Insurance Lady client\'s Texts tab');
  const staged = db.prepare(`SELECT * FROM unresolved_intake WHERE review_type = 'unknown_sms_sender'`).get();
  assert.match(staged.reason, /Insurance Lady-only client/);
});

test('SCENARIO 3 (dup of 2/3 numbering guard): an Insurance-Lady-only sender creates no Prosperity relationship, case, or task', () => {
  const db = setup();
  const ilClient = createClient(db, { firstName: 'Reed', lastName: 'Salas', phone: '4145559020', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  const beforeContacts = contactCount(db);
  const beforeTasks = taskCount(db);
  handleInboundSmsUnified(db, { From: ilClient.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'hi', MessageSid: 'SM_il_only_2' });
  assert.equal(contactCount(db), beforeContacts, 'no new contact');
  assert.equal(taskCount(db), beforeTasks, 'no follow-up task');
  assert.equal(messageCount(db), 0, 'no sms_messages row at all for this scenario');
  const caseCountAfter = db.prepare('SELECT COUNT(*) AS n FROM cases').get().n;
  assert.equal(caseCountAfter, 0);
  const link = db.prepare(`SELECT * FROM contact_brands WHERE contact_id = ? AND status = 'Active'`).all(ilClient.contact.id);
  assert.equal(link.length, 1, 'still only the original Insurance Lady relationship -- no Prosperity relationship created');
  assert.equal(link[0].brand_id !== undefined, true);
});

test('SCENARIO 2: an Insurance-Lady-only sender\'s consent is never changed by an inbound message on the Prosperity number', () => {
  const db = setup();
  const ilClient = createClient(db, { firstName: 'Sana', lastName: 'Ueda', phone: '4145559021', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(ilClient.contact.id);
  handleInboundSmsUnified(db, { From: ilClient.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'hi', MessageSid: 'SM_il_consent_1' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ilClient.contact.id);
  assert.equal(contact.sms_consent, 1);
  assert.equal(contact.sms_opted_out_at, null);
});

// ── Scenario 3: completely unknown sender ───────────────────────────────────

test('SCENARIO 4: a completely unknown number creates no contact before review', () => {
  const db = setup();
  const before = contactCount(db);
  const result = handleInboundSmsUnified(db, { From: '+14145559030', To: PROSPERITY_NUMBER, Body: 'hi is this Loretta', MessageSid: 'SM_unknown_1' });
  assert.equal(result.outcome, 'staged_for_review');
  assert.equal(contactCount(db), before, 'no contact created');
  assert.equal(taskCount(db), 0);
  assert.equal(messageCount(db), 0);
  const staged = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(result.unresolvedIntakeId);
  assert.equal(staged.review_type, 'unknown_sms_sender');
  const payload = JSON.parse(staged.raw_payload);
  assert.equal(payload.From, '+14145559030');
  assert.equal(payload.To, PROSPERITY_NUMBER);
  assert.equal(payload.Body, 'hi is this Loretta');
  assert.equal(payload.MessageSid, 'SM_unknown_1');
  assert.ok(staged.created_at, 'timestamp preserved');
  assert.equal(staged.source, 'twilio_sms_inbound');
});

test('SCENARIO 5: a duplicate webhook delivery for an unknown number creates exactly one staged item', () => {
  const db = setup();
  const params = { From: '+14145559031', To: PROSPERITY_NUMBER, Body: 'hello?', MessageSid: 'SM_unknown_retry_1' };
  const first = handleInboundSmsUnified(db, params);
  const second = handleInboundSmsUnified(db, params);
  assert.equal(second.outcome, 'already_staged');
  assert.equal(second.unresolvedIntakeId, first.unresolvedIntakeId);
  assert.equal(reviewCount(db), 1);
  assert.equal(contactCount(db), 0);
});

// ── Reviewer actions ─────────────────────────────────────────────────────────

test('SCENARIO 6: reviewer can attach a staged message to an existing active Prosperity client exactly once', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Tobin', lastName: 'Vance', phone: '4145559040', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const staged = handleInboundSmsUnified(db, { From: '+14145559041', To: PROSPERITY_NUMBER, Body: 'is this Loretta', MessageSid: 'SM_attach_1' });
  const result = resolveUnknownSmsReview(db, { intakeId: staged.unresolvedIntakeId, action: 'attach_existing', contactId: client.contact.id, actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'attached');
  assert.equal(result.messageCreated, true);
  const detail = getClientDetail(db, client.contact.id);
  assert.equal(detail.smsThread.filter(m => m.body === 'is this Loretta').length, 1);
  // Resolving again must never duplicate -- the intake is no longer Pending.
  assert.throws(() => resolveUnknownSmsReview(db, { intakeId: staged.unresolvedIntakeId, action: 'attach_existing', contactId: client.contact.id, actor: 'Loretta Stewart' }), /pending/);
  assert.equal(detail.smsThread.filter(m => m.body === 'is this Loretta').length, 1);
});

test('SCENARIO 6: attach_existing still refuses an Insurance-Lady client target', () => {
  const db = setup();
  const ilClient = createClient(db, { firstName: 'Uma', lastName: 'Weiss', phone: '4145559042', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  const staged = handleInboundSmsUnified(db, { From: '+14145559043', To: PROSPERITY_NUMBER, Body: 'hi', MessageSid: 'SM_attach_2' });
  assert.throws(() => resolveUnknownSmsReview(db, { intakeId: staged.unresolvedIntakeId, action: 'attach_existing', contactId: ilClient.contact.id, actor: 'Loretta Stewart' }), /Prosperity/);
});

test('SCENARIO 7: reviewer can explicitly create a new Prosperity client and attach the message exactly once', () => {
  const db = setup();
  const staged = handleInboundSmsUnified(db, { From: '+14145559050', To: PROSPERITY_NUMBER, Body: 'Interested in a quote', MessageSid: 'SM_create_1' });
  const result = resolveUnknownSmsReview(db, { intakeId: staged.unresolvedIntakeId, action: 'create_new', firstName: 'Vera', lastName: 'Xiong', actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'created');
  assert.equal(result.messageCreated, true);
  const detail = getClientDetail(db, result.contact.id);
  assert.equal(detail.contact.firstName, 'Vera');
  assert.equal(detail.smsThread.filter(m => m.body === 'Interested in a quote').length, 1);
  const link = db.prepare(`SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.id = ?`).get(result.contactBrand.id);
  assert.equal(link.slug, 'prosperity');
  const caseCountAfter = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(result.contactBrand.id).n;
  assert.equal(caseCountAfter, 0, 'no case is created unless the reviewer separately supplies product/case information');
});

test('SCENARIO 7: create_new never silently creates a second relationship when the number already belongs to an Insurance Lady client', () => {
  const db = setup();
  const ilClient = createClient(db, { firstName: 'Wade', lastName: 'Young', phone: '4145559051', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  const staged = handleInboundSmsUnified(db, { From: ilClient.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'hi', MessageSid: 'SM_create_conflict_1' });
  const result = resolveUnknownSmsReview(db, { intakeId: staged.unresolvedIntakeId, action: 'create_new', firstName: 'Wade', lastName: 'Young', actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'company_conflict');
  assert.ok(result.conflictIntake);
  // The original unknown_sms_sender intake is left Pending, not silently resolved.
  const originalIntake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(staged.unresolvedIntakeId);
  assert.equal(originalIntake.status, 'Pending');
  // No new Prosperity relationship was created for this Insurance Lady contact.
  const prosperityLink = db.prepare(`
    SELECT 1 FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id
    WHERE cb.contact_id = ? AND cb.status = 'Active' AND b.slug = 'prosperity'
  `).get(ilClient.contact.id);
  assert.equal(prosperityLink, undefined);
});

test('SCENARIO 8: Archive/Test preserves the staged record and creates no client', () => {
  const db = setup();
  const staged = handleInboundSmsUnified(db, { From: '+14145559060', To: PROSPERITY_NUMBER, Body: 'random text', MessageSid: 'SM_archive_1' });
  const before = contactCount(db);
  const result = archiveReviewItem(db, { intakeId: staged.unresolvedIntakeId, actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'archived');
  assert.equal(contactCount(db), before);
  const intake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(staged.unresolvedIntakeId);
  assert.equal(intake.status, 'Archived');
  assert.equal(JSON.parse(intake.raw_payload).Body, 'random text', 'the staged raw record is preserved, not deleted');
});

// ── Scenario 4: STOP / START / HELP ─────────────────────────────────────────

test('SCENARIO 9: STOP from a known Prosperity client blocks later drafts and creates no follow-up task', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Reva', lastName: 'Suarez', phone: '4145559015', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(client.contact.id);
  const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'STOP', MessageSid: 'SM_stop_1' });
  assert.equal(result.consentAction, 'opted_out');
  assert.equal(result.autoTaskId, null, 'STOP must never create a reply task');
  assert.equal(taskCount(db), 0);
  assert.throws(
    () => createDraft(db, { contactId: client.contact.id, channel: 'text', body: 'Hi again' }, 'Loretta Stewart'),
    /STOP/
  );
});

test('SCENARIO 10: START restores Prosperity consent and creates no follow-up task', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Sam', lastName: 'Torres', phone: '4145559016', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`UPDATE contacts SET sms_consent = 0, sms_opted_out_at = '2026-01-01' WHERE id = ?`).run(client.contact.id);
  const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'START', MessageSid: 'SM_start_1' });
  assert.equal(result.consentAction, 'opted_in');
  assert.equal(result.autoTaskId, null);
  assert.equal(taskCount(db), 0);
  assert.doesNotThrow(() => createDraft(db, { contactId: client.contact.id, channel: 'text', body: 'Welcome back' }, 'Loretta Stewart'));
});

test('SCENARIO 11: STOP from an Insurance-Lady-only sender does not change that contact\'s consent', () => {
  const db = setup();
  const ilClient = createClient(db, { firstName: 'Xena', lastName: 'Cho', phone: '4145559022', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(ilClient.contact.id);
  handleInboundSmsUnified(db, { From: ilClient.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'STOP', MessageSid: 'SM_il_stop_1' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ilClient.contact.id);
  assert.equal(contact.sms_consent, 1);
  assert.equal(contact.sms_opted_out_at, null);
});

test('SCENARIO 12: HELP creates no ordinary reply task', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Yara', lastName: 'Diallo', phone: '4145559023', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'HELP', MessageSid: 'SM_help_1' });
  assert.equal(result.consentAction, 'help_requested');
  assert.equal(result.autoTaskId, null);
  assert.equal(taskCount(db), 0);
});

// ── Scenario 7: delivery-status callback ────────────────────────────────────

test('SCENARIO 13: a delivery-status callback never creates a contact, message, review item, or task', () => {
  const db = setup();
  db.prepare(`INSERT INTO sms_messages (direction, body, status, twilio_sid) VALUES ('outbound', 'hi', 'sent', 'SM_legacy_dr_1')`).run();
  const before = { contacts: contactCount(db), messages: messageCount(db), tasks: taskCount(db), reviews: reviewCount(db) };
  const result = handleInboundSmsUnified(db, { From: '+14145550000', To: PROSPERITY_NUMBER, MessageStatus: 'delivered', MessageSid: 'SM_legacy_dr_1' });
  assert.equal(result.outcome, 'delivery_receipt_deflected');
  assert.deepEqual(
    { contacts: contactCount(db), messages: messageCount(db), tasks: taskCount(db), reviews: reviewCount(db) },
    before
  );
  const row = db.prepare(`SELECT status FROM sms_messages WHERE twilio_sid = 'SM_legacy_dr_1'`).get();
  assert.equal(row.status, 'delivered');
});

// ── Legacy-only path (non-Prosperity number) — unchanged by this correction ─

test('LEGACY (non-Prosperity number, unchanged): an inbound SMS from an existing contact attaches to that contact', () => {
  const db = setup();
  const ins = db.prepare(`INSERT INTO contacts (first_name, last_name, phone, phone_e164) VALUES ('Wendell', 'Ash', '(414) 555-9001', '+14145559001')`).run();
  const result = handleInboundSmsUnified(db, { From: '+14145559001', To: OTHER_NUMBER, Body: 'hey', MessageSid: 'SM_legacy_match_1' });
  assert.equal(result.outcome, 'processed');
  assert.equal(result.contactId, ins.lastInsertRowid);
  assert.equal(result.isProsperityNumber, false);
});

test('LEGACY (non-Prosperity number, unchanged): an unrecognized number still auto-creates an Unknown Caller contact', () => {
  const db = setup();
  const result = handleInboundSmsUnified(db, { From: '+14145559002', To: OTHER_NUMBER, Body: 'who is this', MessageSid: 'SM_legacy_new_1' });
  assert.equal(result.outcome, 'processed');
  assert.equal(result.contactCreated, true);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.contactId);
  assert.equal(contact.lead_type, 'Unknown Caller');
  assert.equal(contact.lead_status, 'New Lead');
  assert.ok(result.autoTaskId, 'the legacy path still creates its reply task unconditionally');
});

test('LEGACY (non-Prosperity number, unchanged): a retry never duplicates the message or the task', () => {
  const db = setup();
  const params = { From: '+14145559003', To: OTHER_NUMBER, Body: 'hello', MessageSid: 'SM_legacy_retry_1' };
  const first = handleInboundSmsUnified(db, params);
  const second = handleInboundSmsUnified(db, params);
  assert.equal(first.outcome, 'processed');
  assert.equal(second.outcome, 'duplicate_ignored');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM sms_messages WHERE twilio_sid = 'SM_legacy_retry_1'`).get().n, 1);
});

// ── Revenue MVP: inbound YES / NO / STOP consent recording ─────────────────
// The "Existing Client Reconnection" workflow's whole reason for existing
// is this: the initial SMS is sent WITHOUT consent already on file
// (crm/lib/existingClientOutreach.js), and consent is only ever recorded
// here, by the contact's own reply -- never by the sender. YES was already
// a recognized START-equivalent keyword before this round; these tests
// cover the newly-added consent AUDIT TRAIL stamping (source/timestamp)
// and the newly-added NO keyword.

// 2026-09-16: the Life Insurance Awareness Month campaign's approved copy
// now reads "reply YES and I'll send you my booking link" -- so a plain
// YES now grants consent AND automatically sends the booking link, exactly
// like REVIEW (see test H below). consentAction is 'review_requested' for
// both -- there is no behavioral difference between them any more.
test('D. an Existing Client replying YES: SMS consent becomes YES, the reply is preserved in history, and the client receives the Prosperity booking link automatically', async () => {
  const db = setup();
  const client = createClient(db, {
    firstName: 'Renee', lastName: 'Jones', phone: '4145559101', brandSlug: 'prosperity', relationshipType: 'active_client',
  }, 'Loretta Stewart');
  assert.equal(client.contact.sms_consent, 0, 'starts with no consent on file');

  const before = new Date();
  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'YES', MessageSid: 'SM_yes_1',
  }, OK_REVIEW_SEND_DEPS);
  assert.equal(result.consentAction, 'review_requested');
  assert.equal(result.reviewRequested, true);
  assert.equal(result.autoTaskId, null, 'YES must not create an ordinary reply task, same as STOP/START/NO/HELP');

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 1);
  assert.equal(contact.sms_consent_source, 'Inbound SMS');
  assert.ok(contact.sms_consent_at, 'consent timestamp must be recorded');
  assert.ok(new Date(contact.sms_consent_at.replace(' ', 'T') + 'Z') >= new Date(before.getTime() - 2000), 'timestamp must reflect roughly now, not a stale/default value');
  assert.equal(contact.sms_opted_out_at, null);

  const sendOutcome = await result.reviewBookingLinkPromise;
  assert.equal(sendOutcome.ok, true);

  const detail = getClientDetail(db, client.contact.id);
  assert.ok(detail.smsThread.some(m => m.body === 'YES' && m.direction === 'inbound'), 'the inbound YES message itself must be preserved in communication history');
  const bookingReplies = detail.smsThread.filter(m => m.direction === 'outbound' && m.body.includes(PROSPERITY_LIFE_INSURANCE_SHORT_BOOKING_URL));
  assert.equal(bookingReplies.length, 1, 'the automated booking-link reply must appear exactly once in SMS History -- no duplicate booking-link text');
});

test('YES is matched case-insensitively and tolerates surrounding whitespace ("Yes", "yes", " YES ")', () => {
  const db = setup();
  for (const [i, body] of ['Yes', 'yes', ' YES '].entries()) {
    const client = createClient(db, { firstName: 'Case', lastName: `Test${i}`, phone: `414555920${i}`, brandSlug: 'prosperity' }, 'Loretta Stewart');
    const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: body, MessageSid: `SM_yes_case_${i}` }, OK_REVIEW_SEND_DEPS);
    assert.equal(result.consentAction, 'review_requested', `"${body}" must be recognized as YES`);
  }
});

// START/UNSTOP: the general Twilio-standard re-subscribe keywords, a
// different signal than this campaign's own "reply YES" prompt -- these
// must keep granting consent alone, with NO automatic booking-link send.
test('a plain START or UNSTOP still grants consent only, with NO automatic booking-link reply', () => {
  const db = setup();
  for (const [i, body] of ['START', 'UNSTOP'].entries()) {
    const client = createClient(db, { firstName: 'Start', lastName: `Only${i}`, phone: `414555922${i}`, brandSlug: 'prosperity' }, 'Loretta Stewart');
    const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: body, MessageSid: `SM_start_only_${i}` }, OK_REVIEW_SEND_DEPS);
    assert.equal(result.consentAction, 'opted_in', `"${body}" must still be recognized as plain consent, not a booking-link request`);
    assert.equal(result.reviewRequested, undefined);
    assert.equal(result.reviewBookingLinkPromise, undefined);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
    assert.equal(contact.sms_consent, 1);
    const detail = getClientDetail(db, client.contact.id);
    assert.equal(detail.smsThread.filter(m => m.direction === 'outbound').length, 0, `"${body}" must never automatically send the booking link`);
  }
});

test('an unrelated sentence merely containing "yes" is NOT treated as automatic consent', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Not', lastName: 'Consent', phone: '4145559210', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'yes I think so, thanks!', MessageSid: 'SM_yes_sentence_1' });
  assert.equal(result.consentAction, null, 'only a message whose ENTIRE body is "yes" counts');
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 0);
});

test('E. an Existing Client replying NO: SMS consent becomes NO, with timestamp/source recorded, distinct from STOP', () => {
  const db = setup();
  const client = createClient(db, {
    firstName: 'Renee', lastName: 'Jones', phone: '4145559102', brandSlug: 'prosperity', relationshipType: 'active_client',
  }, 'Loretta Stewart');
  db.prepare(`UPDATE contacts SET sms_consent = 1 WHERE id = ?`).run(client.contact.id); // e.g. consented previously, now declining

  const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'NO', MessageSid: 'SM_no_1' });
  assert.equal(result.consentAction, 'declined');
  assert.equal(result.autoTaskId, null, 'NO must not create an ordinary reply task, same as STOP/START/HELP');

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 0);
  assert.equal(contact.sms_consent_source, 'Inbound SMS');
  assert.ok(contact.sms_consent_at);
  assert.equal(contact.sms_opted_out_at, null, 'NO must NOT set the authoritative STOP/opt-out timestamp -- it is a lighter, separate signal');

  const detail = getClientDetail(db, client.contact.id);
  assert.ok(detail.smsThread.some(m => m.body === 'NO' && m.direction === 'inbound'));
});

test('F. STOP remains authoritative and unchanged -- still blocks future SMS even after a prior YES', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Renee', lastName: 'Jones', phone: '4145559103', brandSlug: 'prosperity' }, 'Loretta Stewart');
  handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'YES', MessageSid: 'SM_f_yes_1' });
  let contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 1);

  const stopResult = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'STOP', MessageSid: 'SM_f_stop_1' });
  assert.equal(stopResult.consentAction, 'opted_out');
  contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 0);
  assert.ok(contact.sms_opted_out_at, 'STOP must still set the authoritative opt-out timestamp');
  assert.throws(
    () => createDraft(db, { contactId: client.contact.id, channel: 'text', body: 'Hi again' }, 'Loretta Stewart'),
    /STOP/
  );
});

test('G. after YES, an ordinary Prosperity SMS passes the existing consent gate through the normal send system', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Renee', lastName: 'Jones', phone: '4145559104', brandSlug: 'prosperity' }, 'Loretta Stewart');
  handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'YES', MessageSid: 'SM_g_yes_1' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);

  const { checkConsentGate } = require('../lib/legacySmsSend');
  const gate = checkConsentGate(contact);
  assert.equal(gate.blocked, false, 'the SAME consent gate every other SMS in this CRM uses must now pass, with no special-casing needed');
});

// ── H: Existing Client replying REVIEW (Life Insurance Awareness Month) ────
// REVIEW is a reply option added to the Existing Client - Life Insurance
// Awareness Month SMS template: it grants SMS consent exactly like YES, AND
// also triggers an automated reply carrying the Prosperity booking link.

const OK_REVIEW_SEND_DEPS = { sendLegacySms: async (db, { contactId, body, fromNumber, messageType }) => {
  const twilioSid = 'SMfake-review-' + Math.random().toString(36).slice(2);
  const ins = db.prepare(`
    INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, twilio_sid, message_type)
    VALUES (?, 'outbound', ?, ?, ?, 'sent', ?, ?)
  `).run(contactId, fromNumber, PROSPERITY_NUMBER, body, twilioSid, messageType);
  return { ok: true, sms: db.prepare('SELECT * FROM sms_messages WHERE id = ?').get(ins.lastInsertRowid) };
}};

test('H. an Existing Client replying REVIEW: SMS consent becomes YES exactly like a plain YES, the reply is preserved in history, and the client receives the Prosperity booking link automatically', async () => {
  const db = setup();
  const client = createClient(db, {
    firstName: 'Renee', lastName: 'Jones', phone: '4145559105', brandSlug: 'prosperity', relationshipType: 'active_client',
  }, 'Loretta Stewart');
  assert.equal(client.contact.sms_consent, 0, 'starts with no consent on file');
  const contactBrandIdBefore = db.prepare(`SELECT id FROM contact_brands WHERE contact_id = ? AND status = 'Active'`).get(client.contact.id).id;

  const before = new Date();
  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'REVIEW', MessageSid: 'SM_review_1',
  }, OK_REVIEW_SEND_DEPS);

  assert.equal(result.consentAction, 'review_requested');
  assert.equal(result.reviewRequested, true);
  assert.equal(result.autoTaskId, null, 'REVIEW must not create an ordinary reply task, same as STOP/START/NO/HELP');

  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 1, 'REVIEW grants SMS consent exactly like YES');
  assert.equal(contact.sms_consent_source, 'Inbound SMS');
  assert.ok(contact.sms_consent_at);
  assert.ok(new Date(contact.sms_consent_at.replace(' ', 'T') + 'Z') >= new Date(before.getTime() - 2000), 'timestamp must reflect roughly now');
  assert.equal(contact.sms_opted_out_at, null);

  // Client remains assigned to the same brand -- REVIEW never reassigns.
  const contactBrandIdAfter = db.prepare(`SELECT id FROM contact_brands WHERE contact_id = ? AND status = 'Active'`).get(client.contact.id).id;
  assert.equal(contactBrandIdAfter, contactBrandIdBefore);

  const sendOutcome = await result.reviewBookingLinkPromise;
  assert.equal(sendOutcome.ok, true);

  const detail = getClientDetail(db, client.contact.id);
  assert.ok(detail.smsThread.some(m => m.body === 'REVIEW' && m.direction === 'inbound'), 'the inbound REVIEW message itself must be preserved in communication history');
  const bookingReplies = detail.smsThread.filter(m => m.direction === 'outbound' && m.body.includes(PROSPERITY_LIFE_INSURANCE_SHORT_BOOKING_URL));
  assert.equal(bookingReplies.length, 1, 'the automated booking-link reply must appear exactly once in SMS History -- no duplicate booking-link text');
});

test('Template Manager: renaming/rewording the Life Insurance Awareness Month SMS template via the Template Manager does NOT break REVIEW automation -- consent grant and the booking-link reply still work exactly the same afterward', async () => {
  const db = setup();
  // Rename it FIRST, via the exact same path crm/routes/crmActions.js's
  // PATCH /api/app/templates/:templateKey uses -- template_key/
  // sms_message_type are never touched by this.
  updateTemplate(db, {
    templateKey: 'existingClientLifeInsuranceAwarenessSms', channel: 'sms',
    label: 'Existing Client - Reconnect Life Insurance Awareness Month (renamed)',
    body: 'Hi {{first_name}}, completely reworded outbound message. Reply REVIEW for a policy review.',
  });

  const client = createClient(db, {
    firstName: 'Priya', lastName: 'Renamed', phone: '4145559120', brandSlug: 'prosperity', relationshipType: 'active_client',
  }, 'Loretta Stewart');

  const result = handleInboundSmsUnified(db, {
    From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'REVIEW', MessageSid: 'SM_review_renamed_1',
  }, OK_REVIEW_SEND_DEPS);

  assert.equal(result.consentAction, 'review_requested');
  assert.equal(result.reviewRequested, true);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 1, 'REVIEW still grants SMS consent after the template was renamed');
  assert.equal(contact.sms_consent_source, 'Inbound SMS');

  const sendOutcome = await result.reviewBookingLinkPromise;
  assert.equal(sendOutcome.ok, true, 'the automated booking-link reply still fires after the template was renamed');

  const detail = getClientDetail(db, client.contact.id);
  const bookingReplies = detail.smsThread.filter(m => m.direction === 'outbound' && m.body.includes(PROSPERITY_LIFE_INSURANCE_SHORT_BOOKING_URL));
  assert.equal(bookingReplies.length, 1);
});

test('REVIEW is matched case-insensitively and tolerates surrounding whitespace ("Review", "review", " REVIEW ")', () => {
  const db = setup();
  for (const [i, body] of ['Review', 'review', ' REVIEW '].entries()) {
    const client = createClient(db, { firstName: 'Case', lastName: `ReviewTest${i}`, phone: `414555921${i}`, brandSlug: 'prosperity' }, 'Loretta Stewart');
    const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: body, MessageSid: `SM_review_case_${i}` }, OK_REVIEW_SEND_DEPS);
    assert.equal(result.consentAction, 'review_requested', `"${body}" must be recognized as REVIEW`);
  }
});

test('an unrelated sentence merely containing "review" is NOT treated as the REVIEW command', () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Not', lastName: 'ReviewCommand', phone: '4145559215', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'I would like a review sometime', MessageSid: 'SM_review_sentence_1' });
  assert.equal(result.consentAction, null, 'only a message whose ENTIRE body is "review" counts');
  assert.equal(result.reviewRequested, undefined);
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contact.sms_consent, 0);
});

// 2026-09-16: superseded by test D above (YES now triggers the same
// automated booking-link reply as REVIEW) -- kept here, inverted, as an
// explicit regression guard against ever silently reverting to the old
// YES-is-consent-only behavior.
test('YES now DOES trigger the automated booking-link reply, exactly like REVIEW', async () => {
  const db = setup();
  const client = createClient(db, { firstName: 'Yes', lastName: 'Only', phone: '4145559106', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const result = handleInboundSmsUnified(db, { From: client.contact.phone_e164, To: PROSPERITY_NUMBER, Body: 'YES', MessageSid: 'SM_yes_only_1' }, OK_REVIEW_SEND_DEPS);
  assert.equal(result.consentAction, 'review_requested');
  assert.equal(result.reviewRequested, true);
  const sendOutcome = await result.reviewBookingLinkPromise;
  assert.equal(sendOutcome.ok, true);
  const detail = getClientDetail(db, client.contact.id);
  const bookingReplies = detail.smsThread.filter(m => m.direction === 'outbound' && m.body.includes(PROSPERITY_LIFE_INSURANCE_SHORT_BOOKING_URL));
  assert.equal(bookingReplies.length, 1, 'a YES must automatically send the booking link exactly once');
});

test('SCENARIO 14: both inbound endpoint paths remain behaviorally identical (same shared handler, same outcome)', () => {
  const db1 = setup();
  const db2 = setup();
  const client1 = createClient(db1, { firstName: 'Zane', lastName: 'Abara', phone: '4145559070', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const client2 = createClient(db2, { firstName: 'Zane', lastName: 'Abara', phone: '4145559070', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const params = { From: '+14145559070', To: PROSPERITY_NUMBER, Body: 'same message', MessageSid: 'SM_alias_check_1' };
  const resultViaAuthoritative = handleInboundSmsUnified(db1, params);
  const resultViaAlias = handleInboundSmsUnified(db2, params);
  assert.equal(resultViaAuthoritative.outcome, resultViaAlias.outcome);
  assert.equal(resultViaAuthoritative.contactBrandId !== null, resultViaAlias.contactBrandId !== null);
});
