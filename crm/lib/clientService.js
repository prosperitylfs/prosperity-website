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
  applyContactFields(db, contact.id, fields, { email, phoneDisplay, phoneE164 });

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

// Never accepts a brand/company field — structurally impossible to change
// the permanent company through this function.
//
// sms_consent/email_consent ARE accepted here (Revenue MVP requirement: a
// manually-added existing client must be markable as consented, or the
// Text/Email actions in crm/lib/communicationDraftService.js can never be
// used for them at all — there was previously no path to ever set this to
// true for a manually-entered contact). Loretta is the one deciding
// whether real consent exists (existing-business-relationship, verbal, a
// prior opt-in reply, etc.) — this only gives the CRM a place to record
// that decision, it never infers or assumes consent itself.
function applyContactFields(db, contactId, fields, normalized) {
  db.prepare(`
    UPDATE contacts SET
      first_name       = COALESCE(@first_name, first_name),
      last_name        = COALESCE(@last_name, last_name),
      email            = COALESCE(@email, email),
      phone            = COALESCE(@phone, phone),
      phone_e164       = COALESCE(@phone_e164, phone_e164),
      street_address   = COALESCE(@street_address, street_address),
      city             = COALESCE(@city, city),
      state            = COALESCE(@state, state),
      zip_code         = COALESCE(@zip_code, zip_code),
      date_of_birth    = COALESCE(@date_of_birth, date_of_birth),
      lead_source      = COALESCE(@lead_source, lead_source),
      general_notes    = COALESCE(@general_notes, general_notes),
      sms_consent      = COALESCE(@sms_consent, sms_consent),
      email_consent    = COALESCE(@email_consent, email_consent),
      updated_at       = CURRENT_TIMESTAMP
    WHERE id = @id
  `).run({
    first_name: toStringOrNull(fields.firstName), last_name: toStringOrNull(fields.lastName),
    email: normalized.email, phone: normalized.phoneDisplay, phone_e164: normalized.phoneE164,
    street_address: toStringOrNull(fields.address), city: toStringOrNull(fields.city),
    state: toStringOrNull(fields.state), zip_code: toStringOrNull(fields.zip),
    date_of_birth: toStringOrNull(fields.dateOfBirth), lead_source: toStringOrNull(fields.originalSource),
    general_notes: toStringOrNull(fields.generalNotes),
    sms_consent: toBoolIntOrNull(fields.smsConsent), email_consent: toBoolIntOrNull(fields.emailConsent),
    id: contactId,
  });
}

function updateClient(db, contactId, fields) {
  const existing = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!existing) throw new Error(`updateClient: contact ${contactId} does not exist`);
  const email = fields.email !== undefined ? normalizeEmail(fields.email) : null;
  const phone = fields.phone !== undefined ? normalizePhone(fields.phone) : { display: null, e164: null };
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

module.exports = { createClient, updateClient, archiveClient, restoreClient, requestCompanyChange };
