// ── EMAILJS CONFIGURATION ─────────────────────────────────────────────────
// Replace these two values after setting up your EmailJS account.
// See setup instructions in index.html or at https://www.emailjs.com
var EMAILJS_SERVICE_ID  = 'YOUR_SERVICE_ID';   // e.g. 'service_abc123'
var EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID';  // e.g. 'template_xyz789'
// ─────────────────────────────────────────────────────────────────────────

// ── CRM LEAD CAPTURE ──────────────────────────────────────────────────────
var CRM_ENDPOINT = 'http://localhost:3001/api/leads';
var CRM_API_KEY  = 'prosperity-crm-2025';

/**
 * Post a lead to the CRM. Fire-and-forget — never blocks the user.
 * Accepts an optional callback(success) called after the request settles.
 *
 * @param {Object}   data     - any lead fields; lead_type should already be set
 * @param {string}   leadType - fallback lead_type if not present in data
 * @param {Function} callback - optional; called with true (success) or false (fail)
 */
function postToCRM(data, leadType, callback) {
  var payload = Object.assign({}, data, {
    lead_type:   data.lead_type || leadType || 'contact',
    lead_source: data.lead_source || window.location.href,
    created_at:  new Date().toISOString(),
  });

  console.log('[CRM] Sending lead...', payload);

  fetch(CRM_ENDPOINT, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    CRM_API_KEY,
    },
    body: JSON.stringify(payload),
  })
    .then(function(res) {
      return res.json().then(function(body) { return { ok: res.ok, status: res.status, body: body }; });
    })
    .then(function(r) {
      if (r.ok) {
        console.log('[CRM] Lead saved successfully:', r.body);
      } else {
        console.error('[CRM] Lead save failed (' + r.status + '):', r.body);
      }
      if (typeof callback === 'function') callback(r.ok);
    })
    .catch(function(err) {
      console.error('[CRM] Lead save error (network):', err);
      if (typeof callback === 'function') callback(false);
    });
}

window.postToCRM = postToCRM;

/**
 * Send a booking form lead to the CRM, then call callback().
 * Used by book.html immediately before showing the Calendly step.
 * All fields collected through the multi-step form are passed through.
 * Callback always fires — user is never blocked by a CRM failure.
 *
 * @param {Object}   data     - booking form fields
 * @param {Function} callback - called after request settles
 */
function sendBookingLead(data, callback) {
  var payload = Object.assign({
    lead_source: window.location.href,
    created_at:  new Date().toISOString(),
  }, data);

  console.log('[CRM] Sending booking lead...', payload);

  var done = false;
  function proceed() { if (!done) { done = true; callback(); } }

  fetch(CRM_ENDPOINT, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key':    CRM_API_KEY,
    },
    body: JSON.stringify(payload),
  })
    .then(function(res) {
      return res.json().then(function(body) { return { ok: res.ok, status: res.status, body: body }; });
    })
    .then(function(r) {
      if (r.ok) {
        console.log('[CRM] Booking lead saved successfully:', r.body);
      } else {
        console.error('[CRM] Booking lead save failed (' + r.status + '):', r.body);
      }
      proceed();
    })
    .catch(function(err) {
      console.error('[CRM] Booking lead save error (network):', err);
      proceed();
    });
}

window.sendBookingLead = sendBookingLead;
// ─────────────────────────────────────────────────────────────────────────

// ── PHONE FORMATTING UTILITIES ─────────────────────────────────────────────
// Exposed on window so inline <script> blocks on any page can call them.

/** Strip every non-digit character from a string. */
function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Format up-to-10 digits as (NXX) NXX-XXXX while the user types.
 * Partial sequences are formatted to the extent possible, e.g.
 *   "414"       → "(414"
 *   "4144"      → "(414) 4"
 *   "4144411"   → "(414) 441-1"
 *   "4144411177"→ "(414) 441-1177"
 */
function formatPhoneDisplay(digits) {
  digits = digits.slice(0, 10);
  if (digits.length <= 3)  return '(' + digits;
  if (digits.length <= 6)  return '(' + digits.slice(0,3) + ') ' + digits.slice(3);
  return '(' + digits.slice(0,3) + ') ' + digits.slice(3,6) + '-' + digits.slice(6);
}

/**
 * Convert any common US phone string to E.164 (+1XXXXXXXXXX).
 * Accepts bare 10-digit strings, (NXX) NXX-XXXX, NXX-NXX-XXXX,
 * and 11-digit strings starting with 1.
 * Returns the E.164 string on success, or null if the number is invalid.
 */
