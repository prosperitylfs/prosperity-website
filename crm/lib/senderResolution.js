// Fail-closed sender-identity resolution.
//
// Takes an explicit better-sqlite3 `db` handle (never opens its own
// connection) plus an explicit context object. Resolves WHICH brand's
// sender identity a new, outbound communication should use — never reads
// a "brand" field off the master contact (no such field exists — see the
// three-level contacts → contact_brands → cases model from Checkpoint B),
// never reads a dashboard "viewing filter", never defaults to the first or
// most-recently-used brand, and never falls back from one brand to the
// other on failure. Any missing, conflicting, or unresolved context blocks
// the send instead of guessing.
//
// This module only resolves an identity for NEW sends. It never rewrites
// the brand recorded on a historical communications row — those already
// have their own contact_brand_id/case_id snapshot from Checkpoint B and
// are read directly, not re-resolved.

const { BRANDS, isChannelConfigured, publicBrandIdentity } = require('../config/brands');

function blocked(reason) {
  return { blocked: true, reason, brandId: null, brand: null };
}

function brandSlugFromContactBrandsRowId(db, contactBrandsId) {
  const row = db.prepare('SELECT brand_id FROM contact_brands WHERE id = ?').get(contactBrandsId);
  if (!row) return null;
  const brandRow = db.prepare('SELECT slug FROM brands WHERE id = ?').get(row.brand_id);
  return brandRow ? brandRow.slug : null;
}

// Gathers every explicit signal present in `context` and resolves each to a
// brand slug independently. Only recognized context keys are read — any
// extraneous field (e.g. a dashboard "viewingFilter") is silently ignored
// because nothing here looks for it.
function resolveSignals(db, context) {
  const signals = [];

  if (context.manualBrandSelection !== undefined && context.manualBrandSelection !== null) {
    if (!BRANDS[context.manualBrandSelection]) {
      return { error: `manualBrandSelection '${context.manualBrandSelection}' is not a known brand` };
    }
    signals.push({ source: 'manualBrandSelection', brandId: context.manualBrandSelection });
  }

  if (context.brandId !== undefined && context.brandId !== null) {
    if (!BRANDS[context.brandId]) {
      return { error: `brandId '${context.brandId}' is not a known brand` };
    }
    signals.push({ source: 'brandId', brandId: context.brandId });
  }

  if (context.contactBrandId !== undefined && context.contactBrandId !== null) {
    const slug = brandSlugFromContactBrandsRowId(db, context.contactBrandId);
    if (!slug) return { error: `contactBrandId ${context.contactBrandId} does not resolve to a known brand relationship` };
    signals.push({ source: 'contactBrandId', brandId: slug });
  }

  // A case's CURRENT relationship — i.e. its cases.contact_brand_id as it
  // stands right now — determines sender identity for a new communication.
  if (context.caseId !== undefined && context.caseId !== null) {
    const row = db.prepare('SELECT contact_brand_id FROM cases WHERE id = ?').get(context.caseId);
    if (!row) return { error: `caseId ${context.caseId} does not exist` };
    const slug = brandSlugFromContactBrandsRowId(db, row.contact_brand_id);
    if (!slug) return { error: `caseId ${context.caseId} does not resolve to a known brand relationship` };
    signals.push({ source: 'caseId (current relationship)', brandId: slug });
  }

  // An appointment's OWN stored brand snapshot (a contact_brands.id value
  // captured at the time that specific appointment was created) — kept
  // separate from caseId so a send tied to one specific appointment can be
  // resolved against what that appointment was booked under, independent
  // of whether the case has since been reassigned.
  if (context.appointmentBrandSnapshot !== undefined && context.appointmentBrandSnapshot !== null) {
    const slug = brandSlugFromContactBrandsRowId(db, context.appointmentBrandSnapshot);
    if (!slug) return { error: `appointmentBrandSnapshot ${context.appointmentBrandSnapshot} does not resolve to a known brand relationship` };
    signals.push({ source: 'appointmentBrandSnapshot', brandId: slug });
  }

  if (context.inboundPhoneNumber !== undefined && context.inboundPhoneNumber !== null) {
    const matches = Object.values(BRANDS).filter(b => b.phone.e164 === context.inboundPhoneNumber);
    if (matches.length !== 1) {
      return { error: `inboundPhoneNumber '${context.inboundPhoneNumber}' does not match exactly one configured brand` };
    }
    signals.push({ source: 'inboundPhoneNumber', brandId: matches[0].id });
  }

  return { signals };
}

