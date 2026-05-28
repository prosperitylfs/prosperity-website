// Contact detail page

const id = new URLSearchParams(location.search).get('id');
const errorEl = document.getElementById('error-banner');

if (!id) {
  document.getElementById('contact-name').textContent = 'No contact ID';
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatPhone(raw) {
  if (!raw) return raw;
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1)
            : digits.length === 10 ? digits : null;
  if (!ten) return raw;
  return `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}`;
}

function formatDate(iso, includeTime = false) {
  if (!iso) return '—';
  const opts = { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' };
  if (includeTime) { opts.hour = 'numeric'; opts.minute = '2-digit'; opts.hour12 = true; }
  return new Date(iso).toLocaleString('en-US', opts);
}

function formatCurrency(val) {
  if (val == null || val === '') return null;
  const n = typeof val === 'number' ? val : parseFloat(val);
  if (isNaN(n)) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}

function parseCurrencyInput(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

function toDateInput(val) {
  if (!val) return '';
  return String(val).slice(0, 10);
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function tag(text, cls = '') {
  return text ? `<span class="tag ${cls}">${escHtml(text)}</span>` : '';
}

// ─── Section field definitions ────────────────────────────────────────────────
// Each entry maps a form element ID → DB column key → field type.

const SECTIONS = {
  retirement: [
    { id: 'f-retirement_account_type',       key: 'retirement_account_type',       type: 'select' },
    { id: 'f-current_institution',           key: 'current_institution',           type: 'text' },
    { id: 'f-estimated_rollover_amount',     key: 'estimated_rollover_amount',     type: 'currency' },
    { id: 'f-retirement_timeline',           key: 'retirement_timeline',           type: 'select' },
    { id: 'f-has_current_advisor',           key: 'has_current_advisor',           type: 'bool' },
    { id: 'f-interested_in_roth_conversion', key: 'interested_in_roth_conversion', type: 'bool' },
  ],
  life: [
    { id: 'f-insurance_company', key: 'insurance_company', type: 'text' },
    { id: 'f-policy_type',       key: 'policy_type',       type: 'select' },
    { id: 'f-face_amount',       key: 'face_amount',       type: 'currency' },
    { id: 'f-monthly_premium',   key: 'monthly_premium',   type: 'currency' },
    { id: 'f-annual_premium',    key: 'annual_premium',    type: 'currency' },
    { id: 'f-policy_status',     key: 'policy_status',     type: 'select' },
    { id: 'f-application_date',  key: 'application_date',  type: 'date' },
    { id: 'f-policy_issue_date', key: 'policy_issue_date', type: 'date' },
  ],
  annuity: [
    { id: 'f-annuity_carrier',  key: 'annuity_carrier',  type: 'text' },
    { id: 'f-annuity_type',     key: 'annuity_type',     type: 'select' },
    { id: 'f-annuity_premium',  key: 'annuity_premium',  type: 'currency' },
    { id: 'f-estimated_income', key: 'estimated_income', type: 'currency' },
    { id: 'f-surrender_period', key: 'surrender_period', type: 'text' },
    { id: 'f-income_rider',     key: 'income_rider',     type: 'bool' },
  ],
  followup: [
    { id: 'f-next_follow_up_date', key: 'next_follow_up_date', type: 'date' },
    { id: 'f-last_contact_date',   key: 'last_contact_date',   type: 'date' },
    { id: 'f-commission_estimate', key: 'commission_estimate', type: 'currency' },
  ],
};

// ─── Populate all section fields from a contact object ────────────────────────

function populateSections(contact) {
  for (const fields of Object.values(SECTIONS)) {
    for (const f of fields) {
      const el = document.getElementById(f.id);
      if (!el) continue;
      const val = contact[f.key];
      if (f.type === 'bool') {
        el.checked = !!val;
      } else if (f.type === 'date') {
        el.value = toDateInput(val);
      } else if (f.type === 'currency') {
        // Store raw number; placeholder shows "$0" so context is clear
        el.value = (val != null && val !== '') ? String(val) : '';
      } else {
        el.value = val || '';
      }
    }
  }
}

// ─── Save a section (called from onclick in HTML) ─────────────────────────────

async function saveCrmSection(event, key) {
  const btn = event.currentTarget;
  const savedEl = document.getElementById('saved-' + key);
  const origText = btn.textContent;

  btn.disabled = true;
  btn.textContent = 'Saving…';

  // Collect current field values
  const data = {};
  for (const f of SECTIONS[key]) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    if (f.type === 'bool') {
      data[f.key] = el.checked ? 1 : 0;
    } else if (f.type === 'currency') {
      data[f.key] = parseCurrencyInput(el.value); // null if blank
    } else {
      data[f.key] = el.value.trim() || null;
    }
  }

  try {
    const updated = await CRM.fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    // Re-populate from server response so displayed values are authoritative
    populateSections(updated);
    savedEl.classList.remove('hidden');
    setTimeout(() => savedEl.classList.add('hidden'), 2500);
  } catch (err) {
    showError(`Could not save: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

// ─── Click-to-call (detail page) ──────────────────────────────────────────────

function wireCallButton(contact) {
  const action = document.getElementById('call-action');
  const btn    = document.getElementById('detail-call-btn');
  if (!action || !btn || !contact.phone) return;

  const phone = contact.phone_e164 || (contact.phone ? '+1' + contact.phone.replace(/\D/g, '') : null);
  if (!phone) return;

  if (!window.CRM_TWILIO_ENABLED) return;

  action.classList.remove('hidden');
  btn.onclick = () => initiateDetailCall(btn);
}

// ─── Send email (detail page) ──────────────────────────────────────────────────

function wireEmailButton(contact) {
  if (!contact.email) return;

  // Header "Send Email" button
  const action = document.getElementById('email-action');
  const btn    = document.getElementById('detail-email-btn');
  if (action && btn) {
    action.classList.remove('hidden');
    btn.onclick = () => openEmailModal(parseInt(id), contact.email,
      'Prosperity Life & Financial Solutions Follow-Up');
  }

  // "Compose" button in Email History card
  const composeBtn = document.getElementById('compose-email-btn');
  if (composeBtn) {
    composeBtn.classList.remove('hidden');
    composeBtn.onclick = () => openEmailModal(parseInt(id), contact.email,
      'Prosperity Life & Financial Solutions Follow-Up');
  }

  // "Sync Replies" button in Email History card
  const syncBtn = document.getElementById('sync-email-btn');
  if (syncBtn) {
    syncBtn.classList.remove('hidden');
    syncBtn.onclick = () => syncEmailHistory(syncBtn);
  }
}

// ─── Gmail inbox sync ─────────────────────────────────────────────────────────

async function syncEmailHistory(btn) {
  const origHtml = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '↻ Syncing…'; }

  try {
    const result = await CRM.fetch('/api/email/sync', {
      method: 'POST',
      body: JSON.stringify({ contact_id: parseInt(id) }),
    });

    if (result.reauth_required) {
      showError('Gmail needs re-authorization for inbox sync. Go to Settings → Gmail and click Re-Authorize.');
      if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
      return;
    }

    const msg = result.imported > 0
      ? `✓ ${result.imported} new repl${result.imported === 1 ? 'y' : 'ies'}`
      : '✓ Up to date';
    if (btn) btn.innerHTML = msg;

    await loadEmailHistory();

    setTimeout(() => {
      if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
    }, 3000);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
    showError(`Sync failed: ${err.message}`);
  }
}

// ─── Email history ─────────────────────────────────────────────────────────────

async function loadEmailHistory() {
  try {
    const emails = await CRM.fetch(`/api/email/contact/${id}`);
    renderEmailHistory(emails);
  } catch {
    // Silently skip — email feature may not be active
  }
}

function renderEmailHistory(emails) {
  const el = document.getElementById('email-history-list');
  if (!el) return;
  if (!emails || !emails.length) {
    el.innerHTML = '<p class="text-muted">No emails yet.</p>';
    return;
  }
  el.innerHTML = emails.map(e => {
    const inbound = e.direction === 'inbound';
    const icon    = inbound ? '📩' : '✉';
    const tag     = inbound
      ? '<span class="tag tag-blue"  style="font-size:.68rem;padding:.1rem .45rem">Received</span>'
      : '<span class="tag tag-green" style="font-size:.68rem;padding:.1rem .45rem">Sent</span>';
    const addrLine = inbound
      ? (e.from_email ? `From: ${escHtml(e.from_email)} &nbsp;·&nbsp; ` : '')
      : (e.to_email   ? `To: ${escHtml(e.to_email)} &nbsp;·&nbsp; `     : '');
    return `
      <div class="email-log-item${inbound ? ' email-log-item-inbound' : ''}">
        <div class="email-log-subject">${icon} ${escHtml(e.subject || '(No subject)')}</div>
        <div class="email-log-meta">
          ${addrLine}${formatDate(e.sent_at, true)} &nbsp;·&nbsp; ${tag}
        </div>
        ${e.body ? `<div class="email-log-preview">${escHtml(e.body.slice(0, 160))}${e.body.length > 160 ? '…' : ''}</div>` : ''}
      </div>`;
  }).join('');
}

async function initiateDetailCall(btn) {
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="call-spinner"></span> Calling…';
  try {
    await CRM.fetch('/api/calls/outbound', {
      method: 'POST',
      body: JSON.stringify({ contact_id: id }),
    });
    btn.innerHTML = '✓ Your phone is ringing — answer to connect';
    setTimeout(() => { btn.disabled = false; btn.innerHTML = origHtml; }, 8000);
    await loadCallLogs();
  } catch (err) {
    showError(`Call failed: ${err.message}`);
    btn.disabled = false;
    btn.innerHTML = origHtml;
  }
}

// ─── Recent calls ─────────────────────────────────────────────────────────────

async function loadCallLogs() {
  try {
    const logs = await CRM.fetch(`/api/calls/contact/${id}`);
    renderCallLogs(logs);
  } catch {
    // Don't block the page if the calls endpoint isn't available yet
  }
}

function renderCallLogs(logs) {
  const el = document.getElementById('calls-list');
  if (!el) return;
  if (!logs.length) {
    el.innerHTML = '<p class="text-muted">No calls logged yet.</p>';
    return;
  }

  const today = new Date().toDateString();
  el.innerHTML = logs.map(c => {
    const isInbound = c.direction === 'inbound';
    const isToday   = c.started_at && new Date(c.started_at).toDateString() === today;
    const dirIcon   = isInbound ? '📲' : '☎';
    const dirLabel  = isInbound ? 'Inbound Call' : 'Outbound Call';
    const badge     = callStatusBadge(c.status);
    const todayPill = isToday ? '<span class="call-ind-today call-ind-pill">Today</span>' : '';

    // Outbound: agent left voicemail for lead
    const vmLeftPill = c.notes === 'voicemail_left'
      ? '<span class="call-ind-voicemail call-ind-pill">Voicemail Left</span>' : '';

    // Phone row differs by direction
    const phoneRow = isInbound
      ? (c.from_number ? `<div class="call-detail-row">From: ${escHtml(formatPhone(c.from_number))}</div>` : '')
      : (c.to_number   ? `<div class="call-detail-row">To: ${escHtml(formatPhone(c.to_number))}</div>`   : '');

    // Duration shown for answered calls and voicemail recordings
    const durRow = c.duration_sec
      ? `<div class="call-detail-row">Duration: ${escHtml(formatDuration(c.duration_sec))}</div>` : '';

    // Voicemail audio player — fetched through the CRM proxy, no Twilio auth popup
    const recRow = c.recording_url
      ? `<div class="voicemail-player" id="vm-${c.id}">
           <button class="call-recording-btn" onclick="loadVoicemail(${c.id})">
             🎙 Play Voicemail
           </button>
         </div>` : '';

    // Transcription (when enabled)
    const transcRow = c.transcription
      ? `<div class="call-detail-row call-transcription">📝 "${escHtml(c.transcription)}"</div>` : '';

    // "Mark Voicemail Left" — only for outbound calls where we called the lead
    const canMarkVm = !isInbound
      && ['no-answer', 'completed', 'in-progress'].includes(c.status)
      && c.notes !== 'voicemail_left';

    return `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <div class="timeline-body">
          <div class="timeline-meta">
            ${dirIcon} <strong>${escHtml(dirLabel)}</strong>
            ${badge} ${todayPill} ${vmLeftPill}
            <span class="timeline-meta-date">${formatDate(c.started_at, true)}</span>
          </div>
          ${phoneRow}${durRow}${recRow}${transcRow}
          ${canMarkVm ? `<button class="call-mark-btn" onclick="markVoicemail(${c.id})">Mark Voicemail Left</button>` : ''}
        </div>
      </div>`;
  }).join('');
}

function callStatusBadge(status) {
  const map = {
    'initiated':   ['badge-call-init',      'Initiated'],
    'ringing':     ['badge-call-ringing',   'Ringing'],
    'in-progress': ['badge-call-progress',  'In Progress'],
    'completed':   ['badge-call-done',      'Completed'],
    'answered':    ['badge-call-done',      'Answered'],
    'no-answer':   ['badge-call-noanswer',  'No Answer'],
    'busy':        ['badge-call-busy',      'Busy'],
    'failed':      ['badge-call-failed',    'Failed'],
    'canceled':    ['badge-call-failed',    'Canceled'],
    'missed':      ['badge-call-missed',    'Missed'],
    'voicemail':   ['badge-call-voicemail', 'Voicemail'],
    'unknown':     ['badge-call-init',      'Unknown'],
  };
  const [cls, label] = map[status] || ['badge-call-init', status || '—'];
  return `<span class="call-status-badge ${cls}">${escHtml(label)}</span>`;
}

function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

async function markVoicemail(callId) {
  try {
    await CRM.fetch(`/api/calls/${callId}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: 'voicemail_left' }),
    });
    await loadCallLogs();
  } catch (err) {
    showError(`Could not update call: ${err.message}`);
  }
}