function toE164(value) {
  var d = phoneDigits(value);
  if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1); // strip leading country code
  if (d.length !== 10) return null;
  return '+1' + d;
}

/**
 * Attach live (NXX) NXX-XXXX display formatting to a phone <input>.
 * Idempotent — safe to call more than once on the same element.
 */
function attachPhoneFormatting(input) {
  if (!input || input.dataset.phoneFmt) return;
  input.dataset.phoneFmt = '1';
  input.setAttribute('inputmode', 'tel');
  input.setAttribute('autocomplete', 'tel');
  input.addEventListener('input', function () {
    var cursorPos = this.selectionStart;
    var prevLen   = this.value.length;
    var d         = phoneDigits(this.value).slice(0, 10);
    this.value    = formatPhoneDisplay(d);
    // Nudge cursor forward/back proportionally after reformatting
    var delta = this.value.length - prevLen;
    try { this.setSelectionRange(cursorPos + delta, cursorPos + delta); } catch (ignore) {}
  });
}

/**
 * Validate and rewrite every phone input inside a form to E.164.
 * Call this immediately before submitting; it mutates input .value in-place
 * so FormData and URLSearchParams automatically capture the E.164 string.
 *
 * Returns an error message string if any phone is invalid, else null.
 * Optional-and-empty inputs are skipped.
 */
function normalizeFormPhones(form) {
  var inputs = form.querySelectorAll('input[type="tel"], input[name="phone"]');
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    var raw   = input.value.trim();
    if (!input.required && raw === '') continue; // optional + blank → skip
    var e164 = toE164(raw);
    if (!e164) {
      input.focus();
      return 'Please enter a valid 10-digit US phone number (e.g. 414-441-1177).';
    }
    input.value = e164; // e.g. +14144411177
  }
  return null;
}

// Make phone utilities available to inline scripts on every page
window.phoneDigits           = phoneDigits;
window.formatPhoneDisplay    = formatPhoneDisplay;
window.toE164                = toE164;
window.attachPhoneFormatting = attachPhoneFormatting;
window.normalizeFormPhones   = normalizeFormPhones;
// ─────────────────────────────────────────────────────────────────────────

// ── EMAIL VALIDATION UTILITIES ────────────────────────────────────────────

/**
 * Returns true if value is a properly formatted email address.
 * Requires text before @, a domain after @, and a suffix after the dot.
 * Examples that pass:  name@gmail.com, loretta@prosperitylfs.com
 * Examples that fail:  loretta@, loretta@gmail, @gmail.com, loretta
 */
function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());
}

/**
 * Attach live blur + input validation listeners to an email input.
 * - On blur: if non-empty and invalid, shows error and adds .input-error class.
 * - On input: clears error as soon as value becomes valid.
 *
 * @param {HTMLInputElement} inputEl  - the email <input>
 * @param {HTMLElement}      errorEl - the <p> that shows the error message
 */
function attachEmailValidation(inputEl, errorEl) {
  if (!inputEl || !errorEl) return;
  var MSG = 'Please enter a valid email address.';
  function clearErr() {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
    inputEl.classList.remove('input-error');
  }
  inputEl.addEventListener('blur', function() {
    var val = inputEl.value.trim();
    if (val !== '' && !isValidEmail(val)) {
      errorEl.textContent = MSG;
      errorEl.style.display = 'block';
      inputEl.classList.add('input-error');
    } else {
      clearErr();
    }
  });
  inputEl.addEventListener('input', function() {
    if (isValidEmail(inputEl.value)) clearErr();
  });
}

