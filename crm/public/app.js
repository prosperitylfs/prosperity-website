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
const tableCard       = document.getElementById('table-card');
const pipelineBoard   = document.getElementById('pipeline-board');
const btnViewList     = document.getElementById('btn-view-list');
const btnViewPipeline = document.getElementById('btn-view-pipeline');

// ─── State ─────────────────────────────────────────────────────────────────────
let debounceTimer;
let allContacts = [];
let currentView = localStorage.getItem('crm-view') || 'list';
let dragState   = null;
let wasDragged  = false;
let ghostEl     = null;

// ─── Pipeline column order ─────────────────────────────────────────────────────
const PIPELINE_STATUSES = [
  'New Lead', 'Attempted Contact', 'Contacted',
  'Appointment Scheduled', 'Appointment Completed', 'Follow-Up Needed',
  'Application Submitted', 'Sold', 'Long-Term Nurture',
  'Do Not Contact', 'Dead Lead',
];

const STATUS_HEADER_CLASS = {
  'New Lead':              'col-header-blue',
  'Attempted Contact':     'col-header-amber',
  'Contacted':             'col-header-purple',
  'Appointment Scheduled': 'col-header-teal',
  'Appointment Completed': 'col-header-green',
  'Follow-Up Needed':      'col-header-orange',
  'Application Submitted': 'col-header-indigo',
  'Sold':                  'col-header-green-dark',
  'Long-Term Nurture':     'col-header-purple',
  'Do Not Contact':        'col-header-red',
  'Dead Lead':             'col-header-gray',
};

// ─── Utilities ─────────────────────────────────────────────────────────────────
function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tag(text, className = '') {
  if (!text) return '<span class="tag tag-gray">—</span>';
  return `<span class="tag ${className}">${escHtml(text)}</span>`;
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

// ─── View toggle ───────────────────────────────────────────────────────────────
function setView(view) {
  currentView = view;
  localStorage.setItem('crm-view', view);
  btnViewList.classList.toggle('active', view === 'list');
  btnViewPipeline.classList.toggle('active', view === 'pipeline');
  tableCard.classList.toggle('hidden', view !== 'list');
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
    emptyEl.classList.remove('hidden');
    countEl.textContent = '0 contacts';
    return;
  }

  emptyEl.classList.add('hidden');
  countEl.textContent = `${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`;

  tbody.innerHTML = contacts.map(c => {
    const name     = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—';
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

// ─── Pipeline view ─────────────────────────────────────────────────────────────
function renderPipeline(contacts) {
  errorEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  countEl.textContent = `${contacts.length} contact${contacts.length !== 1 ? 's' : ''}`;

  // Group contacts by status; unknown statuses fall into New Lead
  const grouped = Object.fromEntries(PIPELINE_STATUSES.map(s => [s, []]));
  for (const c of contacts) {
    const s = c.lead_status || 'New Lead';
    (grouped[s] ?? grouped['New Lead']).push(c);
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

  // Wire up drag and click on all cards
  pipelineBoard.querySelectorAll('.pipeline-card').forEach(bindCard);
}

function buildCard(c) {
  const name     = [c.first_name, c.last_name].filter(Boolean).join(' ') || '(No name)';
  const initials = [c.first_name, c.last_name].filter(Boolean).map(n => n[0]).join('').toUpperCase() || '?';
  const phone    = c.phone ? formatPhone(c.phone) : null;
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
      ${c.lead_source ? `<div class="pc-source">${escHtml(c.lead_source)}</div>` : ''}
    </div>
  `;
}

function bindCard(card) {
  card.addEventListener('pointerdown', onPointerDown);
  card.addEventListener('click', onCardClick);
}

function onCardClick(e) {
  if (wasDragged) { wasDragged = false; return; }
  location.href = `/contact.html?id=${e.currentTarget.dataset.id}`;
}

// ─── Drag and drop (pointer events — mouse + touch) ────────────────────────────
function onPointerDown(e) {
  // Left button / first touch only
  if (e.button !== undefined && e.button !== 0) return;

  const card = e.currentTarget;
  const rect = card.getBoundingClientRect();

  // Create ghost (clone positioned over the original)
  ghostEl = card.cloneNode(true);
  ghostEl.className = 'pipeline-card drag-ghost';
  ghostEl.style.width  = rect.width + 'px';
  ghostEl.style.left   = rect.left + 'px';
  ghostEl.style.top    = rect.top  + 'px';
  document.body.appendChild(ghostEl);

  dragState = {
    card,
    contactId:      card.dataset.id,
    originalStatus: card.dataset.status,
    startX:         e.clientX,
    startY:         e.clientY,
    currentCol:     null,
    moved:          false,
  };

  card.classList.add('drag-source');
  card.setPointerCapture(e.pointerId);
  card.addEventListener('pointermove',   onPointerMove);
  card.addEventListener('pointerup',     onPointerUp);
  card.addEventListener('pointercancel', onPointerCancel);
  e.preventDefault();
}

function onPointerMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;

  if (!dragState.moved && Math.hypot(dx, dy) > 6) dragState.moved = true;
  if (!dragState.moved) return;

  ghostEl.style.transform = `translate(${dx}px, ${dy}px)`;

  // Detect target column (hide ghost so elementFromPoint hits the board)
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
  const destBody = currentCol.querySelector('.pipeline-col-body');
  const emptyMarker = destBody.querySelector('.pipeline-col-empty');
  if (emptyMarker) emptyMarker.remove();

  card.dataset.status = newStatus;
  destBody.appendChild(card);
  card.addEventListener('pointerdown', onPointerDown);
  card.addEventListener('click', onCardClick);

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
    const srcCol  = pipelineBoard.querySelector(`.pipeline-col[data-status="${CSS.escape(originalStatus)}"]`);
    const srcBody = srcCol?.querySelector('.pipeline-col-body');
    if (srcBody) {
      const em = srcBody.querySelector('.pipeline-col-empty');
      if (em) em.remove();
      srcBody.appendChild(card);
      card.addEventListener('pointerdown', onPointerDown);
      card.addEventListener('click', onCardClick);
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
  const body  = colEl.querySelector('.pipeline-col-body');
  const cards = body.querySelectorAll('.pipeline-card');
  if (cards.length === 0 && !body.querySelector('.pipeline-col-empty')) {
    body.innerHTML = '<div class="pipeline-col-empty">Drop here</div>';
  }
}

function adjustColCount(status, delta) {
  const el = document.getElementById('col-count-' + status.replace(/ /g, '-'));
  if (el) el.textContent = Math.max(0, parseInt(el.textContent || '0') + delta);
}

// ─── Load contacts ─────────────────────────────────────────────────────────────
async function loadContacts() {
  const params = new URLSearchParams();
  const q  = searchEl.value.trim();
  const lt = filterEl.value;
  const ls = filterStatusEl.value;
  const sm = filterSmsEl.value;
  if (q)       params.set('q', q);
  if (lt)      params.set('lead_type', lt);
  if (ls)      params.set('lead_status', ls);
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

// ─── Event listeners ───────────────────────────────────────────────────────────
searchEl.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(loadContacts, 300);
});
filterEl.addEventListener('change', loadContacts);
filterStatusEl.addEventListener('change', loadContacts);
filterSmsEl.addEventListener('change', loadContacts);

// ─── Init ──────────────────────────────────────────────────────────────────────
setView(currentView);
loadContacts();