// ─── Voicemail audio player ───────────────────────────────────────────────────

async function loadVoicemail(callId) {
  const player = document.getElementById(`vm-${callId}`);
  const btn    = player ? player.querySelector('.call-recording-btn') : null;
  if (!btn) return;

  const origText = btn.innerHTML;
  btn.disabled   = true;
  btn.innerHTML  = '<span class="call-spinner"></span> Loading…';

  try {
    const resp = await fetch(`/api/calls/${callId}/recording`, {
      headers: { 'x-api-key': CRM.apiKey },
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(body.error || `HTTP ${resp.status}`);
    }

    const blob = await resp.blob();
    const url  = URL.createObjectURL(blob);

    player.innerHTML = `
      <audio class="voicemail-audio" controls autoplay>
        <source src="${url}" type="audio/mpeg">
      </audio>`;
  } catch (err) {
    btn.disabled  = false;
    btn.innerHTML = origText;
    showError(`Could not load voicemail: ${err.message}`);
  }
}

// ─── Contact info (read-only header card) ─────────────────────────────────────

function renderInfo(contact) {
  document.getElementById('contact-name').textContent =
    [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '(No name)';

  document.getElementById('contact-meta').innerHTML = [
    contact.lead_type ? tag(contact.lead_type, 'tag-purple') : '',
    contact.role && contact.role !== 'lead' ? tag(contact.role, 'tag-gray') : '',
    `<span class="meta-date">Added ${formatDate(contact.created_at)}</span>`,
  ].filter(Boolean).join(' ');

  const statusEl = document.getElementById('lead-status-select');
  if (statusEl) statusEl.value = contact.lead_status || 'New Lead';

  const emailGmailUrl = contact.email
    ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(contact.email)}&su=Prosperity%20Life%20%26%20Financial%20Solutions%20Follow-Up`
    : null;

  const fields = [
    ['Email',          contact.email,       emailGmailUrl],
    ['Phone',          contact.phone     ? formatPhone(contact.phone)     : null, null],
    ['Alt Phone',      contact.alt_phone ? formatPhone(contact.alt_phone) : null, null],
    ['Lead Source',    contact.lead_source, null],
    ['SMS Consent',    contact.sms_consent        ? 'Yes' : null, null],
    ['Appt Booked',    contact.appointment_booked ? 'Yes' : null, null],
    ['Appt Date',      contact.appointment_date,  null],
    ['Last Contacted', contact.last_contacted,    null],
  ].filter(([, v]) => v);

  document.getElementById('contact-info').innerHTML = fields.length
    ? fields.map(([label, value, href]) => `
        <div class="info-row">
          <span class="info-label">${escHtml(label)}</span>
          <span class="info-value">${href
            ? `<a class="email-link" href="${escHtml(href)}" target="_blank" rel="noopener" title="Send Email">${escHtml(value)}</a>`
            : escHtml(value)
          }</span>
        </div>`).join('')
    : '<p class="text-muted">No details on file.</p>';
}

// ─── Notes ────────────────────────────────────────────────────────────────────

function renderNotes(notes) {
  const el = document.getElementById('notes-list');
  const rows = Array.isArray(notes) ? notes.filter(n => n && typeof n === 'object') : [];
  if (!rows.length) {
    el.innerHTML = '<p class="text-muted">No notes yet.</p>';
    return;
  }
  el.innerHTML = rows.map(n => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-body">
        <div class="timeline-meta">${formatDate(n.created_at, true)}</div>
        <div class="timeline-text">${escHtml(typeof n.body === 'string' ? n.body : JSON.stringify(n.body))}</div>
      </div>
    </div>`).join('');
}

