/**
 * POST /api/leads
 *
 * Accepts form submissions from the website. Creates or updates a contact,
 * logs the form submission as a communication, and stores form answers as a note.
 *
 * Supported lead_type values:
 *   "guide"           → Guide Lead (free guide form)
 *   "retirement"      → Retirement Lead
 *   "life_insurance"  → Life Insurance Lead
 *   "contact"         → General contact form
 */

const express = require('express');
const router = express.Router();
const db = require('../db/database');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return { display: null, e164: null };
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 10 ? digits
    : (digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : null);
  const e164    = ten ? `+1${ten}` : null;
  const display = ten ? `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}` : raw.trim();
  return { display, e164 };
}

function formatLeadTypeLabel(raw) {
  const map = {
    guide:               'Retirement Guide Lead',
    retirement_guide:    'Retirement Guide Lead',
    retirement_rollover: 'Retirement Guide Lead',
    retirement_savings:  'Retirement Guide Lead',
    retirement:          'Retirement Lead',
    life_insurance:      'Life Insurance Lead',
    life:                'Life Insurance Lead',
    contact:             'Contact Form Lead',
    contact_form:        'Contact Form Lead',
    roth:                'Roth Conversion Lead',
    roth_conversion:     'Roth Conversion Lead',
    annuity:             'Annuity Lead',
    existing_client:     'Existing Client',
    referral_partner:    'Referral Partner',
  };
  return map[(raw || '').toLowerCase().replace(/ /g, '_')] || raw || 'Website Lead';
}

