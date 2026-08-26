// Tests for crm/lib/emailReplySync.js -- the fix for the Sync Replies bug
// where unrelated historical mailbox messages (e.g. old April emails
// sharing the contact's Gmail address) were imported into a CRM contact's
// Email History. Every test injects a fully mocked Gmail client via
// deps.getGmailClient -- the real 'googleapis' client is never constructed
// or contacted, mirroring the exact pattern already proven in
// crm/test/taskCalendarSync.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createFreshDb } = require('../testSupport/legacyDb');
const {
  syncContactEmailReplies, getKnownThreadIds, isFromContact,
} = require('../lib/emailReplySync');

function setup() {
  const db = createFreshDb();
  db.exec(`
    CREATE TABLE contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT
    );
    CREATE TABLE emails (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id       INTEGER,
      to_email         TEXT,
      from_email       TEXT,
      subject          TEXT,
      body             TEXT,
      status           TEXT DEFAULT 'sent',
      gmail_message_id TEXT,
      thread_id        TEXT,
      direction        TEXT NOT NULL DEFAULT 'outbound',
      sent_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX idx_emails_gmail_msg_id ON emails(gmail_message_id) WHERE gmail_message_id IS NOT NULL;
  `);
  return db;
}

function insertContact(db, email) {
  return db.prepare('INSERT INTO contacts (email) VALUES (?)').run(email).lastInsertRowid;
}

function insertOutboundEmail(db, contactId, { threadId, gmailMessageId, toEmail = 'x@example.com' }) {
  db.prepare(`
    INSERT INTO emails (contact_id, to_email, subject, body, status, gmail_message_id, thread_id, direction)
    VALUES (?, ?, 'CRM sent this', 'body', 'sent', ?, ?, 'outbound')
  `).run(contactId, toEmail, gmailMessageId, threadId);
}

function insertInboundEmail(db, contactId, { threadId, gmailMessageId, fromEmail }) {
  db.prepare(`
    INSERT INTO emails (contact_id, from_email, subject, body, status, gmail_message_id, thread_id, direction)
    VALUES (?, ?, 'a reply', 'body', 'received', ?, ?, 'inbound')
  `).run(contactId, fromEmail, gmailMessageId, threadId);
}

// A message shaped exactly like a real Gmail API threads.get() message.
function gmailMessage({ id, from, to = 'loretta@prosperitylfs.com', subject = 'Re: Hello', dateMs = Date.now() }) {
  return {
    id,
    internalDate: String(dateMs),
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject },
        { name: 'Date', value: new Date(dateMs).toUTCString() },
      ],
      body: { data: Buffer.from('reply body text').toString('base64url') },
    },
  };
}

// Mock Gmail client: threads.get(id) returns whatever's registered for that
// thread id; any thread id not registered throws (simulating "the CRM never
// pulled that thread" -- and proving the fix never even asks Gmail about
// threads it doesn't already know belong to this contact).
function mockGmail(threadsById) {
  const calls = { threadsGet: [] };
  const client = {
    users: {
      threads: {
        get: async ({ id }) => {
          calls.threadsGet.push(id);
          if (!threadsById[id]) {
            const err = new Error('Not Found'); err.code = 404; throw err;
          }
          return { data: { messages: threadsById[id] } };
        },
      },
    },
  };
  return { calls, deps: { getGmailClient: () => client } };
}

// ── Pure helpers ─────────────────────────────────────────────────────────

test('isFromContact matches case-insensitively and rejects unrelated addresses', () => {
  assert.equal(isFromContact('Jane Doe <jane@example.com>', 'jane@example.com'), true);
  assert.equal(isFromContact('JANE@EXAMPLE.COM', 'jane@example.com'), true);
  assert.equal(isFromContact('someone-else@example.com', 'jane@example.com'), false);
  assert.equal(isFromContact('', 'jane@example.com'), false);
});