// ─── Appointments ─────────────────────────────────────────────────────────────

const APPT_STATUSES = ['Scheduled', 'Completed', 'No-Show', 'Cancelled', 'Rescheduled'];

function apptStatusTag(s) {
  const cls = {
    'Scheduled':   'tag-purple',
    'Completed':   'tag-green',
    'No-Show':     'tag-amber',
    'Cancelled':   'tag-gray',
    'Rescheduled': 'tag-blue',
  };
  return `<span class="tag tag-xs ${cls[s] || 'tag-gray'}">${escHtml(s)}</span>`;
}

function fmtApptDt(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

async function loadAppointments() {
  try {
    const appts = await CRM.fetch(`/api/appointments/contact/${id}`);
    renderAppointments(appts);
  } catch (e) {
    console.error('loadAppointments failed:', e);
  }
}

function renderAppointments(appts) {
  const el = document.getElementById('appts-list');
  if (!el) return;
  if (!appts.length) {
    el.innerHTML = '<p class="text-muted">No appointments yet.</p>';
    return;
  }
  el.innerHTML = appts.map(a => {
    const statusOpts = APPT_STATUSES.map(s =>
      `<option value="${s}"${s === a.status ? ' selected' : ''}>${s}</option>`
    ).join('');
    return `
      <div class="appt-item">
        <div class="appt-item-header">
          <span class="appt-item-type">${escHtml(a.appt_type)}</span>
          ${apptStatusTag(a.status)}
        </div>
        <div class="appt-item-dt">📅 ${escHtml(fmtApptDt(a.appt_datetime))} CT</div>
        ${a.location ? `<div class="appt-item-loc">📍 ${escHtml(a.location)}</div>` : ''}
        ${a.notes    ? `<div class="appt-item-notes">${escHtml(a.notes)}</div>` : ''}
        <div class="appt-item-footer">
          <select class="crm-select appt-status-sel" onchange="updateApptStatus(${a.id}, this.value)">${statusOpts}</select>
          <button class="btn-section-cancel" onclick="deleteAppt(${a.id})">Delete</button>
        </div>
      </div>`;
  }).join('');
}

async function saveAppointment() {
  const typeEl  = document.getElementById('appt-type');
  const dtEl    = document.getElementById('appt-datetime');
  const locEl   = document.getElementById('appt-location');
  const notesEl = document.getElementById('appt-notes');

  const appt_type     = typeEl?.value;
  const appt_datetime = dtEl?.value ? new Date(dtEl.value).toISOString() : null;
  const location      = locEl?.value.trim()  || null;
  const notes         = notesEl?.value.trim() || null;

  if (!appt_type)     { alert('Please select an appointment type.'); return; }
  if (!appt_datetime) { alert('Please select a date and time.');     return; }

  const btn = document.getElementById('appt-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await CRM.fetch('/api/appointments', {
      method: 'POST',
      body: JSON.stringify({ contact_id: parseInt(id), appt_type, appt_datetime, location, notes }),
    });
    if (typeEl)  typeEl.value  = '';
    if (dtEl)    dtEl.value    = '';
    if (locEl)   locEl.value   = '';
    if (notesEl) notesEl.value = '';
    toggleApptForm(false);
    await loadAppointments();
  } catch (e) {
    alert(`Could not save appointment: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Appointment'; }
  }
}

async function updateApptStatus(apptId, newStatus) {
  try {
    await CRM.fetch(`/api/appointments/${apptId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    });
    await loadAppointments();
  } catch (e) {
    showError(`Could not update appointment: ${e.message}`);
  }
}

