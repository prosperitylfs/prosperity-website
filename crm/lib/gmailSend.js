// Shared "send one email via Gmail + log it" primitive, extracted from
// crm/routes/email.js's POST /send handler so the exact same
// authorize-then-send-then-log behavior can be reused by an automated
// sender (crm/lib/existingClientOutreach.js) without duplicating it --
// mirrors crm/lib/legacySmsSend.js's own extraction (see that file's header
// comment for the identical reasoning). crm/routes/email.js's /send route
// now delegates to sendGmailEmail() below; its own HTTP contract (status
// codes, error text, response shape) is unchanged.
//
// Single Gmail identity only (loretta@prosperitylfs.com / GMAIL_* env vars)
// -- this is the Prosperity email identity (crm/config/brands.js); there is
// no Insurance Lady Gmail integration to accidentally reach here.
//
// deps.gmailClientFactory / deps.authedClientFactory let tests substitute a
// fake Gmail client without ever importing the real `googleapis` package or
// touching a live account -- same injection idea as
// crm/lib/legacySmsSend.js's deps.twilioClientFactory.

const { google } = require('googleapis');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];

function fromName() { return process.env.GMAIL_FROM_NAME || 'Loretta Stewart'; }
function fromAddr() { return process.env.GMAIL_FROM || 'loretta@prosperitylfs.com'; }

function makeClient() {
  const redirectUri =
    process.env.GMAIL_REDIRECT_URI ||
    (process.env.APP_URL
      ? `${process.env.APP_URL}/api/email/callback`
      : 'http://localhost:3001/api/email/callback');

  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri
  );
}

function authedClient() {
  if (!process.env.GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail not authorised. Visit /api/email/auth to complete setup.');
  }
  const client = makeClient();
  client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return client;
}

function isConfigured() {
  return !!(
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
  );
}

// Returns { gmailMessageId, threadId }. Throws on any failure (auth not
// configured, Gmail API error) -- callers catch and translate, exactly like
// the original route's try/catch did.
//
// contactId is optional (omit to send without logging anywhere, matching
// the original route's `if (contact_id) { ... }` guard) -- every existing
// caller (crm/routes/email.js) always supplies one.
async function sendGmailEmail(db, { contactId = null, toEmail, subject, body }, deps = {}) {
  const auth = deps.authedClientFactory ? deps.authedClientFactory() : authedClient();
  const gmail = deps.gmailClientFactory ? deps.gmailClientFactory(auth) : google.gmail({ version: 'v1', auth });

  const raw = [
    `From: ${fromName()} <${fromAddr()}>`,
    `To: ${toEmail}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].join('\r\n');

  const result = await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: Buffer.from(raw).toString('base64url') },
  });

  const gmailMessageId = result.data.id;
  const threadId = result.data.threadId || null;
  const preview = body.length > 400 ? body.slice(0, 397) + '…' : body;

  if (contactId) {
    db.prepare(`
      INSERT OR IGNORE INTO emails
        (contact_id, to_email, subject, body, status, gmail_message_id, thread_id, direction)
      VALUES (?, ?, ?, ?, 'sent', ?, ?, 'outbound')
    `).run(contactId, toEmail, subject, preview, gmailMessageId, threadId);

    // Also land in the communications timeline (activity feed excludes comm_type='email')
    db.prepare(`
      INSERT INTO communications (contact_id, comm_type, direction, subject, body, status, external_id)
      VALUES (?, 'email', 'outbound', ?, ?, 'sent', ?)
    `).run(contactId, subject, preview, gmailMessageId);
  }

  return { gmailMessageId, threadId };
}

module.exports = { sendGmailEmail, isConfigured, makeClient, authedClient, SCOPES };
