// Calls & Voicemail dashboard

let currentFilter = '';

// ─── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatPhone(raw) {
  if (!raw) return '';
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1)
    : digits.length === 10 ? digits : null;
  if (!ten) return raw;
  return `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Chicago',
  });
}

function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
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
  };
  const [cls, label] = map[status] || ['badge-call-init', status || '—'];
  return `<span class="call-status-badge ${cls}">${escHtml(label)}</span>`;
}

// ─── Stats & tab badges ───────────────────────────────────────────────────────

async function loadStats() {
  try {
    const { unread_voicemails, missed_calls } = await CRM.fetch('/api/calls/stats');

    const missedBadge = document.getElementById('tab-badge-missed');
    if (missedBadge) {
      missedBadge.textContent = missed_calls > 0 ? String(missed_calls) : '';
      missedBadge.classList.toggle('hidden', missed_calls === 0);
    }

    const vmBadge = document.getElementById('tab-badge-voicemail');
    if (vmBadge) {
      vmBadge.textContent = unread_voicemails > 0 ? String(unread_voicemails) : '';
      vmBadge.classList.toggle('hidden', unread_voicemails === 0);
    }

    // Keep sidebar badge in sync
    const navBadge = document.getElementById('nav-badge-calls');
    if (navBadge) {
      const total = (unread_voicemails || 0) + (missed_calls || 0);
      navBadge.textContent = total > 0 ? (total > 99 ? '99+' : String(total)) : '';
      navBadge.classList.toggle('hidden', total === 0);
    }
  } catch {}
}

// ─── Load & render ────────────────────────────────────────────────────────────

async function loadCalls(filter) {
  currentFilter = filter == null ? currentFilter : filter;

  document.querySelectorAll('.calls-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.filter === currentFilter);
  });

  const container = document.getElementById('calls-container');
  const errEl     = document.getElementById('calls-error');
  errEl.classList.add('hidden');
  container.innerHTML = '<div class="loading-row">Loading calls…</div>';

  try {
    const params = new URLSearchParams({ limit: 200 });
    if (currentFilter) params.set('filter', currentFilter);
    const calls = await CRM.fetch(`/api/calls?${params}`);

    document.getElementById('calls-count').textContent =
      `${calls.length} call${calls.length !== 1 ? 's' : ''}`;

    if (!calls.length) {
      container.innerHTML = '<div class="calls-empty">No calls found.</div>';
      return;
    }

    container.innerHTML = calls.map(c => renderCallRow(c)).join('');
  } catch (err) {
    errEl.textContent = `Failed to load calls: ${err.message}`;
    errEl.classList.remove('hidden');
    container.innerHTML = '';
  }
}

function renderCallRow(c) {
  const isInbound = c.direction === 'inbound';
  const isMissed  = isInbound && ['missed','no-answer','busy','canceled'].includes(c.status);
  const isVm      = c.status === 'voicemail';
  const isUnread  = !c.listened_at && (isVm || isMissed);

  const dirIcon  = isInbound ? '📲' : '☎';
  const dirLabel = isInbound ? 'Inbound' : 'Outbound';

  const contactName = (c.first_name || c.last_name)
    ? [c.first_name, c.last_name].filter(Boolean).join(' ')
    : (c.contact_name || 'Unknown Caller');

  const phone = formatPhone(isInbound ? c.from_number : c.to_number);
  const dur   = c.duration_sec ? formatDuration(c.duration_sec) : '';

  const nameHtml = c.contact_id
    ? `<a class="call-contact-link" href="/contact.html?id=${c.contact_id}">${escHtml(contactName)}</a>`
    : `<span class="call-contact-name">${escHtml(contactName)}</span>`;

  const vmPlayer = c.recording_url
    ? `<div class="voicemail-player" id="vm-${c.id}" style="margin-top:.4rem">
         <button class="call-recording-btn" onclick="loadVoicemail(${c.id})">🎙 Play Voicemail</button>
       </div>`
    : '';

  const transcription = c.transcription
    ? `<div class="call-transcription" style="margin-top:.25rem">📝 "${escHtml(c.transcription)}"</div>`
    : '';

  const markReadBtn = isUnread
    ? `<button class="calls-action-btn" onclick="markListened(${c.id})">✓ Mark Read</button>`
    : (c.listened_at ? `<span class="call-listened-mark">✓ Read</span>` : '');

  const viewBtn = c.contact_id
    ? `<a class="calls-action-btn calls-action-view" href="/contact.html?id=${c.contact_id}">View Contact →</a>`
    : '';

  return `
    <div class="call-row${isUnread ? ' unread' : ''}" id="call-row-${c.id}">
      <div class="call-row-top">
        <div class="call-row-meta">
          <span class="call-dir-icon">${dirIcon}</span>
          <span class="call-dir-label">${escHtml(dirLabel)}</span>
          ${callStatusBadge(c.status)}
        </div>
        <span class="call-row-time">${formatDateTime(c.started_at)}</span>
      </div>
      <div class="call-row-contact">
        ${nameHtml}
        ${phone ? `<span class="call-row-phone">${escHtml(phone)}</span>` : ''}
        ${dur   ? `<span class="call-row-dur">${escHtml(dur)}</span>` : ''}
      </div>
      ${vmPlayer}
      ${transcription}
      <div class="call-row-actions">
        ${viewBtn}
        <button class="calls-action-btn" onclick="toggleNoteForm(${c.id})">📝 Add Note</button>
        ${markReadBtn}
      </div>
      <div class="call-note-form hidden" id="note-form-${c.id}">
        <textarea class="call-note-textarea" id="note-text-${c.id}"
          placeholder="Add a note about this call…" rows="2"></textarea>
        <div class="call-note-form-actions">
          <button class="calls-action-btn calls-action-save"
            onclick="saveCallNote(${c.id}, ${c.contact_id || 'null'})">Save Note</button>
          <button class="calls-action-btn"
            onclick="toggleNoteForm(${c.id}, true)">Cancel</button>
        </div>
      </div>
    </div>`;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function markListened(callId) {
  try {
    await CRM.fetch(`/api/calls/${callId}`, {
      method: 'PATCH',
      body: JSON.stringify({ listened_at: new Date().toISOString() }),
    });
    await Promise.all([loadCalls(), loadStats()]);
  } catch (err) {
    alert(`Could not mark as read: ${err.message}`);
  }
}

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

    // Auto-mark as read when the recording starts playing
    const row = document.getElementById(`call-row-${callId}`);
    if (row && row.classList.contains('unread')) {
      markListened(callId);
    }
  } catch (err) {
    btn.disabled  = false;
    btn.innerHTML = origText;
    const errEl = document.getElementById('calls-error');
    if (errEl) {
      errEl.textContent = `Could not load voicemail: ${err.message}`;
      errEl.classList.remove('hidden');
    }
  }
}

function toggleNoteForm(callId, forceClose) {
  const form = document.getElementById(`note-form-${callId}`);
  if (!form) return;
  if (forceClose || !form.classList.contains('hidden')) {
    form.classList.add('hidden');
  } else {
    form.classList.remove('hidden');
    const ta = document.getElementById(`note-text-${callId}`);
    if (ta) { ta.focus(); ta.select(); }
  }
}

async function saveCallNote(callId, contactId) {
  const ta   = document.getElementById(`note-text-${callId}`);
  const text = ta ? ta.value.trim() : '';
  if (!text) { ta && ta.focus(); return; }

  try {
    if (contactId) {
      await CRM.fetch(`/api/contacts/${contactId}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: text }),
      });
    } else {
      await CRM.fetch(`/api/calls/${callId}`, {
        method: 'PATCH',
        body: JSON.stringify({ notes: text }),
      });
    }
    toggleNoteForm(callId, true);
    if (ta) ta.value = '';
  } catch (err) {
    alert(`Could not save note: ${err.message}`);
  }
}

// ─── Tab delegation ───────────────────────────────────────────────────────────

document.getElementById('calls-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.calls-tab');
  if (tab) loadCalls(tab.dataset.filter);
});

// ─── Init ─────────────────────────────────────────────────────────────────────

loadStats();
loadCalls('');