function buildFormNote(body) {
  const skip = new Set(['first_name', 'last_name', 'email', 'phone', 'lead_type', 'lead_source', 'honeypot', 'sms_consent', 'sms', 'email_consent', 'terms_accepted']);
  const lines = Object.entries(body)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k.replace(/_/g, ' ')}: ${val}`;
    });
  return lines.length ? lines.join('\n') : null;
}

// ─── POST /api/leads ──────────────────────────────────────────────────────────

router.post('/', (req, res) => {
  try {
    const {
      first_name,
      last_name,
      email,
      phone,
      lead_type,
      lead_source,
      honeypot,         // spam trap — reject if filled
      sms_consent: smsCF,
      sms: smsSF,
      email_consent: emailConsentCF,
      terms_accepted,   // consumed but not stored as a note
      ...rest
    } = req.body;

    const isTruthyConsent = (v) => v === true || v === 1 || v === 'true' || v === 'yes' || v === 'on' || v === '1';
    const smsConsentVal   = (isTruthyConsent(smsCF) || isTruthyConsent(smsSF)) ? 1 : 0;
    const emailConsentVal = isTruthyConsent(emailConsentCF) ? 1 : 0;

    // Basic spam check
    if (honeypot) {
      return res.status(200).json({ ok: true }); // silent discard
    }

    if (!email && !phone) {
      return res.status(400).json({ error: 'email or phone required' });
    }

    const { display: phoneDisplay, e164: phoneE164 } = normalizePhone(phone);
    const leadLabel = formatLeadTypeLabel(lead_type);
    const now = new Date().toISOString();

    // ── Upsert contact ────────────────────────────────────────────────────────
    // Dedupe by email first, then by phone (any existing contact — not just
    // Unknown Caller placeholders) so repeat form submissions never create
    // duplicate contacts.
    let contact = email ? db.prepare('SELECT * FROM contacts WHERE email = ?').get(email) : null;

    if (!contact && phoneE164) {
      contact = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get(phoneE164) || null;
    }
    if (!contact && phoneDisplay) {
      contact = db.prepare(
        'SELECT * FROM contacts WHERE phone = ? OR alt_phone = ?'
      ).get(phoneDisplay, phoneDisplay) || null;
    }

    if (!contact) {
      const insert = db.prepare(`
        INSERT INTO contacts (first_name, last_name, email, phone, phone_e164, lead_type, lead_status, lead_source, sms_consent, email_consent, updated_at)
        VALUES (@first_name, @last_name, @email, @phone, @phone_e164, @lead_type, @lead_status, @lead_source, @sms_consent, @email_consent, @now)
      `);
      const result = insert.run({
        first_name:    first_name || null,
        last_name:     last_name  || null,
        email:         email      || null,
        phone:         phoneDisplay,
        phone_e164:    phoneE164,
        lead_type:     leadLabel,
        lead_status:   'New Lead',
        lead_source:   lead_source || null,
        sms_consent:   smsConsentVal,
        email_consent: emailConsentVal,
        now,
      });
      contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
    } else if (contact.lead_type === 'Unknown Caller') {
      // Upgrade Unknown Caller → real contact: replace placeholder name, set email, update lead type
      db.prepare(`
        UPDATE contacts SET
          first_name    = COALESCE(@first_name, first_name),
          last_name     = COALESCE(@last_name,  last_name),
          email         = COALESCE(@email,      email),
          phone         = COALESCE(phone,       @phone),
          phone_e164    = COALESCE(phone_e164,  @phone_e164),
          lead_type     = @lead_type,
          lead_source   = COALESCE(lead_source, @lead_source),
          sms_consent   = MAX(sms_consent,      @sms_consent),
          email_consent = MAX(email_consent,    @email_consent),
          updated_at    = @now
        WHERE id = @id
      `).run({
        first_name:    first_name || null,
        last_name:     last_name  || null,
        email:         email      || null,
        phone:         phoneDisplay,
        phone_e164:    phoneE164,
        lead_type:     leadLabel,
        lead_source:   lead_source || null,
        sms_consent:   smsConsentVal,
        email_consent: emailConsentVal,
        now,
        id: contact.id,
      });
      contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
    } else {
      // Update missing fields only — never overwrite existing data
      // sms_consent is OR'd so it can only go from 0→1, never cleared by re-submission
      db.prepare(`
        UPDATE contacts SET
          first_name    = COALESCE(first_name,  @first_name),
          last_name     = COALESCE(last_name,   @last_name),
          phone         = COALESCE(phone,       @phone),
          phone_e164    = COALESCE(phone_e164,  @phone_e164),
          lead_type     = COALESCE(lead_type,   @lead_type),
          lead_source   = COALESCE(lead_source, @lead_source),
          sms_consent   = MAX(sms_consent,      @sms_consent),
          email_consent = MAX(email_consent,    @email_consent),
          updated_at    = @now
        WHERE id = @id
      `).run({
        first_name:    first_name || null,
        last_name:     last_name  || null,
        phone:         phoneDisplay,
        phone_e164:    phoneE164,
        lead_type:     leadLabel,
        lead_source:   lead_source || null,
        sms_consent:   smsConsentVal,
        email_consent: emailConsentVal,
        now,
        id: contact.id,
      });
      contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
    }

    // ── Log communication (form submission) ───────────────────────────────────
    const formBody = { first_name, last_name, email, phone, lead_type, lead_source, ...rest };
    const commSubject = `${leadLabel} — ${lead_source || 'website'}`;
    const commBody = JSON.stringify(formBody, null, 2);

    db.prepare(`
      INSERT INTO communications (contact_id, comm_type, direction, subject, body, status)
      VALUES (@contact_id, 'form', 'inbound', @subject, @body, 'received')
    `).run({ contact_id: contact.id, subject: commSubject, body: commBody });

    // ── Add note for extra form fields ────────────────────────────────────────
    const noteText = buildFormNote(rest);
    if (noteText) {
      db.prepare(`
        INSERT INTO contact_notes (contact_id, body)
        VALUES (@contact_id, @body)
      `).run({ contact_id: contact.id, body: `Form answers from ${leadLabel}:\n${noteText}` });
    }

    return res.status(201).json({ ok: true, contact_id: contact.id });

  } catch (err) {
    console.error('Lead capture error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
