// Dry-run brand classification for existing contacts. Pure function — takes
// a plain contact object, returns a proposal only. Never writes anything;
// callers decide separately whether/how to act on a proposal.
//
// Deliberately does NOT default every record to Prosperity. A record is
// only proposed for a brand when there is a recognized, named piece of
// evidence for it; anything without recognized evidence is proposed as
// 'Review Required' rather than guessed.

const TEST_MARKER_PATTERNS = [
  /\btest\b/i, /\bdemo\b/i, /\bsample\b/i, /^asdf/i, /example\.com$/i,
  /^delete/i, /\bdummy\b/i, /^xxx/i, /^n\/?a$/i,
];

// Reserved-for-fiction phone exchange (555-01xx) per NANP — never a real
// subscriber number, so any contact using one is a test record.
const TEST_PHONE_PATTERN = /555.?01\d{2}/;

// lead_type/lead_source values that, before Insurance Lady was connected to
// this CRM, could only have been produced by a Prosperity-only intake
// channel (website forms, guides, calculators, Prosperity's own Twilio
// number). Sourced from main.js / send-guide.js / calcom.js / twilio.js.
const PROSPERITY_LEGACY_CHANNELS = new Set([
  'Guide Lead',
  'Retirement Lead',
  'Life Insurance Lead',
  'Contact Form',
  'Retirement Guide Lead',
  'Roth Conversion Lead',
  'Inbound Call',
  'Inbound SMS',
  '13 Retirement & Rollover Mistakes to Avoid',
  '7 Retirement & Savings Mistakes Guide',
]);

// Signals that would indicate Insurance Lady involvement, once that brand is
// actually connected to this CRM. Listed explicitly (rather than "anything
// not matched above defaults to Prosperity") so the classifier can propose
// Insurance Lady the moment real evidence exists, instead of never being
// able to.
const INSURANCE_LADY_KEYWORDS = [
  'insurance lady', 'insuranceladyllc',
  'cash cancer', 'final expense', 'cash-building',
];

function textFields(contact) {
  return [
    contact.lead_type, contact.lead_source, contact.notes,
    contact.general_notes, contact.first_name, contact.last_name,
    contact.email, contact.phone,
  ].filter(Boolean).map(String);
}

function matchesAny(patterns, value) {
  return patterns.some(p => p.test(value));
}

function classifyContact(contact) {
  const evidence = [];

  // ── Test / Archived ────────────────────────────────────────────────────
  if (contact.lead_status === 'Archived' || contact.lead_status === 'Test') {
    evidence.push(`lead_status = '${contact.lead_status}'`);
    return { contactId: contact.id, proposedBrand: 'Test/Archived', evidence, reason: 'lead_status explicitly marks this record as archived/test' };
  }
  for (const field of ['first_name', 'last_name', 'email']) {
    const value = contact[field];
    if (value && matchesAny(TEST_MARKER_PATTERNS, String(value))) {
      evidence.push(`${field} = '${value}' matches a test-data pattern`);
      return { contactId: contact.id, proposedBrand: 'Test/Archived', evidence, reason: `${field} contains a recognized test/placeholder marker` };
    }
  }
  for (const field of ['phone', 'phone_e164']) {
    const value = contact[field];
    if (value && TEST_PHONE_PATTERN.test(String(value))) {
      evidence.push(`${field} = '${value}' is a reserved fictional (555-01xx) number`);
      return { contactId: contact.id, proposedBrand: 'Test/Archived', evidence, reason: 'phone number is in the NANP 555-01xx fictional/testing range' };
    }
  }

  // ── Insurance Lady evidence ─────────────────────────────────────────────
  const haystack = textFields(contact).join(' | ').toLowerCase();
  const ilHit = INSURANCE_LADY_KEYWORDS.find(kw => haystack.includes(kw));
  if (ilHit) {
    evidence.push(`text field contains Insurance Lady signal keyword '${ilHit}'`);
    return { contactId: contact.id, proposedBrand: 'Insurance Lady', evidence, reason: `matched a recognized Insurance Lady signal: '${ilHit}'` };
  }

  // ── Prosperity evidence — known legacy-only intake channel ─────────────
  if (contact.lead_type && PROSPERITY_LEGACY_CHANNELS.has(contact.lead_type)) {
    evidence.push(`lead_type = '${contact.lead_type}' is a Prosperity-only intake channel`);
    return { contactId: contact.id, proposedBrand: 'Prosperity', evidence, reason: `lead_type '${contact.lead_type}' could only have been created through a Prosperity-only channel before Insurance Lady was connected to this CRM` };
  }
  if (contact.lead_source && PROSPERITY_LEGACY_CHANNELS.has(contact.lead_source)) {
    evidence.push(`lead_source = '${contact.lead_source}' is a Prosperity-only intake channel`);
    return { contactId: contact.id, proposedBrand: 'Prosperity', evidence, reason: `lead_source '${contact.lead_source}' could only have been created through a Prosperity-only channel before Insurance Lady was connected to this CRM` };
  }

  // ── No recognized evidence — do not guess ───────────────────────────────
  return {
    contactId: contact.id,
    proposedBrand: 'Review Required',
    evidence: [],
    reason: 'no recognized lead_type/lead_source/brand signal found — insufficient evidence to assign a brand automatically',
  };
}

module.exports = {
  classifyContact,
  PROSPERITY_LEGACY_CHANNELS,
  INSURANCE_LADY_KEYWORDS,
};
