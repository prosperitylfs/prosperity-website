// Shared CRM shell: service worker registration, mobile sidebar, nav badges.
// Loaded on every page after config.js.

// ── Service worker ────────────────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

// ── Mobile sidebar toggle ─────────────────────────────────────────────────────
(function () {
  const hamburger = document.getElementById('hamburger-btn');
  const sidebar   = document.getElementById('sidebar');
  const overlay   = document.getElementById('sidebar-overlay');
  if (!hamburger || !sidebar || !overlay) return;

  function open() {
    sidebar.classList.add('sidebar-open');
    overlay.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function close() {
    sidebar.classList.remove('sidebar-open');
    overlay.classList.remove('visible');
    document.body.style.overflow = '';
  }

  hamburger.addEventListener('click', open);
  overlay.addEventListener('click', close);

  // Close on nav-link tap (navigates away, but helps if same page)
  document.querySelectorAll('.sidebar .nav-link').forEach(a => {
    a.addEventListener('click', () => {
      if (window.innerWidth <= 768) close();
    });
  });
})();

// ── Nav badge counts (unread voicemails + missed calls) ───────────────────────
(async function updateNavBadges() {
  function setBadge(id, n) {
    const el = document.getElementById(id);
    if (!el) return;
    if (n > 0) {
      el.textContent = n > 99 ? '99+' : String(n);
      el.classList.remove('hidden');
    } else {
      el.textContent = '';
      el.classList.add('hidden');
    }
  }

  try {
    const r = await fetch('/api/calls/stats', {
      headers: window.CRM ? { 'x-api-key': CRM.apiKey } : {},
    });
    if (!r.ok) return;
    const { unread_voicemails = 0, missed_calls = 0 } = await r.json();
    const total = unread_voicemails + missed_calls;
    setBadge('nav-badge-calls', total);
    setBadge('nav-badge-calls-mobile', total);
  } catch {}
})();
