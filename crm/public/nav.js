// Shared CRM shell: service worker registration, mobile sidebar, nav badges,
// logout link. Loaded on every page after config.js.

// ── Log out link ──────────────────────────────────────────────────────────────
// Injected into the sidebar footer on every page rather than duplicated across
// 5 HTML files. Hitting /logout returns 401 with a different Basic Auth realm,
// which makes most browsers drop the cached dashboard credentials. If Basic
// Auth isn't enabled (CRM_DASHBOARD_AUTH_ENABLED unset), this link is harmless
// — there's nothing to log out of.
(function () {
  const footer = document.querySelector('.sidebar-footer');
  if (!footer) return;
  const link = document.createElement('a');
  link.href = '/logout';
  link.textContent = 'Log out';
  link.style.cssText = 'display:block;margin-top:8px;color:inherit;opacity:0.75;font-size:0.8rem;text-decoration:underline;';
  footer.insertAdjacentElement('afterend', link);
})();

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
