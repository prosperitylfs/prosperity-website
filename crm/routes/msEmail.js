// Microsoft Graph delegated OAuth2 setup for the Insurance Lady mailbox
// (loretta@insuranceladyllc.com) -- 2026-10-16. Separate from
// crm/routes/email.js (Gmail/Prosperity) entirely, mirroring how
// crm/routes/googleCalendarAuth.js already lives in its own file alongside
// Gmail's rather than sharing one -- same "one dedicated route file per
// OAuth integration, own prefix" convention (see crm/server.js's mount
// comments for both).
//
// GET /auth     -- starts the one-time interactive authorization.
// GET /callback -- receives Microsoft's redirect, validates the CSRF
//                  `state` value, exchanges the code server-side, and
//                  shows the human a plain success/failure page. The
//                  authorization code and every token are handled entirely
//                  server-side (lib/msGraphAuth.js) -- this route never
//                  places any of them in a URL, a rendered page, a log
//                  line, or a JSON response.

const express = require('express');
const router = express.Router();
const db = require('../db/database');
const { createState, consumeState } = require('../lib/oauthStateStore');
const { isEnvConfigured, missingEnvVars, getMicrosoftAuthCodeUrl, acquireTokenByAuthCode } = require('../lib/msGraphAuth');

// ─── GET /api/ms-email/auth — start one-time OAuth flow ───────────────────

router.get('/auth', async (req, res) => {
  if (!isEnvConfigured()) {
    return res.status(503).send(page('Microsoft Graph not configured',
      `<p>Add the following environment variable(s) to Render, then visit this page again: <code>${escHtml(missingEnvVars().join(', '))}</code>.</p>
       <p><a href="/">Back to CRM</a></p>`));
  }

  try {
    const state = createState();
    const url = await getMicrosoftAuthCodeUrl(db, { state });
    res.redirect(url);
  } catch (err) {
    console.error('[ms-email] auth error:', err.message);
    res.status(500).send(page('Microsoft authorization failed', `<p>${escHtml(err.message)}</p>`));
  }
});

// ─── GET /api/ms-email/callback — receive Microsoft's redirect ────────────

router.get('/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;

  if (error) {
    return res.status(400).send(page('Microsoft OAuth Error',
      `<p>${escHtml(String(error))}${error_description ? ': ' + escHtml(String(error_description)) : ''}</p><p><a href="/">Back to CRM</a></p>`));
  }
  if (!code) {
    return res.status(400).send(page('No code', '<p>No authorization code received.</p>'));
  }

  // CSRF check -- must pass BEFORE any token exchange is attempted. An
  // invalid, missing, expired, or already-used state is rejected here with
  // no further action; Microsoft's client library is never invoked.
  if (!consumeState(state)) {
    return res.status(400).send(page('Invalid or expired request',
      `<p>This authorization link is invalid, expired, or has already been used.</p>
       <p>Please restart authorization at <a href="/api/ms-email/auth">/api/ms-email/auth</a>.</p>`));
  }

  try {
    // Exchanges the code for tokens; lib/msGraphAuth.js's MSAL cache
    // plugin persists the resulting refresh token to the database as a
    // side effect. Nothing here ever sees or displays the token itself.
    await acquireTokenByAuthCode(db, { code: String(code) });

    return res.send(page('Insurance Lady mailbox connected',
      `<div class="success">Microsoft Graph email is now connected for <strong>${escHtml(process.env.MICROSOFT_FROM || 'loretta@insuranceladyllc.com')}</strong>.</div>
       <p>The CRM can now send Insurance Lady email through Microsoft Graph. No further action is needed here -- the authorization is stored securely and will renew itself automatically.</p>
       <p><a href="/">Back to CRM</a></p>`));
  } catch (err) {
    console.error('[ms-email] callback error:', err.message);
    return res.status(500).send(page('Token exchange failed', `<p>${escHtml(err.message)}</p>`));
  }
});

// ─── Helpers ────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${escHtml(title)} — Prosperity CRM</title>
<style>
  body{font-family:-apple-system,sans-serif;max-width:640px;margin:60px auto;padding:0 24px;color:#151414;line-height:1.6}
  h2{color:#3a1f70}
  code{background:#f5f4f8;padding:2px 6px;border-radius:4px;font-size:.9em}
  .success{background:#d1fae5;border:1px solid #6ee7b7;border-radius:8px;padding:12px 16px;color:#065f46;margin:16px 0}
</style>
</head><body><h2>${escHtml(title)}</h2>${body}</body></html>`;
}

module.exports = router;
