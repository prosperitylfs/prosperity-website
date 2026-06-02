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
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const tz       = 'America/Chicago';
  const todayStr = new Date().toLocaleDateString('en-US', { timeZone: tz });
  const isToday  = d.toLocaleDateString('en-US', { timeZone: tz }) === todayStr;
  if (!includeTime) {
    return isToday
      ? 'Today'
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz });
  }
  const timeStr = d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  return isToday
    ? `Today, ${timeStr}`
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
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

// ─── SMS compose area ─────────────────────────────────────────────────────────

function wireSmsCompose(contact) {
  const area = document.getElementById('sms-compose-area');
  if (!area) return;
  // Show only when Twilio is enabled and the contact has a phone number
  if (window.CRM_TWILIO_ENABLED && (contact.phone || contact.phone_e164)) {
    area.classList.remove('hidden');
  } else {
    area.classList.add('hidden');
  }
}

async function sendManualSms() {
  const textarea = document.getElementById('sms-compose-body');
  const btn      = document.getElementById('sms-send-btn');
  const errEl    = document.getElementById('sms-send-error');
  const counter  = document.getElementById('sms-char-count');
  const message  = textarea?.value.trim();

  if (!message) { textarea?.focus(); return; }
  if (errEl) errEl.classList.add('hidden');
  if (btn)   { btn.disabled = true; btn.textContent = 'Sending…'; }

  try {
    await CRM.fetch('/api/sms/send', {
      method: 'POST',
      body: JSON.stringify({ contact_id: parseInt(id), message }),
    });
    if (textarea) textarea.value = '';
    if (counter)  counter.textContent = '0 / 160';
  } catch (err) {
    if (errEl) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Send SMS'; }
    await loadSmsHistory();
  }
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

// ─── SMS history ──────────────────────────────────────────────────────────────

async function loadSmsHistory() {
  try {
    const messages = await CRM.fetch(`/api/sms/contact/${id}`);
    renderSmsHistory(messages);
  } catch {
    // SMS feature may not be active yet
  }
}

function renderSmsHistory(messages) {
  const el = document.getElementById('sms-history-list');
  if (!el) return;
  if (!messages || !messages.length) {
    el.innerHTML = '<p class="text-muted">No SMS messages yet.</p>';
    return;
  }
  el.innerHTML = messages.map(m => {
    const inbound  = m.direction === 'inbound';
    const icon     = inbound ? '📨' : '💬';
    const dirTag   = inbound
      ? '<span class="tag tag-blue"  style="font-size:.68rem;padding:.1rem .45rem">Received</span>'
      : '<span class="tag tag-green" style="font-size:.68rem;padding:.1rem .45rem">Sent</span>';
    const statusBadge = m.status === 'failed'
      ? '<span class="tag tag-red"   style="font-size:.68rem;padding:.1rem .45rem">Failed</span>'
      : m.status === 'queued'
        ? '<span class="tag tag-amber" style="font-size:.68rem;padding:.1rem .45rem">Queued</span>'
        : (m.status && !['sent','received'].includes(m.status))
          ? `<span class="tag tag-gray" style="font-size:.68rem;padding:.1rem .45rem">${escHtml(m.status)}</span>`
          : '';
    const addrLine = inbound
      ? (m.from_number ? `From: ${escHtml(m.from_number)} &nbsp;·&nbsp; ` : '')
      : (m.to_number   ? `To: ${escHtml(m.to_number)}   &nbsp;·&nbsp; ` : '');
    return `
      <div class="sms-log-item${inbound ? ' sms-log-item-inbound' : ''}">
        <div class="sms-log-meta">
          ${icon} ${addrLine}${formatDate(m.sent_at, true)} &nbsp;·&nbsp; ${dirTag} ${statusBadge}
        </div>
        ${m.body ? `<div class="sms-log-body">${escHtml(m.body)}</div>` : ''}
      </div>`;
  }).join('');
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

  el.innerHTML = logs.map(c => {
    const isInbound  = c.direction === 'inbound';
    const hasVmStatus = c.status === 'voicemail';
    const isVm       = hasVmStatus && !!c.recording_url;
    const isMissed   = isInbound && ['missed','no-answer','busy','canceled'].includes(c.status);

    // Voicemail status without a recording → treat as missed for badge purposes
    const effectiveStatus = (hasVmStatus && !c.recording_url) ? 'missed' : c.status;

    // Left-border colour encodes call type at a glance
    const entryDir = isMissed ? 'missed'
      : hasVmStatus           ? 'voicemail'
      : isInbound             ? 'inbound'
      :                         'outbound';

    const dirArrowCls = isInbound ? (isMissed ? 'dir-missed' : 'dir-in') : 'dir-out';
    const dirLabel    = isInbound ? 'Inbound' : 'Outbound';

    const badge  = callStatusBadge(effectiveStatus);
    const vmIcon = isVm ? '<span class="vm-icon" title="Has recording">🎙</span>' : '';

    // VM-left section: timestamped row shown below call details when agent has marked it
    const vmLeftSection = c.notes === 'voicemail_left'
      ? `<div class="vm-left-section">
           <span class="vm-icon">🎙</span>
           <span class="vm-left-label">Voicemail Left By Agent</span>
           <span class="vm-left-ts">·&nbsp;${
             c.voicemail_left_at
               ? formatDate(c.voicemail_left_at, true)
               : 'Time not recorded'
           }</span>
           <button class="vm-left-undo-btn" onclick="unmarkVoicemail(${c.id})">Undo</button>
         </div>` : '';

    const phoneRow = isInbound
      ? (c.from_number ? `<div class="call-detail-row">From: ${escHtml(formatPhone(c.from_number))}</div>` : '')
      : (c.to_number   ? `<div class="call-detail-row">To: ${escHtml(formatPhone(c.to_number))}</div>` : '');

    const durRow = c.duration_sec
      ? `<div class="call-detail-row">Duration: <span class="call-duration-pill">${escHtml(formatDuration(c.duration_sec))}</span></div>` : '';

    // Play button only when a real recording exists
    const recRow = isVm
      ? `<div class="voicemail-player" id="vm-${c.id}">
           <button class="call-recording-btn" onclick="loadVoicemail(${c.id})">🎙 Play Voicemail</button>
         </div>`
      : (hasVmStatus ? `<div class="vm-no-recording">No recording available</div>` : '');

    const transcRow = c.transcription
      ? `<div class="call-detail-row call-transcription">📝 "${escHtml(c.transcription)}"</div>` : '';

    // "Mark Voicemail Left" button — outbound calls only
    const canMarkVm = !isInbound
      && ['no-answer', 'completed', 'in-progress'].includes(c.status)
      && c.notes !== 'voicemail_left';

    return `
      <div class="call-entry" data-dir="${entryDir}">
        <div class="call-entry-header">
          <div class="call-entry-left">
            <span class="call-dir-arrow ${dirArrowCls}">${isInbound ? '↙' : '↗'}</span>
            <span class="call-entry-dir-label">${dirLabel}</span>
            ${badge}${vmIcon}
          </div>
          <span class="call-entry-ts">${formatDate(c.started_at, true)}</span>
        </div>
        ${phoneRow}${durRow}${recRow}${transcRow}${vmLeftSection}
        ${canMarkVm ? `<div class="call-entry-actions"><button class="call-mark-btn" onclick="markVoicemail(${c.id})">Mark Voicemail Left</button></div>` : ''}
      </div>`;
  }).join('');
}

function callStatusBadge(status) {
  const map = {
    'initiated':      ['badge-call-init',      'Initiated'],
    'ringing':        ['badge-call-ringing',   'Ringing'],
    'in-progress':    ['badge-call-progress',  'In Progress'],
    'completed':      ['badge-call-done',      'Completed'],
    'answered':       ['badge-call-done',      'Answered'],
    'no-answer':      ['badge-call-noanswer',  'No Answer'],
    'busy':           ['badge-call-busy',      'Busy'],
    'failed':         ['badge-call-failed',    'Failed'],
    'canceled':       ['badge-call-failed',    'Canceled'],
    'missed':         ['badge-call-missed',    'Missed Call'],
    'voicemail':      ['badge-call-voicemail', 'Voicemail Received'],
    'voicemail_left': ['badge-call-voicemail', 'Voicemail Left'],
    'unknown':        ['badge-call-init',      'Unknown'],
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
    showToast('Voicemail marked successfully');
    await loadCallLogs();
  } catch (err) {
    showError(`Could not update call: ${err.message}`);
  }
}

async function unmarkVoicemail(callId) {
  try {
    await CRM.fetch(`/api/calls/${callId}`, {
      method: 'PATCH',
      body: JSON.stringify({ notes: null }),
    });
    showToast('Voicemail mark removed');
    await loadCallLogs();
  } catch (err) {
    showError(`Could not remove voicemail mark: ${err.message}`);
  }
}

// ─── Voicemail audio player ───────────────────────────────────────────────────

async function loadVoicemail(callId) {
  const player = document.getElementById(`vm-${callId}`);
  const btn    = player ? player.querySelector('.call-recording-btn') : null;
  if (!btn) return;

  const origText = btn.innerHTML;
  btn.disabled   = true;
  btn.innerHTML  = '<span class="call-spinner"></span> Loading voicemail…';

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
    player.innerHTML = `
      <div class="vm-error">
        Unable to load voicemail
        <button class="vm-retry-btn" onclick="loadVoicemail(${callId})">Retry</button>
      </div>`;
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
  return `<span class="tag tag-xs appt-status-tag ${cls[s] || 'tag-gray'}">${escHtml(s)}</span>`;
}

function fmtApptDt(iso) {
  return formatDate(iso, true);
}

async function loadAppointments() {
  try {
    const appts = await CRM.fetch(`/api/appointments/contact/${id}`);
    renderAppointments(appts);
  } catch (e) {
    console.error('loadAppointments failed:', e);
  }
}

function renderApptItem(a, isPast) {
  const needsOutcome = isPast && (a.status === 'Scheduled' || a.status === 'Rescheduled');
  const statusOpts = APPT_STATUSES.map(s =>
    `<option value="${s}"${s === a.status ? ' selected' : ''}>${s}</option>`
  ).join('');
  let cls = 'appt-item';
  if (isPast) cls += ' appt-past';
  if (needsOutcome) cls += ' appt-needs-outcome';
  return `
    <div class="${cls}" data-appt-id="${a.id}">
      <div class="appt-item-header">
        <span class="appt-item-type">${escHtml(a.appt_type)}</span>
        ${apptStatusTag(a.status)}
        ${needsOutcome ? '<span class="tag tag-xs tag-amber">Needs Outcome</span>' : ''}
      </div>
      <div class="appt-item-dt">📅 ${escHtml(fmtApptDt(a.appt_datetime))} CT</div>
      ${a.location ? `<div class="appt-item-loc">📍 ${escHtml(a.location)}</div>` : ''}
      ${a.notes    ? `<div class="appt-item-notes">${escHtml(a.notes)}</div>` : ''}
      ${needsOutcome ? '<div class="appt-outcome-prompt">What was the outcome? Update the status below.</div>' : ''}
      <div class="appt-item-footer">
        <div class="appt-status-control">
          <select class="crm-select appt-status-sel"
                  data-prev="${escHtml(a.status)}"
                  onchange="updateApptStatus(${a.id}, this.value, this)">${statusOpts}</select>
          <span class="appt-autosave-hint">Changes are saved automatically</span>
        </div>
        <button class="btn-section-cancel" onclick="deleteAppt(${a.id})">Delete</button>
      </div>
    </div>`;
}

function renderAppointments(appts) {
  const el = document.getElementById('appts-list');
  if (!el) return;
  if (!appts.length) {
    el.innerHTML = '<p class="text-muted">No appointments yet.</p>';
    return;
  }
  const nowIso   = new Date().toISOString();
  const upcoming = appts.filter(a => a.appt_datetime >= nowIso)
                        .sort((a, b) => a.appt_datetime.localeCompare(b.appt_datetime));
  const past     = appts.filter(a => a.appt_datetime < nowIso)
                        .sort((a, b) => b.appt_datetime.localeCompare(a.appt_datetime));
  let html = '';
  if (upcoming.length) html += upcoming.map(a => renderApptItem(a, false)).join('');
  if (past.length) {
    html += `<div class="appt-section-header">Past Appointments</div>`;
    html += past.map(a => renderApptItem(a, true)).join('');
  }
  el.innerHTML = html || '<p class="text-muted">No appointments yet.</p>';

  // Auto-update lead status to "Needs Outcome" when a past appointment has no outcome recorded
  const hasUnresolved = past.some(a => a.status === 'Scheduled' || a.status === 'Rescheduled');
  const currentStatus = window._currentContact?.lead_status;
  if (hasUnresolved && (currentStatus === 'Appointment Scheduled' || currentStatus === 'Appointment Rescheduled')) {
    autoSetNeedsOutcome();
  }
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

async function updateApptStatus(apptId, newStatus, selectEl) {
  // Disable dropdown and flip hint to "Saving…" for immediate feedback
  if (selectEl) selectEl.disabled = true;
  const card = document.querySelector(`.appt-item[data-appt-id="${apptId}"]`);
  const hint = card?.querySelector('.appt-autosave-hint');
  if (hint) hint.textContent = 'Saving…';

  // Optimistic badge swap so the status tag updates before the round-trip
  if (card) {
    const oldBadge = card.querySelector('.appt-status-tag');
    if (oldBadge) oldBadge.outerHTML = apptStatusTag(newStatus);
    const isResolved = ['Completed', 'No-Show', 'Cancelled'].includes(newStatus);
    if (isResolved) {
      card.classList.remove('appt-needs-outcome');
      const needsBadge = card.querySelector('.tag-amber');
      if (needsBadge) needsBadge.remove();
      const prompt = card.querySelector('.appt-outcome-prompt');
      if (prompt) prompt.remove();
    }
  }

  try {
    await CRM.fetch(`/api/appointments/${apptId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    });
    showToast('Appointment updated successfully');
    // loadAppointments re-renders the list: re-enables the select and restores hint text
    await loadAppointments();
    // Refresh lead_status dropdown (server may have updated it)
    const refreshed = await CRM.fetch(`/api/contacts/${id}`);
    if (refreshed.lead_status) {
      const statusEl = document.getElementById('lead-status-select');
      if (statusEl) statusEl.value = refreshed.lead_status;
      if (window._currentContact) window._currentContact.lead_status = refreshed.lead_status;
    }
  } catch (e) {
    showToast('Unable to update appointment', 3500, 'error');
    await loadAppointments(); // re-render reverts optimistic updates and re-enables the select
  }
}

async function autoSetNeedsOutcome() {
  try {
    await CRM.fetch(`/api/contacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ lead_status: 'Needs Outcome' }),
    });
    if (window._currentContact) window._currentContact.lead_status = 'Needs Outcome';
    const statusEl = document.getElementById('lead-status-select');
    if (statusEl) statusEl.value = 'Needs Outcome';
  } catch (e) {
    console.error('[autoSetNeedsOutcome] failed:', e);
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

// ─── Follow-Up Tasks ──────────────────────────────────────────────────────────

async function loadTasks() {
  try {
    const tasks = await CRM.fetch(`/api/tasks/contact/${id}`);
    renderTasks(tasks);
  } catch (e) {
    console.error('loadTasks failed:', e);
  }
}

function taskTypeIcon(type) {
  const icons = {
    'Call':          '📞',
    'Email':         '✉',
    'Text':          '💬',
    'Send Document': '📄',
    'Follow-Up':     '🔄',
    'Other':         '📌',
  };
  return icons[type] || '📌';
}

function taskPriorityBadge(priority) {
  const map = {
    'High':   ['task-priority-high',   'High'],
    'Medium': ['task-priority-medium', 'Medium'],
    'Low':    ['task-priority-low',    'Low'],
  };
  const [cls, label] = map[priority] || ['task-priority-medium', priority || 'Medium'];
  return `<span class="task-priority-badge ${cls}">${escHtml(label)}</span>`;
}

function fmt12h(t24) {
  if (!t24) return '';
  const [h, m] = t24.split(':').map(Number);
  const p = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12} ${p}` : `${h12}:${String(m).padStart(2, '0')} ${p}`;
}

function formatTaskDue(dueDate, dueTime) {
  if (!dueDate) return '';
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const nd = new Date(); nd.setDate(nd.getDate() + 1);
  const tomorrow = nd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const timeStr = dueTime ? ` at ${fmt12h(dueTime)}` : '';
  if (dueDate < today) {
    const diff = Math.round((new Date(today) - new Date(dueDate)) / 86400000);
    return `⚠ ${diff === 1 ? '1 day overdue' : `${diff} days overdue`}`;
  }
  if (dueDate === today)    return `Due Today${timeStr}`;
  if (dueDate === tomorrow) return `Due Tomorrow${timeStr}`;
  const diff = Math.round((new Date(dueDate) - new Date(today)) / 86400000);
  const [y, m, d] = dueDate.split('-').map(Number);
  const short = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return diff <= 7 ? `Due in ${diff} days — ${short}${timeStr}` : `${short}, ${y}${timeStr}`;
}

function renderTasks(tasks) {
  const pendingEl   = document.getElementById('tasks-pending');
  const completedEl = document.getElementById('tasks-completed');
  const toggleEl    = document.getElementById('tasks-completed-toggle');
  if (!pendingEl) return;

  const pending   = tasks.filter(t => t.status === 'Pending');
  const completed = tasks.filter(t => t.status !== 'Pending');

  if (!pending.length && !completed.length) {
    pendingEl.innerHTML = '<p class="text-muted">No tasks yet.</p>';
    if (toggleEl)    toggleEl.classList.add('hidden');
    return;
  }

  pendingEl.innerHTML = pending.length
    ? pending.map(t => renderTaskCard(t)).join('')
    : '<p class="text-muted" style="margin:.5rem 0">No pending tasks.</p>';

  if (completed.length) {
    if (toggleEl) toggleEl.classList.remove('hidden');
    const labelEl = document.getElementById('tasks-completed-toggle-label');
    if (labelEl) labelEl.textContent = `Completed Follow-Ups (${completed.length})`;
    if (completedEl) completedEl.innerHTML = completed.map(t => renderTaskCard(t)).join('');
  } else {
    if (toggleEl) toggleEl.classList.add('hidden');
    if (completedEl) { completedEl.innerHTML = ''; completedEl.classList.add('hidden'); }
  }
}

function renderTaskCard(t) {
  const isDone      = t.status === 'Completed';
  const isCancelled = t.status === 'Cancelled';
  const today    = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const nd = new Date(); nd.setDate(nd.getDate() + 1);
  const tomorrow = nd.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const isOverdue   = !isDone && !isCancelled && t.due_date < today;
  const isDueToday  = !isDone && !isCancelled && t.due_date === today;
  const isDueTomorrow = !isDone && !isCancelled && t.due_date === tomorrow;

  let cardCls = 'task-card';
  if (isDone)             cardCls += ' task-card-done';
  else if (isCancelled)   cardCls += ' task-card-cancelled';
  else if (isOverdue)     cardCls += ' task-card-overdue';
  else if (isDueToday)    cardCls += ' task-card-today';
  else if (isDueTomorrow) cardCls += ' task-card-tomorrow';

  const dueStr = formatTaskDue(t.due_date, t.due_time);
  const dueLabelCls = isOverdue ? 'task-due-label task-due-overdue'
    : isDueToday    ? 'task-due-label task-due-today'
    : isDueTomorrow ? 'task-due-label task-due-tomorrow'
    : 'task-due-label';

  const completedLine = isDone
    ? `<div class="task-completed-ts">✓ Completed ${t.completed_at ? formatDate(t.completed_at, true) : ''}</div>` : '';
  const cancelledLine = isCancelled ? `<div class="task-completed-ts task-cancelled-ts">Cancelled</div>` : '';

  const quickActions = (!isDone && !isCancelled) ? taskQuickActionButtons(t) : '';

  const actions = isDone || isCancelled
    ? `<button class="task-action-btn task-action-delete" onclick="deleteTask(${t.id})">Delete</button>`
    : `<button class="task-action-btn task-action-complete" onclick="completeTask(${t.id})">Mark Done</button>
       <button class="task-action-btn task-action-cancel"  onclick="cancelTask(${t.id})">Cancel</button>
       <button class="task-action-btn task-action-delete"  onclick="deleteTask(${t.id})">Delete</button>`;

  return `
    <div class="${cardCls}" data-id="${t.id}">
      <div class="task-card-header">
        <div class="task-card-left">
          <span class="task-type-icon">${taskTypeIcon(t.task_type)}</span>
          <span class="task-type-label">${escHtml(t.task_type)}</span>
          ${taskPriorityBadge(t.priority)}
        </div>
        ${dueStr ? `<span class="${dueLabelCls}">📅 ${escHtml(dueStr)}</span>` : ''}
      </div>
      ${t.notes ? `<div class="task-notes">${escHtml(t.notes)}</div>` : ''}
      ${completedLine}${cancelledLine}
      ${quickActions}
      <div class="task-card-actions">${actions}</div>
    </div>`;
}

function taskQuickActionButtons(t) {
  const c = window._currentContact;
  if (!c) return '';
  const hasTwilio = !!window.CRM_TWILIO_ENABLED;
  const hasPhone  = !!(c.phone || c.phone_e164);
  const callBtn   = hasTwilio && hasPhone
    ? `<button class="task-qa-btn task-qa-call"  onclick="taskQuickCall(${t.id},event)">☎ Call</button>` : '';
  const smsBtn    = hasTwilio && !!c.sms_consent && hasPhone
    ? `<button class="task-qa-btn task-qa-sms"   onclick="taskQuickSms(${t.id},event)">💬 SMS</button>` : '';
  const emailBtn  = c.email
    ? `<button class="task-qa-btn task-qa-email" onclick="taskQuickEmail(${t.id},event)">✉ Email</button>` : '';
  const order = { 'Call': [callBtn, emailBtn, smsBtn], 'Email': [emailBtn, callBtn, smsBtn], 'Text': [smsBtn, callBtn, emailBtn] };
  const btns = (order[t.task_type] || [callBtn, emailBtn, smsBtn]).filter(Boolean).join('');
  return btns ? `<div class="task-qa-buttons">${btns}</div>` : '';
}

async function taskQuickCall(taskId, event) {
  if (event) event.stopPropagation();
  const btn = document.querySelector(`.task-card[data-id="${taskId}"] .task-qa-call`);
  const orig = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = 'Calling…'; }
  try {
    await CRM.fetch('/api/calls/outbound', { method: 'POST', body: JSON.stringify({ contact_id: parseInt(id) }) });
    if (btn) btn.innerHTML = '✓ Ringing';
    await loadCallLogs();
    setTimeout(() => askMarkTaskComplete(taskId), 600);
    setTimeout(() => { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }, 6000);
  } catch (err) {
    showError(`Call failed: ${err.message}`);
    if (btn) { btn.disabled = false; btn.innerHTML = orig; }
  }
}

function taskQuickSms(taskId, event) {
  if (event) event.stopPropagation();
  const area = document.getElementById('sms-compose-area');
  if (area) { area.scrollIntoView({ behavior: 'smooth' }); }
  setTimeout(() => {
    const ta = document.getElementById('sms-compose-body');
    if (ta) ta.focus();
  }, 350);
  setTimeout(() => askMarkTaskComplete(taskId), 400);
}

function taskQuickEmail(taskId, event) {
  if (event) event.stopPropagation();
  const c = window._currentContact;
  if (!c || !c.email) return;
  if (window.CRM_GMAIL_ENABLED && typeof openEmailModal === 'function') {
    openEmailModal(parseInt(id), c.email, 'Prosperity Life & Financial Solutions Follow-Up');
  } else {
    window.open(
      `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}&su=${encodeURIComponent('Prosperity Life & Financial Solutions Follow-Up')}`,
      '_blank', 'noopener'
    );
  }
  setTimeout(() => askMarkTaskComplete(taskId), 400);
}

function askMarkTaskComplete(taskId) {
  if (confirm('Mark this task complete?')) completeTask(taskId);
}

async function saveTask() {
  const typeEl     = document.getElementById('task-type');
  const priorityEl = document.getElementById('task-priority');
  const dateEl     = document.getElementById('task-due-date');
  const timeEl     = document.getElementById('task-due-time');
  const notesEl    = document.getElementById('task-notes');

  const task_type = typeEl?.value;
  const priority  = priorityEl?.value || 'Medium';
  const due_date  = dateEl?.value;
  const due_time  = timeEl?.value || null;
  const notes     = notesEl?.value.trim() || null;

  if (!task_type) { alert('Please select a task type.'); return; }
  if (!due_date)  { alert('Please select a due date.');  return; }

  const btn = document.getElementById('task-save-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }

  try {
    await CRM.fetch('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ contact_id: parseInt(id), task_type, due_date, due_time, notes, priority }),
    });
    if (typeEl)     typeEl.value     = '';
    if (priorityEl) priorityEl.value = 'Medium';
    if (dateEl)     dateEl.value     = '';
    if (timeEl)     timeEl.value     = '';
    if (notesEl)    notesEl.value    = '';
    toggleTaskForm(false);
    await loadTasks();
    showToast('Task saved');
  } catch (e) {
    alert(`Could not save task: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Save Task'; }
  }
}

