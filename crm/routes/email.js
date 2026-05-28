// Email route — Gmail API via OAuth 2.0

const express      = require('express');
const router       = express.Router();
const db           = require('../db/database');
const { google }   = require('googleapis');

const SCOPES    = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
];
const FROM_NAME = process.env.GMAIL_FROM_NAME || 'Loretta Stewart';
const FROM_ADDR = process.env.GMAIL_FROM      || 'loretta@prosperitylfs.com';

// ─── OAuth helpers ─────────────────────────────────────────────────────────────

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

// ─── GET /api/email/status ─────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json({ configured: isConfigured(), from_email: FROM_ADDR, from_name: FROM_NAME });
});

// ─── GET /api/email/auth — start one-time OAuth flow ──────────────────────────

router.get('/auth', (req, res) => {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    return res.status(503).send(page('Gmail not configured',
      `<p>Add <code>GMAIL_CLIENT_ID</code> and <code>GMAIL_CLIENT_SECRET</code> to your environment variables, then visit this page again.</p>
       <p><a href="/">Back to CRM</a></p>`));
  }

  const url = makeClient().generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',        // always re-prompt so we always get a refresh_token
  });
  res.redirect(url);
});

// ─── GET /api/email/callback — receive OAuth code, show refresh token ──────────

router.get('/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) return res.status(400).send(page('OAuth Error', `<p>${error}</p><p><a href="/">Back to CRM</a></p>`));
  if (!code)  return res.status(400).send(page('No code', '<p>No authorization code received.</p>'));

  try {
    const client = makeClient();
    const { tokens } = await client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      return res.status(400).send(page('No refresh token',
        `<p>Google did not return a refresh token. This usually means the account was already authorised without the offline scope.</p>
         <ol>
           <li>Go to <a href="https://myaccount.google.com/permissions" target="_blank">Google Account → Security → Third-party apps</a></li>
           <li>Remove access for your app</li>
           <li>Visit <a href="/api/email/auth">/api/email/auth</a> again</li>
         </ol>`));
    }

    return res.send(page('Gmail Connected!', `
      <div class="success">Gmail authorised for <strong>${FROM_ADDR}</strong></div>

      <div class="step">
        <strong>Step 1 — Copy your refresh token:</strong>
        <div class="token-box" id="tok">${refreshToken}</div>
        <button onclick="copy()">Copy Token</button>
      </div>

      <div class="step">
        <strong>Step 2 — Add this environment variable on Render:</strong>
        <div class="token-box">GMAIL_REFRESH_TOKEN = ${refreshToken}</div>
      </div>

      <div class="step">
        <strong>Step 3 — Redeploy</strong> your Render service (Deploy → Manual Deploy) for the variable to take effect.
      </div>

      <p style="margin-top:2rem"><a href="/">← Back to CRM</a></p>
      <script>
        function copy() {
          navigator.clipboard.writeText(document.getElementById('tok').textContent)
            .then(() => document.querySelector('button').textContent = 'Copied!');
        }
      </script>`));
  } catch (err) {
    res.status(500).send(page('Token exchange failed', `<p>${escHtml(err.message)}</p>`));
  }
});

// ─── POST /api/email/send ──────────────────────────────────────────────────────

router.post('/send', async (req, res) => {
  const { contact_id, to_email, subject, body } = req.body;

  if (!to_email) return res.status(400).json({ error: 'to_email is required' });
  if (!subject)  return res.status(400).json({ error: 'subject is required' });
  if (!body)     return res.status(400).json({ error: 'body is required' });

  try {
    const auth  = authedClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const raw = [
      `From: ${FROM_NAME} <${FROM_ADDR}>`,
      `To: ${to_email}`,
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

    const gmailId  = result.data.id;
    const threadId = result.data.threadId || null;
    const preview  = body.length > 400 ? body.slice(0, 397) + '…' : body;

    if (contact_id) {
      db.prepare(`
        INSERT OR IGNORE INTO emails
          (contact_id, to_email, subject, body, status, gmail_message_id, thread_id, direction)
        VALUES (?, ?, ?, ?, 'sent', ?, ?, 'outbound')
      `).run(contact_id, to_email, subject, preview, gmailId, threadId);

      // Also land in the communications timeline (activity feed excludes comm_type='email')
      db.prepare(`
        INSERT INTO communications (contact_id, comm_type, direction, subject, body, status, external_id)
        VALUES (?, 'email', 'outbound', ?, ?, 'sent', ?)
      `).run(contact_id, subject, preview, gmailId);
    }

    res.json({ ok: true, gmail_message_id: gmailId });
  } catch (err) {
    console.error('[email] send error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to send email' });
  }
});

// ─── GET /api/email/contact/:id ───────────────────────────────────────────────
// Merges two sources:
//   1. emails table — current records written by /api/email/send
//   2. communications table comm_type='email' — legacy records from earlier sends
// Deduplicates by gmail_message_id so emails that appear in both tables show once.

