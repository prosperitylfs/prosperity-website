// Shared "Add Contact" modal — included on index.html only (the contact list
// page). Mirrors the structure of email-modal.js: HTML is injected once,
// shown/hidden via the .hidden class on the overlay.

(function () {
  const MODAL_ID = 'add-contact-modal';

  function ensureModal() {
    if (document.getElementById(MODAL_ID)) return;

    const el = document.createElement('div');
    el.innerHTML = `
      <div id="${MODAL_ID}" class="email-modal-overlay hidden" role="dialog" aria-modal="true" aria-label="Add contact">
        <div class="email-modal-box ac-modal-box" onclick="event.stopPropagation()">

          <div class="email-modal-header">
            <span class="email-modal-title">Add Contact</span>
            <button class="email-modal-close" onclick="closeAddContactModal()" aria-label="Close">&#x2715;</button>
          </div>

          <div class="email-modal-body ac-modal-body">

            <div class="ac-section-title">Company (required — cannot be changed casually after saving)</div>
            <div class="crm-grid">
              <div class="crm-field crm-field-full">
                <label class="crm-label" for="ac-brand_slug">Company</label>
                <select id="ac-brand_slug" class="crm-select">
                  <option value="">— Select —</option>
                  <option value="prosperity">Prosperity Life &amp; Financial Solutions</option>
                  <option value="insurance-lady">Insurance Lady LLC</option>
                </select>
              </div>
            </div>

            <div class="ac-section-title">Basic Information</div>
            <div class="crm-grid">
              <div class="crm-field">
                <label class="crm-label" for="ac-first_name">First Name</label>
                <input id="ac-first_name" type="text" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-last_name">Last Name</label>
                <input id="ac-last_name" type="text" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-email">Email</label>
                <input id="ac-email" type="email" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-phone">Mobile Phone</label>
                <input id="ac-phone" type="tel" class="crm-input" placeholder="(414) 555-0100">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-home_phone">Home Phone</label>
                <input id="ac-home_phone" type="tel" class="crm-input" placeholder="(414) 555-0100">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-preferred_contact_method">Preferred Contact Method</label>
                <select id="ac-preferred_contact_method" class="crm-select">
                  <option value="">— Select —</option>
                  <option>Email</option>
                  <option>Phone Call</option>
                  <option>Text / SMS</option>
                  <option>Mail</option>
                </select>
              </div>
            </div>

            <div class="ac-section-title">Address</div>
            <div class="crm-grid">
              <div class="crm-field crm-field-full">
                <label class="crm-label" for="ac-street_address">Street Address</label>
                <input id="ac-street_address" type="text" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-city">City</label>
                <input id="ac-city" type="text" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-state">State</label>
                <input id="ac-state" type="text" class="crm-input" placeholder="WI">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-zip_code">ZIP Code</label>
                <input id="ac-zip_code" type="text" class="crm-input">
              </div>
            </div>

            <div class="ac-section-title">Personal &amp; Family Information</div>
            <div class="crm-grid">
              <div class="crm-field">
                <label class="crm-label" for="ac-date_of_birth">Date of Birth</label>
                <input id="ac-date_of_birth" type="date" class="crm-input" onchange="recalcAddContactAge()">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-age">Age</label>
                <input id="ac-age" type="number" min="0" class="crm-input" placeholder="Auto-calculated from DOB">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-marital_status">Marital Status</label>
                <select id="ac-marital_status" class="crm-select">
                  <option value="">— Select —</option>
                  <option>Single</option>
                  <option>Married</option>
                  <option>Divorced</option>
                  <option>Widowed</option>
                  <option>Other</option>
                </select>
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-spouse_name">Spouse Name</label>
                <input id="ac-spouse_name" type="text" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-spouse_date_of_birth">Spouse Date of Birth</label>
                <input id="ac-spouse_date_of_birth" type="date" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-number_of_children">Number of Children</label>
                <input id="ac-number_of_children" type="number" min="0" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-number_of_grandchildren">Number of Grandchildren</label>
                <input id="ac-number_of_grandchildren" type="number" min="0" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-occupation">Occupation</label>
                <input id="ac-occupation" type="text" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-employer">Employer</label>
                <input id="ac-employer" type="text" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-retirement_date_goal">Retirement Date Goal</label>
                <input id="ac-retirement_date_goal" type="date" class="crm-input">
              </div>
              <div class="crm-field crm-field-full">
                <label class="crm-label" for="ac-family_notes">Family Notes</label>
                <textarea id="ac-family_notes" class="crm-input" rows="2"></textarea>
              </div>
            </div>

            <div class="ac-section-title">Lead Information</div>
            <div class="crm-grid">
              <div class="crm-field">
                <label class="crm-label" for="ac-lead_type">Lead Type</label>
                <select id="ac-lead_type" class="crm-select">
                  <option value="">— Select —</option>
                  <option>Unknown Caller</option>
                  <option>Retirement Guide Lead</option>
                  <option>Retirement Lead</option>
                  <option>Roth Conversion Lead</option>
                  <option>Life Insurance Lead</option>
                  <option>Contact Form Lead</option>
                  <option>Referral Partner</option>
                </select>
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-lead_source">Lead Source</label>
                <input id="ac-lead_source" type="text" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-referred_by">Referred By</label>
                <input id="ac-referred_by" type="text" class="crm-input">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-best_time_to_contact">Best Time To Contact</label>
                <input id="ac-best_time_to_contact" type="text" class="crm-input" placeholder="e.g. Weekday mornings">
              </div>
              <div class="crm-field">
                <label class="crm-label" for="ac-relationship_type">Relationship</label>
                <select id="ac-relationship_type" class="crm-select">
                  <option value="">— Select —</option>
                  <option value="lead">Lead / Prospect</option>
                  <option value="active_client">Active Client</option>
                  <option value="former_client">Former Client</option>
                  <option value="prior_applicant">Prior Applicant</option>
                  <option value="declined_applicant">Declined Applicant</option>
                </select>
              </div>
            </div>

            <div class="ac-section-title">Marketing Permissions</div>
            <div class="crm-checks">
              <label class="crm-check-label">
                <input id="ac-sms_consent" type="checkbox">
                <span>SMS Consent</span>
              </label>
              <label class="crm-check-label">
                <input id="ac-email_consent" type="checkbox">
                <span>Email Consent</span>
              </label>
            </div>
            <div class="crm-grid">
              <div class="crm-field">
                <label class="crm-label" for="ac-sms_consent_source">Consent Source <span class="hint">(required if SMS Consent is checked)</span></label>
                <select id="ac-sms_consent_source" class="crm-select">
                  <option value="">— Select —</option>
                  <option>Website Form</option>
                  <option>Phone – Renee</option>
                  <option>Phone – Jennifer</option>
                  <option>Existing Client – Prior Documented Consent</option>
                  <option>Inbound SMS</option>
                  <option>Verbal Consent</option>
                  <option>Other</option>
                </select>
              </div>
              <div class="crm-field crm-field-full">
                <label class="crm-label" for="ac-sms_consent_notes">Consent Notes <span class="hint">(optional)</span></label>
                <textarea id="ac-sms_consent_notes" class="crm-input" rows="2"></textarea>
              </div>
            </div>

            <div class="ac-section-title">Notes</div>
            <div class="crm-grid">
              <div class="crm-field crm-field-full">
                <label class="crm-label" for="ac-general_notes">General Notes</label>
                <textarea id="ac-general_notes" class="crm-input" rows="2"></textarea>
              </div>
            </div>

          </div><!-- /email-modal-body -->

          <div class="email-modal-footer">
            <div id="ac-error" class="em-error hidden"></div>
            <div class="em-footer-actions">
              <button id="ac-save-btn" class="btn btn-primary" onclick="saveNewContact()">Save Contact</button>
              <button class="btn em-cancel-btn" onclick="closeAddContactModal()">Cancel</button>
            </div>
          </div>

        </div>
      </div>`;
    document.body.appendChild(el.firstElementChild);

    document.getElementById(MODAL_ID).addEventListener('click', function (e) {
      if (e.target === this) closeAddContactModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeAddContactModal();
    });
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  window.openAddContactModal = function () {
    ensureModal();
    // Clear every field — modal instance is reused across opens
    [
      'brand_slug',
      'first_name', 'last_name', 'email', 'phone', 'home_phone', 'preferred_contact_method',
      'street_address', 'city', 'state', 'zip_code',
      'date_of_birth', 'age', 'marital_status', 'spouse_name', 'spouse_date_of_birth',
      'number_of_children', 'number_of_grandchildren', 'occupation', 'employer',
      'retirement_date_goal', 'family_notes',
      'lead_type', 'lead_source', 'referred_by', 'best_time_to_contact', 'relationship_type', 'general_notes',
      'sms_consent_source', 'sms_consent_notes',
    ].forEach(key => {
      const el = document.getElementById('ac-' + key);
      if (el) el.value = '';
    });
    document.getElementById('ac-sms_consent').checked = false;
    document.getElementById('ac-email_consent').checked = false;
    document.getElementById('ac-error').classList.add('hidden');

    document.getElementById(MODAL_ID).classList.remove('hidden');
    document.getElementById('ac-first_name').focus();
  };

  window.closeAddContactModal = function () {
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.classList.add('hidden');
  };

  // Live age preview while editing — server recomputes from date_of_birth
  // authoritatively on save; this is just instant feedback.
  window.recalcAddContactAge = function () {
    const dobEl = document.getElementById('ac-date_of_birth');
    const ageEl = document.getElementById('ac-age');
    if (!dobEl || !ageEl || !dobEl.value) return;
    const dob = new Date(dobEl.value);
    if (isNaN(dob.getTime())) return;
    const now = new Date();
    let age = now.getFullYear() - dob.getFullYear();
    const monthDiff = now.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < dob.getDate())) age--;
    ageEl.value = age;
  };

  window.saveNewContact = async function () {
    const errEl = document.getElementById('ac-error');
    const btn   = document.getElementById('ac-save-btn');
    errEl.classList.add('hidden');

    const val = key => (document.getElementById('ac-' + key)?.value || '').trim();

    const payload = {
      brand_slug:                val('brand_slug'),
      first_name:               val('first_name'),
      last_name:                val('last_name'),
      email:                    val('email'),
      phone:                    val('phone'),
      home_phone:               val('home_phone'),
      preferred_contact_method: val('preferred_contact_method'),
      street_address:           val('street_address'),
      city:                     val('city'),
      state:                    val('state'),
      zip_code:                 val('zip_code'),
      date_of_birth:            val('date_of_birth'),
      age:                      val('age'),
      marital_status:           val('marital_status'),
      spouse_name:              val('spouse_name'),
      spouse_date_of_birth:     val('spouse_date_of_birth'),
      number_of_children:       val('number_of_children'),
      number_of_grandchildren:  val('number_of_grandchildren'),
      occupation:               val('occupation'),
      employer:                 val('employer'),
      retirement_date_goal:     val('retirement_date_goal'),
      family_notes:             val('family_notes'),
      lead_type:                val('lead_type'),
      lead_source:              val('lead_source'),
      referred_by:              val('referred_by'),
      best_time_to_contact:     val('best_time_to_contact'),
      relationship_type:        val('relationship_type'),
      general_notes:            val('general_notes'),
      sms_consent:   document.getElementById('ac-sms_consent').checked,
      email_consent: document.getElementById('ac-email_consent').checked,
      sms_consent_source: val('sms_consent_source'),
      sms_consent_notes:  val('sms_consent_notes'),
    };

    if (!payload.first_name && !payload.last_name && !payload.email && !payload.phone) {
      errEl.textContent = 'Enter at least a name, email, or phone number.';
      errEl.classList.remove('hidden');
      return;
    }

    if (!payload.brand_slug) {
      errEl.textContent = 'Choose a company before saving.';
      errEl.classList.remove('hidden');
      return;
    }

    if (payload.sms_consent && !payload.sms_consent_source) {
      errEl.textContent = 'Choose how SMS consent was obtained before saving.';
      errEl.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      const created = await CRM.fetch('/api/contacts', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      window.location.href = `/contact.html?id=${created.id}`;
    } catch (err) {
      errEl.textContent = err.message || 'Could not create contact.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Save Contact';
    }
  };
})();