window.isValidEmail          = isValidEmail;
window.attachEmailValidation = attachEmailValidation;
// ─────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  // Auto-attach live formatting to every phone input on the page
  document.querySelectorAll('input[type="tel"], input[name="phone"]')
    .forEach(attachPhoneFormatting);

  // Auto-attach email blur/input validation to every email input with data-email-err
  document.querySelectorAll('input[type="email"][data-email-err]').forEach(function(input) {
    attachEmailValidation(input, document.getElementById(input.dataset.emailErr));
  });

  // ── Consultation / Contact forms ────────────────────────────────────────
  function handleForm(form, messageEl) {
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      // Validate email format
      var emailInput = form.querySelector('input[type="email"]');
      if (emailInput) {
        var emailVal = emailInput.value.trim();
        var errId    = emailInput.dataset.emailErr;
        var inlineEmailErr = errId ? document.getElementById(errId) : null;
        if (!isValidEmail(emailVal)) {
          var msg = 'Please enter a valid email address.';
          if (inlineEmailErr) { inlineEmailErr.textContent = msg; inlineEmailErr.style.display = 'block'; }
          else if (messageEl) { messageEl.textContent = msg; messageEl.className = 'form-message error'; }
          emailInput.classList.add('input-error');
          emailInput.focus();
          return;
        }
        if (inlineEmailErr) { inlineEmailErr.textContent = ''; inlineEmailErr.style.display = 'none'; }
        emailInput.classList.remove('input-error');
      }

      // Normalize phone to E.164 before any other processing
      var phoneErr = normalizeFormPhones(form);
      if (phoneErr) {
        if (messageEl) { messageEl.textContent = phoneErr; messageEl.className = 'form-message error'; }
        return;
      }

      // Note: SMS consent checkbox is optional, not required

      if (messageEl) { messageEl.textContent = ''; messageEl.className = 'form-message'; }

      // Post to CRM (fire-and-forget)
      var crmPayload = {};
      for (var i = 0; i < form.elements.length; i++) {
        var el = form.elements[i];
        if (el.name && el.value !== undefined) crmPayload[el.name] = el.value;
      }
      postToCRM(crmPayload, crmPayload.lead_type || 'contact');

      const data = new FormData(form);
      // Replace fetch URL with your backend or form service integration.
      fetch('https://example.com/submit', { method: 'POST', body: data })
        .then(function () {
          if (messageEl) {
            messageEl.textContent = 'Thanks — we received your request. We will contact you soon.';
            messageEl.className = 'form-message success';
          }
          form.reset();
        })
        .catch(function () {
          if (messageEl) {
            messageEl.textContent = 'Submission simulated. Configure backend to enable real submissions.';
            messageEl.className = 'form-message';
          }
        });
    });
  }

  // ── Guide download forms — sends guide to visitor via email ─────────────
  function handleGuideForm(form, messageEl, thankyouEl) {
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      // Normalize phone to E.164 first (phone is collected but not sent in email;
      // normalizing here ensures consistency if backend later captures FormData)
      var phoneErr = normalizeFormPhones(form);
      if (phoneErr) {
        if (messageEl) { messageEl.textContent = phoneErr; messageEl.className = 'form-message error'; }
        return;
      }

      var email     = form.elements['email']      ? form.elements['email'].value.trim()      : '';
      var firstName = form.elements['first_name'] ? form.elements['first_name'].value.trim() : 'there';
      if (!email || !isValidEmail(email)) {
        var emailInput = form.elements['email'];
        var errId = emailInput ? emailInput.dataset.emailErr : null;
        var inlineEmailErr = errId ? document.getElementById(errId) : null;
        var msg = 'Please enter a valid email address.';
        if (inlineEmailErr) { inlineEmailErr.textContent = msg; inlineEmailErr.style.display = 'block'; }
        else if (messageEl) { messageEl.textContent = msg; messageEl.className = 'form-message error'; }
        if (emailInput) { emailInput.classList.add('input-error'); emailInput.focus(); }
        return;
      }

      if (messageEl) messageEl.textContent = 'Sending your guide…';

      var guideUrl = 'https://prosperity-website.pages.dev/retirement-rollover-mistakes-guide.html';

      var templateParams = {
        to_name:    firstName,
        to_email:   email,
        guide_link: guideUrl
      };

      // Post to CRM (fire-and-forget — never blocks the UX)
      var crmData = {};
      var formElements = form.elements;
      for (var i = 0; i < formElements.length; i++) {
        var el = formElements[i];
        if (el.name && el.value !== undefined) crmData[el.name] = el.value;
      }
      postToCRM(crmData, 'guide');

      function showThankYou() {
        form.style.display = 'none';
        if (messageEl) messageEl.textContent = '';
        if (thankyouEl) thankyouEl.style.display = 'block';
      }

      // Send via EmailJS if configured; fall back to showing thank-you if not yet set up
      if (typeof window.emailjs !== 'undefined' &&
          EMAILJS_SERVICE_ID !== 'YOUR_SERVICE_ID' &&
          EMAILJS_TEMPLATE_ID !== 'YOUR_TEMPLATE_ID') {
        window.emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, templateParams)
          .then(showThankYou)
          .catch(function (err) {
            console.error('EmailJS error:', err);
            showThankYou(); // Still show thank-you so the visitor isn't left hanging
          });
      } else {
        // EmailJS not yet configured — show thank-you after a short delay
        setTimeout(showThankYou, 800);
      }
    });
  }

  handleForm(document.getElementById('lead'), document.getElementById('lead-message'));
  handleForm(document.getElementById('book-form'), document.getElementById('book-message'));
  handleGuideForm(document.getElementById('guide-form-home'), document.getElementById('guide-home-message'), document.getElementById('guide-home-thankyou'));
});
