// Brand-aware lead intake pipeline (Checkpoint E1 / Phase 1).
//
// Replaces the flat, brand-blind contact write that crm/routes/leads.js
// used to perform directly against the legacy `contacts` table only. Every
// inbound lead now:
//   1. Preserves the raw intake (see recordIntakeCommunication /
//      unresolved_intake.raw_payload) and, when the caller supplies one, a
//      reliable external reference (see external_ref/ref_type below).
//   2. Normalizes email and phone (crm/lib/leadNormalize.js).
//   3. Matches or creates ONE master contact via the approved
//      dedupeContact() helper.
//   4. Resolves a brand ONLY from a verified caller/source mapping
//      (crm/config/leadSources.js) — never from a client-supplied field,
//      never inferred from product/service.
//   5. Creates/confirms the contact_brand relationship via the approved
//      resolveContactBrand() helper.
//   6. Matches an existing case, creates a genuinely new one, or stages
//      Case Review Required, via the approved matchOrCreateCase() helper.
//   7. Records an audit-trail communication + note, stamped with the
//      resolved contact_brand_id/case_id where known.
//   8. Prevents duplicate contacts (dedupeContact) and duplicate cases
//      (matchOrCreateCase's external-ref idempotency + open-case reuse).
//   9. Never touches sender identity, message templates, or any
//      communication channel — this module only writes to
//      contacts/contact_brands/cases/case_external_refs/unresolved_intake/
//      communications/contact_notes.
//
// Pure: takes an explicit better-sqlite3 `db` handle, exactly like every
// other crm/lib module (caseMatching.js, classification.js, etc.). Never
// imports crm/db/database.js, never reads an environment variable, never
// reads a credential, never selects a sender, never triggers a call/text/
// email.

const {
  dedupeContact,
  resolveContactBrand,
  matchOrCreateCase,
  stageUnresolvedIntake,
} = require('./caseMatching');
const { resolveBrandSlugForSource } = require('../config/leadSources');
const {
  normalizePhone,
  normalizeEmail,
  formatLeadTypeLabel,
  isTruthyConsent,
  toStringOrNull,
  buildFormNote,
} = require('./leadNormalize');

// lead_type label -> product name, per brand. Only exact, unambiguous 1:1
// correspondences are listed. Brand is ALREADY resolved by the time this is
// consulted — this table only decides which PRODUCT row a case is filed
// under, and can never change, override, or influence a resolved brand.
// Anything not listed here is intentionally left unmapped so the case lands
// in Case Review Required instead of being guessed (e.g. "Retirement Guide
// Lead" / "Contact Form Lead" have no clean 1:1 product match today).
const PROSPERITY_LEAD_TYPE_TO_PRODUCT = {
  'Life Insurance Lead': 'Life insurance',
  'Annuity Lead':        'Annuities',
  'Retirement Lead':     'Rollovers and safe-money solutions',
};

// No Phase 1 verified source resolves to insurance-lady yet (see
// crm/config/leadSources.js) — kept empty rather than omitted so the shape
// is ready for Phase 2 without requiring a change here.
const LEAD_TYPE_TO_PRODUCT_BY_BRAND_SLUG = {
  prosperity: PROSPERITY_LEAD_TYPE_TO_PRODUCT,
  'insurance-lady': {},
};

function getBrandRow(db, slug) {
  return db.prepare('SELECT * FROM brands WHERE slug = ?').get(slug);
}

function getProductRow(db, brandRowId, productName) {
  if (!productName) return null;
  return db.prepare('SELECT * FROM products WHERE brand_id = ? AND name = ?').get(brandRowId, productName);
}

// Preserves the exact legacy `contacts`-table enrichment behavior (Unknown
// Caller upgrade + COALESCE-based "never overwrite existing data" update)
// that crm/routes/leads.js implemented directly before this checkpoint —
// moved here unchanged so dedupeContact() can own contact IDENTITY
// resolution while this keeps owning the legacy FIELD enrichment that other
// CRM screens already depend on (lead_type/lead_status/lead_source/consent).
function enrichLegacyContactFields(db, contact, fields) {
  const { firstName, lastName, email, phoneDisplay, phoneE164, leadLabel, leadSource, smsConsentVal, emailConsentVal } = fields;
  const now = new Date().toISOString();
  const params = {
    first_name: firstName || null, last_name: lastName || null, email: email || null,
    phone: phoneDisplay, phone_e164: phoneE164, lead_type: leadLabel,
    lead_source: leadSource || null, sms_consent: smsConsentVal, email_consent: emailConsentVal,
    now, id: contact.id,
  };

  if (contact.lead_type === 'Unknown Caller') {
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
    `).run(params);
  } else {
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
    `).run(params);
  }

  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id);
}

