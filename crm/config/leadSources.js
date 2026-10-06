// Server-side mapping of VERIFIED request sources to brands, for lead
// intake only (crm/lib/leadSubmission.js). This is never a credential
// store — entries are looked up only AFTER a request has already been
// authenticated by matching the PRIVATE x-internal-key header (never the
// public x-api-key — a value shipped in browser code cannot authenticate
// which site a request came from). Brand is never taken from a
// client-supplied field; it is always looked up here, keyed only by which
// private credential authenticated the request.
//
// Phase 1 (Checkpoint E1) wired only the existing Prosperity website forms,
// all of which submit through the same-origin /submit-lead Cloudflare Pages
// Function (functions/submit-lead.js), which alone held CRM_INTERNAL_KEY —
// there was no per-brand credential yet.
//
// 'insurance-lady-website' (added 2026-09-30, for the retirement-booking.html
// 3-step qualification flow) is the first per-brand credential: its own
// distinct private key, CRM_INTERNAL_KEY_INSURANCE_LADY (see
// crm/lib/leadSubmission.js), so it can never reuse or silently fall back
// to the 'prosperity-website' entry.

const LEAD_SOURCES = {
  'prosperity-website': { brandSlug: 'prosperity' },
  'insurance-lady-website': { brandSlug: 'insurance-lady' },
};

function resolveBrandSlugForSource(sourceId) {
  const source = LEAD_SOURCES[sourceId];
  return source ? source.brandSlug : null;
}

module.exports = { LEAD_SOURCES, resolveBrandSlugForSource };