async function deleteAppt(apptId) {
  if (!confirm('Delete this appointment?')) return;
  try {
    await CRM.fetch(`/api/appointments/${apptId}`, { method: 'DELETE' });
    await loadAppointments();
  } catch (e) {
    showError(`Could not delete appointment: ${e.message}`);
  }
}

function toggleApptForm(show) {
  const form = document.getElementById('appt-form');
  const btn  = document.getElementById('add-appt-btn');
  if (!form) return;
  if (show === undefined) show = form.classList.contains('hidden');
  if (show) {
    form.classList.remove('hidden');
    if (btn) btn.textContent = '✕ Cancel';
  } else {
    form.classList.add('hidden');
    if (btn) btn.textContent = '+ Add';
  }
}

// ─── Communications ───────────────────────────────────────────────────────────

function renderComms(comms) {
  const el = document.getElementById('comms-list');

  // Backend already excludes comm_type='email' from this array.
  // This client-side guard is a secondary safety net for any cached API responses.
  const filtered = comms.filter(c =>
    (c.comm_type || '').toLowerCase().trim() !== 'email' &&
    !(c.email_to || c.email_from)
  );

  if (!filtered.length) {
    el.innerHTML = '<p class="text-muted">No activity yet.</p>';
    return;
  }
  el.innerHTML = filtered.map(c => {
    let bodyHtml = '';
    if (c.comm_type === 'form' && c.body) {
      try {
        const data = JSON.parse(c.body);
        const skip = new Set(['honeypot']);
        const rows = Object.entries(data)
          .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && String(v).trim() !== '')
          .map(([k, v]) => {
            let dv = (k === 'phone' || k === 'alt_phone') ? formatPhone(v) || v : v;
            if (typeof dv === 'object' && dv !== null) dv = JSON.stringify(dv);
            return `<div class="form-row">
              <span class="form-key">${escHtml(k.replace(/_/g, ' '))}</span>
              <span class="form-val">${escHtml(String(dv ?? ''))}</span>
            </div>`;
          }).join('');
        bodyHtml = rows ? `<div class="form-data">${rows}</div>` : '';
      } catch {
        bodyHtml = `<pre class="comm-body">${escHtml(c.body)}</pre>`;
      }
    } else if (c.body) {
      bodyHtml = `<div class="comm-body-text">${escHtml(c.body)}</div>`;
    }

    const icon = { form: '📋', email: '✉️', sms: '💬', call: '📞', appointment: '📅' }[c.comm_type] || '📌';
    const dir  = c.direction === 'inbound'  ? '<span class="badge badge-in">Inbound</span>'
               : c.direction === 'outbound' ? '<span class="badge badge-out">Outbound</span>'
               : '';

    return `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <div class="timeline-body">
          <div class="timeline-meta">
            ${icon} <strong>${escHtml(c.subject || c.comm_type)}</strong> ${dir}
            <span class="timeline-meta-date">${formatDate(c.created_at, true)}</span>
          </div>
          ${bodyHtml}
        </div>
      </div>`;
  }).join('');
}