// Audit trail — same "one communication row per submission" behavior the
// legacy route always performed, now also stamped with contact_brand_id/
// case_id (nullable columns added by crm/db/migrateBrands.js) when those
// are known, so the CRM contact timeline stays queryable by case. Health/
// qualifier-style answers (tobacco, health_concerns, coverage details) are
// preserved in the note body exactly as before — that's the legitimate
// business purpose of collecting them — but never placed in the subject
// line and never written to console/log output.
function recordIntakeCommunication(db, { contact, contactBrandId, caseId, leadLabel, leadSource, extraFields }) {
  const subject = `${leadLabel} — ${leadSource || 'website'}`;
  const body = JSON.stringify(extraFields, null, 2);

  db.prepare(`
    INSERT INTO communications (contact_id, comm_type, direction, subject, body, status, contact_brand_id, case_id)
    VALUES (@contact_id, 'form', 'inbound', @subject, @body, 'received', @contact_brand_id, @case_id)
  `).run({ contact_id: contact.id, subject, body, contact_brand_id: contactBrandId || null, case_id: caseId || null });

  const noteText = buildFormNote(extraFields);
  if (noteText) {
    db.prepare(`
      INSERT INTO contact_notes (contact_id, body, contact_brand_id, case_id)
      VALUES (@contact_id, @body, @contact_brand_id, @case_id)
    `).run({
      contact_id: contact.id,
      body: `Form answers from ${leadLabel}:\n${noteText}`,
      contact_brand_id: contactBrandId || null,
      case_id: caseId || null,
    });
  }
}

// Fields already handled explicitly above are excluded from the freeform
// note/communication body so they aren't duplicated.
function restFields(payload) {
  const {
    first_name, last_name, email, phone, lead_type, lead_source,
    honeypot, sms_consent, sms, email_consent, terms_accepted, turnstile_token,
    brand, brandId, external_ref, ref_type,
    ...rest
  } = payload || {};
  return rest;
}