async function completeTask(taskId) {
  try {
    await CRM.fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Completed' }),
    });
    showToast('Task marked as done ✓');
    await loadTasks();
  } catch (e) {
    showError(`Could not complete task: ${e.message}`);
  }
}

async function cancelTask(taskId) {
  try {
    await CRM.fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'Cancelled' }),
    });
    await loadTasks();
  } catch (e) {
    showError(`Could not cancel task: ${e.message}`);
  }
}

async function deleteTask(taskId) {
  if (!confirm('Delete this task?')) return;
  try {
    await CRM.fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    await loadTasks();
  } catch (e) {
    showError(`Could not delete task: ${e.message}`);
  }
}

function toggleTaskForm(show) {
  const form = document.getElementById('task-form');
  const btn  = document.getElementById('add-task-btn');
  if (!form) return;
  if (show === undefined) show = form.classList.contains('hidden');
  if (show) {
    form.classList.remove('hidden');
    if (btn) btn.textContent = '✕ Cancel';
  } else {
    form.classList.add('hidden');
    if (btn) btn.textContent = '+ Add Task';
  }
}

function toggleCompletedTasks() {
  const el    = document.getElementById('tasks-completed');
  const label = document.getElementById('tasks-completed-toggle-label');
  if (!el) return;
  const isHidden = el.classList.contains('hidden');
  el.classList.toggle('hidden', !isHidden);
  if (label) {
    const count = el.querySelectorAll('.task-card').length;
    label.textContent = isHidden ? `Hide Completed Follow-Ups (${count})` : `Completed Follow-Ups (${count})`;
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

// ─── Activity Timeline ────────────────────────────────────────────────────────

function formatTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const tz = 'America/Chicago';
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const dStr = d.toLocaleDateString('en-CA', { timeZone: tz });
  const nd = new Date(); nd.setDate(nd.getDate() - 1);
  const yesterdayStr = nd.toLocaleDateString('en-CA', { timeZone: tz });
  const timeStr = d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  if (dStr === todayStr) return `Today at ${timeStr}`;
  if (dStr === yesterdayStr) return `Yesterday at ${timeStr}`;
  const [y, mo, dy] = dStr.split('-').map(Number);
  const label = new Date(y, mo - 1, dy).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${label} at ${timeStr}`;
}

const TL_META = {
  call:           { icon: '📞', cls: 'tl-call' },
  missed_call:    { icon: '📵', cls: 'tl-missed' },
  voicemail:      { icon: '🎙', cls: 'tl-voicemail' },
  sms:            { icon: '💬', cls: 'tl-sms' },
  email:          { icon: '✉',  cls: 'tl-email' },
  note:           { icon: '📝', cls: 'tl-note' },
  task:           { icon: '📌', cls: 'tl-task' },
  task_completed: { icon: '✅', cls: 'tl-task-done' },
  appointment:    { icon: '📅', cls: 'tl-appointment' },
  form:           { icon: '📋', cls: 'tl-form' },
};

function renderTimeline(items) {
  const feed = document.getElementById('timeline-feed');
  if (!feed) return;
  if (!items || !items.length) {
    feed.innerHTML = '<p class="text-muted tl-empty">No activity recorded yet.</p>';
    return;
  }
  feed.innerHTML = items.map(item => {
    const meta = TL_META[item.type] || { icon: '•', cls: 'tl-note' };
    // Only calls, SMS, and email carry meaningful inbound/outbound color distinction.
    // All other types use their own fixed color via CSS class.
    const useDirCls = ['call', 'sms', 'email'].includes(item.type);
    const dirCls = useDirCls
      ? (item.direction === 'inbound' ? 'tl-inbound' : 'tl-outbound')
      : '';
    const desc = item.description
      ? `<div class="tl-desc">${escHtml(item.description)}</div>` : '';
    return `<div class="tl-item ${meta.cls} ${dirCls}">
  <div class="tl-icon">${meta.icon}</div>
  <div class="tl-body">
    <div class="tl-row1">
      <span class="tl-title">${escHtml(item.title)}</span>
      <span class="tl-time">${escHtml(formatTimestamp(item.timestamp))}</span>
    </div>${desc}
  </div>
</div>`;
  }).join('');
}

async function loadTimeline() {
  try {
    const items = await CRM.fetch(`/api/contacts/${id}/timeline`);
    renderTimeline(items);
  } catch (err) {
    console.error('[Timeline] failed to load:', err.message);
    const feed = document.getElementById('timeline-feed');
    if (feed) feed.innerHTML = '<p class="text-muted tl-empty">Could not load activity.</p>';
  }
}

async function loadContact() {
  if (!id) return;
  try {
    const contact = await CRM.fetch(`/api/contacts/${id}`);
    window._currentContact = contact;
    renderInfo(contact);
    wireCallButton(contact);
    wireEmailButton(contact);
    wireSmsCompose(contact);
    populateSections(contact);
    renderNotes(contact.notes || []);
    await Promise.all([loadCallLogs(), loadSmsHistory(), loadEmailHistory(), loadAppointments(), loadActivity(), loadTasks(), loadTimeline()]);
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

function showToast(msg, duration = 2500, type = '') {
  let el = document.getElementById('crm-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'crm-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `crm-toast${type === 'error' ? ' crm-toast-error' : ''}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('crm-toast-hidden'), duration);
}