// ─── Load contact ─────────────────────────────────────────────────────────────

// Dedicated activity loader — calls /activity endpoint which whitelists comm_types
// and never returns email records regardless of what the browser has cached.
async function loadActivity() {
  try {
    const activity = await CRM.fetch(`/api/contacts/${id}/activity`);
    renderComms(activity);
  } catch (err) {
    console.error('[Activity] failed to load:', err.message);
  }
}

async function loadContact() {
  if (!id) return;
  try {
    const contact = await CRM.fetch(`/api/contacts/${id}`);
    renderInfo(contact);
    wireCallButton(contact);
    wireEmailButton(contact);
    populateSections(contact);
    renderNotes(contact.notes || []);
    await Promise.all([loadCallLogs(), loadEmailHistory(), loadAppointments(), loadActivity()]);
  } catch (err) {
    showError(`Could not load contact: ${err.message}`);
  }
}

// ─── Lead status auto-save ────────────────────────────────────────────────────

document.getElementById('lead-status-select').addEventListener('change', async function () {
  const msgEl = document.getElementById('status-save-msg');
  try {
    await CRM.fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ lead_status: this.value }),
    });
    msgEl.classList.remove('hidden');
    setTimeout(() => msgEl.classList.add('hidden'), 2000);
  } catch (err) {
    showError(`Could not update status: ${err.message}`);
  }
});

