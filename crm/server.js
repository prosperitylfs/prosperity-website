require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS ─────────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS accepts a comma-separated list of origins (preferred).
// Legacy single-value ALLOWED_ORIGIN is still accepted for backward compat.
const _envOrigins = (process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || '')
  .split(',').map(o => o.trim()).filter(Boolean);

const allowedOrigins = [
  'http://localhost:3001',
  'http://localhost:5500',     // VS Code Live Server (localhost variant)
  'http://127.0.0.1:5500',    // VS Code Live Server (127.0.0.1 variant)
  'http://127.0.0.1:3001',
  // Production domains — hardcoded so CORS doesn't depend on ALLOWED_ORIGINS
  // being set correctly on Render. www and bare apex are different origins
  // to a browser, so both must be listed explicitly.
  'https://prosperitylfs.com',
  'https://www.prosperitylfs.com',
  'https://prosperity-crm.onrender.com',
  ..._envOrigins,
];

app.use(cors({
  origin: (origin, cb) => {
    // allow requests with no origin (e.g. curl, Postman) and matched origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));

// Capture raw body buffer for HMAC webhook signature verification (Cal.com, etc.)
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));
app.use(express.urlencoded({ extended: true }));

// ─── API Key middleware (protects CRM read/write endpoints) ───────────────────
// The lead capture endpoint is PUBLIC (no key needed) so website forms can post.
// Everything under /api/contacts requires the key.
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  const configured = process.env.CRM_API_KEY;

  if (!configured || configured === 'change-me-before-deploy') {
    // In dev with no key set, allow all — print a warning
    console.warn('WARNING: CRM_API_KEY is not set. Endpoints are unprotected.');
    return next();
  }
  if (key !== configured) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ─── Dashboard Basic Auth (protects the CRM UI, its static assets, and every
// API route that exposes private CRM data) ─────────────────────────────────────
//
// CRM_DASHBOARD_AUTH_ENABLED is the explicit on/off switch. It is left unset
// in local dev, so dev always fails OPEN (matches requireApiKey's existing
// behavior above). Once set to a truthy value (only ever done on Render, per
// deployment instructions), auth is mandatory — if CRM_DASHBOARD_USER or
// CRM_DASHBOARD_PASSWORD is then missing, that's a misconfiguration, not a
// dev default, so this fails CLOSED (blocks everything) rather than silently
// exposing the dashboard.
function isAuthExplicitlyDisabled(raw) {
  if (raw === undefined || raw === null || raw === '') return true;
  return ['false', '0', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

// Fixed-length SHA-256 digest comparison via crypto.timingSafeEqual — avoids
// both a length-based timing side-channel and the need for equal-length
// input (timingSafeEqual itself throws on mismatched lengths).
function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function dashboardAuth(req, res, next) {
  if (isAuthExplicitlyDisabled(process.env.CRM_DASHBOARD_AUTH_ENABLED)) {
    console.warn('WARNING: CRM_DASHBOARD_AUTH_ENABLED is not set to true — the CRM dashboard is UNPROTECTED.');
    return next();
  }

  const user = process.env.CRM_DASHBOARD_USER;
  const pass = process.env.CRM_DASHBOARD_PASSWORD;

  if (!user || !pass) {
    console.error('CRM_DASHBOARD_AUTH_ENABLED=true but CRM_DASHBOARD_USER/CRM_DASHBOARD_PASSWORD are not both set — blocking all dashboard access until both are configured.');
    return res.status(503).send('Dashboard authentication is misconfigured. Set CRM_DASHBOARD_USER and CRM_DASHBOARD_PASSWORD, then redeploy.');
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    let decoded = '';
    try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); } catch { /* fall through to 401 */ }
    const sepIdx = decoded.indexOf(':');
    if (sepIdx !== -1) {
      const reqUser = decoded.slice(0, sepIdx);
      const reqPass = decoded.slice(sepIdx + 1);
      if (safeEqual(reqUser, user) && safeEqual(reqPass, pass)) {
        return next();
      }
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Prosperity CRM"');
  return res.status(401).send('Authentication required.');
}

// ─── Routes ───────────────────────────────────────────────────────────────────
// Everything in this first block is PUBLIC and stays reachable with no
// authentication of any kind — external services (the website's own forms,
// Twilio, Cal.com) call these directly and can't supply a Basic Auth header
// or CRM_API_KEY.

// Lead capture — PUBLIC (no auth) so website forms can post
app.use('/api/leads', require('./routes/leads'));

// Twilio webhooks — PUBLIC (Twilio calls these from its own servers, no CRM key)
app.use('/api/twilio', require('./routes/twilio'));

// Cal.com booking webhooks — PUBLIC (Cal.com posts from its servers, no CRM key)
// Optional HMAC protection via CALCOM_WEBHOOK_SECRET env var
app.use('/api/calcom', require('./routes/calcom'));

// Health check — PUBLIC, no sensitive data
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Logout helper — always reachable regardless of auth state. Responds 401
// with a different realm than the dashboard's, which makes most browsers
// discard the previously-cached dashboard credentials and prompt fresh next
// time. Browsers cache Basic Auth credentials for the life of the browser
// process, so fully clearing them may still require closing all windows —
// this page says so explicitly.
app.get('/logout', (req, res) => {
  res.set('WWW-Authenticate', 'Basic realm="Prosperity CRM Logout"');
  res.status(401).type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Logged out</title></head>
<body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:440px;margin:96px auto;text-align:center;color:#222;">
  <h2 style="color:#3a1f70;">You've been logged out</h2>
  <p>If this browser keeps logging you back in automatically, close all browser windows to fully clear the saved login.</p>
  <p><a href="/" style="color:#4e2c94;font-weight:600;">Return to CRM</a></p>
</body></html>`);
});

// ─── Everything below this line is the private CRM dashboard and its data —
// gated behind Basic Auth. See dashboardAuth() above for the enable/disable
// and fail-open/fail-closed rules. ───────────────────────────────────────────
app.use(dashboardAuth);

// CRM contacts — protected
app.use('/api/contacts', requireApiKey, require('./routes/contacts'));

// Call management — protected
app.use('/api/calls', requireApiKey, require('./routes/calls'));

// Appointments — protected
app.use('/api/appointments', requireApiKey, require('./routes/appointments'));

// Follow-up tasks — protected
app.use('/api/tasks', requireApiKey, require('./routes/tasks'));

// Dashboard summary stats — protected
app.use('/api/stats', requireApiKey, require('./routes/stats'));

// SMS history — protected
app.use('/api/sms', requireApiKey, require('./routes/sms'));

// Redesigned CRM interface (crm/public/app/) — read-only company-aware
// dashboard/clients/review/communications/policies data. Same protection
// tier as every other private CRM data route above.
app.use('/api/app', requireApiKey, require('./routes/crmApp'));

// Email / Gmail
// /auth and /callback are browser redirects — no API key header is possible
// there, but they're still behind dashboardAuth above (the browser already
// has Basic Auth credentials cached from loading the dashboard, and it
// automatically resends them through the Google OAuth redirect round-trip).
// All other sub-routes (/send, /status, /contact/:id) also remain protected
// by requireApiKey on top of that.
app.use('/api/email', (req, res, next) => {
  if (req.path === '/auth' || req.path === '/callback') return next();
  requireApiKey(req, res, next);
}, require('./routes/email'));

// ─── Dashboard config — served dynamically so the API key comes from the server
// environment rather than requiring manual localStorage setup in every browser.
// This route takes priority over the static config.js in public/.
app.get('/config.js', (req, res) => {
  const apiKey        = process.env.CRM_API_KEY || '';
  const twilioEnabled = !!(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_FROM_NUMBER &&
    process.env.AGENT_PHONE_NUMBER
  );
  const gmailEnabled  = !!(
    process.env.GMAIL_CLIENT_ID &&
    process.env.GMAIL_CLIENT_SECRET &&
    process.env.GMAIL_REFRESH_TOKEN
  );
  const gmailFrom = process.env.GMAIL_FROM || 'loretta@prosperitylfs.com';
  res.type('application/javascript').send(
`window.CRM_TWILIO_ENABLED = ${twilioEnabled};
window.CRM_GMAIL_ENABLED   = ${gmailEnabled};
window.CRM_GMAIL_FROM      = ${JSON.stringify(gmailFrom)};
window.CRM = {
  get baseUrl() { return window.location.origin; },
  get apiKey()  { return ${JSON.stringify(apiKey)}; },
  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  },
  async fetch(path, opts = {}) {
    const url = this.baseUrl + path;
    const res = await fetch(url, { ...opts, headers: { ...this.headers(), ...(opts.headers || {}) } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || \`HTTP \${res.status}\`);
    }
    return res.json();
  }
};`
  );
});

// ─── Serve CRM Dashboard (static) ────────────────────────────────────────────
// No-cache on HTML/JS/CSS so the browser always fetches the latest version.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

// Fallback: serve dashboard for any unmatched route (SPA-style)
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nProsperity CRM running at http://localhost:${PORT}`);
  console.log(`Dashboard:      http://localhost:${PORT}/`);
  console.log(`Lead endpoint:  POST http://localhost:${PORT}/api/leads\n`);
});
