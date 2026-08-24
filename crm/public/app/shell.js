// Shared app shell for the redesigned CRM interface: sidebar nav, mobile
// drawer, company filter, and a small fetch helper. Every page in
// crm/public/app/ includes this after config.js and calls
// CrmApp.mount({ active, title, subtitle }) once its <body> has an empty
// <div id="app-root"></div>.
//
// Company filter is a VIEWING control only — persisted in localStorage and
// mirrored into the URL (?company=) so a link/reload keeps the same view.
// It is never sent anywhere that could select a sender; see
// crm/lib/senderResolution.js / crm/lib/senderGuardrail.js, which this
// frontend never calls directly — Call/Text/Email actions only ever
// preview the resolved sender (see client.html), never trigger sending.

(function () {
  const ICONS = {
    dashboard: '<path d="M3 13h8V3H3v10Zm0 8h8v-6H3v6Zm10 0h8V11h-8v10Zm0-18v6h8V3h-8Z"/>',
    clients: '<path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4 0-8 2-8 5v2h16v-2c0-3-4-5-8-5Z"/>',
    leads: '<path d="M12 2 2 8l10 6 8-4.8V17h2V8L12 2Zm-6 9.2V16l6 3.6 6-3.6v-4.8l-6 3.6-6-3.6Z"/>',
    cases: '<path d="M10 4a2 2 0 0 0-2 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-4a2 2 0 0 0-2-2h-4Zm0 2h4v2h-4V6Z"/>',
    policies: '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm8 1.5V8h4.5L14 3.5ZM8 13h8v2H8v-2Zm0 4h8v2H8v-2Zm0-8h4v2H8V9Z"/>',
    tasks: '<path d="m9.5 16.2-3.5-3.5L4.6 14.1l4.9 4.9 10-10-1.4-1.4z"/>',
    appointments: '<path d="M7 2v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2V2h-2v2H9V2H7Zm-2 8h14v10H5V10Z"/>',
    communications: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v.01L12 12l8-5.99V6H4Z"/>',
    reports: '<path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 12h2V9H7v6Zm4 0h2V6h-2v9Zm4 0h2v-4h-2v4Z"/>',
    review: '<path d="M12 2 2 7l10 5 8-4V17h2V7l-10-5Zm-8 9v5c0 2.2 3.6 4 8 4s8-1.8 8-4v-5l-8 4-8-4Z"/>',
    settings: '<path d="M19.4 13a7.7 7.7 0 0 0 0-2l2.1-1.6a.5.5 0 0 0 .1-.7l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.6 7.6 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.6c-.6.2-1.2.6-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.7L4.6 11a7.7 7.7 0 0 0 0 2l-2.1 1.6a.5.5 0 0 0-.1.7l2 3.5c.1.2.4.3.6.2l2.5-1c.5.4 1.1.8 1.7 1l.4 2.6c0 .2.3.4.5.4h4c.2 0 .5-.2.5-.4l.4-2.6c.6-.2 1.2-.6 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.7L19.4 13ZM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7Z"/>',
  };

  const NAV_ITEMS = [
    { key: 'dashboard', label: 'Dashboard', href: 'dashboard.html', icon: 'dashboard' },
    { key: 'clients', label: 'Clients', href: 'clients.html', icon: 'clients' },
    { key: 'leads', label: 'Leads', href: 'leads.html', icon: 'leads', badgeKey: 'newLeads' },
    { key: 'cases', label: 'Cases', href: 'cases.html', icon: 'cases' },
    { key: 'policies', label: 'Policies', href: 'policies.html', icon: 'policies' },
    { key: 'tasks', label: 'Tasks', href: 'tasks.html', icon: 'tasks', badgeKey: 'overdueTasks' },
    { key: 'appointments', label: 'Appointments', href: 'appointments.html', icon: 'appointments' },
    { key: 'communications', label: 'Communications', href: 'communications.html', icon: 'communications' },
    { key: 'reports', label: 'Reports', href: 'reports.html', icon: 'reports' },
    { key: 'review', label: 'Review Required', href: 'review.html', icon: 'review', badgeKey: 'reviewRequired' },
    { key: 'settings', label: 'Settings', href: '/settings.html', icon: 'settings' },
  ];

  const COMPANIES = [
    { key: 'all', label: 'All Companies' },
    { key: 'insurance-lady', label: 'Insurance Lady', cls: 'il' },
    { key: 'prosperity', label: 'Prosperity', cls: 'prosperity' },
  ];

  function icon(name) {
    return `<svg class="nav-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  function getCompany() {
    const fromUrl = new URLSearchParams(location.search).get('company');
    if (fromUrl) return fromUrl;
    return localStorage.getItem('crmAppCompany') || 'all';
  }

  function setCompany(company) {
    localStorage.setItem('crmAppCompany', company);
    const url = new URL(location.href);
    url.searchParams.set('company', company);
    history.replaceState(null, '', url);
  }

  function companyBadge(brandId, shortName) {
    if (!brandId) return '';
    const cls = brandId === 'insurance-lady' ? 'il' : 'prosperity';
    const label = shortName || (brandId === 'insurance-lady' ? 'Insurance Lady' : 'Prosperity');
    return `<span class="badge-company ${cls}"><span class="dot"></span>${escapeHtml(label)}</span>`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
  }

  async function fetchJSON(path) {
    const url = (window.CRM ? window.CRM.baseUrl : '') + path;
    const headers = window.CRM ? window.CRM.headers() : { 'Content-Type': 'application/json' };
    const res = await fetch(url, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function friendlyDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    const today = new Date().toISOString().slice(0, 10);
    const dStr = iso.slice(0, 10);
    if (dStr === today) return 'Today';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: dStr.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' });
  }

  // hour12 is forced explicitly (display formatting only -- never affects
  // what's stored or the timezone the value represents) rather than left to
  // the browser's default locale, so this never depends on OS/browser
  // settings: 15:00 always renders as "3:00 PM", never "15:00".
  function friendlyDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return `${friendlyDate(iso)} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: true })}`;
  }

  // Formats a plain "HH:MM" (24-hour) string -- e.g. a follow_up_tasks.due_time
  // value straight out of the database -- as 12-hour AM/PM, without needing a
  // full date. Never touches the stored value, only how it's displayed.
  function friendlyTime(hhmm) {
    if (!hhmm) return '';
    const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
    if (!m) return hhmm;
    const hour24 = Number(m[1]);
    const minute = m[2];
    const period = hour24 >= 12 ? 'PM' : 'AM';
    const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
    return `${hour12}:${minute} ${period}`;
  }

  function sidebarHtml(active) {
    const links = NAV_ITEMS.map(item => `
      <a class="nav-link${item.key === active ? ' active' : ''}" href="${item.href}" data-nav-key="${item.key}">
        ${icon(item.icon)}
        <span class="nav-label">${item.label}</span>
        ${item.badgeKey ? `<span class="nav-badge hidden" data-badge="${item.badgeKey}"></span>` : ''}
      </a>`).join('');
    return `
      <div class="sidebar-brand">
        <span class="sidebar-brand-mark">P</span>
        <span>Prosperity CRM</span>
      </div>
      <nav class="sidebar-nav">${links}</nav>
      <div class="sidebar-footer">Loretta Stewart</div>
    `;
  }

  function companyFilterHtml(current) {
    return COMPANIES.map(c => `
      <button type="button" data-company="${c.key}" class="${c.key === current ? 'active' : ''}">
        ${c.cls ? `<span class="dot ${c.cls}"></span>` : ''}${c.label}
      </button>`).join('');
  }

  function mount({ active, title, subtitle, showCompanyFilter = true }) {
    const root = document.getElementById('app-root');
    if (!root) return;
    const company = getCompany();

    root.innerHTML = `
      <div class="app-shell">
        <div class="sidebar-overlay" id="sidebar-overlay"></div>
        <aside class="sidebar" id="sidebar">${sidebarHtml(active)}</aside>
        <div class="workspace">
          <header class="topbar">
            <button class="hamburger-btn" id="hamburger-btn" aria-label="Open menu">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M3 6h18v2H3zM3 11h18v2H3zM3 16h18v2H3z"/></svg>
            </button>
            <div>
              <div class="topbar-title">${title || ''}</div>
              ${subtitle ? `<div class="topbar-sub">${subtitle}</div>` : ''}
            </div>
            ${showCompanyFilter ? `<div class="company-filter" id="company-filter">${companyFilterHtml(company)}</div>` : ''}
          </header>
          <main class="content" id="page-content"></main>
        </div>
      </div>
    `;

    const hamburger = document.getElementById('hamburger-btn');
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    hamburger && hamburger.addEventListener('click', () => {
      sidebar.classList.add('sidebar-open');
      overlay.classList.add('visible');
    });
    overlay && overlay.addEventListener('click', () => {
      sidebar.classList.remove('sidebar-open');
      overlay.classList.remove('visible');
    });

    const filterEl = document.getElementById('company-filter');
    if (filterEl) {
      filterEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-company]');
        if (!btn) return;
        setCompany(btn.dataset.company);
        filterEl.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        document.dispatchEvent(new CustomEvent('crmapp:companychange', { detail: { company: btn.dataset.company } }));
      });
    }

    refreshBadges();
  }

  async function refreshBadges() {
    try {
      const data = await fetchJSON('/api/app/dashboard?company=all');
      const s = data.summary || {};
      document.querySelectorAll('[data-badge]').forEach(el => {
        const n = s[el.dataset.badge] || 0;
        if (n > 0) { el.textContent = n > 99 ? '99+' : String(n); el.classList.remove('hidden'); }
        else { el.classList.add('hidden'); }
      });
    } catch (e) { /* badges are a nicety, never block the page on this */ }
  }

  // Shared JSON POST/PATCH helper — every mutation goes through here so
  // error handling (and the API key header) stays consistent everywhere.
  async function postJSON(path, method, body) {
    const url = (window.CRM ? window.CRM.baseUrl : '') + path;
    const headers = window.CRM ? window.CRM.headers() : { 'Content-Type': 'application/json' };
    const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // A single, reusable <dialog>-based modal — every "Add X" / "Edit X" form
  // in the app renders into this same element instead of each page
  // reinventing modal open/close/backdrop/focus handling. bodyHtml is
  // trusted markup built by the caller (never raw user input without
  // escapeHtml). onMount(dialogEl) runs after the dialog is in the DOM and
  // open, for wiring form listeners.
  function openModal({ title, bodyHtml, onMount, wide }) {
    let dialog = document.getElementById('crmapp-modal');
    if (!dialog) {
      dialog = document.createElement('dialog');
      dialog.id = 'crmapp-modal';
      dialog.className = 'crmapp-modal';
      document.body.appendChild(dialog);
      dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
    }
    dialog.classList.toggle('wide', !!wide);
    dialog.innerHTML = `
      <div class="crmapp-modal-header">
        <h2>${title}</h2>
        <button type="button" class="crmapp-modal-close" aria-label="Close">&times;</button>
      </div>
      <div class="crmapp-modal-body">${bodyHtml}</div>
    `;
    dialog.querySelector('.crmapp-modal-close').addEventListener('click', () => dialog.close());
    if (typeof HTMLDialogElement === 'function' && dialog.showModal) dialog.showModal();
    else dialog.setAttribute('open', '');
    if (onMount) onMount(dialog);
    return dialog;
  }
  function closeModal() {
    const dialog = document.getElementById('crmapp-modal');
    if (dialog && dialog.open) dialog.close();
  }

  // Custom confirm-modal (not native confirm()) so every confirmation reads
  // an exact message and resolves a Promise<boolean> — used before every
  // review action / archive action per "require confirmation before local
  // review actions."
  function confirmAction(message, { confirmLabel = 'Confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      const dialog = openModal({
        title: 'Please confirm',
        bodyHtml: `
          <p class="confirm-message">${message}</p>
          <div class="crmapp-modal-actions">
            <button type="button" class="btn" data-act="cancel">Cancel</button>
            <button type="button" class="btn ${danger ? '' : 'primary'}" data-act="confirm" ${danger ? 'style="background:var(--danger);border-color:var(--danger);color:#fff;"' : ''}>${confirmLabel}</button>
          </div>
        `,
      });
      let settled = false;
      const settle = (val) => { if (settled) return; settled = true; resolve(val); dialog.close(); };
      dialog.querySelector('[data-act="cancel"]').addEventListener('click', () => settle(false));
      dialog.querySelector('[data-act="confirm"]').addEventListener('click', () => settle(true));
      dialog.addEventListener('close', () => settle(false), { once: true });
    });
  }

  // Small transient toast instead of alert() -- non-blocking, CDP-friendly.
  function toast(message, { error = false } = {}) {
    let el = document.getElementById('crmapp-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'crmapp-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = error ? 'error visible' : 'visible';
    clearTimeout(el.__timer);
    el.__timer = setTimeout(() => el.classList.remove('visible'), 3200);
  }

  window.CrmApp = {
    mount, getCompany, setCompany, companyBadge, escapeHtml, initials,
    fetchJSON, postJSON, friendlyDate, friendlyDateTime, friendlyTime, NAV_ITEMS,
    openModal, closeModal, confirmAction, toast,
  };
})();
