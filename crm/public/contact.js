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

  if (!window.CRM_TWILIO_ENABLED) return; // hide button when Twilio not configured

  action.classList.remove('hidden');
  btn.onclick = () => initiateDetailCall(btn);
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
            <span style="float:right">${formatDate(c.started_at, true)}</span>
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

// ─── Communications ───────────────────────────────────────────────────────────

function renderComms(comms) {
  const el = document.getElementById('comms-list');
  if (!comms.length) {
    el.innerHTML = '<p class="text-muted">No activity yet.</p>';
    return;
  }
  el.innerHTML = comms.map(c => {
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

    const icon = { form: '📋', email: '✉️', sms: '💬', call: '📞' }[c.comm_type] || '📌';
    const dir  = c.direction === 'inbound'
      ? '<span class="badge badge-in">Inbound</span>'
      : '<span class="badge badge-out">Outbound</span>';

    return `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <div class="timeline-body">
          <div class="timeline-meta">
            ${icon} <strong>${escHtml(c.subject || c.comm_type)}</strong> ${dir}
            <span style="float:right">${formatDate(c.created_at, true)}</span>
          </div>
          ${bodyHtml}
        </div>
      </div>`;
  }).join('');
}

// ─── Load contact ─────────────────────────────────────────────────────────────

async function loadContact() {
  if (!id) return;
  try {
    const contact = await CRM.fetch(`/api/contacts/${id}`);
    renderInfo(contact);
    wireCallButton(contact);
    populateSections(contact);
    renderNotes(contact.notes || []);
    renderComms(contact.communications || []);
    await loadCallLogs();
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

loadContact();
