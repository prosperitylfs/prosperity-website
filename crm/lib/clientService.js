// Client (contact) create/edit/archive/restore and manual company-change
// requests. Every function takes an explicit better-sqlite3 `db` handle —
// never opens a connection itself, never imports crm/db/database.js.
//
// The permanent-company rule applies here exactly as it does to automatic
// intake (crm/lib/leadIntake.js): a brand is required to create a client,
// is never inferred from product, and a contact that already has an active
// relationship under a DIFFERENT brand is staged for review rather than
// silently given a second one. updateClient() below structurally cannot
// change a client's company — the field isn't part of its accepted input
// at all, so there is nothing to "casually edit."

const { BRANDS, isKnownBrandId } = require('../config/brands');
const {
  dedupeContact, resolveContactBrand, findConflictingActiveBrand,
} = require('./caseMatching');
const { stageUnresolvedIntake } = require('./caseMatching');
const { normalizePhone, normalizeEmail, toStringOrNull } = require('./leadNormalize');

function getBrandRow(db, slug) {
  return db.prepare('SELECT * FROM brands WHERE slug = ?').get(slug);
}

// Independent of lead_type (which stays a source/history field — "Retirement
// Guide Lead", "Referral Partner", etc. — and is never removed or
// repurposed). relationship_type answers one question only: what is this
// person's current relationship to the business? A book of business is
// larger than "lead vs. client" — this stores a free TEXT column
// (crm/db/database.js) with no CHECK constraint, so this list is the ONLY
// place the allowed set lives; adding another category later (e.g. a future
// status beyond these five) is purely additive here plus a matching
// <option> in the two Add Contact UIs — never a schema change. No category
// here may ever imply or grant SMS consent — that stays fully independent
// (enforced below, in applyContactFields).
const RELATIONSHIP_TYPES = ['lead', 'active_client', 'former_client', 'prior_applicant', 'declined_applicant'];

// brandSlug is REQUIRED and must be a known brand — there is no default,
// matching "No company may be preselected when adding a client manually."
function createClient(db, fields, actor) {
  const { brandSlug } = fields;
  if (!actor) throw new Error('createClient: actor is required for the audit trail');
  if (!brandSlug || !isKnownBrandId(brandSlug)) {
    throw new Error('createClient: a valid company (brandSlug) is required and must be explicitly chosen');
  }
  const email = normalizeEmail(fields.email);
  const { display: phoneDisplay, e164: phoneE164 } = normalizePhone(fields.phone);
  if (!email && !phoneDisplay) {
    throw new Error('createClient: email or phone is required');
  }

  const contact = dedupeContact(db, {
    email, phone: phoneDisplay, phone_e164: phoneE164,
    first_name: toStringOrNull(fields.firstName), last_name: toStringOrNull(fields.lastName),
  });
  // requireConsentSource: true -- manual creation is the one path where a
  // human is actively asserting "SMS consent = yes" for the first time, so
  // it's the one place we insist on knowing how that consent was obtained.
  // updateClient (below) does NOT pass this -- see its own comment.
  applyContactFields(db, contact.id, fields, { email, phoneDisplay, phoneE164 }, { requireConsentSource: true });

  const brandRow = getBrandRow(db, brandSlug);
  const conflict = findConflictingActiveBrand(db, contact.id, brandRow.id);
  if (conflict) {
    const unresolvedIntake = stageUnresolvedIntake(db, {
      source: 'manual_client_entry',
      rawPayload: fields,
      candidateContactId: contact.id,
      reason: `manually adding this client to '${brandSlug}' conflicts with an existing active company assignment under a different brand — requires deliberate review before any second relationship is created`,
      reviewType: 'company_conflict',
      contactBrandId: conflict.id,
      incomingBrandId: brandRow.id,
    });
    return { outcome: 'company_conflict', contact, unresolvedIntake };
  }

  const contactBrand = resolveContactBrand(db, { contactId: contact.id, brandId: brandRow.id });
  return { outcome: 'created', contact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact.id), contactBrand };
}

