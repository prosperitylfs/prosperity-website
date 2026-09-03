// Tests for crm/lib/gmailSend.js -- extracted from crm/routes/email.js's
// POST /send handler (see that module's own header comment) so it can be
// reused by crm/lib/existingClientOutreach.js without duplicating it. Fake
// Gmail client injected via deps -- never imports the real `googleapis`
// network path.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { sendGmailEmail } = require('../lib/gmailSend');

function fakeDeps(behavior = 'ok') {
  const sentParams = [];
  return {
    deps: {
      authedClientFactory: () => ({}),
      gmailClientFactory: () => ({
        users: {
          messages: {
            send: async (params) => {
              sentParams.push(params);
              if (behavior === 'fail') throw new Error('Gmail API error');
              return { data: { id: 'gmail-fake-1', threadId: 'thread-fake-1' } };
            },
          },
        },
      }),
    },
    sentParams,
  };
}

function seedContact(db) {
  return db.prepare(`
    INSERT INTO contacts (first_name, last_name, email) VALUES ('Renee', 'Jones', 'renee@example.com')
  `).run().lastInsertRowid;
}

test('sendGmailEmail sends via the injected fake client and returns the Gmail message id', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps } = fakeDeps('ok');

  const result = await sendGmailEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Hello', body: 'Body text' }, deps);
  assert.equal(result.gmailMessageId, 'gmail-fake-1');
  assert.equal(result.threadId, 'thread-fake-1');
});

test('sendGmailEmail logs the send to BOTH the emails table and the communications timeline', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps } = fakeDeps('ok');

  await sendGmailEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Hello', body: 'Body text' }, deps);

  const emailRow = db.prepare('SELECT * FROM emails WHERE contact_id = ?').get(contactId);
  assert.ok(emailRow);
  assert.equal(emailRow.direction, 'outbound');
  assert.equal(emailRow.status, 'sent');
  assert.equal(emailRow.gmail_message_id, 'gmail-fake-1');
  assert.equal(emailRow.thread_id, 'thread-fake-1');

  const commRow = db.prepare(`SELECT * FROM communications WHERE contact_id = ? AND comm_type = 'email'`).get(contactId);
  assert.ok(commRow);
  assert.equal(commRow.direction, 'outbound');
  assert.equal(commRow.external_id, 'gmail-fake-1');
});

test('sendGmailEmail truncates a long body to a preview when logging, without affecting what was actually sent', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps, sentParams } = fakeDeps('ok');
  const longBody = 'x'.repeat(500);

  await sendGmailEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Long', body: longBody }, deps);

  const emailRow = db.prepare('SELECT body FROM emails WHERE contact_id = ?').get(contactId);
  assert.ok(emailRow.body.length < longBody.length, 'the LOGGED copy must be truncated to a preview');
  assert.equal(sentParams.length, 1);
  // The actual raw MIME message passed to the fake Gmail client must still
  // carry the FULL, untruncated body -- decode the base64url raw payload.
  const raw = Buffer.from(sentParams[0].requestBody.raw, 'base64url').toString('utf8');
  assert.ok(raw.includes(longBody), 'the message actually sent must never be truncated, only the logged preview');
});

test('sendGmailEmail with no contactId sends but logs nothing (matches the original route\'s optional contact_id)', async () => {
  const db = createLegacyDb();
  const { deps } = fakeDeps('ok');
  const result = await sendGmailEmail(db, { toEmail: 'nobody-tracked@example.com', subject: 'Hi', body: 'Body' }, deps);
  assert.ok(result.gmailMessageId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM communications').get().n, 0);
});

test('sendGmailEmail propagates a Gmail API failure to the caller (never silently swallowed)', async () => {
  const db = createLegacyDb();
  const contactId = seedContact(db);
  const { deps } = fakeDeps('fail');
  await assert.rejects(
    () => sendGmailEmail(db, { contactId, toEmail: 'renee@example.com', subject: 'Hi', body: 'Body' }, deps),
    /Gmail API error/
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 0, 'a failed send must not log a fake "sent" row');
});
