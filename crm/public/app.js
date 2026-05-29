// Dashboard — contacts list

// ─── DOM refs ──────────────────────────────────────────────────────────────────
const tbody           = document.getElementById('contacts-tbody');
const countEl         = document.getElementById('contact-count');
const errorEl         = document.getElementById('error-banner');
const emptyEl         = document.getElementById('empty-state');
const searchEl        = document.getElementById('search-input');
const filterEl        = document.getElementById('filter-type');
const filterStatusEl  = document.getElementById('filter-status');
const filterSmsEl     = document.getElementById('filter-sms');
const tableCard          = document.getElementById('table-card');
const contactCardsList   = document.getElementById('contacts-cards-list');
const pipelineBoard      = document.getElementById('pipeline-board');
const btnViewList     = document.getElementById('btn-view-list');
const btnViewPipeline = document.getElementById('btn-view-pipeline');
const mobileFilterBtn = document.getElementById('mobile-filter-btn');
const filterDrawerEl  = document.getElementById('filter-drawer');
const filterDrawerOverlay = document.getElementById('filter-drawer-overlay');
const fdSearch        = document.getElementById('fd-search');
const fdType          = document.getElementById('fd-type');
const fdStatus        = document.getElementById('fd-status');
const fdSms           = document.getElementById('fd-sms');
const fabEl           = document.getElementById('fab');

// ─── State ─────────────────────────────────────────────────────────────────────
let debounceTimer;
let allContacts  = [];
let currentView  = localStorage.getItem('crm-view') || 'list';
let dragState    = null;
let wasDragged   = false;
let ghostEl      = null;
let notePopover  = null;

// ─── Visible pipeline columns (7 main stages) ──────────────────────────────────
// Remaining statuses (Attempted Contact, Application Submitted, Do Not Contact,
// Dead Lead) stay available in the status dropdown but don't appear as columns.
const PIPELINE_STATUSES = [
  'New Lead',
  'Contacted',
  'Appointment Scheduled',
  'Appointment Completed',
  'Follow-Up Needed',
  'Sold',
  'Long-Term Nurture',
];

const STATUS_HEADER_CLASS = {
  'New Lead':              'col-header-blue',
  'Contacted':             'col-header-purple',
  'Appointment Scheduled': 'col-header-teal',
  'Appointment Completed': 'col-header-green',
  'Follow-Up Needed':      'col-header-orange',
  'Sold':                  'col-header-green-dark',
  'Long-Term Nurture':     'col-header-purple',
};

// ─── Utilities ─────────────────────────────────────────────────────────────────
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
}