// Explicit-tri-state boolean: undefined ("this field was never part of the
// request") is distinguished from a real false, so COALESCE below only
// overwrites sms_consent/email_consent when the caller actually meant to —
// a caller that never mentions consent at all (e.g. an unrelated field
// update) must never accidentally reset it.
function toBoolIntOrNull(v) {
  if (v === undefined) return null;
  return v ? 1 : 0;
}

// Same tri-state idea as toStringOrNull, for the handful of numeric profile
// fields (age, number_of_children, number_of_grandchildren) -- an empty
// string/undefined/non-numeric input COALESCEs to "leave unchanged" rather
// than writing 0 or NaN.
function toIntOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Never accepts a brand/company field — structurally impossible to change
// the permanent company through this function. Also never accepts
// lead_type: unlike relationship_type (below), lead_type stays a
// source/history field recording how this contact originally entered the
// CRM (see the RELATIONSHIP_TYPES comment above) and is deliberately left
// out of the editable field set entirely, not merely unwritten here.
//
// 2026-09-08 expansion (Edit Client): every other "complete contact
// profile" column crm/db/database.js already defines on `contacts` --
// middle_name, home_phone, alt_phone, preferred_contact_method,
// best_time_to_contact, age, marital_status, spouse_name/date_of_birth,
// number_of_children/grandchildren, family_notes, occupation, employer,
// referred_by, lead_status -- is now accepted the same COALESCE way as the
// fields already here. Deliberately excludes every case/policy-shaped
// column also on this table (insurance_company, policy_type, face_amount,
// coverage_goal, retirement_assets, etc.) -- those belong to Cases/Policies
// (crm/lib/caseService.js / policyService.js), not the client profile, and
// every purely historical/activity column (last_contacted,
// next_follow_up_date, last_called_at, commission_estimate, etc.).
//
// sms_consent/email_consent ARE accepted here (Revenue MVP requirement: a
// manually-added existing client must be markable as consented, or the
// Text/Email actions in crm/lib/communicationDraftService.js can never be
// used for them at all — there was previously no path to ever set this to
// true for a manually-entered contact). Loretta is the one deciding
// whether real consent exists (existing-business-relationship, verbal, a
// prior opt-in reply, etc.) — this only gives the CRM a place to record
// that decision, it never infers or assumes consent itself.
//
// relationship_type is fully independent of sms_consent — selecting any
// relationship category (e.g. "Active Client") must never itself grant or
// imply consent (a business requirement, not an oversight); the two are
// validated and written separately below with no interaction between them.
//
// SMS consent audit trail (sms_consent_source/_at/_notes): sms_consent_at
// is only ever stamped here, server-side, at the exact moment sms_consent
// transitions from false to true — never client-supplied, never backdated,
// never touched on any other save (including a save that merely re-sends
// smsConsent: true unchanged, or one that turns it back off). This is
// deliberate: it is impossible to fabricate a consent date for a
// pre-existing record through this function.
//
// opts.requireConsentSource (createClient only, see below) hard-blocks a
// *new* consent grant with no source. It is intentionally NOT enforced for
// updateClient, so the pre-existing, already-live "Edit Client" modal
// (crm/public/app/client.html), which has no consent-source field yet, is
// left completely unaffected by this change.
function applyContactFields(db, contactId, fields, normalized, opts = {}) {
  if (
    fields.relationshipType !== undefined && fields.relationshipType !== null && fields.relationshipType !== '' &&
    !RELATIONSHIP_TYPES.includes(fields.relationshipType)
  ) {
    throw new Error(`applyContactFields: unknown relationshipType '${fields.relationshipType}' — must be one of ${RELATIONSHIP_TYPES.join(', ')}`);
  }

  const existing = db.prepare('SELECT sms_consent FROM contacts WHERE id = ?').get(contactId);
  const previouslyConsented = !!(existing && existing.sms_consent);
  const isNewConsentGrant = fields.smsConsent === true && !previouslyConsented;

  if (isNewConsentGrant && opts.requireConsentSource && !toStringOrNull(fields.smsConsentSource)) {
    throw new Error('applyContactFields: sms_consent_source is required when granting SMS consent');
  }

  db.prepare(`
    UPDATE contacts SET
      first_name           = COALESCE(@first_name, first_name),
      last_name            = COALESCE(@last_name, last_name),
      middle_name          = COALESCE(@middle_name, middle_name),
      email                = COALESCE(@email, email),
      phone                = COALESCE(@phone, phone),
      phone_e164           = COALESCE(@phone_e164, phone_e164),
      home_phone           = COALESCE(@home_phone, home_phone),
      alt_phone            = COALESCE(@alt_phone, alt_phone),
      preferred_contact_method = COALESCE(@preferred_contact_method, preferred_contact_method),
      best_time_to_contact = COALESCE(@best_time_to_contact, best_time_to_contact),
      street_address       = COALESCE(@street_address, street_address),
      city                 = COALESCE(@city, city),
      state                = COALESCE(@state, state),
      zip_code             = COALESCE(@zip_code, zip_code),
      date_of_birth        = COALESCE(@date_of_birth, date_of_birth),
      age                  = COALESCE(@age, age),
      marital_status       = COALESCE(@marital_status, marital_status),
      spouse_name          = COALESCE(@spouse_name, spouse_name),
      spouse_date_of_birth = COALESCE(@spouse_date_of_birth, spouse_date_of_birth),
      number_of_children      = COALESCE(@number_of_children, number_of_children),
      number_of_grandchildren = COALESCE(@number_of_grandchildren, number_of_grandchildren),
      family_notes         = COALESCE(@family_notes, family_notes),
      occupation           = COALESCE(@occupation, occupation),
      employer             = COALESCE(@employer, employer),
      referred_by          = COALESCE(@referred_by, referred_by),
      lead_source          = COALESCE(@lead_source, lead_source),
      lead_status          = COALESCE(@lead_status, lead_status),
      general_notes        = COALESCE(@general_notes, general_notes),
      relationship_type    = COALESCE(@relationship_type, relationship_type),
      sms_consent          = COALESCE(@sms_consent, sms_consent),
      sms_consent_source   = COALESCE(@sms_consent_source, sms_consent_source),
      sms_consent_notes    = COALESCE(@sms_consent_notes, sms_consent_notes),
      sms_consent_at       = CASE WHEN @is_new_consent_grant = 1 THEN CURRENT_TIMESTAMP ELSE sms_consent_at END,
      email_consent        = COALESCE(@email_consent, email_consent),
      updated_at           = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    first_name: toStringOrNull(fields.firstName), last_name: toStringOrNull(fields.lastName),
    middle_name: toStringOrNull(fields.middleName),
    email: normalized.email, phone: normalized.phoneDisplay, phone_e164: normalized.phoneE164,
    home_phone: toStringOrNull(fields.homePhone), alt_phone: toStringOrNull(fields.altPhone),
    preferred_contact_method: toStringOrNull(fields.preferredContactMethod),
    best_time_to_contact: toStringOrNull(fields.bestTimeToContact),
    street_address: toStringOrNull(fields.address), city: toStringOrNull(fields.city),
    state: toStringOrNull(fields.state), zip_code: toStringOrNull(fields.zip),
    date_of_birth: toStringOrNull(fields.dateOfBirth), age: toIntOrNull(fields.age),
    marital_status: toStringOrNull(fields.maritalStatus),
    spouse_name: toStringOrNull(fields.spouseName), spouse_date_of_birth: toStringOrNull(fields.spouseDateOfBirth),
    number_of_children: toIntOrNull(fields.numberOfChildren),
    number_of_grandchildren: toIntOrNull(fields.numberOfGrandchildren),
    family_notes: toStringOrNull(fields.familyNotes),
    occupation: toStringOrNull(fields.occupation), employer: toStringOrNull(fields.employer),
    referred_by: toStringOrNull(fields.referredBy),
    lead_source: toStringOrNull(fields.originalSource), lead_status: toStringOrNull(fields.leadStatus),
    general_notes: toStringOrNull(fields.generalNotes),
    relationship_type: toStringOrNull(fields.relationshipType),
    sms_consent: toBoolIntOrNull(fields.smsConsent), email_consent: toBoolIntOrNull(fields.emailConsent),
    sms_consent_source: toStringOrNull(fields.smsConsentSource),
    sms_consent_notes: toStringOrNull(fields.smsConsentNotes),
    is_new_consent_grant: isNewConsentGrant ? 1 : 0,
    id: contactId,
  });
}

function updateClient(db, contactId, fields) {
  const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!existing) throw new Error(`updateClient: contact ${contactId} does not exist`);
  const email = fields.email !== undefined ? normalizeEmail(fields.email) : null;
  const phone = fields.phone !== undefined ? normalizePhone(fields.phone) : { display: null, e164: null };
  // No requireConsentSource here — see applyContactFields' header comment.
  applyContactFields(db, contactId, fields, { email, phoneDisplay: phone.display, phoneE164: phone.e164 });
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
}

function archiveClient(db, contactId, actor) {
  if (!actor) throw new Error('archiveClient: actor is required');
  const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!existing) throw new Error(`archiveClient: contact ${contactId} does not exist`);
  if (existing.archived_at) return existing; // already archived -- idempotent, not an error
  db.prepare('UPDATE contacts SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(contactId);
  // Archiving the client never touches cases/policies/communications/notes.
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
}

function restoreClient(db, contactId, actor) {
  if (!actor) throw new Error('restoreClient: actor is required');
  const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!existing) throw new Error(`restoreClient: contact ${contactId} does not exist`);
  db.prepare('UPDATE contacts SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(contactId);
  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
}

// The permanent company "cannot be casually edited" -- this is the ONLY
// path that can even propose a change, and it never applies one. It stages
// a review record (reviewType='company_change') showing the existing
// relationship and the requested brand side by side, for the SAME
// deliberate Review Required flow a detected conflict uses. A transfer
// action is intentionally not implemented (matches the read-only checkpoint
// this behavior was first introduced under) -- see
// crm/lib/reviewResolution.js's resolveCompanyConflict.
function requestCompanyChange(db, { contactId, requestedBrandSlug, reason, actor }) {
  if (!actor) throw new Error('requestCompanyChange: actor is required for the audit trail');
  if (!requestedBrandSlug || !isKnownBrandId(requestedBrandSlug)) {
    throw new Error('requestCompanyChange: a valid requested company is required');
  }
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!contact) throw new Error(`requestCompanyChange: contact ${contactId} does not exist`);

  const currentLink = db.prepare(`
    SELECT * FROM contact_brands WHERE contact_id = ? AND status = 'Active'
  `).all(contactId)[0] || null;
  const requestedBrandRow = getBrandRow(db, requestedBrandSlug);

  if (currentLink && currentLink.brand_id === requestedBrandRow.id) {
    throw new Error('requestCompanyChange: requested company matches the current company already — nothing to change');
  }

  const unresolvedIntake = stageUnresolvedIntake(db, {
    source: `manual_company_change_request:${actor}`,
    rawPayload: { contactId, requestedBrandSlug, reason: reason || null, requestedBy: actor },
    candidateContactId: contactId,
    reason: reason ? `Company change requested by ${actor}: ${reason}` : `Company change requested by ${actor}`,
    reviewType: 'company_change',
    contactBrandId: currentLink ? currentLink.id : null,
    incomingBrandId: requestedBrandRow.id,
  });
  return unresolvedIntake;
}

module.exports = { createClient, updateClient, archiveClient, restoreClient, requestCompanyChange, RELATIONSHIP_TYPES };
