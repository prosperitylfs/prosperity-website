// Calls & Voicemail — threaded conversation view

let allCalls    = [];   // raw call records from last fetch
let allThreads  = [];   // grouped threads (all filters)
let openThreads = new Set(); // thread keys currently expanded
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

function formatRelativeDate(iso) {
  if (!iso) return '—';
  const d   = new Date(iso);
  const now = new Date();
  const tz  = 'America/Chicago';
  const toDate = dt => dt.toLocaleDateString('en-US', { timeZone: tz });
  const dStr         = toDate(d);
  const todayStr     = toDate(now);
  const yesterdayStr = toDate(new Date(now - 86400000));
  if (dStr === todayStr)
    return d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  if (dStr === yesterdayStr) return 'Yesterday';
  if (now - d < 6 * 86400000)
    return d.toLocaleString('en-US', { timeZone: tz, weekday: 'short' });
  if (d.getFullYear() === now.getFullYear())
    return d.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
  return d.toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' });
}

function formatFullDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const tz       = 'America/Chicago';
  const todayStr = new Date().toLocaleDateString('en-US', { timeZone: tz });
  const isToday  = d.toLocaleDateString('en-US', { timeZone: tz }) === todayStr;
  const timeStr  = d.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true });
  return isToday
    ? `Today, ${timeStr}`
    : d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
}

function formatDuration(sec) {
  if (!sec) return '';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
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
    'missed':         ['badge-call-missed',    'Missed'],
    'voicemail':      ['badge-call-voicemail', 'Voicemail'],
    'voicemail_left': ['badge-call-voicemail', 'VM Left'],
  };
  const [cls, label] = map[status] || ['badge-call-init', status || '—'];
  return `<span class="call-status-badge ${cls}">${escHtml(label)}</span>`;
}

// ─── Thread grouping ──────────────────────────────────────────────────────────

function getThreadKey(call) {
  if (call.contact_id) return `c${call.contact_id}`;
  const phone = ((call.direction === 'inbound' ? call.from_number : call.to_number) || '').replace(/\D/g, '');
  return `p${phone || call.id}`;
}

function getContactName(call) {
  if (call.first_name || call.last_name)
    return [call.first_name, call.last_name].filter(Boolean).join(' ');
  return call.contact_name || 'Unknown Caller';
}

function groupIntoThreads(calls) {
  const map = new Map();

  for (const call of calls) {
    const key = getThreadKey(call);

    if (!map.has(key)) {
      const phone = (call.direction === 'inbound' ? call.from_number : call.to_number) || '';
      map.set(key, {
        key,
        contact_id:        call.contact_id || null,
        contact_name:      getContactName(call),
        phone_raw:         phone,
        phone:             formatPhone(phone),
        contact_lead_type: call.contact_lead_type || null,
        calls:             [],
        call_count:        0,
        voicemail_count:   0,
        missed_count:      0,
        unread_count:      0,
        last_activity:     null,
        last_status:       null,
        last_direction:    null,
      });
    }

    const t = map.get(key);
    t.calls.push(call);
    t.call_count++;

    const isVm     = call.status === 'voicemail';
    const isMissed = call.direction === 'inbound' &&
                     ['missed','no-answer','busy','canceled'].includes(call.status);
    if (isVm)     t.voicemail_count++;
    if (isMissed) t.missed_count++;
    if (!call.listened_at && (isVm || isMissed)) t.unread_count++;

    if (!t.last_activity || call.started_at > t.last_activity) {
      t.last_activity  = call.started_at;
      t.last_status    = call.status;
      t.last_direction = call.direction;
    }
  }

  return [...map.values()].sort((a, b) => b.last_activity.localeCompare(a.last_activity));
}

