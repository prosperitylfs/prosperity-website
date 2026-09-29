// Tests for crm/lib/msGraphSend.js -- the "send one email via Microsoft
// Graph + log it" primitive for the Insurance Lady mailbox. Fake token
// source and fake fetch injected via deps -- never imports
// @azure/msal-node's real network path or touches a live Microsoft
// account, mirroring crm/test/gmailSend.test.js's own approach.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { sendMsGraphEmail, GRAPH_SEND_MAIL_URL } = require('../lib/msGraphSend');

const FAKE_ACCESS_TOKEN = 'fake-access-token-value-should-never-be-logged';

function fakeDeps({ tokenBehavior = 'ok', fetchBehavior = 'ok' } = {}) {
  const fetchCalls = [];
  return {
    deps: {
      acquireGraphAccessToken: async () => {
        if (tokenBehavior === 'not_configured') {
          const err = new Error('Microsoft Graph email is not configured (missing environment variable(s): MICROSOFT_TENANT_ID).');
          err.status = 503;
          throw err;
        }
        if (tokenBehavior === 'not_authorized') {
          const err = new Error('The Insurance Lady mailbox has not yet been authorized for Microsoft Graph email. Visit /api/ms-email/auth to connect it.');
          err.status = 503;
          throw err;
        }
        return FAKE_ACCESS_TOKEN;
      },
      fetch: async (url, options) => {
        fetchCalls.push({ url, options });
        if (fetchBehavior === 'fail') {
          return { ok: false, status: 403, text: async () => 'Access is denied. Check credentials and try again.' };
        }
        return { ok: true, status: 202, text: async () => '' };
      },
    },
    fetchCalls,
  };
}

function seedContact(db) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, email) VALUES ('Renee', 'Jones', 'renee@example.com')
  `).run().lastInsertRowid;
}

test('sendMsGraphEmail POSTs to the correct Graph endpoint, with a Bearer token header and the expected JSON body shape', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps, fetchCalls } = fakeDeps();

  await sendMsGraphEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Hello', body: 'Body text' }, deps);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, GRAPH_SEND_MAIL_URL);
  assert.equal(fetchCalls[0].options.method, 'POST');
  assert.equal(fetchCalls[0].options.headers.Authorization, `Bearer ${FAKE_ACCESS_TOKEN}`);
  const payload = JSON.parse(fetchCalls[0].options.body);
  assert.equal(payload.message.subject, 'Hello');
  assert.equal(payload.message.body.content, 'Body text');
  assert.equal(payload.message.toRecipients[0].emailAddress.address, 'renee@example.com');
  assert.equal(payload.saveToSentItems, true);
});

test('sendMsGraphEmail logs the send to BOTH the emails table (with from_email set to the Insurance Lady address) and the communications timeline', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps } = fakeDeps();

  await sendMsGraphEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Hello', body: 'Body text' }, deps);

  const emailRow = db.prepare('SELECT * FROM emails WHERE contact_id = ?').get(contactId);
  assert.ok(emailRow);
  assert.equal(emailRow.direction, 'outbound');
  assert.equal(emailRow.status, 'sent');
  assert.equal(emailRow.from_email, 'loretta@insuranceladyllc.com');
  assert.equal(emailRow.gmail_message_id, null, 'Graph sendMail returns no message id -- this column stays NULL, exactly like every other non-Gmail row');

  const commRow = db.prepare(`SELECT * FROM communications WHERE contact_id = ? AND comm_type = 'email'`).get(contactId);
  assert.ok(commRow);
  assert.equal(commRow.direction, 'outbound');
});

test('sendMsGraphEmail truncates a long body to a preview when logging, without affecting what was actually sent', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps, fetchCalls } = fakeDeps();
  const longBody = 'x'.repeat(500);

  await sendMsGraphEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Long', body: longBody }, deps);

  const emailRow = db.prepare('SELECT body FROM emails WHERE contact_id = ?').get(contactId);
  assert.ok(emailRow.body.length < longBody.length, 'the LOGGED copy must be truncated to a preview');
  const payload = JSON.parse(fetchCalls[0].options.body);
  assert.equal(payload.message.body.content, longBody, 'the message actually sent must never be truncated, only the logged preview');
});

test('sendMsGraphEmail with no contactId sends but logs nothing (matches sendGmailEmail\'s identical optional contactId behavior)', async () => {
  const db = createLegacyDb();
  const { deps } = fakeDeps();
  const result = await sendMsGraphEmail(db, { toEmail: 'nobody-tracked@example.com', subject: 'Hi', body: 'Body' }, deps);
  assert.ok(result.sentAt);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM communications').get().n, 0);
});

test('sendMsGraphEmail stamps appointment_id/message_type/appointment_occurrence_at when supplied, and leaves them NULL when omitted', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps } = fakeDeps();

  await sendMsGraphEmail(db, {
    contactId, toEmail: 'renee@example.com', subject: 'Reminder', body: 'Body',
    appointmentId: 42, messageType: 'reminder_24h', appointmentOccurrenceAt: '2026-11-01T18:00:00.000Z',
  }, deps);

  const row = db.prepare('SELECT appointment_id, message_type, appointment_occurrence_at FROM emails WHERE contact_id = ?').get(contactId);
  assert.equal(row.appointment_id, 42);
  assert.equal(row.message_type, 'reminder_24h');
  assert.equal(row.appointment_occurrence_at, '2026-11-01T18:00:00.000Z');
});

test('a Graph API failure (non-2xx response) throws, and the thrown message never contains the access token -- only Graph\'s own status/response text', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps } = fakeDeps({ fetchBehavior: 'fail' });

  await assert.rejects(
    () => sendMsGraphEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Hi', body: 'Body' }, deps),
    (err) => {
      assert.match(err.message, /Microsoft Graph sendMail failed \(HTTP 403\)/);
      assert.match(err.message, /Access is denied/);
      assert.doesNotMatch(err.message, new RegExp(FAKE_ACCESS_TOKEN));
      return true;
    }
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 0, 'a failed send must not log a fake "sent" row');
});

test('token acquisition failure ("not configured") propagates as a clear, non-secret-bearing thrown error, and no fetch call is ever attempted', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps, fetchCalls } = fakeDeps({ tokenBehavior: 'not_configured' });

  await assert.rejects(
    () => sendMsGraphEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Hi', body: 'Body' }, deps),
    /Microsoft Graph email is not configured/
  );
  assert.equal(fetchCalls.length, 0, 'must never attempt an HTTP call when a token could not be acquired at all');
});

test('token acquisition failure ("not yet authorized") propagates with guidance to visit /api/ms-email/auth', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps } = fakeDeps({ tokenBehavior: 'not_authorized' });

  await assert.rejects(
    () => sendMsGraphEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Hi', body: 'Body' }, deps),
    /not yet been authorized.*\/api\/ms-email\/auth/
  );
});
