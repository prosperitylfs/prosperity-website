// Sender guardrail for the local dashboard's Call/Text/Email action buttons.
// Built on crm/lib/senderResolution.js (Checkpoint C) — reuses its
// fail-closed brand resolution rather than re-implementing it. This module
// NEVER sends anything; it only decides what the UI should show next to a
// disabled action button.
//
// Three distinct situations, each with its own message (do not conflate
// them — this was a real accuracy bug in the first Checkpoint D draft):
//   A. No case/relationship selected at all → brand itself is unresolved.
//      A person-level action may let the user EXPLICITLY pick a brand for
//      that one communication (see getSenderGuardrailForManualSelection) —
//      picking a sender here only sets who this one communication is from.
//      It never moves, reassigns, or transfers a case, and never changes
//      the contact's brand relationships.
//   B. A relationship IS resolved and the requested channel is configured
//      → show the exact brand + sender identity that would be used.
//   C. A relationship IS resolved but THIS channel's credentials are not
//      configured → the BRAND is known; only that one channel is blocked.
//      Never implies the brand is unresolved, never falls back to the
//      other brand, and never shows env-var names in the main message
//      (those go in a separate technicalDetails field for an optional
//      admin-only disclosure).
//
// Call and Text both send through the same Twilio account + brand-specific
// FROM number (see crm/config/brands.js), so both are evaluated against
// that brand's 'sms' credential set. Email is evaluated independently
// against that brand's 'email' credential set — a missing channel never
// affects the others.

const { resolveBrandContext } = require('./senderResolution');
const { BRANDS, isChannelConfigured } = require('../config/brands');

const CHANNEL_CREDENTIAL_KEY = { call: 'sms', text: 'sms', sms: 'sms', email: 'email' };
const CHANNEL_LABEL = { call: 'Call', text: 'Text', sms: 'Text', email: 'Email' };
// Only the verb differs by channel — "placed" for a phone call, "sent" for
// a text or email — the rest of the sentence structure stays identical.
const CHANNEL_VERB = { call: 'placed', text: 'sent', sms: 'sent', email: 'sent' };

function otherBrandShortName(brandId) {
  const otherId = brandId === 'insurance-lady' ? 'prosperity' : 'insurance-lady';
  return BRANDS[otherId].shortName;
}

function evaluateSingleChannel(brandId, brand, channel) {
  const credentialKey = CHANNEL_CREDENTIAL_KEY[channel];
  const label = CHANNEL_LABEL[channel];
  const verb = CHANNEL_VERB[channel];
  const status = isChannelConfigured(brandId, credentialKey);

  if (status.ok) {
    const identity = channel === 'email' ? brand.emailSender : brand.phone.display;
    return {
      blocked: false,
      message: `This ${label.toLowerCase()} will be ${verb} from ${identity} as ${brand.shortName}.`,
      brandId, brand, channel, identity,
      canSend: false,
    };
  }

  return {
    blocked: true,
    message: `${brand.shortName} is selected, but its ${label.toLowerCase() === 'email' ? 'email sender' : 'phone number'} is not configured. ${label} cannot be sent.`,
    fallbackNotice: `The system will not fall back to ${otherBrandShortName(brandId)}.`,
    technicalDetails: `Missing environment variable(s): ${status.missing.join(', ')}`,
    brandId, brand, channel,
    canSend: false,
  };
}

function evaluateAllChannels(brandId, brand) {
  return {
    call: evaluateSingleChannel(brandId, brand, 'call'),
    text: evaluateSingleChannel(brandId, brand, 'text'),
    email: evaluateSingleChannel(brandId, brand, 'email'),
  };
}

function brandChoiceList() {
  return Object.values(BRANDS).map(b => ({ id: b.id, shortName: b.shortName }));
}

// Case-level entry point — resolves the brand for a specific case ONCE,
// then evaluates Call, Text, and Email independently against that brand's
// own credentials.
// Returns:
//   { scenario: 'no_relationship', blocked: true, message, brandChoices }
//   { scenario: 'resolved', blocked: false, brandId, brand, channels: { call, text, email } }
function getSenderGuardrailForCase(db, { caseId }) {
  const brandChoices = brandChoiceList();

  if (!caseId) {
    return {
      scenario: 'no_relationship',
      blocked: true,
      message: `Choose which business this message is from: ${brandChoices.map(b => b.shortName).join(' or ')}.`,
      brandId: null,
      brand: null,
      brandChoices,
      channels: null,
    };
  }

  const brandResult = resolveBrandContext(db, { caseId });
  if (brandResult.blocked) {
    // caseId was given but didn't resolve (e.g. bad id, or upstream data
    // problem) — still a "no relationship" situation from the UI's
    // perspective, since no valid brand was found.
    return {
      scenario: 'no_relationship',
      blocked: true,
      message: `Choose which business this message is from: ${brandChoices.map(b => b.shortName).join(' or ')}.`,
      reason: brandResult.reason,
      brandId: null,
      brand: null,
      brandChoices,
      channels: null,
    };
  }

  return {
    scenario: 'resolved',
    blocked: false, // the BRAND is resolved; per-channel availability is independent, see .channels
    brandId: brandResult.brandId,
    brand: brandResult.brand,
    channels: evaluateAllChannels(brandResult.brandId, brandResult.brand),
  };
}

// Person-level entry point — for a Call/Text/Email action that isn't tied
// to one specific case (e.g. a general outreach to a person). The brand is
// never inferred or defaulted; a human must EXPLICITLY pick one via
// manualBrandSelection (the same signal crm/lib/senderResolution.js already
// recognizes from Checkpoint C). Picking a brand here only determines the
// sender identity for this one communication — it never creates, moves, or
// reassigns a case, and never changes any contact_brands relationship.
function getSenderGuardrailForManualSelection(db, { manualBrandSelection } = {}) {
  const brandChoices = brandChoiceList();

  if (!manualBrandSelection) {
    return {
      scenario: 'no_relationship',
      blocked: true,
      message: 'Choose the business this communication is from. This selection controls the sender for this communication only. It does not move or reassign any case.',
      brandId: null,
      brand: null,
      brandChoices,
      channels: null,
    };
  }

  const brandResult = resolveBrandContext(db, { manualBrandSelection });
  if (brandResult.blocked) {
    return {
      scenario: 'no_relationship',
      blocked: true,
      message: 'Choose the business this communication is from. This selection controls the sender for this communication only. It does not move or reassign any case.',
      reason: brandResult.reason,
      brandId: null,
      brand: null,
      brandChoices,
      channels: null,
    };
  }

  return {
    scenario: 'resolved',
    blocked: false,
    brandId: brandResult.brandId,
    brand: brandResult.brand,
    channels: evaluateAllChannels(brandResult.brandId, brandResult.brand),
  };
}

module.exports = { getSenderGuardrailForCase, getSenderGuardrailForManualSelection };
