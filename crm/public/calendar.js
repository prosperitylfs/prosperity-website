// Calendar page — appointments list with status management

let calAppts   = [];
let calView    = 'upcoming';

const calTbody    = document.getElementById('cal-tbody');
const calCards    = document.getElementById('cal-cards');
const calEmpty    = document.getElementById('cal-empty');
const calTableCard = document.getElementById('cal-table-card');
const calCount    = document.getElementById('cal-count');
const calError    = document.getElementById('cal-error');

const APPT_STATUSES = ['Scheduled', 'Completed', 'No-Show', 'Cancelled', 'Rescheduled'];

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtCT(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function statusTag(s) {
  const cls = {
    'Scheduled':   'tag-purple',
    'Completed':   'tag-green',
    'No-Show':     'tag-amber',
    'Cancelled':   'tag-gray',
    'Rescheduled': 'tag-blue',
  };
  return `<span class="tag tag-xs ${cls[s] || 'tag-gray'}">${escHtml(s)}</span>`;
}

function statusSelect(apptId, current) {
  const opts = APPT_STATUSES.map(s =>
    `<option value="${s}"${s === current ? ' selected' : ''}>${s}</option>`
  ).join('');
  return `<select class="cal-status-select" onchange="updateStatus(${apptId}, this.value)">${opts}</select>`;
}

function showError(msg) {
  calError.textContent = msg;
  calError.classList.remove('hidden');
}

window.updateStatus = async function (apptId, newStatus) {
  try {
    await CRM.fetch(`/api/appointments/${apptId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: newStatus }),
    });
    await loadAppts();
  } catch (e) {
    showError(`Could not update: ${e.message}`);
  }
};

function renderTable(appts) {
  calCards.classList.add('hidden');
  calTableCard.classList.remove('hidden');
  calTbody.innerHTML = appts.map(a => {
    const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Unknown';
    return `
      <tr>
        <td><a href="/contact.html?id=${a.contact_id}" class="cal-contact-link">${escHtml(name)}</a></td>
        <td>${escHtml(a.phone || '—')}</td>
        <td class="cal-col-email">${escHtml(a.email || '—')}</td>
        <td>${escHtml(a.appt_type)}</td>
        <td class="cal-dt-cell">${escHtml(fmtCT(a.appt_datetime))}</td>
        <td>${statusSelect(a.id, a.status)}</td>
        <td><a href="/contact.html?id=${a.contact_id}" class="btn btn-sm btn-outline">View</a></td>
      </tr>`;
  }).join('');
}

function renderCards(appts) {
  calTableCard.classList.add('hidden');
  calCards.classList.remove('hidden');
  calCards.innerHTML = appts.map(a => {
    const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || 'Unknown';
    return `
      <div class="cal-card">
        <div class="cal-card-header">
          <a href="/contact.html?id=${a.contact_id}" class="cal-contact-link">${escHtml(name)}</a>
          ${statusTag(a.status)}
        </div>
        <div class="cal-card-type">${escHtml(a.appt_type)}</div>
        <div class="cal-card-dt">📅 ${escHtml(fmtCT(a.appt_datetime))}</div>
        ${a.phone ? `<div class="cal-card-row">📞 ${escHtml(a.phone)}</div>` : ''}
        ${a.email ? `<div class="cal-card-row">✉ ${escHtml(a.email)}</div>` : ''}
        ${a.location ? `<div class="cal-card-row">📍 ${escHtml(a.location)}</div>` : ''}
        ${a.notes ? `<div class="cal-card-notes">${escHtml(a.notes)}</div>` : ''}
        <div class="cal-card-footer">
          ${statusSelect(a.id, a.status)}
          <a href="/contact.html?id=${a.contact_id}" class="btn btn-sm btn-outline">View</a>
        </div>
      </div>`;
  }).join('');
}

function renderAppts(appts) {
  calError.classList.add('hidden');

  if (!appts.length) {
    calTableCard.classList.add('hidden');
    calCards.classList.add('hidden');
    calEmpty.classList.remove('hidden');
    const label = calView === 'upcoming' ? 'upcoming ' : calView === 'past' ? 'past ' : '';
    calCount.textContent = `No ${label}appointments`;
    return;
  }

  calEmpty.classList.add('hidden');
  const label = calView === 'upcoming' ? 'upcoming' : calView === 'past' ? 'past' : 'total';
  calCount.textContent = `${appts.length} ${label} appointment${appts.length !== 1 ? 's' : ''}`;

  if (window.innerWidth <= 768) {
    renderCards(appts);
  } else {
    renderTable(appts);
  }
}

async function loadAppts() {
  calError.classList.add('hidden');
  try {
    const url = calView ? `/api/appointments?view=${calView}` : '/api/appointments';
    calAppts = await CRM.fetch(url);
    renderAppts(calAppts);
  } catch (e) {
    showError(`Could not load appointments: ${e.message}`);
  }
}

// Tabs
document.getElementById('cal-tabs').addEventListener('click', e => {
  const btn = e.target.closest('.calls-tab');
  if (!btn) return;
  document.querySelectorAll('#cal-tabs .calls-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  calView = btn.dataset.view;
  loadAppts();
});

// Re-render on resize (switch between table and cards)
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (calAppts.length) renderAppts(calAppts); }, 150);
});

loadAppts();
