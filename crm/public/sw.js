// Prosperity CRM — Service Worker v23
// Strategy: network-first for same-origin assets (always fresh JS/HTML),
//           cache fallback for offline; network-only for live API + config.js

const CACHE = 'prosperity-crm-v35';

const PRECACHE = [
  '/',
  '/calls.html',
  '/contact.html',
  '/calendar.html',
  '/settings.html',
  '/style.css',
  '/app.js',
  '/contact.js',
  '/calls-page.js',
  '/calendar.js',
  '/email-modal.js',
  '/nav.js',
  '/manifest.json',
  '/favicon.ico',
  '/icons/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: drop old caches ─────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: route requests ─────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Network-only: live API data and the dynamic config endpoint.
  // These must never be served from cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/config.js') {
    e.respondWith(fetch(request));
    return;
  }

  // Cross-origin (Google Fonts, etc.): cache-first with network fallback.
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.match(request).then(cached =>
        cached || fetch(request).then(res => {
          if (res.ok) {
            caches.open(CACHE).then(c => c.put(request, res.clone()));
          }
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // Same-origin assets (HTML, JS, CSS, icons): network-first.
  // Always fetches from the network so deployed updates are visible immediately.
  // Falls back to cache only when the network is unavailable (offline).
  e.respondWith(
    fetch(request)
      .then(res => {
        if (res.ok) {
          caches.open(CACHE).then(c => c.put(request, res.clone()));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});
