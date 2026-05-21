require('dotenv').config();

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

app.use(express.json());
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

// ─── Routes ───────────────────────────────────────────────────────────────────

// Lead capture — PUBLIC (no auth) so website forms can post
app.use('/api/leads', require('./routes/leads'));

// CRM contacts — protected
app.use('/api/contacts', requireApiKey, require('./routes/contacts'));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── Dashboard config — served dynamically so the API key comes from the server
// environment rather than requiring manual localStorage setup in every browser.
// This route takes priority over the static config.js in public/.
app.get('/config.js', (req, res) => {
  const apiKey = process.env.CRM_API_KEY || '';
  res.type('application/javascript').send(
`window.CRM = {
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
app.use(express.static(path.join(__dirname, 'public')));

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