function applyFilter(threads, filter) {
  if (!filter)                return threads;
  if (filter === 'voicemail') return threads.filter(t => t.voicemail_count > 0);
  if (filter === 'missed')    return threads.filter(t => t.missed_count > 0);
  if (filter === 'unknown')   return threads.filter(t =>
    !t.contact_id || t.contact_lead_type === 'Unknown Caller'
  );
  return threads;
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

    const navBadge = document.getElementById('nav-badge-calls');
    if (navBadge) {
      const total = (unread_voicemails || 0) + (missed_calls || 0);
      navBadge.textContent = total > 0 ? (total > 99 ? '99+' : String(total)) : '';
      navBadge.classList.toggle('hidden', total === 0);
    }
  } catch {}
}

// ─── Render ───────────────────────────────────────────────────────────────────

function threadInitials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  return parts.length >= 2
    ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    : (parts[0] || '?')[0].toUpperCase();
}

function buildThreadPills(t) {
  const vmBadge     = t.voicemail_count > 0
    ? `<span class="thread-pill thread-pill-vm">🎙 ${t.voicemail_count} VM</span>` : '';
  const missedBadge = t.missed_count > 0
    ? `<span class="thread-pill thread-pill-missed">⚠ ${t.missed_count} Missed</span>` : '';
  const unreadBadge = t.unread_count > 0
    ? `<span class="thread-pill thread-pill-unread">${t.unread_count} Unread</span>` : '';
  return `<span class="thread-pill thread-pill-calls">${t.call_count} call${t.call_count !== 1 ? 's' : ''}</span>`
       + `${vmBadge}${missedBadge}${unreadBadge}${callStatusBadge(t.last_status)}`;
}

function renderThreadCard(t) {
  const isExpanded = openThreads.has(t.key);
  const hasUnread  = t.unread_count > 0;

  const nameHtml = t.contact_id
    ? `<a class="thread-name-link" href="/contact.html?id=${t.contact_id}"
          onclick="event.stopPropagation()">${escHtml(t.contact_name)}</a>`
    : `<span class="thread-name-text">${escHtml(t.contact_name)}</span>`;

  const leadBadge = t.contact_lead_type
    ? `<span class="thread-lead-type">${escHtml(t.contact_lead_type)}</span>` : '';

  const callbackBtn = window.CRM_TWILIO_ENABLED && t.contact_id
    ? `<button class="calls-action-btn thread-callback-btn"
         onclick="event.stopPropagation(); callBack(this, ${t.contact_id})"
         title="Call via Twilio bridge">☎ Call Back</button>` : '';

  const viewBtn = t.contact_id
    ? `<a class="calls-action-btn calls-action-view"
          href="/contact.html?id=${t.contact_id}"
          onclick="event.stopPropagation()">View Contact →</a>` : '';

  const actionsHtml = (callbackBtn || viewBtn)
    ? `<div class="thread-actions">${callbackBtn}${viewBtn}</div>` : '';

  return `
    <div class="thread-card${hasUnread ? ' has-unread' : ''}${isExpanded ? ' expanded' : ''}"
         id="thread-${t.key}">
      <div class="thread-header" onclick="toggleThread('${t.key}')">
        <div class="thread-avatar">${escHtml(threadInitials(t.contact_name))}</div>
        <div class="thread-body">
          <div class="thread-top-row">
            <div class="thread-name">${nameHtml}</div>
            <span class="thread-time">${formatRelativeDate(t.last_activity)}</span>
          </div>
          <div class="thread-sub-row">
            ${t.phone ? `<span class="thread-phone">${escHtml(t.phone)}</span>` : ''}
            ${leadBadge}
          </div>
          <div class="thread-pills" id="pills-${t.key}">${buildThreadPills(t)}</div>
          ${actionsHtml}
        </div>
        <span class="thread-chevron${isExpanded ? ' open' : ''}">▾</span>
      </div>
      <div class="thread-detail${isExpanded ? '' : ' hidden'}" id="detail-${t.key}">
        ${isExpanded ? '<div class="loading-row" style="padding:.875rem 1rem">Loading…</div>' : ''}
      </div>
    </div>`;
}

