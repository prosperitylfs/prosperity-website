// Reads API config from localStorage (set via /settings.html)
// Falls back to same-origin (since dashboard is served by the CRM server itself)
window.CRM = {
  get baseUrl() {
    return localStorage.getItem('crm_base_url') || '';
  },
  get apiKey() {
    return localStorage.getItem('crm_api_key') || '';
  },
  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    return h;
  },
  async fetch(path, opts = {}) {
    const url = this.baseUrl + path;
    const res = await fetch(url, { ...opts, headers: { ...this.headers(), ...opts.headers } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  }
};
