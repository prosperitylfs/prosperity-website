// Fixes the Sync Replies mailbox-matching bug: the previous implementation
// (crm/routes/email.js's POST /sync) searched Gmail broadly via
// `from:<contact.email>` across the ENTIRE mailbox, with maxResults: 50 and
// no thread/reply boundary at all. That pulled in any historical email ever
// sent from that address -- including messages with nothing to do with
// this CRM contact's conversation -- and persisted them into this
// contact's Email History.
//
// Fixed behavior: a reply is only ever imported if it lives inside a Gmail
// thread the CRM already knows belongs to this contact -- specifically, a
// thread that has at least one OUTBOUND email row for this contact
// (direction='outbound' in the `emails` table, i.e. an email the CRM
// itself sent them via POST /send, which already stores thread_id -- no
// schema change needed). A thread is never "known" purely because an
// inbound row happens to reference it, so even an already-bad-imported row
// from before this fix can never seed/expand into further wrong imports.
//
// Within a known thread, only messages whose From header is actually the
// contact's address are imported -- guards against a thread that includes
// another participant (e.g. a CC'd party).
//
// deps.getGmailClient lets tests inject a fully mocked Gmail client --
// mirrors the exact pattern already used in crm/lib/taskCalendarSync.js
// (deps.getCalendarClient) and crm/lib/providers/liveTwilioAdapter.js. The
// real googleapis client is never constructed by this module itself --
// crm/routes/email.js passes it in, exactly as it already did before this
// fix.

function getKnownThreadIds(db, contactId) {
  return db.prepare(`
    SELECT DISTINCT thread_id FROM emails
    WHERE contact_id = ? AND direction = 'outbound' AND thread_id IS NOT NULL
  `).all(contactId).map(r => r.thread_id);
}

function extractHeader(headers, name) {
  return (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

// Pulls the bare address out of a From header, which may be either a bare
// address ("jane@example.com") or a display-name form
// ("Jane Doe <jane@example.com>").
function extractEmailAddress(headerValue) {
  const match = /<([^>]+)>/.exec(headerValue || '');
  return (match ? match[1] : (headerValue || '')).trim().toLowerCase();
}

// Exact match only -- NOT a substring check. "not-jane@example.com"
// literally contains "jane@example.com" as a substring, so a `.includes()`
// comparison would wrongly treat it as a match; this was caught by this
// module's own test suite before shipping.
function isFromContact(fromHeader, contactEmail) {
  if (!fromHeader || !contactEmail) return false;
  return extractEmailAddress(fromHeader) === contactEmail.trim().toLowerCase();
}

// Recursively extract plain-text body from a Gmail MIME payload tree.
// Moved verbatim from crm/routes/email.js -- only ever used by the sync
// path (POST /send never calls it), so it now lives where it's used.
function extractGmailBody(payload) {
  if (!payload) return '';
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64url').toString('utf-8');
  }
  if (payload.parts) {
    // Prefer text/plain; fall back to text/html (stripped)
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8');
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64url').toString('utf-8')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    // Recurse into nested multipart (multipart/alternative, multipart/mixed, etc.)
    for (const part of payload.parts) {
      const text = extractGmailBody(part);
      if (text) return text;
    }
  }
  return '';
}

// Returns { imported, skipped, scanned, threadsChecked }. Never throws for
// a single bad/inaccessible thread (e.g. deleted in Gmail since it was
// recorded) -- that thread is skipped and the sync continues with the
// contact's other known threads.
async function syncContactEmailReplies(db, contact, deps = {}) {
  if (!deps.getGmailClient) {
    throw new Error('syncContactEmailReplies: deps.getGmailClient is required');
  }
  const gmail = deps.getGmailClient();

  const threadIds = getKnownThreadIds(db, contact.id);
  let imported = 0;
  let skipped = 0;
  let scanned = 0;

  for (const threadId of threadIds) {
    let threadRes;
    try {
      threadRes = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
    } catch (err) {
      continue;
    }

    for (const msg of (threadRes.data.messages || [])) {
      scanned++;
      const headers = msg.payload.headers || [];
      const fromEmail = extractHeader(headers, 'From');
      if (!isFromContact(fromEmail, contact.email)) continue;

      const existing = db.prepare('SELECT id FROM emails WHERE gmail_message_id = ?').get(msg.id);
      if (existing) { skipped++; continue; }

      const toEmail = extractHeader(headers, 'To');
      const subject = extractHeader(headers, 'Subject');

      let receivedAt;
      try { receivedAt = new Date(extractHeader(headers, 'Date')).toISOString(); } catch { /* fall through */ }
      if (!receivedAt || receivedAt === 'Invalid Date') {
        receivedAt = new Date(parseInt(msg.internalDate, 10)).toISOString();
      }

      const bodyText = extractGmailBody(msg.payload);
      const preview = bodyText.slice(0, 500).trim();

      db.prepare(`
        INSERT OR IGNORE INTO emails
          (contact_id, from_email, to_email, subject, body, status,
           gmail_message_id, thread_id, direction, sent_at)
        VALUES (?, ?, ?, ?, ?, 'received', ?, ?, 'inbound', ?)
      `).run(contact.id, fromEmail, toEmail, subject, preview, msg.id, threadId, receivedAt);

      imported++;
    }
  }

  return { imported, skipped, scanned, threadsChecked: threadIds.length };
}

module.exports = { syncContactEmailReplies, getKnownThreadIds, isFromContact, extractGmailBody };