function renderCallLogItem(call) {
  const isInbound = call.direction === 'inbound';
  const isMissed  = isInbound && ['missed','no-answer','busy','canceled'].includes(call.status);
  const isVm      = call.status === 'voicemail';
  const isUnread  = !call.listened_at && (isVm || isMissed);
  const dur       = call.duration_sec ? formatDuration(call.duration_sec) : '';

  const dirClass = isInbound ? (isMissed ? 'dir-missed' : 'dir-in') : 'dir-out';
  const dirIcon  = isInbound ? '↙' : '↗';

  const vmPlayer = call.recording_url
    ? `<div class="voicemail-player" id="vm-${call.id}">
         <button class="calls-action-btn" onclick="loadVoicemail(${call.id})">🎙 Play Voicemail</button>
       </div>` : '';

  const transcription = call.transcription
    ? `<div class="call-transcription">📝 "${escHtml(call.transcription)}"</div>` : '';

  const savedNotes = call.notes
    ? `<div class="call-log-notes">📋 ${escHtml(call.notes)}</div>` : '';

  const markReadBtn = isUnread
    ? `<button class="calls-action-btn" onclick="markListened(${call.id})">✓ Mark Read</button>` : '';

  return `
    <div class="call-log-item${isUnread ? ' log-unread' : ''}" id="call-row-${call.id}">
      <div class="call-log-header">
        <span class="call-log-dir ${dirClass}">${dirIcon}</span>
        ${callStatusBadge(call.status)}
        <span class="call-log-time">${formatFullDate(call.started_at)}</span>
        ${dur ? `<span class="call-log-dur">${escHtml(dur)}</span>` : ''}
      </div>
      ${vmPlayer}${transcription}${savedNotes}
      <div class="call-row-actions" style="margin-top:.35rem">
        ${markReadBtn}
        <button class="calls-action-btn" onclick="toggleNoteForm(${call.id})">+ Note</button>
      </div>
      <div class="call-note-form hidden" id="note-form-${call.id}">
        <textarea class="call-note-textarea" id="note-text-${call.id}"
          placeholder="Add a note about this call…" rows="2"></textarea>
        <div class="call-note-form-actions">
          <button class="calls-action-btn calls-action-save"
            onclick="saveCallNote(${call.id}, ${call.contact_id || 'null'})">Save</button>
          <button class="calls-action-btn"
            onclick="toggleNoteForm(${call.id}, true)">Cancel</button>
        </div>
      </div>
    </div>`;
}

function renderThreadList(threads) {
  const container = document.getElementById('calls-container');
  if (!threads.length) {
    container.innerHTML = '<div class="calls-empty" style="padding:3rem 2rem;text-align:center;color:var(--text-muted)">No calls found.</div>';
    return;
  }
  container.innerHTML = `<div class="thread-list">${threads.map(t => renderThreadCard(t)).join('')}</div>`;
}

// ─── Thread expansion ─────────────────────────────────────────────────────────

async function loadThreadDetail(key, thread) {
  const detailEl = document.getElementById(`detail-${key}`);
  if (!detailEl) return;

  try {
    let calls;
    if (thread.contact_id) {
      calls = await CRM.fetch(`/api/calls/contact/${thread.contact_id}`);
    } else {
      // Unknown caller: use the calls already in the thread from the last fetch
      calls = thread.calls;
    }
    detailEl.innerHTML = calls.length
      ? `<div class="call-log-list">${calls.map(c => renderCallLogItem(c)).join('')}</div>`
      : '<div style="padding:.875rem 1rem;color:var(--text-muted);font-size:.875rem">No call history found.</div>';
  } catch {
    detailEl.innerHTML = '<div style="padding:.875rem 1rem;color:var(--red);font-size:.875rem">Could not load calls.</div>';
  }
}