function formatCurrency(val) {
  if (val == null || val === '') return null;
  const n = typeof val === 'number' ? val : parseFloat(val);
  if (isNaN(n)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tag(text, className = '') {
  if (!text) return '<span class="tag tag-gray">—</span>';
  return `<span class="tag ${className}">${escHtml(text)}</span>`;
}

// ─── Next-task formatting helpers ──────────────────────────────────────────────

function fmt12h(t24) {
  if (!t24) return '';
  const [h, m] = t24.split(':').map(Number);
  const p  = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12} ${p}` : `${h12}:${String(m).padStart(2, '0')} ${p}`;
}

function fmtTaskDue(date, time) {
  if (!date) return '—';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const nd = new Date(); nd.setDate(nd.getDate() + 1);
  const tomorrow = nd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const ts = time ? ' ' + fmt12h(time) : '';
  if (date < today) {
    const days = Math.round((new Date(today) - new Date(date)) / 86400000);
    return `Overdue ${days}d`;
  }
  if (date === today)    return `Today${ts}`;
  if (date === tomorrow) return `Tomorrow${ts}`;
  const [y, mo, dy] = date.split('-').map(Number);
  const label = new Date(y, mo - 1, dy).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return ts ? `${label}${ts}` : label;
}

function nextTaskCls(date) {
  if (!date) return 'next-task-none';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const nd = new Date(); nd.setDate(nd.getDate() + 1);
  const tomorrow = nd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  if (date < today)    return 'next-task-overdue';
  if (date === today)  return 'next-task-today';
  if (date === tomorrow) return 'next-task-tomorrow';
  return 'next-task-future';
}

function taskSortKey(c) {
  if (!c.next_task_date) return 4;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const nd = new Date(); nd.setDate(nd.getDate() + 1);
  const tomorrow = nd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  if (c.next_task_date < today)    return 0;
  if (c.next_task_date === today)  return 1;
  if (c.next_task_date === tomorrow) return 2;
  return 3;
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
  if (l.includes('unknown'))  return 'tag-red';
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

// ─── View toggle ───────────────────────────────────────────────────────────────
function setView(view) {
  currentView = view;
  localStorage.setItem('crm-view', view);
  btnViewList.classList.toggle('active', view === 'list');
  btnViewPipeline.classList.toggle('active', view === 'pipeline');
  tableCard.classList.toggle('hidden', view !== 'list');
  if (contactCardsList) contactCardsList.classList.toggle('hidden', view !== 'list');
  pipelineBoard.classList.toggle('hidden', view !== 'pipeline');
  if (view === 'pipeline') emptyEl.classList.add('hidden');
}

btnViewList.addEventListener('click', () => { setView('list'); loadContacts(); });
btnViewPipeline.addEventListener('click', () => { setView('pipeline'); loadContacts(); });

// ─── List view ─────────────────────────────────────────────────────────────────
function renderContacts(contacts) {
  errorEl.classList.add('hidden');

  if (!contacts.length) {
    tbody.innerHTML = '';
    if (contactCardsList) contactCardsList.innerHTML = '';
    emptyEl.classList.remove('hidden');
    countEl.textContent = '0 contacts';
    return;
  }

  emptyEl.classList.add('hidden');
  countEl.textContent = `${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`;

  // Sort by task urgency (overdue → today → tomorrow → future → no task),
  // preserving existing created_at order within each tier.
  const sorted = [...contacts].sort((a, b) => taskSortKey(a) - taskSortKey(b));

  tbody.innerHTML = sorted.map(c => {
    const name     = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
    const initials = [c.first_name, c.last_name].filter(Boolean).map(n => n[0]).join('').toUpperCase() || '?';
    const ntCls    = nextTaskCls(c.next_task_date);
    const ntType   = c.next_task_type
      ? `<span class="next-task-pill ${ntCls}">${escHtml(c.next_task_type)}</span>`
      : `<span class="next-task-pill next-task-none">No Task</span>`;
    const ntDue    = c.next_task_date
      ? `<span class="next-task-pill ${ntCls}">${escHtml(fmtTaskDue(c.next_task_date, c.next_task_time))}</span>`
      : `<span class="next-task-pill next-task-none">—</span>`;
    return `
      <tr class="contact-row" onclick="location.href='/contact.html?id=${c.id}'" style="cursor:pointer">
        <td>
          <div class="name-cell">
            <div class="avatar">${escHtml(initials)}</div>
            <span class="contact-name">${escHtml(name)}</span>
          </div>
        </td>
        <td class="text-muted">${c.email ? `<a class="email-link" href="https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}&su=Prosperity%20Life%20%26%20Financial%20Solutions%20Follow-Up" target="_blank" rel="noopener" title="Send Email" onclick="event.stopPropagation()">${escHtml(c.email)}</a>` : '—'}</td>
        <td class="text-muted">${c.phone
            ? `<button class="phone-call-btn" data-phone="${escHtml(c.phone_e164 || c.phone)}" onclick="event.stopPropagation(); initiateCallById(this, ${c.id})" title="Call ${escHtml(formatPhone(c.phone))}">☎ ${escHtml(formatPhone(c.phone))}</button>`
            : '—'}</td>
        <td>${tag(c.lead_type, leadTypeClass(c.lead_type))}</td>
        <td>
          ${tag(c.lead_status || 'New Lead', leadStatusClass(c.lead_status || 'New Lead'))}
          ${c.tasks_overdue  ? `<span class="task-badge task-badge-overdue">⚠${c.tasks_overdue}</span>` : ''}
          ${!c.tasks_overdue && c.tasks_today ? `<span class="task-badge task-badge-today">📅${c.tasks_today}</span>` : ''}
          ${!c.tasks_overdue && !c.tasks_today && c.tasks_tomorrow ? `<span class="task-badge task-badge-tomorrow">📅${c.tasks_tomorrow}</span>` : ''}
        </td>
        <td class="next-task-col">${ntType}</td>
        <td class="next-task-col">${ntDue}</td>
        <td class="text-muted text-small">${c.lead_source ? escHtml(c.lead_source) : '—'}</td>
        <td class="text-muted text-small">${formatDate(c.created_at)}</td>
      </tr>
    `;
  }).join('');

  if (contactCardsList) {
    contactCardsList.innerHTML = contacts.map(c => buildMobileContactCard(c)).join('');
  }
}

function buildMobileContactCard(c) {
  const name     = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
  const initials = [c.first_name, c.last_name].filter(Boolean).map(n => n[0]).join('').toUpperCase() || '?';
  const phone    = c.phone ? formatPhone(c.phone) : null;
  const callHref = c.phone_e164 || (c.phone ? '+1' + c.phone.replace(/\D/g, '') : null);

  const callBtn = phone
    ? `<button class="mcc-call-btn" data-phone="${escHtml(callHref || phone)}" onclick="event.stopPropagation(); initiateCallById(this, ${c.id})" title="Call ${escHtml(phone)}">☎</button>`
    : '';

  const emailBtn = c.email
    ? `<button class="mcc-email-btn" onclick="event.stopPropagation(); mccOpenEmail(${c.id}, '${escHtml(c.email)}')" title="Send email">✉</button>`
    : '';

  return `
    <div class="mobile-contact-card" onclick="location.href='/contact.html?id=${c.id}'">
      <div class="mcc-top">
        <div class="avatar">${escHtml(initials)}</div>
        <div class="mcc-info">
          <div class="mcc-name">${escHtml(name)}</div>
          ${phone ? `<div class="mcc-phone">${escHtml(phone)}</div>` : ''}
        </div>
        <div class="mcc-btns">
          ${callBtn}
          ${emailBtn}
          <a class="mcc-view-btn" href="/contact.html?id=${c.id}" onclick="event.stopPropagation()">→</a>
        </div>
      </div>
      <div class="mcc-footer">
        ${tag(c.lead_type, leadTypeClass(c.lead_type))}
        ${tag(c.lead_status || 'New Lead', leadStatusClass(c.lead_status || 'New Lead'))}
        ${c.tasks_overdue  ? `<span class="task-badge task-badge-overdue">⚠${c.tasks_overdue}</span>` : ''}
        ${!c.tasks_overdue && c.tasks_today ? `<span class="task-badge task-badge-today">📅${c.tasks_today}</span>` : ''}
        ${!c.tasks_overdue && !c.tasks_today && c.tasks_tomorrow ? `<span class="task-badge task-badge-tomorrow">📅${c.tasks_tomorrow}</span>` : ''}
        <span class="mcc-date">${formatDate(c.created_at)}</span>
      </div>
      ${c.next_task_type ? `<div class="mcc-next-task">
        <span class="next-task-pill ${nextTaskCls(c.next_task_date)}">${escHtml(c.next_task_type)}</span>
        <span class="next-task-pill ${nextTaskCls(c.next_task_date)}">${escHtml(fmtTaskDue(c.next_task_date, c.next_task_time))}</span>
      </div>` : ''}
    </div>
  `;
}

// ─── Pipeline view ─────────────────────────────────────────────────────────────
function renderPipeline(contacts) {
  errorEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  countEl.textContent = `${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`;

  // Contacts whose status is not a visible column fall into the nearest visible one.
  // Attempted Contact → Contacted; Application Submitted → Follow-Up Needed;
  // Do Not Contact / Dead Lead → Long-Term Nurture (shown in pipeline but no dedicated col).
  const fallback = {
    'Attempted Contact':     'Contacted',
    'Application Submitted': 'Follow-Up Needed',
    'Do Not Contact':        'Long-Term Nurture',
    'Dead Lead':             'Long-Term Nurture',
  };

  const sorted = [...contacts].sort((a, b) => taskSortKey(a) - taskSortKey(b));
  const grouped = Object.fromEntries(PIPELINE_STATUSES.map(s => [s, []]));
  for (const c of sorted) {
    const s = c.lead_status || 'New Lead';
    const bucket = grouped[s] ? s : (fallback[s] || 'New Lead');
    grouped[bucket].push(c);
  }

  pipelineBoard.innerHTML = PIPELINE_STATUSES.map(status => {
    const cards = grouped[status];
    const colId = status.replace(/ /g, '-');
    return `
      <div class="pipeline-col" data-status="${escHtml(status)}">
        <div class="pipeline-col-header ${STATUS_HEADER_CLASS[status] || 'col-header-gray'}">
          <span class="pipeline-col-title">${escHtml(status)}</span>
          <span class="pipeline-col-count" id="col-count-${colId}">${cards.length}</span>
        </div>
        <div class="pipeline-col-body" id="col-body-${colId}">
          ${cards.map(c => buildCard(c)).join('')}
          ${cards.length === 0 ? '<div class="pipeline-col-empty">Drop here</div>' : ''}
        </div>
      </div>
    `;
  }).join('');

  // Drag on each card (click handled by board delegation below)
  pipelineBoard.querySelectorAll('.pipeline-card').forEach(card => {
    card.addEventListener('pointerdown', onPointerDown);
  });

  // Single delegated click handler — replaces per-card click listeners
  pipelineBoard.removeEventListener('click', handleBoardClick);
  pipelineBoard.addEventListener('click', handleBoardClick);
}

// ─── Card template ─────────────────────────────────────────────────────────────
function buildCard(c) {
  const name     = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(No name)';
  const initials = [c.first_name, c.last_name].filter(Boolean).map(n => n[0]).join('').toUpperCase() || '?';
  const phone    = c.phone ? formatPhone(c.phone) : null;
  const callHref = c.phone_e164 || (c.phone ? '+1' + c.phone.replace(/\D/g, '') : null);

  const calledToday    = c.last_called_at && new Date(c.last_called_at).toDateString() === new Date().toDateString();
  // Missed: outbound no-answer/busy OR inbound missed
  const missedToday    = calledToday && ['no-answer', 'busy', 'missed'].includes(c.last_call_status);
  // Voicemail: we left one (outbound) OR they left one (inbound)
  const voicemailToday = calledToday && ['voicemail_left', 'voicemail'].includes(c.last_call_status);

  const actionCall = phone
    ? `<button class="pc-action-btn pc-action-call" data-action="call" data-contact-id="${c.id}" data-phone="${escHtml(callHref || phone)}" title="Call ${escHtml(phone)}">☎ Call</button>`
    : '';
  const gmailUrl = c.email
    ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}&su=Prosperity%20Life%20%26%20Financial%20Solutions%20Follow-Up`
    : null;
  // Email button: opens CRM modal when Gmail configured, falls back to Gmail compose
  const actionEmail = c.email
    ? `<button class="pc-action-btn pc-action-email" data-action="email"
         data-contact-id="${c.id}" data-email="${escHtml(c.email)}" data-name="${escHtml(name)}"
         title="Send Email">Email</button>`
    : '';

  const prodItems = [];
  if (c.face_amount)               prodItems.push(`Life: ${formatCurrency(c.face_amount)}`);
  if (c.annuity_premium)           prodItems.push(`Ann: ${formatCurrency(c.annuity_premium)}`);
  if (c.estimated_rollover_amount) prodItems.push(`Rollover: ${formatCurrency(c.estimated_rollover_amount)}`);
  if (c.commission_estimate)       prodItems.push(`Comm: ${formatCurrency(c.commission_estimate)}`);
  const prodLine = prodItems.length
    ? `<div class="pc-production">${escHtml(prodItems.join(' · '))}</div>`
    : '';

  return `
    <div class="pipeline-card" data-id="${c.id}" data-status="${escHtml(c.lead_status || 'New Lead')}">
      <div class="pc-name-row">
        <div class="avatar avatar-sm">${escHtml(initials)}</div>
        <span class="pc-name">${escHtml(name)}</span>
      </div>
      ${phone   ? `<div class="pc-detail">${escHtml(phone)}</div>` : ''}
      ${c.email ? `<div class="pc-detail pc-muted">${escHtml(c.email)}</div>` : ''}
      <div class="pc-footer">
        ${c.lead_type ? `<span class="tag tag-xs ${leadTypeClass(c.lead_type)}">${escHtml(c.lead_type)}</span>` : ''}
        <span class="pc-date">${formatDate(c.created_at)}</span>
      </div>
      ${calledToday && !missedToday && !voicemailToday ? '<div class="call-indicator call-ind-today">Called Today</div>' : ''}
      ${missedToday    ? '<div class="call-indicator call-ind-missed">Missed Call</div>'      : ''}
      ${voicemailToday ? '<div class="call-indicator call-ind-voicemail">Voicemail</div>'     : ''}
      ${c.tasks_overdue  ? `<div class="call-indicator task-ind-overdue">⚠ ${c.tasks_overdue} overdue task${c.tasks_overdue > 1 ? 's' : ''}</div>` : ''}
      ${!c.tasks_overdue && c.tasks_today    ? `<div class="call-indicator task-ind-today">📅 ${c.tasks_today} task${c.tasks_today > 1 ? 's' : ''} today</div>` : ''}
      ${!c.tasks_overdue && !c.tasks_today && c.tasks_tomorrow ? `<div class="call-indicator task-ind-tomorrow">📅 ${c.tasks_tomorrow} due tomorrow</div>` : ''}
      ${!c.tasks_overdue && !c.tasks_today && !c.tasks_tomorrow && c.tasks_upcoming ? `<div class="call-indicator task-ind-upcoming">📋 ${c.tasks_upcoming} upcoming</div>` : ''}
      ${c.lead_source ? `<div class="pc-source">${escHtml(c.lead_source)}</div>` : ''}
      ${prodLine}
      <div class="pc-actions">
        ${actionCall}
        ${actionEmail}
        <button class="pc-action-btn" data-action="note" title="Add a note">Note</button>
        <a class="pc-action-btn pc-action-view" href="/contact.html?id=${c.id}" data-action="view" title="View full contact">View</a>
      </div>
    </div>
  `;
}

// ─── Board click delegation ────────────────────────────────────────────────────
function handleBoardClick(e) {
  closeNotePopover();

  const btn = e.target.closest('.pc-action-btn');
  if (btn) {
    const action = btn.dataset.action;
    if (action === 'note') {
      e.preventDefault();
      const card = btn.closest('.pipeline-card');
      if (card) showQuickNote(btn, card.dataset.id);
      return;
    }
    if (action === 'call') {
      e.preventDefault();
      initiateCall(btn, btn.dataset.contactId, btn.dataset.phone);
      return;
    }
    if (action === 'email') {
      e.preventDefault();
      const email = btn.dataset.email;
      const cid   = parseInt(btn.dataset.contactId);
      if (window.CRM_GMAIL_ENABLED && email && typeof openEmailModal === 'function') {
        openEmailModal(cid, email, 'Prosperity Life & Financial Solutions Follow-Up');
      } else if (email) {
        // Fallback: open Gmail compose
        const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent('Prosperity Life & Financial Solutions Follow-Up')}`;
        window.open(url, '_blank', 'noopener');
      }
      return;
    }
    // view: let href navigate
    return;
  }

  const card = e.target.closest('.pipeline-card');
  if (card) {
    if (wasDragged) { wasDragged = false; return; }
    location.href = `/contact.html?id=${card.dataset.id}`;
  }
}

// ─── Quick note popover ────────────────────────────────────────────────────────
function showQuickNote(triggerEl, contactId) {
  const rect = triggerEl.getBoundingClientRect();
  const pw = 248;
  const ph = 155; // estimated height

  let left = rect.left;
  let top  = rect.bottom + 6;

  // Keep within viewport
  if (left + pw > window.innerWidth - 10) left = window.innerWidth - pw - 10;
  if (left < 10) left = 10;
  if (top + ph > window.innerHeight - 10) top = rect.top - ph - 6;
  if (top < 10) top = 10;

  notePopover = document.createElement('div');
  notePopover.className = 'quick-note-popover';
  notePopover.style.cssText = `left:${left}px;top:${top}px;width:${pw}px`;
  notePopover.innerHTML = `
    <div class="qn-title">Quick Note</div>
    <textarea class="qn-textarea" placeholder="Type a note… (Ctrl+Enter to save)" rows="3"></textarea>
    <div class="qn-footer">
      <button class="btn btn-primary qn-save">Save Note</button>
      <button class="btn qn-cancel">Cancel</button>
    </div>
  `;
  document.body.appendChild(notePopover);
  notePopover.querySelector('.qn-textarea').focus();

  async function save() {
    const body = notePopover.querySelector('.qn-textarea').value.trim();
    if (!body) return;
    const saveBtn = notePopover.querySelector('.qn-save');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await CRM.fetch(`/api/contacts/${contactId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      });
      closeNotePopover();
    } catch (err) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Note';
      showError(`Could not save note: ${err.message}`);
    }
  }

  notePopover.querySelector('.qn-save').addEventListener('click', save);
  notePopover.querySelector('.qn-cancel').addEventListener('click', closeNotePopover);
  notePopover.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeNotePopover();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
  });

  // Stash outside-click handler so we can remove it on close
  function onOutsideClick(e) {
    if (notePopover && !notePopover.contains(e.target) && e.target !== triggerEl) {
      closeNotePopover();
    }
  }
  // Delay to prevent the same click that opened it from immediately closing it
  setTimeout(() => document.addEventListener('click', onOutsideClick), 100);
  notePopover._dismiss = () => document.removeEventListener('click', onOutsideClick);
}