// Central entry point, called by crm/lib/leadSubmission.js after its
// honeypot/Turnstile gates already passed.
//
// sourceId: the caller/source identifier the CALLER (leadSubmission.js)
//   determined from which credential authenticated the request — never
//   taken from the request body itself. null means the source could not be
//   verified.
// payload: the already-JSON-parsed request body, exactly as received.
//   Optional payload.external_ref/ref_type provide a reliable external
//   reference when the caller has one (no current Phase 1 caller does —
//   this exists so a genuinely idempotent identifier, e.g. a future Back9
//   application id, can be wired through without further changes here).
//
// Returns one of:
//   { outcome: 'matched' | 'created', contact, contactBrand, case }
//   { outcome: 'brand_review_required', contact, unresolvedIntake }
//   { outcome: 'case_review_required',  contact, contactBrand, unresolvedIntake }
//   { outcome: 'company_conflict',      contact, unresolvedIntake }
//
// deps.resolveBrandSlugForSource lets tests substitute a source/brand
// mapping without mutating crm/config/leadSources.js's shared exports —
// same pattern as crm/lib/leadSubmission.js's deps.verifyTurnstile.
// Production always uses the real crm/config/leadSources.js mapping.
function processLeadIntake(db, { sourceId, payload }, deps = {}) {
  const resolveBrandSlugForSourceFn = deps.resolveBrandSlugForSource || resolveBrandSlugForSource;
  const {
    first_name, last_name, email: rawEmail, phone,
    lead_type, lead_source,
    sms_consent: smsCF, sms: smsSF, email_consent: emailConsentCF,
    brand: claimedBrandA, brandId: claimedBrandB,
    external_ref, ref_type,
  } = payload || {};

  const firstName  = toStringOrNull(first_name);
  const lastName   = toStringOrNull(last_name);
  const leadSource = toStringOrNull(lead_source);
  const email = normalizeEmail(rawEmail);
  const { display: phoneDisplay, e164: phoneE164 } = normalizePhone(phone);
  const leadLabel = formatLeadTypeLabel(lead_type);
  const smsConsentVal   = (isTruthyConsent(smsCF) || isTruthyConsent(smsSF)) ? 1 : 0;
  const emailConsentVal = isTruthyConsent(emailConsentCF) ? 1 : 0;
  const claimedBrand = toStringOrNull(claimedBrandA) || toStringOrNull(claimedBrandB);
  const externalRef = toStringOrNull(external_ref) || undefined;
  const refType = toStringOrNull(ref_type) || 'lead_submission_id';

  // ── 2-3. Normalize, then dedupe/create the one master contact, then
  //         preserve the exact legacy field-enrichment behavior. ─────────
  let contact = dedupeContact(db, { email, phone: phoneDisplay, phone_e164: phoneE164, first_name: firstName, last_name: lastName });
  contact = enrichLegacyContactFields(db, contact, {
    firstName, lastName, email, phoneDisplay, phoneE164,
    leadLabel, leadSource, smsConsentVal, emailConsentVal,
  });

  // ── 4. Resolve brand strictly from the verified source — never from any
  //      client-supplied field, never from product/service. ─────────────
  const resolvedBrandSlug = resolveBrandSlugForSourceFn(sourceId);

  if (!resolvedBrandSlug) {
    const unresolvedIntake = stageUnresolvedIntake(db, {
      source: sourceId || 'unknown',
      rawPayload: payload,
      candidateContactId: contact.id,
      reason: 'lead source could not be verified against a known source/credential mapping',
      reviewType: 'brand',
    });
    return { outcome: 'brand_review_required', contact, unresolvedIntake };
  }

  if (claimedBrand && claimedBrand !== resolvedBrandSlug) {
    const unresolvedIntake = stageUnresolvedIntake(db, {
      source: sourceId,
      rawPayload: payload,
      candidateContactId: contact.id,
      reason: `submitted brand '${claimedBrand}' conflicts with verified source brand '${resolvedBrandSlug}' — never overridden automatically`,
      reviewType: 'brand',
    });
    return { outcome: 'brand_review_required', contact, unresolvedIntake };
  }

  const brandRow = getBrandRow(db, resolvedBrandSlug);
  if (!brandRow) {
    throw new Error(`processLeadIntake: configured brand slug '${resolvedBrandSlug}' was not found in the brands table — has crm/db/migrateBrands.js been run?`);
  }

  // ── Permanent-company rule: a client keeps ONE active originating company
  //    for active business (never inferred from product). If this contact
  //    already has an ACTIVE contact_brands relationship under a DIFFERENT
  //    brand than the one this verified source just resolved, do not
  //    silently create a second active relationship, transfer the contact,
  //    or send anything — stage a company-assignment conflict for
  //    deliberate, audited review instead. A contact with no existing
  //    relationship, or one that already matches this brand, is unaffected
  //    (first-time establishment / repeat lead — proceeds normally below).
  const existingActiveBrands = db.prepare(`
    SELECT * FROM contact_brands WHERE contact_id = ? AND status = 'Active'
  `).all(contact.id);
  const conflictingRelationship = existingActiveBrands.find(cb => cb.brand_id !== brandRow.id);

  if (conflictingRelationship) {
    const unresolvedIntake = stageUnresolvedIntake(db, {
      source: sourceId,
      rawPayload: payload,
      candidateContactId: contact.id,
      reason: `incoming verified source resolved to brand '${resolvedBrandSlug}', but this contact already has an active company assignment under a different brand — requires deliberate review before any second relationship is created`,
      reviewType: 'company_conflict',
      contactBrandId: conflictingRelationship.id,
      incomingBrandId: brandRow.id,
      refType, refValue: externalRef,
    });
    return { outcome: 'company_conflict', contact, unresolvedIntake };
  }

  // ── 5. Confirm the contact_brand relationship. ─────────────────────────
  const contactBrand = resolveContactBrand(db, { contactId: contact.id, brandId: brandRow.id });

  // ── 6. Determine product (never affects brand) and match/create/stage
  //      the case. ────────────────────────────────────────────────────────
  const productName = (LEAD_TYPE_TO_PRODUCT_BY_BRAND_SLUG[resolvedBrandSlug] || {})[leadLabel] || null;
  const productRow = getProductRow(db, brandRow.id, productName);

  const matchResult = matchOrCreateCase(db, {
    contactBrandId: contactBrand.id,
    productId: productRow ? productRow.id : null,
    externalRef,
    refType,
    eventType: 'repeat_submission',
    title: leadLabel,
    source: sourceId,
    rawPayload: payload,
  });

  // ── 7. Audit trail. ─────────────────────────────────────────────────────
  recordIntakeCommunication(db, {
    contact, contactBrandId: contactBrand.id,
    caseId: matchResult.case ? matchResult.case.id : null,
    leadLabel, leadSource,
    extraFields: { first_name: firstName, last_name: lastName, email, phone, lead_type, lead_source: leadSource, ...restFields(payload) },
  });

  if (matchResult.outcome === 'review_required') {
    return { outcome: 'case_review_required', contact, contactBrand, unresolvedIntake: matchResult.unresolvedIntake };
  }
  return { outcome: matchResult.outcome, contact, contactBrand, case: matchResult.case };
}

module.exports = { processLeadIntake };