// ─── Add note ─────────────────────────────────────────────────────────────────

document.getElementById('add-note-btn').addEventListener('click', async () => {
  const body = document.getElementById('new-note-body').value.trim();
  if (!body) return;
  try {
    await CRM.fetch(`/api/contacts/${id}/notes`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    document.getElementById('new-note-body').value = '';
    await loadContact();
  } catch (err) {
    showError(`Could not save note: ${err.message}`);
  }
});

// ─── Toast notification ───────────────────────────────────────────────────────

function showToast(msg, duration = 2500) {
  let el = document.getElementById('crm-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'crm-toast';
    el.className = 'crm-toast crm-toast-hidden';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove('crm-toast-hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('crm-toast-hidden'), duration);
}

// ─── Refresh handler ──────────────────────────────────────────────────────────

async function refreshContact() {
  console.log('Refresh clicked');

  const mBtn = document.getElementById('mobile-refresh-btn');
  const dBtn = document.getElementById('desktop-refresh-btn');

  const mOrig = mBtn ? mBtn.innerHTML   : '';
  const dOrig = dBtn ? dBtn.textContent : '';
  if (mBtn) { mBtn.disabled = true; mBtn.innerHTML   = '↻'; }
  if (dBtn) { dBtn.disabled = true; dBtn.textContent = '↻ Refreshing…'; }

  console.log('Reloading contact data...');

  try {
    if (!id) return;
    const contact = await CRM.fetch(`/api/contacts/${id}`);
    renderInfo(contact);
    wireCallButton(contact);
    wireEmailButton(contact);
    populateSections(contact);
    renderNotes(contact.notes || []);
    await Promise.all([loadCallLogs(), loadEmailHistory(), loadAppointments(), loadActivity()]);
    showToast('CRM refreshed ✓');
  } catch (err) {
    console.error('Refresh failed:', err);
    showError(`Refresh failed: ${err.message}`);
  } finally {
    if (mBtn) { mBtn.disabled = false; mBtn.innerHTML   = mOrig; }
    if (dBtn) { dBtn.disabled = false; dBtn.textContent = dOrig; }
  }
}

// Wire refresh buttons via addEventListener — works in all browsers and installed PWA.
// Inline onclick attributes are unreliable when scripts load asynchronously or in
// strict PWA shells; programmatic wiring runs immediately after the DOM is ready.
(function wireRefreshButtons() {
  const mBtn = document.getElementById('mobile-refresh-btn');
  const dBtn = document.getElementById('desktop-refresh-btn');
  if (mBtn) mBtn.addEventListener('click', refreshContact);
  if (dBtn) dBtn.addEventListener('click', refreshContact);
})();

loadContact();
