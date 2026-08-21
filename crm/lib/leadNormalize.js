// Pure, shared normalization helpers for inbound lead-intake fields. No
// database access, no environment reads, no network calls — reused by
// crm/lib/leadIntake.js (and previously duplicated inline in
// crm/routes/leads.js) so the legacy flat-contact fields and the new
// brand-aware intake pipeline apply IDENTICAL normalization.

function normalizePhone(raw) {
  if (!raw) return { display: null, e164: null };
  const digits = String(raw).replace(/\D/g, '');
  const ten = digits.length === 10 ? digits
    : (digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : null);
  const e164    = ten ? `+1${ten}` : null;
  const display = ten ? `(${ten.slice(0,3)}) ${ten.slice(3,6)}-${ten.slice(6)}` : String(raw).trim();
  return { display, e164 };
}

// Trim + lowercase only — never rejects a malformed address (that's the
// frontend's job; "email or phone required" is the only server-side
// presence check). Normalizing here, before dedupe/lookup, means the SAME
// normalized value is what's stored, searched, and compared everywhere —
// "Test@Foo.com" and "test@foo.com" now resolve to one contact instead of
// silently creating two.
function normalizeEmail(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed.toLowerCase() : null;
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
  const isString = typeof raw === 'string';
  const key = isString ? raw.toLowerCase().replace(/ /g, '_') : '';
  return map[key] || (isString && raw ? raw : 'Website Lead');
}

function isTruthyConsent(v) {
  return v === true || v === 1 || v === 'true' || v === 'yes' || v === 'on' || v === '1';
}

// Coerces any submitted field to a plain string-or-null before it is ever
// compared, logged, or bound into a SQL statement — a non-string (object,
// array) submitted for a normally-textual field becomes null rather than
// being bound as-is (which better-sqlite3 would reject) or compared as a
// truthy value it isn't.
function toStringOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function buildFormNote(body) {
  const skip = new Set([
    'first_name', 'last_name', 'email', 'phone', 'lead_type', 'lead_source',
    'honeypot', 'sms_consent', 'sms', 'email_consent', 'terms_accepted',
    'turnstile_token', 'brand', 'brandId', 'external_ref', 'ref_type',
  ]);
  const lines = Object.entries(body || {})
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && String(v).trim() !== '')
    .map(([k, v]) => {
      const val = typeof v === 'object' ? JSON.stringify(v) : String(v);
      return `${k.replace(/_/g, ' ')}: ${val}`;
    });
  return lines.length ? lines.join('\n') : null;
}

module.exports = {
  normalizePhone,
  normalizeEmail,
  formatLeadTypeLabel,
  isTruthyConsent,
  toStringOrNull,
  buildFormNote,
};