// Resolves brand identity only — no credential/channel check. Useful for
// display purposes that don't need to know if sending is actually possible.
function resolveBrandContext(db, context) {
  const { signals, error } = resolveSignals(db, context);
  if (error) return blocked(error);
  if (!signals || signals.length === 0) return blocked('no brand-resolution context was provided');

  const distinctBrandIds = [...new Set(signals.map(s => s.brandId))];
  if (distinctBrandIds.length > 1) {
    return blocked(`conflicting brand signals: ${signals.map(s => `${s.source}=${s.brandId}`).join(', ')}`);
  }

  const brandId = distinctBrandIds[0];
  return {
    blocked: false,
    brandId,
    brand: publicBrandIdentity(brandId),
    resolvedFrom: signals.map(s => s.source),
  };
}

// Full sender resolution: resolves brand context, then requires an explicit
// `channel` ('email' | 'sms') and confirms that brand's credentials for that
// channel are actually configured. Never falls back to the other brand if
// they aren't — blocks instead.
function resolveSenderIdentity(db, context) {
  const brandResult = resolveBrandContext(db, context);
  if (brandResult.blocked) return brandResult;

  const { channel } = context;
  if (!channel) return blocked('channel ("email" or "sms") is required to resolve a sender identity');

  const status = isChannelConfigured(brandResult.brandId, channel);
  if (!status.ok) {
    const brand = BRANDS[brandResult.brandId];
    return blocked(
      `${brand.shortName} ${channel} sender is not configured` +
      (status.missing && status.missing.length ? ` (missing: ${status.missing.join(', ')})` : '') +
      ' — refusing to send; not falling back to another brand.'
    );
  }

  return { ...brandResult, channel };
}

// Resolves the outbound VOICE caller ID for a live call, brand-aware.
// Mirrors the exact safety pattern already proven for SMS
// (crm/lib/providers/liveTwilioAdapter.js): a brand-specific env var
// (TWILIO_FROM_NUMBER_PROSPERITY / TWILIO_FROM_NUMBER_INSURANCE_LADY) is
// required, trimmed to tolerate incidental whitespace from a pasted
// dashboard value, and cross-checked against the number on file in
// config/brands.js. A resolved brand with no configured number for it is
// refused outright — it is never redirected to the other brand's number,
// and never falls back to the legacy single TWILIO_FROM_NUMBER (that
// fallback, for contacts with no brand relationship at all, is the
// caller's responsibility — see crm/routes/calls.js).
function resolveVoiceCallerId(db, context) {
  const brandResult = resolveBrandContext(db, context);
  if (brandResult.blocked) return brandResult;

  const envVarName = brandResult.brandId === 'prosperity'
    ? 'TWILIO_FROM_NUMBER_PROSPERITY' : 'TWILIO_FROM_NUMBER_INSURANCE_LADY';
  const configured = (process.env[envVarName] || '').trim();
  const expected = BRANDS[brandResult.brandId].phone.e164;

  if (!configured) {
    return blocked(`${brandResult.brand.shortName} calling is not configured — missing ${envVarName}.`);
  }
  if (configured !== expected) {
    return blocked(`${envVarName} does not match the configured ${brandResult.brand.shortName} number — refusing to call.`);
  }

  return { blocked: false, brandId: brandResult.brandId, brand: brandResult.brand, fromNumber: configured };
}

module.exports = { resolveBrandContext, resolveSenderIdentity, resolveVoiceCallerId };
