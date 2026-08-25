// Google Calendar OAuth setup — completely separate from crm/routes/email.js's
// Gmail OAuth flow, on purpose. Reuses the SAME Google OAuth Client
// (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET — one Google Cloud project, one
// registered app, no new Google app needed), but requests ONLY the Calendar
// scope and produces its OWN separate refresh token
// (GOOGLE_CALENDAR_REFRESH_TOKEN), narrowly scoped to calendar access alone.
//
// This file does not send email, does not read Gmail, and does not touch
// GMAIL_REFRESH_TOKEN in any way — crm/routes/email.js and its existing
// Gmail authorization are completely unaffected by this file's existence.
//
// This is setup-only: it obtains and displays a refresh token for you to
// copy into Render yourself. It does not create, update, or delete any
// calendar event — that's a later, separate implementation step.

const express = require('express');
const router  = express.Router();
const { google } = require('googleapis');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

function makeClient() {
  const redirectUri =
    process.env.GOOGLE_CALENDAR_REDIRECT_URI ||
    (process.env.APP_URL
      ? `${process.env.APP_URL}/api/calendar/callback`
      : 'http://localhost:3001/api/calendar/callback');

  return new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    redirectUri
  );
}

function isConfigured() {
  return !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_CLIENT_SECRET);
}

function authedClient() {
  if (!process.env.GOOGLE_CALENDAR_REFRESH_TOKEN) {
    throw new Error('Google Calendar not authorized yet. Visit /api/calendar/auth to complete setup.');
  }
  const client = makeClient();
  client.setCredentials({ refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN });
  return client;
}

// ─── GET /api/calendar/status ──────────────────────────────────────────────

router.get('/status', (req, res) => {
  res.json({
    oauth_client_configured: isConfigured(),
    calendar_authorized: !!process.env.GOOGLE_CALENDAR_REFRESH_TOKEN,
  });
});

// ─── GET /api/calendar/verify — read-only connection check ────────────────
// Lists the calendars visible to this connection (calendarList.list is a
// pure read call -- creates, updates, or deletes nothing) and confirms
// "CRM Tasks & Follow-Ups" is among them. This is the connection test
// itself, not the task-sync feature -- no CRM task or event is touched.

router.get('/verify', async (req, res) => {
  let auth;
  try {
    auth = authedClient();
  } catch (err) {
    return res.status(400).send(page('Not authorized yet',
      `<p>${escHtml(err.message)}</p><p><a href="/api/calendar/auth">Start authorization</a></p>`));
  }

  try {
    const calendar = google.calendar({ version: 'v3', auth });
    const result = await calendar.calendarList.list();
    const items = result.data.items || [];
    const names = items.map(c => c.summary || c.id);
    const found = items.some(c => (c.summary || '').trim() === 'CRM Tasks & Follow-Ups');

    return res.send(page(found ? 'Connection verified!' : 'Connected, but calendar not found', `
      <div class="${found ? 'success' : 'warning'}">
        ${found
          ? '"CRM Tasks &amp; Follow-Ups" was found in the calendars this connection can see. The connection works.'
          : 'The connection works (calendars could be listed), but "CRM Tasks &amp; Follow-Ups" was not among them &mdash; double-check the calendar name.'}
      </div>
      <div class="step">
        <strong>Calendars visible to this connection:</strong>
        <ul>${names.map(n => `<li>${escHtml(n)}</li>`).join('')}</ul>
      </div>
      <p style="margin-top:2rem"><a href="/">← Back to CRM</a></p>
    `));
  } catch (err) {
    return res.status(500).send(page('Verification failed', `<p>${escHtml(err.message)}</p>`));
  }
});

// ─── GET /api/calendar/auth — start one-time OAuth flow ───────────────────

router.get('/auth', (req, res) => {
  if (!isConfigured()) {
    return res.status(503).send(page('Google Calendar setup not ready',
      `<p>The Google OAuth Client (<code>GMAIL_CLIENT_ID</code> / <code>GMAIL_CLIENT_SECRET</code>) isn't configured yet — this reuses the same Client the Gmail connection already uses, so check that first.</p>
       <p><a href="/">Back to CRM</a></p>`));
  }

  const url = makeClient().generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent', // always re-prompt so we always get a refresh_token
  });
  res.redirect(url);
});

// ─── GET /api/calendar/callback — receive OAuth code, show refresh token ──

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
        `<p>Google did not return a refresh token. This usually means calendar access was already granted once without the offline/consent prompt sticking.</p>
         <ol>
           <li>Go to <a href="https://myaccount.google.com/permissions" target="_blank">Google Account → Security → Third-party apps</a></li>
           <li>Find this app and remove its access</li>
           <li>Visit <a href="/api/calendar/auth">/api/calendar/auth</a> again</li>
         </ol>`));
    }

    return res.send(page('Google Calendar Connected!', `
      <div class="success">Calendar access authorized for the CRM Tasks &amp; Follow-Ups calendar.</div>

      <div class="step">
        <strong>Step 1 — Copy your refresh token:</strong>
        <div class="token-box" id="tok">${refreshToken}</div>
        <button onclick="copy()">Copy Token</button>
      </div>

      <div class="step">
        <strong>Step 2 — Add this environment variable on Render:</strong>
        <div class="token-box">GOOGLE_CALENDAR_REFRESH_TOKEN = ${refreshToken}</div>
        <p style="color:#555; font-size:14px;">This is separate from GMAIL_REFRESH_TOKEN — your existing Gmail connection is unaffected.</p>
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

// ─── Helpers ────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${title} — Prosperity CRM</title>
<style>
  body{font-family:-apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 24px;color:#151414;line-height:1.6}
  h2{color:#3a1f70}
  code{background:#f5f4f8;padding:2px 6px;border-radius:4px;font-size:.9em}
  .success{background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:12px 16px;color:#065f46;margin:16px 0}
  .warning{background:#fff3cd;border:1px solid #ffe08a;border-radius:8px;padding:12px 16px;color:#7a5b00;margin:16px 0}
  .token-box{background:#f5f4f8;border:1px solid #e4e1ec;border-radius:8px;padding:14px;font-family:monospace;font-size:13px;word-break:break-all;margin:10px 0;user-select:all}
  .step{margin:24px 0}
  button{padding:8px 18px;background:#4e2c94;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-top:8px}
  button:hover{background:#3a1f70}
  ol li{margin-bottom:8px}
</style>
</head><body><h2>${title}</h2>${body}</body></html>`;
}

module.exports = router;