function closeNotePopover() {
  if (!notePopover) return;
  notePopover._dismiss?.();
  notePopover.remove();
  notePopover = null;
}

// ─── Drag and drop (pointer events — mouse + touch) ────────────────────────────
function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return;
  // Don't start drag if the press originated on an action button
  if (e.target.closest('.pc-action-btn')) return;

  const card = e.currentTarget;

  dragState = {
    card,
    contactId:      card.dataset.id,
    originalStatus: card.dataset.status,
    startX:         e.clientX,
    startY:         e.clientY,
    currentCol:     null,
    moved:          false,
  };

  // Capture pointer so we keep receiving events even if finger drifts off card.
  // Do NOT preventDefault here — the browser needs to evaluate touch-action:pan-y
  // and will fire pointercancel if it claims a vertical scroll gesture.
  card.setPointerCapture(e.pointerId);
  card.addEventListener('pointermove',   onPointerMove);
  card.addEventListener('pointerup',     onPointerUp);
  card.addEventListener('pointercancel', onPointerCancel);
}

function onPointerMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;

  if (!dragState.moved) {
    if (Math.hypot(dx, dy) < 8) return;

    // Primarily vertical → cancel drag so browser can scroll the column.
    // (Browser also fires pointercancel for pan-y gestures, but this explicit
    // check ensures we never flash the ghost on a near-vertical swipe.)
    if (Math.abs(dy) > Math.abs(dx) * 1.2) {
      cleanupDrag(dragState.card);
      return;
    }

    // Primarily horizontal → commit to drag, create ghost now
    const card = dragState.card;
    const rect = card.getBoundingClientRect();
    ghostEl = card.cloneNode(true);
    ghostEl.className = 'pipeline-card drag-ghost';
    ghostEl.style.width = rect.width + 'px';
    ghostEl.style.left  = rect.left  + 'px';
    ghostEl.style.top   = rect.top   + 'px';
    document.body.appendChild(ghostEl);
    card.classList.add('drag-source');
    dragState.moved = true;
    e.preventDefault(); // stop board from scrolling during drag
  }

  ghostEl.style.transform = `translate(${dx}px, ${dy}px)`;

  ghostEl.style.pointerEvents = 'none';
  const el = document.elementFromPoint(e.clientX, e.clientY);
  ghostEl.style.pointerEvents = '';

  const col = el ? el.closest('.pipeline-col') : null;
  if (col !== dragState.currentCol) {
    dragState.currentCol?.querySelector('.pipeline-col-body').classList.remove('drag-over');
    col?.querySelector('.pipeline-col-body').classList.add('drag-over');
    dragState.currentCol = col;
  }
}

