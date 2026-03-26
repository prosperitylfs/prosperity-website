// ── EMAILJS CONFIGURATION ─────────────────────────────────────────────────
// Replace these two values after setting up your EmailJS account.
// See setup instructions in index.html or at https://www.emailjs.com
var EMAILJS_SERVICE_ID  = 'YOUR_SERVICE_ID';   // e.g. 'service_abc123'
var EMAILJS_TEMPLATE_ID = 'YOUR_TEMPLATE_ID';  // e.g. 'template_xyz789'
// ─────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  // ── Consultation / Contact forms ────────────────────────────────────────
  function handleForm(form, messageEl) {
    if (!form) return;
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      // Validate required checkboxes (e.g. SMS consent)
      var unchecked = form.querySelector('input[type="checkbox"][required]:not(:checked)');
      if (unchecked) {
        if (messageEl) {
          messageEl.textContent = 'Please check the SMS consent box before submitting.';
          messageEl.className = 'form-message error';
        }
        unchecked.focus();
        return;
      }

      if (messageEl) { messageEl.textContent = ''; messageEl.className = 'form-message'; }

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

      var email     = form.elements['email']      ? form.elements['email'].value.trim()      : '';
      var firstName = form.elements['first_name'] ? form.elements['first_name'].value.trim() : 'there';
      if (!email) return;

      if (messageEl) messageEl.textContent = 'Sending your guide…';

      // Build the absolute URL to the PDF guide so it works in the email link
      var guideUrl = window.location.origin +
        (window.location.pathname.replace(/\/[^/]*$/, '') === '' ? '' : window.location.pathname.replace(/\/[^/]*$/, '')) +
        '/assets/guides/5%20Mistakes%20to%20Avoid%20When%20Moving%20Retirement%20Accounts.pdf';

      var templateParams = {
        to_name:    firstName,
        to_email:   email,
        guide_link: guideUrl
      };

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
  handleGuideForm(document.getElementById('guide-form'), document.getElementById('guide-message'), document.getElementById('guide-thankyou'));
  handleGuideForm(document.getElementById('guide-form-home'), document.getElementById('guide-home-message'), document.getElementById('guide-home-thankyou'));
});
