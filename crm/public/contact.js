// Contact detail page

const id = new URLSearchParams(location.search).get('id');
const errorEl = document.getElementById('error-banner');

if (!id) {
  document.getElementById('contact-name').textContent = 'No contact ID';
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatDate(iso, includeTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  if (includeTime) { opts.hour = 'numeric'; opts.minute = '2-digit'; }
  return d.toLocaleDateString('en-US', opts);
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.classList.remove('hidden');
}

function tag(text, cls = '') {
  return text ? `<span class="tag ${cls}">${escHtml(text)}</span>` : '';
}

function renderInfo(contact) {
  document.getElementById('contact-name').textContent =
    [contact.first_name, contact.last_name].filter(Boolean).join(' ') || '(No name)';

  document.getElementById('contact-meta').innerHTML = [
    contact.lead_type ? tag(contact.lead_type, 'tag-purple') : '',
    contact.role      ? tag(contact.role, 'tag-gray') : '',
    `<span class="meta-date">Added ${formatDate(contact.created_at)}</span>`,
  ].filter(Boolean).join(' ');

  const fields = [
    ['Email',       contact.email],
    ['Phone',       contact.phone],
    ['Alt Phone',   contact.alt_phone],
    ['Lead Source', contact.lead_source],
    ['Role',        contact.role],
    ['Notes',       contact.notes],
  ].filter(([, v]) => v);

  document.getElementById('contact-info').innerHTML = fields.map(([label, value]) => `
    <div class="info-row">
      <span class="info-label">${escHtml(label)}</span>
      <span class="info-value">${escHtml(value)}</span>
    </div>
  `).join('') || '<p class="text-muted">No details on file.</p>';
}

function renderNotes(notes) {
  const el = document.getElementById('notes-list');
  if (!notes.length) {
    el.innerHTML = '<p class="text-muted">No notes yet.</p>';
    return;
  }
  el.innerHTML = notes.map(n => `
    <div class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-body">
        <div class="timeline-meta">${formatDate(n.created_at, true)}</div>
        <div class="timeline-text">${escHtml(n.body)}</div>
      </div>
    </div>
  `).join('');
}

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
          .map(([k, v]) => `<div class="form-row"><span class="form-key">${escHtml(k.replace(/_/g, ' '))}</span><span class="form-val">${escHtml(v)}</span></div>`)
          .join('');
        bodyHtml = rows ? `<div class="form-data">${rows}</div>` : '';
      } catch {
        bodyHtml = `<pre class="comm-body">${escHtml(c.body)}</pre>`;
      }
    } else if (c.body) {
      bodyHtml = `<div class="comm-body-text">${escHtml(c.body)}</div>`;
    }

    const typeIcon = { form: '📋', email: '✉️', sms: '💬', call: '📞' }[c.comm_type] || '📌';
    const dirBadge = c.direction === 'inbound'
      ? '<span class="badge badge-in">Inbound</span>'
      : '<span class="badge badge-out">Outbound</span>';

    return `
      <div class="timeline-item">
        <div class="timeline-dot"></div>
        <div class="timeline-body">
          <div class="timeline-meta">
            ${typeIcon} <strong>${escHtml(c.subject || c.comm_type)}</strong>
            ${dirBadge}
            <span style="float:right">${formatDate(c.created_at, true)}</span>
          </div>
          ${bodyHtml}
        </div>
      </div>
    `;
  }).join('');
}

async function loadContact() {
  if (!id) return;
  try {
    const contact = await CRM.fetch(`/api/contacts/${id}`);
    renderInfo(contact);
    renderNotes(contact.notes || []);
    renderComms(contact.communications || []);
  } catch (err) {
    showError(`Could not load contact: ${err.message}`);
  }
}

// Add note
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
