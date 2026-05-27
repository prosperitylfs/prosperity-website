// Shared email compose modal — included on both contact.html and index.html

(function () {
  // ─── Inject modal HTML once ──────────────────────────────────────────────────
  const MODAL_ID = 'email-compose-modal';

  function ensureModal() {
    if (document.getElementById(MODAL_ID)) return;

    const el = document.createElement('div');
    el.innerHTML = `
      <div id="${MODAL_ID}" class="email-modal-overlay hidden" role="dialog" aria-modal="true" aria-label="Compose email">
        <div class="email-modal-box" onclick="event.stopPropagation()">

          <div class="email-modal-header">
            <span class="email-modal-title">Send Email</span>
            <button class="email-modal-close" onclick="closeEmailModal()" aria-label="Close">&#x2715;</button>
          </div>

          <div class="email-modal-body">

            <div class="em-field">
              <label class="em-label">From</label>
              <div id="em-from" class="em-from-display"></div>
            </div>

            <div class="em-field">
              <label class="em-label" for="em-to">To</label>
              <input id="em-to" class="em-input" type="email" readonly>
            </div>

            <div class="em-field">
              <label class="em-label" for="em-subject">Subject</label>
              <input id="em-subject" class="em-input" type="text" placeholder="Email subject…" maxlength="200">
            </div>

            <div class="em-field em-field-grow">
              <label class="em-label" for="em-body">Message</label>
              <textarea id="em-body" class="em-textarea" placeholder="Type your message…" rows="9"></textarea>
            </div>

          </div><!-- /email-modal-body -->

          <div class="email-modal-footer">
            <div id="em-error" class="em-error hidden"></div>
            <div class="em-footer-actions">
              <button id="em-send-btn" class="btn btn-primary em-send-btn" onclick="sendEmailModal()">
                <span id="em-send-label">Send Email</span>
              </button>
              <button class="btn em-cancel-btn" onclick="closeEmailModal()">Cancel</button>
              <a id="em-fallback" class="em-fallback-link hidden" href="#" target="_blank" rel="noopener">
                Open in Gmail →
              </a>
            </div>
          </div>

        </div>
      </div>`;
    document.body.appendChild(el.firstElementChild);

    // Close on overlay click
    document.getElementById(MODAL_ID).addEventListener('click', function (e) {
      if (e.target === this) closeEmailModal();
    });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeEmailModal();
    });
  }

  // ─── State ───────────────────────────────────────────────────────────────────
  let _contactId = null;

  // ─── Public API ──────────────────────────────────────────────────────────────

  window.openEmailModal = function (contactId, toEmail, prefillSubject) {
    ensureModal();
    _contactId = contactId || null;

    const from      = window.CRM_GMAIL_FROM || 'loretta@prosperitylfs.com';
    const gmailUrl  = toEmail
      ? `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(toEmail)}&su=${encodeURIComponent(prefillSubject || 'Prosperity Life & Financial Solutions Follow-Up')}`
      : null;

    document.getElementById('em-from').textContent = from;
    document.getElementById('em-to').value          = toEmail || '';
    document.getElementById('em-subject').value     = prefillSubject || '';
    document.getElementById('em-body').value        = '';

    const errorEl = document.getElementById('em-error');
    errorEl.textContent = '';
    errorEl.classList.add('hidden');

    const sendBtn   = document.getElementById('em-send-btn');
    const sendLabel = document.getElementById('em-send-label');
    sendBtn.disabled = false;
    sendLabel.textContent = 'Send Email';

    const fallback = document.getElementById('em-fallback');
    if (gmailUrl && !window.CRM_GMAIL_ENABLED) {
      fallback.href = gmailUrl;
      fallback.classList.remove('hidden');
    } else {
      fallback.classList.add('hidden');
    }

    const overlay = document.getElementById(MODAL_ID);
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    setTimeout(() => {
      const subj = document.getElementById('em-subject');
      subj.focus();
      subj.select();
    }, 100);
  };

  window.closeEmailModal = function () {
    const overlay = document.getElementById(MODAL_ID);
    if (overlay) overlay.classList.add('hidden');
    document.body.style.overflow = '';
    _contactId = null;
  };

  window.sendEmailModal = async function () {
    const toEmail = document.getElementById('em-to').value.trim();
    const subject = document.getElementById('em-subject').value.trim();
    const body    = document.getElementById('em-body').value.trim();
    const errorEl = document.getElementById('em-error');

    errorEl.classList.add('hidden');

    if (!toEmail) return showEmError('Please enter a recipient email address.');
    if (!subject) return showEmError('Please enter a subject line.');
    if (!body)    return showEmError('Please write a message before sending.');

    const sendBtn   = document.getElementById('em-send-btn');
    const sendLabel = document.getElementById('em-send-label');
    sendBtn.disabled = true;
    sendLabel.innerHTML = '<span class="call-spinner"></span> Sending…';

    try {
      await CRM.fetch('/api/email/send', {
        method: 'POST',
        body: JSON.stringify({
          contact_id: _contactId,
          to_email:   toEmail,
          subject,
          body,
        }),
      });

      sendLabel.textContent = '✓ Sent!';
      sendBtn.style.background = 'var(--green-dark)';

      // Refresh timeline if on contact detail page
      if (typeof loadContact === 'function') {
        setTimeout(loadContact, 600);
      }

      setTimeout(() => {
        closeEmailModal();
        sendBtn.style.background = '';
      }, 1400);
    } catch (err) {
      sendBtn.disabled = false;
      sendLabel.textContent = 'Send Email';
      showEmError(err.message || 'Failed to send email. Please try again.');
    }
  };

  function showEmError(msg) {
    const el = document.getElementById('em-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  // Auto-inject modal when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureModal);
  } else {
    ensureModal();
  }
})();
