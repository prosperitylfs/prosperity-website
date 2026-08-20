// Centralized, server-side brand identity configuration.
//
// Contains ONLY public identity information: legal/display names, phone
// numbers, website URLs, sender addresses, and provider labels. It NEVER
// contains a credential value — the `credentialEnvVars` lists below are
// environment-variable NAMES only, used exclusively to check at runtime
// whether a credential is present (via isChannelConfigured()), never to
// read or expose the value itself.
//
// Neither email provider nor phone number is connected by this checkpoint.
// This module only describes identities; it performs no network calls, no
// Twilio/Microsoft/Gmail API access, and is not wired into any live route.
//
// Brand ids ('insurance-lady', 'prosperity') match the `brands.slug` values
// seeded by crm/db/migrateBrands.js, so this config can be joined against
// the Checkpoint B schema by slug.

// Both brand phone numbers live in the SAME Twilio account, so
// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are intentionally shared between
// both brands below — this is not an accidental overlap. Only the sending
// (FROM) number is brand-specific, via its own distinct env var name per
// brand. Sender resolution must check the brand-specific FROM-number
// variable and must never substitute the other brand's number if its own
// is missing — see crm/lib/senderResolution.js / isChannelConfigured().
const SHARED_TWILIO_CREDENTIAL_VARS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'];

const BRANDS = {
  'insurance-lady': {
    id: 'insurance-lady',
    legalName: 'Insurance Lady LLC',
    shortName: 'Insurance Lady',
    phone: { display: '+1 855-930-5239', e164: '+18559305239' },
    website: 'https://insuranceladyllc.com',
    email: { sender: 'loretta@insuranceladyllc.com', provider: 'microsoft' },
    aiReceptionist: 'Jennifer',
    // Env var NAMES only — proposed, not yet created in any environment.
    // Real values must never be read/exposed by this module.
    //
    // Microsoft Graph app-only (client-credentials) auth needs only
    // tenant/client id/secret plus the sending address/display name.
    // MICROSOFT_REFRESH_TOKEN / MICROSOFT_REDIRECT_URI are deliberately
    // NOT listed here — they only apply if a delegated-permission fallback
    // is added later, and must be added to this list at that time, not before.
    credentialEnvVars: {
      email: ['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_FROM', 'MICROSOFT_FROM_NAME'],
      sms:   [...SHARED_TWILIO_CREDENTIAL_VARS, 'TWILIO_FROM_NUMBER_INSURANCE_LADY'],
    },
  },
  prosperity: {
    id: 'prosperity',
    legalName: 'Prosperity Life & Financial Solutions LLC',
    shortName: 'Prosperity',
    phone: { display: '+1 414-441-1177', e164: '+14144411177' },
    website: 'https://www.prosperitylfs.com', // reused verbatim from crm/server.js CORS allow-list / functions/send-guide.js
    email: { sender: 'loretta@prosperitylfs.com', provider: 'gmail' },
    aiReceptionist: 'Renee',
    // Env var NAMES only — GMAIL_* already exist and are in active use
    // elsewhere in this repo (crm/server.js, crm/routes/email.js,
    // crm/routes/calls.js). Reused here by name, not by value.
    // TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are the same shared credential
    // used by Insurance Lady above; TWILIO_FROM_NUMBER_PROSPERITY is this
    // brand's own distinct sending number (a new, brand-aware name — not a
    // rename of the plain TWILIO_FROM_NUMBER already used by the existing,
    // still-untouched single-number live routes in crm/routes/twilio.js).
    credentialEnvVars: {
      email: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'],
      sms:   [...SHARED_TWILIO_CREDENTIAL_VARS, 'TWILIO_FROM_NUMBER_PROSPERITY'],
    },
  },
};

function isKnownBrandId(brandId) {
  return Object.prototype.hasOwnProperty.call(BRANDS, brandId);
}

function getBrandConfig(brandId) {
  return BRANDS[brandId] || null;
}

// Public-safe view — strips the credentialEnvVars list (not secret, but not
// part of the identity either) for anything that renders brand identity.
function publicBrandIdentity(brandId) {
  const brand = BRANDS[brandId];
  if (!brand) return null;
  return {
    id: brand.id,
    legalName: brand.legalName,
    shortName: brand.shortName,
    phone: { ...brand.phone },
    website: brand.website,
    emailSender: brand.email.sender,
    emailProvider: brand.email.provider,
    aiReceptionist: brand.aiReceptionist,
  };
}

// Checks credential AVAILABILITY only, via environment-variable NAMES.
// Returns which named vars are present/missing — never their values.
function isChannelConfigured(brandId, channel) {
  const brand = BRANDS[brandId];
  if (!brand) return { ok: false, missing: [], reason: `unknown brand '${brandId}'` };
  const varNames = brand.credentialEnvVars[channel];
  if (!varNames) return { ok: false, missing: [], reason: `unknown channel '${channel}' for brand '${brandId}'` };

  const missing = varNames.filter(name => !process.env[name]);
  return { ok: missing.length === 0, missing };
}

module.exports = {
  BRANDS,
  isKnownBrandId,
  getBrandConfig,
  publicBrandIdentity,
  isChannelConfigured,
};
