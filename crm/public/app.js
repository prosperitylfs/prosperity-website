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
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' });
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
        <td class="text-muted">${c.email ? `<a class="email-link" href="https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}&su=Prosperity%20Life%20%26%20Financial%20Solutions%20Follow-Up" target="_blank" rel="noopener" title="Send Email" onclick="event.stopPropagation()">${escHtml(c.email)}</a>` : '—'}</td>
        <td class="text-muted">${c.phone
            ? `<button class="phone-call-btn" data-phone="${escHtml(c.phone_e164 || c.phone)}" onclick="event.stopPropagation(); initiateCallById(this, ${c.id})" title="Call ${escHtml(formatPhone(c.phone))}">☎ ${escHtml(formatPhone(c.phone))}</button>`
            : '—'}</td>
        <td>${tag(c.lead_type, leadTypeClass(c.lead_type))}</td>
        <td>${tag(c.lead_status || 'New Lead', leadStatusClass(c.lead_status || 'New Lead'))}</td>
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
          <a class="mcc-view-btn" href="/contact.html?id=${c.id}" onclick="event.stopPropagation()">→</a>
        </div>
      </div>
      <div class="mcc-footer">
        ${tag(c.lead_type, leadTypeClass(c.lead_type))}
        ${tag(c.lead_status || 'New Lead', leadStatusClass(c.lead_status || 'New Lead'))}
        <span class="mcc-date">${formatDate(c.created_at)}</span>
      </div>
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

  const grouped = Object.fromEntries(PIPELINE_STATUSES.map(s => [s, []]));
  for (const c of contacts) {
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
  const actionEmail = gmailUrl
    ? `<a class="pc-action-btn pc-action-email" href="${escHtml(gmailUrl)}" data-action="email" target="_blank" rel="noopener" title="Send Email">Email</a>`
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
    // email / view: let the browser follow their href naturally
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
  // On mobile: native dialer is better UX (agent IS their phone)
  if (window.innerWidth <= 768 || !window.CRM_TWILIO_ENABLED) {
    window.location.href = `tel:${fallbackPhone}`;
    return;
  }
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="call-spinner"></span> Calling…';

  try {
    await CRM.fetch('/api/calls/outbound', {
      method: 'POST',
      body: JSON.stringify({ contact_id: contactId }),
    });
    btn.innerHTML = '✓ Your phone is ringing…';
    setTimeout(() => { btn.disabled = false; btn.innerHTML = origHtml; }, 6000);
    loadContacts(); // refresh cards so "Called Today" badge appears
  } catch (err) {
    showError(`Call failed: ${err.message}`);
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

// Used by the list-view phone button (inline onclick)
async function initiateCallById(btn, contactId) {
  if (window.innerWidth <= 768 || !window.CRM_TWILIO_ENABLED) {
    window.location.href = `tel:${btn.dataset.phone}`;
    return;
  }
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="call-spinner"></span>';

  try {
    await CRM.fetch('/api/calls/outbound', {
      method: 'POST',
      body: JSON.stringify({ contact_id: contactId }),
    });
    btn.innerHTML = '✓ Ringing…';
    setTimeout(() => { btn.disabled = false; btn.innerHTML = origHtml; }, 6000);
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
