// Dashboard — contacts list

const tbody          = document.getElementById('contacts-tbody');
const countEl        = document.getElementById('contact-count');
const errorEl        = document.getElementById('error-banner');
const emptyEl        = document.getElementById('empty-state');
const searchEl       = document.getElementById('search-input');
const filterEl       = document.getElementById('filter-type');
const filterStatusEl = document.getElementById('filter-status');
const filterSmsEl    = document.getElementById('filter-sms');

let debounceTimer;

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function tag(text, className = '') {
  if (!text) return '<span class="tag tag-gray">—</span>';
  return `<span class="tag ${className}">${escHtml(text)}</span>`;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatPhone(raw) {
  if (!raw) return raw;
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits.length === 10 ? digits : null;
  if (!ten) return raw;
  return `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}`;
}

function leadTypeClass(lt) {
  if (!lt) return 'tag-gray';
  const l = lt.toLowerCase();
  if (l.includes('guide'))    return 'tag-green';
  if (l.includes('retire'))   return 'tag-purple';
  if (l.includes('life'))     return 'tag-blue';
  if (l.includes('roth'))     return 'tag-amber';
  if (l.includes('referral')) return 'tag-teal';
  if (l.includes('client'))   return 'tag-indigo';
  return 'tag-gray';
}

function leadStatusClass(ls) {
  if (!ls) return 'tag-gray';
  const l = ls.toLowerCase();
  if (l === 'new lead')                return 'tag-blue';
  if (l === 'attempted contact')       return 'tag-amber';
  if (l === 'contacted')               return 'tag-purple';
  if (l === 'appointment scheduled')   return 'tag-teal';
  if (l === 'appointment completed')   return 'tag-green';
  if (l === 'follow-up needed')        return 'tag-amber';
  if (l === 'application submitted')   return 'tag-indigo';
  if (l === 'sold')                    return 'tag-green';
  if (l === 'long-term nurture')       return 'tag-purple';
  if (l === 'do not contact')          return 'tag-red';
  if (l === 'dead lead')               return 'tag-gray';
  return 'tag-gray';
}

function renderContacts(contacts) {
  errorEl.classList.add('hidden');

  if (!contacts.length) {
    tbody.innerHTML = '';
    emptyEl.classList.remove('hidden');
    countEl.textContent = '0 contacts';
    return;
  }

  emptyEl.classList.add('hidden');
  countEl.textContent = `${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`;

  tbody.innerHTML = contacts.map(c => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
    const initials = [c.first_name, c.last_name].filter(Boolean).map(n => n[0]).join('').toUpperCase() || '?';
    return `
      <tr class="contact-row" onclick="location.href='/contact.html?id=${c.id}'" style="cursor:pointer">
        <td>
          <div class="name-cell">
            <div class="avatar">${escHtml(initials)}</div>
            <span class="contact-name">${escHtml(name)}</span>
          </div>
        </td>
        <td class="text-muted">${c.email ? escHtml(c.email) : '—'}</td>
        <td class="text-muted">${c.phone ? escHtml(formatPhone(c.phone)) : '—'}</td>
        <td>${tag(c.lead_type, leadTypeClass(c.lead_type))}</td>
        <td>${tag(c.lead_status || 'New Lead', leadStatusClass(c.lead_status || 'New Lead'))}</td>
        <td class="text-muted text-small">${c.lead_source ? escHtml(c.lead_source) : '—'}</td>
        <td class="text-muted text-small">${formatDate(c.created_at)}</td>
      </tr>
    `;
  }).join('');
}

async function loadContacts() {
  const params = new URLSearchParams();
  const q  = searchEl.value.trim();
  const lt = filterEl.value;
  const ls = filterStatusEl.value;
  const sm = filterSmsEl.value;
  if (q)  params.set('q', q);
  if (lt) params.set('lead_type', lt);
  if (ls) params.set('lead_status', ls);
  if (sm !== '') params.set('sms_consent', sm);

  try {
    const contacts = await CRM.fetch('/api/contacts?' + params.toString());
    renderContacts(contacts);
  } catch (err) {
    showError(`Could not load contacts: ${err.message}. Is the CRM server running?`);
    tbody.innerHTML = '';
    countEl.textContent = '';
  }
}

// Search / filter with debounce
searchEl.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(loadContacts, 300);
});
filterEl.addEventListener('change', loadContacts);
filterStatusEl.addEventListener('change', loadContacts);
filterSmsEl.addEventListener('change', loadContacts);

// Initial load
loadContacts();