function toggleThread(key) {
  const cardEl   = document.getElementById(`thread-${key}`);
  const detailEl = document.getElementById(`detail-${key}`);
  const chevron  = cardEl?.querySelector('.thread-chevron');
  if (!cardEl || !detailEl) return;

  if (openThreads.has(key)) {
    openThreads.delete(key);
    cardEl.classList.remove('expanded');
    detailEl.classList.add('hidden');
    chevron?.classList.remove('open');
  } else {
    openThreads.add(key);
    cardEl.classList.add('expanded');
    detailEl.classList.remove('hidden');
    chevron?.classList.add('open');
    cardEl.querySelector('.thread-header').classList.add('expanded');

    const thread = allThreads.find(t => t.key === key);
    if (thread) {
      detailEl.innerHTML = '<div class="loading-row" style="padding:.875rem 1rem">Loading calls…</div>';
      loadThreadDetail(key, thread);
    }
  }
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
  const btn    = player?.querySelector('.calls-action-btn');
  if (!btn) return;

  const origText = btn.innerHTML;
  btn.disabled  = true;
  btn.innerHTML = '<span class="call-spinner"></span> Loading…';

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
    const errEl = document.getElementById('calls-error');
    if (errEl) { errEl.textContent = `Could not load voicemail: ${err.message}`; errEl.classList.remove('hidden'); }
  }
}

function toggleNoteForm(callId, forceClose) {
  const form = document.getElementById(`note-form-${callId}`);
  if (!form) return;
  if (forceClose || !form.classList.contains('hidden')) {
    form.classList.add('hidden');
  } else {
    form.classList.remove('hidden');
    document.getElementById(`note-text-${callId}`)?.focus();
  }
}

async function saveCallNote(callId, contactId) {
  const ta   = document.getElementById(`note-text-${callId}`);
  const text = ta ? ta.value.trim() : '';
  if (!text) { ta?.focus(); return; }
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

async function callBack(btn, contactId) {
  if (!window.CRM_TWILIO_ENABLED || !contactId) return;
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="call-spinner"></span> Connecting…';
  try {
    await CRM.fetch('/api/calls/outbound', {
      method: 'POST',
      body: JSON.stringify({ contact_id: contactId }),
    });
    btn.innerHTML = '✓ Your phone is ringing';
    setTimeout(() => { btn.disabled = false; btn.innerHTML = origHtml; }, 8000);
    await loadCalls();
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = origHtml;
    const errEl = document.getElementById('calls-error');
    if (errEl) { errEl.textContent = `Call failed: ${err.message}`; errEl.classList.remove('hidden'); }
  }
}

// ─── Load ─────────────────────────────────────────────────────────────────────

async function loadCalls(filter) {
  currentFilter = filter == null ? currentFilter : filter;

  document.querySelectorAll('.calls-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.filter === currentFilter);
  });

  const container = document.getElementById('calls-container');
  const errEl     = document.getElementById('calls-error');
  errEl.classList.add('hidden');

  // Only show spinner if container is blank (avoids flash on refresh)
  if (!container.querySelector('.thread-list')) {
    container.innerHTML = '<div class="loading-row">Loading calls…</div>';
  }

  try {
    // Always fetch full history; filter applied on frontend so thread stats are accurate
    allCalls   = await CRM.fetch('/api/calls?limit=500');
    allThreads = groupIntoThreads(allCalls);

    const filtered = applyFilter(allThreads, currentFilter);
    document.getElementById('calls-count').textContent =
      `${filtered.length} conversation${filtered.length !== 1 ? 's' : ''}`;

    renderThreadList(filtered);

    // Re-populate detail for threads that were open before the reload
    await Promise.all(
      [...openThreads].map(key => {
        const t = allThreads.find(t => t.key === key);
        return t ? loadThreadDetail(key, t) : Promise.resolve();
      })
    );
  } catch (err) {
    errEl.textContent = `Failed to load calls: ${err.message}`;
    errEl.classList.remove('hidden');
    container.innerHTML = '';
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