function onPointerUp() {
  if (!dragState) return;
  const { card, contactId, originalStatus, currentCol, moved } = dragState;

  wasDragged = moved;
  cleanupDrag(card);

  if (!moved || !currentCol) return;

  const newStatus = currentCol.dataset.status;
  if (newStatus === originalStatus) return;

  // Optimistic DOM move
  const destBody    = currentCol.querySelector('.pipeline-col-body');
  const emptyMarker = destBody.querySelector('.pipeline-col-empty');
  if (emptyMarker) emptyMarker.remove();

  card.dataset.status = newStatus;
  destBody.appendChild(card);
  card.addEventListener('pointerdown', onPointerDown); // re-bind drag after DOM move

  refreshColEmpty(pipelineBoard.querySelector(`.pipeline-col[data-status="${CSS.escape(originalStatus)}"]`));
  adjustColCount(originalStatus, -1);
  adjustColCount(newStatus, +1);

  // Persist
  CRM.fetch(`/api/contacts/${contactId}`, {
    method: 'PATCH',
    body: JSON.stringify({ lead_status: newStatus }),
  }).catch(err => {
    showError(`Could not update status: ${err.message}`);
    // Revert
    card.dataset.status = originalStatus;
    const srcBody = pipelineBoard.querySelector(`.pipeline-col[data-status="${CSS.escape(originalStatus)}"]`)
                                 ?.querySelector('.pipeline-col-body');
    if (srcBody) {
      const em = srcBody.querySelector('.pipeline-col-empty');
      if (em) em.remove();
      srcBody.appendChild(card);
      card.addEventListener('pointerdown', onPointerDown);
    }
    refreshColEmpty(currentCol);
    adjustColCount(newStatus, -1);
    adjustColCount(originalStatus, +1);
  });
}

