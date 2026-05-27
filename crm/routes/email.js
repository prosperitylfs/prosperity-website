// Email route — Gmail API via OAuth 2.0

const express      = require('express');
const router       = express.Router();
const db           = require('../db/database');
const { google }   = require('googleapis');

const SCOPES    = ['https://www.googleapis.com/auth/gmail.send'];
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

    const gmailId = result.data.id;
    const preview = body.length > 400 ? body.slice(0, 397) + '…' : body;

    if (contact_id) {
      db.prepare(`
        INSERT INTO emails (contact_id, to_email, subject, body, status, gmail_message_id)
        VALUES (?, ?, ?, ?, 'sent', ?)
      `).run(contact_id, to_email, subject, preview, gmailId);

      // Also land in the communications timeline
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

router.get('/contact/:id', (req, res) => {
  try {
    const rows = db.prepare(
      `SELECT * FROM emails WHERE contact_id = ? ORDER BY sent_at DESC LIMIT 50`
    ).all(req.params.id);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