test('getKnownThreadIds returns only threads seeded by an OUTBOUND (CRM-sent) email for this contact', () => {
  const db = setup();
  const cid = insertContact(db, 'jane@example.com');
  insertOutboundEmail(db, cid, { threadId: 'thread-good', gmailMessageId: 'sent-1' });
  // An inbound-only row (e.g. a bad historical import) must never seed a
  // "known" thread on its own -- this is exactly what stops an already-bad
  // row from poisoning future syncs even before any cleanup happens.
  insertInboundEmail(db, cid, { threadId: 'thread-bad-inbound-only', gmailMessageId: 'bad-1', fromEmail: 'jane@example.com' });

  const known = getKnownThreadIds(db, cid);
  assert.deepEqual(known, ['thread-good']);
});

// ── A/B: existing CRM-sent email and existing legitimate reply are untouched ──

test('A/B: an existing outbound email and an already-synced inbound reply are both preserved by a further sync', async () => {
  const db = setup();
  const cid = insertContact(db, 'jane@example.com');
  insertOutboundEmail(db, cid, { threadId: 't1', gmailMessageId: 'sent-1' });
  insertInboundEmail(db, cid, { threadId: 't1', gmailMessageId: 'reply-1', fromEmail: 'jane@example.com' });

  const { deps } = mockGmail({ t1: [gmailMessage({ id: 'reply-1', from: 'jane@example.com' })] });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
  await syncContactEmailReplies(db, contact, deps);

  const rows = db.prepare('SELECT * FROM emails WHERE contact_id = ? ORDER BY id').all(cid);
  assert.equal(rows.length, 2, 'both the original send and the original reply must still be present, not duplicated or removed');
  assert.equal(rows[0].direction, 'outbound');
  assert.equal(rows[1].direction, 'inbound');
  assert.equal(rows[1].gmail_message_id, 'reply-1');
});

// ── C/F: Sync Replies still works for a genuine reply in a CRM-known thread ──

test('C/F: a genuine new reply inside a known (CRM-sent) thread is imported', async () => {
  const db = setup();
  const cid = insertContact(db, 'jane@example.com');
  insertOutboundEmail(db, cid, { threadId: 't1', gmailMessageId: 'sent-1' });

  const { deps } = mockGmail({
    t1: [
      gmailMessage({ id: 'sent-1', from: 'loretta@prosperitylfs.com', to: 'jane@example.com' }),
      gmailMessage({ id: 'reply-1', from: 'jane@example.com', subject: 'Re: Hello' }),
    ],
  });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
  const result = await syncContactEmailReplies(db, contact, deps);

  assert.equal(result.imported, 1, 'the CRM"s own outbound copy in the thread must not be re-imported as a new row, only the genuine reply');
  const reply = db.prepare(`SELECT * FROM emails WHERE gmail_message_id = 'reply-1'`).get();
  assert.ok(reply);
  assert.equal(reply.contact_id, cid);
  assert.equal(reply.direction, 'inbound');
});

// ── D: unrelated historical emails are never imported ────────────────────

test('D: an unrelated historical email from the same address, in a thread the CRM never sent, is NOT imported', async () => {
  const db = setup();
  const cid = insertContact(db, 'jane@example.com');
  // No outbound row at all for this contact -- simulates the reported bug
  // scenario where old April emails share the contact's address but were
  // never part of any CRM-initiated conversation.
  const { deps, calls } = mockGmail({
    'old-april-thread': [gmailMessage({ id: 'old-1', from: 'jane@example.com', subject: 'Fwd: Athene PE 10' })],
  });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
  const result = await syncContactEmailReplies(db, contact, deps);

  assert.equal(result.imported, 0);
  assert.equal(result.threadsChecked, 0, 'a contact with no CRM-sent email has no known threads to check at all');
  assert.deepEqual(calls.threadsGet, [], 'Gmail must never even be asked about a thread the CRM did not itself send');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails WHERE contact_id = ?').get(cid).n, 0);
});

