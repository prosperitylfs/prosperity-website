// Prosperity CRM — Service Worker
// Strategy: cache-first for static assets, network-only for API + config.js

const CACHE = 'prosperity-crm-v4';

const PRECACHE = [
  '/',
  '/calls.html',
  '/contact.html',
  '/settings.html',
  '/style.css',
  '/app.js',
  '/contact.js',
  '/calls-page.js',
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

  // Network-only: live API data and the dynamic config endpoint
  if (url.pathname.startsWith('/api/') || url.pathname === '/config.js') {
    e.respondWith(fetch(request));
    return;
  }

  // Cross-origin (Google Fonts etc.): network with cache fallback
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.match(request).then(cached =>
        cached || fetch(request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // Cache-first for all other same-origin requests
  e.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      });
      return cached || networkFetch;
    })
  );
});