router.get('/contact/:id', (req, res) => {
  try {
    const cid = req.params.id;

    // Primary source: emails table (includes new from_email, thread_id, direction columns)
    const fromEmails = db.prepare(
      `SELECT id, contact_id, to_email, from_email, subject, body, status,
              gmail_message_id, thread_id, direction, sent_at
       FROM emails
       WHERE contact_id = ?
       ORDER BY sent_at DESC
       LIMIT 100`
    ).all(cid);

    // Legacy source: communications rows with comm_type='email'
    // Map column names to match emails table shape so renderEmailHistory handles both.
    const fromComms = db.prepare(
      `SELECT id, contact_id,
              NULL        AS to_email,
              NULL        AS from_email,
              subject,    body,  status,
              external_id AS gmail_message_id,
              NULL        AS thread_id,
              direction,
              created_at  AS sent_at
       FROM communications
       WHERE contact_id = ? AND comm_type = 'email'
       ORDER BY created_at DESC
       LIMIT 100`
    ).all(cid);

    // Deduplicate: if a comms record shares gmail_message_id with an emails record, skip it
    const seenGmailIds = new Set(fromEmails.map(e => e.gmail_message_id).filter(Boolean));
    const legacyOnly = fromComms.filter(c =>
      !c.gmail_message_id || !seenGmailIds.has(c.gmail_message_id)
    );

    // Merge and sort newest-first
    const merged = [...fromEmails, ...legacyOnly]
      .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))
      .slice(0, 100);

    console.log(`[email/contact/${cid}] ${fromEmails.length} from emails table + ${legacyOnly.length} legacy from communications = ${merged.length} total`);

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/email/sync ─────────────────────────────────────────────────────
// Fetches recent inbound messages from Gmail for a specific contact and saves
// any new replies to the emails table (direction='inbound').
// Requires GMAIL_REFRESH_TOKEN to have been issued with gmail.readonly scope.
// If the existing token lacks that scope, returns reauth_required:true.

router.post('/sync', async (req, res) => {
  const { contact_id } = req.body;
  if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

  const contact = db.prepare('SELECT id, email FROM contacts WHERE id = ?').get(contact_id);
  if (!contact)       return res.status(404).json({ error: 'Contact not found' });
  if (!contact.email) return res.status(400).json({ error: 'Contact has no email address' });

  try {
    const auth  = authedClient();
    const gmail = google.gmail({ version: 'v1', auth });

    // Search inbox for messages sent by this contact
    const listRes = await gmail.users.messages.list({
      userId:     'me',
      q:          `from:${contact.email}`,
      maxResults: 50,
    });

    const msgList = listRes.data.messages || [];
    let imported = 0;
    let skipped  = 0;

    for (const { id: msgId } of msgList) {
      // Skip already-imported messages (UNIQUE index on gmail_message_id)
      const exists = db.prepare('SELECT id FROM emails WHERE gmail_message_id = ?').get(msgId);
      if (exists) { skipped++; continue; }

      const msgRes = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
      const msg    = msgRes.data;
      const hdrs   = msg.payload.headers || [];
      const hdr    = (name) => hdrs.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const fromEmail = hdr('From');
      const toEmail   = hdr('To');
      const subject   = hdr('Subject');
      const threadId  = msg.threadId || null;

      let receivedAt;
      try { receivedAt = new Date(hdr('Date')).toISOString(); } catch { /* fall through */ }
      if (!receivedAt || receivedAt === 'Invalid Date') {
        receivedAt = new Date(parseInt(msg.internalDate, 10)).toISOString();
      }

      const bodyText = extractGmailBody(msg.payload);
      const preview  = bodyText.slice(0, 500).trim();

      db.prepare(`
        INSERT OR IGNORE INTO emails
          (contact_id, from_email, to_email, subject, body, status,
           gmail_message_id, thread_id, direction, sent_at)
        VALUES (?, ?, ?, ?, ?, 'received', ?, ?, 'inbound', ?)
      `).run(contact.id, fromEmail, toEmail, subject, preview, msgId, threadId, receivedAt);

      imported++;
    }

    console.log(`[email/sync] contact #${contact_id} (${contact.email}): ${imported} imported, ${skipped} already existed`);
    res.json({ ok: true, imported, skipped, total: msgList.length });

  } catch (err) {
    // Google returns 403 when the token was issued without gmail.readonly scope
    if (err.code === 403 || err.message?.toLowerCase().includes('insufficient')) {
      return res.status(403).json({
        error: 'Gmail inbox access not authorized. Visit /api/email/auth to re-authorize with inbox read permission.',
        reauth_required: true,
      });
    }
    console.error('[email/sync] error:', err.message);
    res.status(500).json({ error: err.message || 'Sync failed' });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

// Recursively extract plain-text body from a Gmail MIME payload tree.
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

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function page(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${title} — Prosperity CRM</title>
<style>
  body{font-family:-apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 24px;color:#151414;line-height:1.6}
  h2{color:#3a1f70}
  code{background:#f5f4f8;padding:2px 6px;border-radius:4px;font-size:.9em}
  .success{background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:12px 16px;color:#065f46;margin:16px 0}
  .token-box{background:#f5f4f8;border:1px solid #e4e1ec;border-radius:8px;padding:14px;font-family:monospace;font-size:13px;word-break:break-all;margin:10px 0;user-select:all}
  .step{margin:24px 0}
  button{padding:8px 18px;background:#4e2c94;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-top:8px}
  button:hover{background:#3a1f70}
  ol li{margin-bottom:8px}
</style>
</head><body><h2>${title}</h2>${body}</body></html>`;
}

module.exports = router;