function onPointerCancel() {
  if (dragState) cleanupDrag(dragState.card);
}

function cleanupDrag(card) {
  if (!dragState) return;
  ghostEl?.remove();
  ghostEl = null;
  card.classList.remove('drag-source');
  dragState.currentCol?.querySelector('.pipeline-col-body').classList.remove('drag-over');
  card.removeEventListener('pointermove',   onPointerMove);
  card.removeEventListener('pointerup',     onPointerUp);
  card.removeEventListener('pointercancel', onPointerCancel);
  dragState = null;
}

function refreshColEmpty(colEl) {
  if (!colEl) return;
  const body = colEl.querySelector('.pipeline-col-body');
  if (body.querySelectorAll('.pipeline-card').length === 0 && !body.querySelector('.pipeline-col-empty')) {
    body.innerHTML = '<div class="pipeline-col-empty">Drop here</div>';
  }
}

function adjustColCount(status, delta) {
  const el = document.getElementById('col-count-' + status.replace(/ /g, '-'));
  if (el) el.textContent = Math.max(0, parseInt(el.textContent || '0') + delta);
}

// ─── Click-to-call ─────────────────────────────────────────────────────────────

async function initiateCall(btn, contactId, fallbackPhone) {
  if (!window.CRM_TWILIO_ENABLED) return;

  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="call-spinner"></span> Connecting…';

  try {
    await CRM.fetch('/api/calls/outbound', {
      method: 'POST',
      body: JSON.stringify({ contact_id: contactId }),
    });
    btn.innerHTML = '✓ Your phone is ringing — answer to connect';
    setTimeout(() => { btn.disabled = false; btn.innerHTML = origHtml; }, 8000);
    loadContacts(); // refresh cards so "Called Today" badge appears
  } catch (err) {
    showError(`Call failed: ${err.message}`);
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

// Used by the list-view phone button (inline onclick) and mobile contact cards
async function initiateCallById(btn, contactId) {
  if (!window.CRM_TWILIO_ENABLED) return;

  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="call-spinner"></span>';

  try {
    await CRM.fetch('/api/calls/outbound', {
      method: 'POST',
      body: JSON.stringify({ contact_id: contactId }),
    });
    btn.innerHTML = '✓';
    setTimeout(() => { btn.disabled = false; btn.innerHTML = origHtml; }, 8000);
  } catch (err) {
    showError(`Call failed: ${err.message}`);
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

// ─── Load contacts ─────────────────────────────────────────────────────────────
async function loadContacts() {
  const params = new URLSearchParams();
  const q  = searchEl.value.trim();
  const lt = filterEl.value;
  const ls = filterStatusEl.value;
  const sm = filterSmsEl.value;
  if (q)        params.set('q', q);
  if (lt)       params.set('lead_type', lt);
  if (ls)       params.set('lead_status', ls);
  if (sm !== '') params.set('sms_consent', sm);

  try {
    const contacts = await CRM.fetch('/api/contacts?' + params.toString());
    allContacts = contacts;
    if (currentView === 'list') {
      renderContacts(contacts);
    } else {
      renderPipeline(contacts);
    }
  } catch (err) {
    showError(`Could not load contacts: ${err.message}. Is the CRM server running?`);
    if (currentView === 'list') {
      tbody.innerHTML = '';
      countEl.textContent = '';
    }
  }
}

// ─── Mobile contact card email helper ─────────────────────────────────────────

function mccOpenEmail(contactId, email) {
  if (window.CRM_GMAIL_ENABLED && typeof openEmailModal === 'function') {
    openEmailModal(contactId, email, 'Prosperity Life & Financial Solutions Follow-Up');
  } else {
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent('Prosperity Life & Financial Solutions Follow-Up')}`;
    window.open(url, '_blank', 'noopener');
  }
}

// ─── Filter drawer (mobile bottom sheet) ───────────────────────────────────────

function openFilterDrawer() {
  if (!filterDrawerEl) return;
  if (fdSearch) fdSearch.value = searchEl.value;
  if (fdType)   fdType.value   = filterEl.value;
  if (fdStatus) fdStatus.value = filterStatusEl.value;
  if (fdSms)    fdSms.value    = filterSmsEl.value;
  filterDrawerEl.classList.add('drawer-open');
  filterDrawerOverlay.classList.add('visible');
  document.body.style.overflow = 'hidden';
  setTimeout(() => fdSearch && fdSearch.focus(), 300);
}

function closeFilterDrawer() {
  if (!filterDrawerEl) return;
  filterDrawerEl.classList.remove('drawer-open');
  filterDrawerOverlay.classList.remove('visible');
  document.body.style.overflow = '';
}

function applyFilterDrawer() {
  if (fdSearch) searchEl.value       = fdSearch.value;
  if (fdType)   filterEl.value        = fdType.value;
  if (fdStatus) filterStatusEl.value  = fdStatus.value;
  if (fdSms)    filterSmsEl.value     = fdSms.value;
  updateMobileFilterBadge();
  closeFilterDrawer();
  loadContacts();
}

function clearFilterDrawer() {
  if (fdSearch) fdSearch.value = '';
  if (fdType)   fdType.value   = '';
  if (fdStatus) fdStatus.value = '';
  if (fdSms)    fdSms.value    = '';
  searchEl.value = '';
  filterEl.value = '';
  filterStatusEl.value = '';
  filterSmsEl.value = '';
  updateMobileFilterBadge();
  closeFilterDrawer();
  loadContacts();
}

function updateMobileFilterBadge() {
  if (!mobileFilterBtn) return;
  const activeFilters = [
    filterEl.value,
    filterStatusEl.value,
    filterSmsEl.value,
    searchEl.value.trim(),
  ].filter(Boolean).length;
  mobileFilterBtn.classList.toggle('has-filters', activeFilters > 0);
  const badge = activeFilters > 0
    ? `<span class="mobile-filter-badge">${activeFilters}</span>`
    : '';
  mobileFilterBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 2.5h12M3 7h8M5 11.5h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
    Filter ${badge}`;
}

// ─── FAB ───────────────────────────────────────────────────────────────────────

function toggleFab() {
  if (!fabEl) return;
  fabEl.classList.toggle('fab-open');
}

function closeFab() {
  if (fabEl) fabEl.classList.remove('fab-open');
}

document.addEventListener('click', e => {
  if (fabEl && fabEl.classList.contains('fab-open') && !fabEl.contains(e.target)) {
    closeFab();
  }
});

// ─── Event listeners ───────────────────────────────────────────────────────────
searchEl.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { loadContacts(); updateMobileFilterBadge(); }, 300);
});
filterEl.addEventListener('change', () => { loadContacts(); updateMobileFilterBadge(); });
filterStatusEl.addEventListener('change', () => { loadContacts(); updateMobileFilterBadge(); });
filterSmsEl.addEventListener('change', () => { loadContacts(); updateMobileFilterBadge(); });

// ─── Dashboard stats ──────────────────────────────────────────────────────────

async function loadTaskStats() {
  try {
    const s = await CRM.fetch('/api/stats');

    // Compact chip bar (header area)
    const bar = document.getElementById('task-stat-bar');
    if (bar) {
      const chips = [];
      if (s.tasks.overdue)   chips.push(`<span class="task-stat-chip task-stat-overdue">⚠ ${s.tasks.overdue} Overdue</span>`);
      if (s.tasks.today)     chips.push(`<span class="task-stat-chip task-stat-today">⏰ ${s.tasks.today} Due Today</span>`);
      if (s.tasks.tomorrow)  chips.push(`<span class="task-stat-chip task-stat-tomorrow">📅 ${s.tasks.tomorrow} Due Tomorrow</span>`);
      if (s.tasks.upcoming)  chips.push(`<span class="task-stat-chip task-stat-upcoming">📋 ${s.tasks.upcoming} Upcoming</span>`);
      bar.innerHTML = chips.join('');
      bar.classList.toggle('hidden', !chips.length);
    }

    renderDashboardStats(s);
  } catch {
    // stats endpoint may not be active yet
  }
}

function renderDashboardStats(s) {
  const grid = document.getElementById('dashboard-stats');
  if (!grid) return;

  const cards = [
    { val: s.tasks.overdue,   label: 'Overdue Tasks',   cls: 'ds-overdue',  alwaysShow: false },
    { val: s.tasks.today,     label: 'Due Today',       cls: 'ds-today',    alwaysShow: true  },
    { val: s.tasks.tomorrow,  label: 'Due Tomorrow',    cls: 'ds-tomorrow', alwaysShow: true  },
    { val: s.tasks.upcoming,  label: 'Upcoming Tasks',  cls: 'ds-upcoming', alwaysShow: true  },
    { val: s.apptsToday,      label: 'Appts Today',     cls: 'ds-appts',    alwaysShow: true  },
    { val: s.newLeads,        label: 'New Leads',       cls: 'ds-leads',    alwaysShow: true  },
    { val: s.inboundSms,      label: 'Inbound SMS',     cls: 'ds-sms',      alwaysShow: false },
    { val: s.inboundEmail,    label: 'Inbound Emails',  cls: 'ds-email',    alwaysShow: false },
  ];

  const visible = cards.filter(c => c.alwaysShow || c.val > 0);
  if (!visible.length) { grid.classList.add('hidden'); return; }

  grid.innerHTML = visible.map(c => `
    <div class="dash-stat-card ${c.cls}${c.val === 0 ? ' ds-zero' : ''}">
      <span class="dash-stat-val">${c.val}</span>
      <span class="dash-stat-label">${escHtml(c.label)}</span>
    </div>`).join('');
  grid.classList.remove('hidden');
}

// ─── Init ──────────────────────────────────────────────────────────────────────
setView(currentView);
loadContacts();
loadTaskStats();