// ─── Delete contact ───────────────────────────────────────────────────────────

async function deleteContact() {
  const name = document.getElementById('contact-name').textContent.trim();
  const confirmed = confirm(
    `Are you sure you want to delete ${name || 'this contact'}? This cannot be undone.`
  );
  if (!confirmed) return;

  const btn = document.getElementById('delete-contact-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

  try {
    await CRM.fetch(`/api/contacts/${id}`, { method: 'DELETE' });
    window.location.href = '/';
  } catch (err) {
    console.error('[deleteContact] failed:', err);
    showError(`Could not delete contact: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '🗑 Delete'; }
  }
}

(function wireDeleteButton() {
  const btn = document.getElementById('delete-contact-btn');
  if (btn) btn.addEventListener('click', deleteContact);
})();

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
    window._currentContact = contact;
    renderInfo(contact);
    wireCallButton(contact);
    wireEmailButton(contact);
    wireSmsCompose(contact);
    populateSections(contact);
    renderNotes(contact.notes || []);
    await Promise.all([loadCallLogs(), loadSmsHistory(), loadEmailHistory(), loadAppointments(), loadActivity(), loadTasks(), loadTimeline()]);
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

// ─── SMS compose button + character counter ───────────────────────────────────

(function wireSmsButton() {
  const btn      = document.getElementById('sms-send-btn');
  const textarea = document.getElementById('sms-compose-body');
  const counter  = document.getElementById('sms-char-count');

  if (btn) btn.addEventListener('click', sendManualSms);

  if (textarea && counter) {
    textarea.addEventListener('input', () => {
      const len  = textarea.value.length;
      const segs = len <= 160 ? 1 : Math.ceil(len / 153);
      counter.textContent = segs === 1 ? `${len} / 160` : `${len} chars (${segs} segments)`;
    });
    textarea.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        btn?.click();
      }
    });
  }
})();

loadContact();
