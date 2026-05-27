// Shared sidebar badge loader — updates unread counts on every CRM page.
// Loaded after config.js so window.CRM is available.
(async function updateNavBadges() {
  const badge = document.getElementById('nav-badge-calls');
  if (!badge) return;
  try {
    const r = await fetch('/api/calls/stats', {
      headers: window.CRM ? { 'x-api-key': CRM.apiKey } : {},
    });
    if (!r.ok) return;
    const { unread_voicemails, missed_calls } = await r.json();
    const total = (unread_voicemails || 0) + (missed_calls || 0);
    if (total > 0) {
      badge.textContent = total > 99 ? '99+' : String(total);
      badge.classList.remove('hidden');
    }
  } catch {}
})();