test('D (residual bad data): a thread only ever referenced by a prior BAD inbound import is still never re-expanded', async () => {
  const db = setup();
  const cid = insertContact(db, 'jane@example.com');
  // Simulates the state left behind by the old bug: a wrongly-imported
  // inbound row already sits in the table, referencing an unrelated thread.
  insertInboundEmail(db, cid, { threadId: 'old-april-thread', gmailMessageId: 'old-1', fromEmail: 'jane@example.com' });

  const { deps, calls } = mockGmail({
    'old-april-thread': [
      gmailMessage({ id: 'old-1', from: 'jane@example.com', subject: 'Fwd: Athene PE 10' }),
      gmailMessage({ id: 'old-2', from: 'jane@example.com', subject: 'Fwd: Axonic Trailhead' }),
    ],
  });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
  const result = await syncContactEmailReplies(db, contact, deps);

  assert.equal(result.imported, 0, 'the already-bad thread must not be re-scanned, so it can never pull in old-2 either');
  assert.deepEqual(calls.threadsGet, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails WHERE contact_id = ?').get(cid).n, 1, 'only the single pre-existing bad row remains -- nothing new was added');
});

// ── G: no duplicates from clicking Sync Replies multiple times ───────────

test('G: calling sync twice for the same thread content never creates duplicate rows', async () => {
  const db = setup();
  const cid = insertContact(db, 'jane@example.com');
  insertOutboundEmail(db, cid, { threadId: 't1', gmailMessageId: 'sent-1' });

  const { deps } = mockGmail({
    t1: [gmailMessage({ id: 'reply-1', from: 'jane@example.com' })],
  });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);

  const first = await syncContactEmailReplies(db, contact, deps);
  const second = await syncContactEmailReplies(db, contact, deps);

  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.skipped, 1);
  const rows = db.prepare(`SELECT * FROM emails WHERE gmail_message_id = 'reply-1'`).all();
  assert.equal(rows.length, 1, 'clicking Sync Replies again must never create a second row for the same message');
});

// ── H: cross-contact isolation ────────────────────────────────────────────

test('H: syncing one contact never imports into or reads another contact\'s thread', async () => {
  const db = setup();
  const cidA = insertContact(db, 'jane@example.com');
  const cidB = insertContact(db, 'other@example.com');
  insertOutboundEmail(db, cidA, { threadId: 't-A', gmailMessageId: 'sent-A' });
  insertOutboundEmail(db, cidB, { threadId: 't-B', gmailMessageId: 'sent-B' });

  const { deps, calls } = mockGmail({
    't-A': [gmailMessage({ id: 'reply-A', from: 'jane@example.com' })],
    't-B': [gmailMessage({ id: 'reply-B', from: 'other@example.com' })],
  });

  const contactA = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cidA);
  await syncContactEmailReplies(db, contactA, deps);

  assert.deepEqual(calls.threadsGet, ['t-A'], 'syncing contact A must never even look at thread B');
  const bRows = db.prepare('SELECT * FROM emails WHERE contact_id = ?').all(cidB);
  assert.equal(bRows.length, 1, 'contact B must still have only its own original outbound row -- nothing from A\'s sync leaked in');
  const aReply = db.prepare(`SELECT * FROM emails WHERE gmail_message_id = 'reply-A'`).get();
  assert.equal(aReply.contact_id, cidA);
});

test('H: a message in a known thread from a DIFFERENT address than the contact is not imported (e.g. a CC\'d third party)', async () => {
  const db = setup();
  const cid = insertContact(db, 'jane@example.com');
  insertOutboundEmail(db, cid, { threadId: 't1', gmailMessageId: 'sent-1' });

  const { deps } = mockGmail({
    t1: [gmailMessage({ id: 'from-someone-else', from: 'not-jane@example.com' })],
  });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
  const result = await syncContactEmailReplies(db, contact, deps);

  assert.equal(result.imported, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails WHERE contact_id = ?').get(cid).n, 1);
});

// ── Resilience ─────────────────────────────────────────────────────────

test('a thread that 404s (e.g. deleted in Gmail since it was recorded) is skipped, not fatal to the rest of the sync', async () => {
  const db = setup();
  const cid = insertContact(db, 'jane@example.com');
  insertOutboundEmail(db, cid, { threadId: 't-missing', gmailMessageId: 'sent-1' });
  insertOutboundEmail(db, cid, { threadId: 't-ok', gmailMessageId: 'sent-2' });

  const { deps } = mockGmail({
    't-ok': [gmailMessage({ id: 'reply-ok', from: 'jane@example.com' })],
    // 't-missing' intentionally not registered -> throws 404 in the mock
  });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
  const result = await syncContactEmailReplies(db, contact, deps);

  assert.equal(result.imported, 1);
  assert.ok(db.prepare(`SELECT * FROM emails WHERE gmail_message_id = 'reply-ok'`).get());
});
