// Resolution actions for Checkpoint D's dashboard: archiving a case, and
// resolving Brand Review Required / Case Review Required queue items.
// Every function takes an explicit better-sqlite3 `db` handle — never opens
// a connection itself, never imports crm/db/database.js.
//
// Every resolution is an explicit, human-triggered action (a specific
// button click mapped to a specific function call) — nothing here ever
// merges opportunities or picks a brand/case automatically.

const { BRANDS } = require('../config/brands');
const {
  dedupeContact, resolveContactBrand, matchOrCreateCase,
  findCaseByExternalRef, attachExternalRef, createCase,
} = require('./caseMatching');
const { createClient } = require('./clientService');

// Archiving a case only ever touches that one case row — never the
// contact, its other cases, or the contact_brands relationship.
function archiveCase(db, { caseId, actor }) {
  const existing = db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
  if (!existing) throw new Error(`archiveCase: case ${caseId} does not exist`);
  db.prepare("UPDATE cases SET status = 'Archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(caseId);
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(caseId);
}

function brandRowIdForSlug(db, slug) {
  const row = db.prepare('SELECT id FROM brands WHERE slug = ?').get(slug);
  return row ? row.id : null;
}

// decision: 'insurance-lady' | 'prosperity' | 'test_archive'
// Assigning a brand creates/resolves the contact_brands relationship and,
// where enough evidence was staged (product/external ref), also resolves
// or creates the underlying case — chaining into matchOrCreateCase, whose
// own review_required outcome (e.g. missing product) becomes a fresh Case
// Review Required item rather than a guess.
function resolveBrandReviewItem(db, { intakeId, decision, actor }) {
  if (!actor) throw new Error('resolveBrandReviewItem: actor is required for the audit trail');
  const intake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId);
  if (!intake) throw new Error(`resolveBrandReviewItem: intake ${intakeId} does not exist`);
  if (intake.review_type !== 'brand') throw new Error(`resolveBrandReviewItem: intake ${intakeId} is not a brand-review item`);
  if (intake.status !== 'Pending') throw new Error(`resolveBrandReviewItem: intake ${intakeId} is not pending (status: ${intake.status})`);

  if (decision === 'test_archive') {
    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Archived', decision = 'test_archive', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(actor, intakeId);
    return { outcome: 'archived', intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId) };
  }

  if (!BRANDS[decision]) throw new Error(`resolveBrandReviewItem: unknown brand decision '${decision}'`);
  const brandRowId = brandRowIdForSlug(db, decision);
  if (!brandRowId) throw new Error(`resolveBrandReviewItem: brand '${decision}' not found in database`);

  let payload = {};
  try { payload = JSON.parse(intake.raw_payload || '{}'); } catch { payload = {}; }

  const contact = dedupeContact(db, {
    email: payload.email, phone: payload.phone, phone_e164: payload.phone_e164,
    first_name: payload.first_name, last_name: payload.last_name,
  });
  // brandRowId is always non-null here (checked above) — resolveContactBrand
  // will throw rather than ever create a NULL-brand relationship regardless.
  const contactBrand = resolveContactBrand(db, { contactId: contact.id, brandId: brandRowId });

  let caseResult = null;
  if (intake.product_id || intake.ref_value) {
    caseResult = matchOrCreateCase(db, {
      contactBrandId: contactBrand.id,
      productId: intake.product_id || null,
      externalRef: intake.ref_value || null,
      refType: intake.ref_type || 'cal_booking_uid',
      eventType: 'new_inquiry',
      source: `brand_review:${intake.source}`,
      rawPayload: payload,
    });
  }

  db.prepare(`
    UPDATE unresolved_intake
    SET status = 'Resolved', decision = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, resolved_contact_brand_id = ?
    WHERE id = ?
  `).run(decision, actor, contactBrand.id, intakeId);

  return {
    outcome: 'resolved',
    contact, contactBrand, caseResult,
    intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId),
  };
}

// action: 'attach_existing_case' | 'create_new_case' | 'test_archive'
// productId is only used by 'create_new_case', and only when the intake
// itself didn't already carry one — see the product-required check below.
function resolveCaseReviewItem(db, { intakeId, action, targetCaseId, productId, actor }) {
  if (!actor) throw new Error('resolveCaseReviewItem: actor is required for the audit trail');
  const intake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId);
  if (!intake) throw new Error(`resolveCaseReviewItem: intake ${intakeId} does not exist`);
  if (intake.review_type !== 'case') throw new Error(`resolveCaseReviewItem: intake ${intakeId} is not a case-review item`);
  if (intake.status !== 'Pending') throw new Error(`resolveCaseReviewItem: intake ${intakeId} is not pending (status: ${intake.status})`);

  if (action === 'test_archive') {
    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Archived', decision = 'test_archive', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(actor, intakeId);
    return { outcome: 'archived', intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId) };
  }

  if (action === 'attach_existing_case') {
    if (!targetCaseId) throw new Error('resolveCaseReviewItem: targetCaseId is required to attach to an existing case');
    const targetCase = db.prepare('SELECT * FROM cases WHERE id = ?').get(targetCaseId);
    if (!targetCase) throw new Error(`resolveCaseReviewItem: case ${targetCaseId} does not exist`);
    // Never let a case-review resolution cross into a different brand
    // relationship than the one this intake was staged under.
    if (targetCase.contact_brand_id !== intake.contact_brand_id) {
      throw new Error('resolveCaseReviewItem: target case belongs to a different brand relationship than this intake — refusing to attach');
    }
    // Never silently re-point a ref that's already attached to a DIFFERENT
    // case — that would be an inconsistent, confusing state.
    if (intake.ref_value) {
      const existingCaseForRef = findCaseByExternalRef(db, intake.ref_type || 'cal_booking_uid', intake.ref_value);
      if (existingCaseForRef && existingCaseForRef.id !== targetCaseId) {
        throw new Error(`resolveCaseReviewItem: ref '${intake.ref_value}' is already attached to case ${existingCaseForRef.id}, not ${targetCaseId}`);
      }
      attachExternalRef(db, targetCaseId, intake.ref_type || 'cal_booking_uid', intake.ref_value);
    }
    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Resolved', decision = 'attach_existing_case', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, resolved_contact_brand_id = ?
      WHERE id = ?
    `).run(actor, intake.contact_brand_id, intakeId);
    return { outcome: 'attached', case: targetCase, intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId) };
  }

  if (action === 'create_new_case') {
    // Refuse to create a duplicate case for a ref that already resolves to
    // one — the correct action for that is attach_existing_case instead.
    if (intake.ref_value) {
      const existingCaseForRef = findCaseByExternalRef(db, intake.ref_type || 'cal_booking_uid', intake.ref_value);
      if (existingCaseForRef) {
        throw new Error(`resolveCaseReviewItem: ref '${intake.ref_value}' already belongs to case ${existingCaseForRef.id} — use attach_existing_case instead of creating a duplicate`);
      }
    }

    // A genuinely new case must have a product/service — never create one
    // with a null product just because the schema permits it. If the
    // intake itself didn't carry a product, the caller must supply one
    // explicitly (the dashboard requires the human to pick one first).
    const effectiveProductId = intake.product_id || productId;
    if (!effectiveProductId) {
      throw new Error('resolveCaseReviewItem: a product/service must be selected before creating a genuinely new case');
    }
    if (productId && !intake.product_id) {
      // The product only ever describes the case AFTER the brand is
      // already resolved — it must belong to this intake's own relationship
      // brand, never the other one. Refuse rather than silently accept a
      // mismatched product, which would effectively let a product choice
      // leak into brand assignment.
      const contactBrand = db.prepare('SELECT brand_id FROM contact_brands WHERE id = ?').get(intake.contact_brand_id);
      const product = db.prepare('SELECT brand_id FROM products WHERE id = ?').get(productId);
      if (!product || !contactBrand || product.brand_id !== contactBrand.brand_id) {
        throw new Error('resolveCaseReviewItem: selected product does not belong to this relationship\'s brand');
      }
    }

    const newCase = createCase(db, { contactBrandId: intake.contact_brand_id, productId: effectiveProductId, title: intake.reason });
    if (intake.ref_value) attachExternalRef(db, newCase.id, intake.ref_type || 'cal_booking_uid', intake.ref_value);
    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Resolved', decision = 'create_new_case', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, resolved_contact_brand_id = ?
      WHERE id = ?
    `).run(actor, intake.contact_brand_id, intakeId);
    return { outcome: 'created', case: newCase, intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId) };
  }

  throw new Error(`resolveCaseReviewItem: unknown action '${action}'`);
}

// action: 'keep_existing' | 'test_archive' — a transfer action is
// intentionally NOT implemented (matches the original prohibition this
// queue was built under): keeping the existing company is the only way to
// resolve a conflict or a manual company-change request without an
// explicit, separately-approved transfer mechanism. Applies to BOTH
// review_type 'company_conflict' (detected automatically at intake) and
// 'company_change' (a manual request via crm/lib/clientService.js's
// requestCompanyChange) — both share the same contact_brand_id (existing)
// / incoming_brand_id (requested) shape.
//
// "Keeping the existing company must not falsely relabel the incoming
// source" — this never rewrites incoming_brand_id or the raw_payload; it
// only records the decision and resolution actor/time, so the full
// existing-vs-incoming comparison stays intact in the resolved record.
function resolveCompanyConflict(db, { intakeId, action, actor }) {
  if (!actor) throw new Error('resolveCompanyConflict: actor is required for the audit trail');
  const intake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId);
  if (!intake) throw new Error(`resolveCompanyConflict: intake ${intakeId} does not exist`);
  if (!['company_conflict', 'company_change'].includes(intake.review_type)) {
    throw new Error(`resolveCompanyConflict: intake ${intakeId} is not a company-conflict or company-change item`);
  }
  if (intake.status !== 'Pending') throw new Error(`resolveCompanyConflict: intake ${intakeId} is not pending (status: ${intake.status})`);

  if (action === 'test_archive') {
    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Archived', decision = 'test_archive', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(actor, intakeId);
    return { outcome: 'archived', intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId) };
  }

  if (action === 'keep_existing') {
    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Resolved', decision = 'keep_existing_company', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, resolved_contact_brand_id = ?
      WHERE id = ?
    `).run(actor, intake.contact_brand_id, intakeId);
    return { outcome: 'kept_existing', intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId) };
  }

  throw new Error(`resolveCompanyConflict: unknown action '${action}' (only 'keep_existing' and 'test_archive' are implemented)`);
}

// Tables holding records "owned" by a contact that must move with a
// 'same_person' merge below, so the existing contact's appointment/SMS/
// activity history stays complete and nothing is stranded under the
// drained duplicate. Same set of tables crm/lib/dashboardQueries.js's own
// LAST_ACTIVITY_SOURCES already treats as this contact's activity, plus
// retirement_intakes and communication_drafts (also contact-owned, just not
// activity-timeline sources). None of these have a UNIQUE constraint on
// contact_id, so a plain UPDATE is safe for all of them — contact_brands
// (which DOES have UNIQUE(contact_id, brand_id)) is handled separately, in
// mergeContactBrands.
const CONTACT_OWNED_TABLES = [
  'communications', 'comm_calls', 'sms_messages', 'emails', 'contact_notes',
  'follow_up_tasks', 'appointments', 'activities', 'retirement_intakes',
  'communication_drafts',
];

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// contacts.archived_at (crm/db/migrateCrmCore.js) is a newer, optional
// column — some already-approved db shapes haven't run that migration yet
// (same reasoning as crm/lib/dashboardQueries.js's own columnExists()).
// Checked dynamically so the merge below degrades gracefully rather than
// throwing in an environment where it's absent: the duplicate's data is
// still fully drained onto the existing contact either way — only the
// "hide the empty duplicate" step is skipped.
function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

function reassignContactOwnedRecords(db, { fromContactId, toContactId }) {
  for (const table of CONTACT_OWNED_TABLES) {
    if (!tableExists(db, table)) continue; // optional/newer tables — see crm/lib/dashboardQueries.js's own tableExists()
    db.prepare(`UPDATE ${table} SET contact_id = ? WHERE contact_id = ?`).run(toContactId, fromContactId);
  }

  // contact_brands has UNIQUE(contact_id, brand_id) — reassign only where
  // the existing contact doesn't already have a link for that brand; where
  // it does, the existing contact's own link is already authoritative, so
  // the duplicate's redundant row is simply removed, never overwriting it.
  const dupLinks = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(fromContactId);
  for (const link of dupLinks) {
    const alreadyLinked = db.prepare('SELECT 1 FROM contact_brands WHERE contact_id = ? AND brand_id = ?').get(toContactId, link.brand_id);
    if (alreadyLinked) db.prepare('DELETE FROM contact_brands WHERE id = ?').run(link.id);
    else db.prepare('UPDATE contact_brands SET contact_id = ? WHERE id = ?').run(toContactId, link.id);
  }
}

// action: 'same_person' | 'confirm_different' | 'test_archive'.
//
// 'confirm_different' just records that Loretta looked at both records side
// by side and confirmed they are two different people — both contact rows
// are left exactly as they already are; nothing is renamed, relinked, or
// deleted (matches resolveCompanyConflict's own restraint on an ordinary
// conflict).
//
// 'same_person' is the one real data operation this module performs: the
// caller (crm/public/app/review.html / client.html) has already shown
// Loretta the existing-vs-incoming comparison — including which single
// field is about to change — and she has explicitly confirmed it's the
// same person. This moves every contact-owned record (appointments,
// sms_messages, communications, notes, calls, emails, tasks, activities,
// retirement intakes, contact_brands) from the newly-created duplicate onto
// the existing contact via reassignContactOwnedRecords, so appointment and
// SMS history is preserved exactly, never dropped or duplicated. It then
// updates ONLY the one field the conflict was actually about — phone for
// 'email_match_phone_diff', email for 'phone_match_email_diff' — on the
// EXISTING contact to the incoming value; every other existing field is
// left untouched, never silently overwritten. The drained duplicate is
// archived (contacts.archived_at, crm/db/migrateCrmCore.js's own
// soft-delete convention), never hard-deleted, so both the original record
// and this decision stay auditable. All of this runs in one transaction —
// either the whole merge lands or none of it does.
function resolveContactConflict(db, { intakeId, action, actor }) {
  if (!actor) throw new Error('resolveContactConflict: actor is required for the audit trail');
  const intake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId);
  if (!intake) throw new Error(`resolveContactConflict: intake ${intakeId} does not exist`);
  if (intake.review_type !== 'contact_conflict') throw new Error(`resolveContactConflict: intake ${intakeId} is not a contact-conflict item`);
  if (intake.status !== 'Pending') throw new Error(`resolveContactConflict: intake ${intakeId} is not pending (status: ${intake.status})`);

  if (action === 'test_archive') {
    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Archived', decision = 'test_archive', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(actor, intakeId);
    return { outcome: 'archived', intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId) };
  }

  if (action === 'confirm_different') {
    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Resolved', decision = 'confirmed_different_person', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(actor, intakeId);
    return { outcome: 'confirmed_different', intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId) };
  }

  if (action === 'same_person') {
    let payload = {};
    try { payload = JSON.parse(intake.raw_payload || '{}'); } catch { payload = {}; }
    const newContactId = payload.new_contact_id;
    const existingContactId = intake.candidate_contact_id;
    if (!newContactId || !existingContactId) {
      throw new Error('resolveContactConflict: intake is missing the contact ids needed to merge');
    }
    const newContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(newContactId);
    const existingContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existingContactId);
    if (!newContact || !existingContact) {
      throw new Error('resolveContactConflict: one of the two contact records no longer exists');
    }

    const merge = db.transaction(() => {
      reassignContactOwnedRecords(db, { fromContactId: newContactId, toContactId: existingContactId });

      if (payload.conflict_type === 'email_match_phone_diff' && newContact.phone_e164) {
        db.prepare('UPDATE contacts SET phone = ?, phone_e164 = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(newContact.phone, newContact.phone_e164, existingContactId);
      } else if (payload.conflict_type === 'phone_match_email_diff' && newContact.email) {
        // The duplicate's own email must be cleared FIRST -- contacts.email
        // is UNIQUE, so writing the same value onto the existing contact
        // while the duplicate still holds it would violate that index.
        db.prepare('UPDATE contacts SET email = NULL WHERE id = ?').run(newContactId);
        db.prepare('UPDATE contacts SET email = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run(newContact.email, existingContactId);
      }

      if (columnExists(db, 'contacts', 'archived_at')) {
        db.prepare("UPDATE contacts SET archived_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newContactId);
      } else {
        db.prepare("UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newContactId);
      }

      db.prepare(`
        UPDATE unresolved_intake
        SET status = 'Resolved', decision = 'confirmed_same_person', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(actor, intakeId);
    });
    merge();

    return {
      outcome: 'merged',
      existingContact: db.prepare('SELECT * FROM contacts WHERE id = ?').get(existingContactId),
      intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId),
    };
  }

  throw new Error(`resolveContactConflict: unknown action '${action}' (only 'same_person', 'confirm_different', and 'test_archive' are implemented)`);
}

// Resolves a staged unmatched-inbound-SMS review item (review_type
// 'unknown_sms_sender', crm/lib/inboundSmsService.js) via one of two
// explicit, human-triggered actions — never a guess, never automatic:
//
//   action: 'attach_existing' — attach to a client the reviewer chooses by
//     hand. Only ever attaches to a client whose ACTIVE company is
//     Prosperity, matching "never attach a reply to an Insurance Lady
//     client." Preserves the original intake row (raw_payload untouched)
//     and inserts the message into sms_messages using the same idempotent
//     INSERT OR IGNORE on twilio_sid as the webhook itself, so resolving
//     the same review item twice can never create two message rows.
//
//   action: 'create_new' — the reviewer has confirmed this is a genuinely
//     new Prosperity client. Reuses crm/lib/clientService.js's
//     createClient() (the SAME function "Add Client" uses) rather than
//     inserting a contact directly, so the exact same permanent-company
//     conflict detection applies here too: if this phone number actually
//     already belongs to a DIFFERENT contact under an active brand (most
//     notably an Insurance Lady client), createClient() stages a
//     'company_conflict' review item instead of creating anything, and
//     THIS unknown_sms_sender intake is left Pending rather than silently
//     resolved — the reviewer must resolve the conflict first. Only on a
//     genuine 'created' outcome does this attach the staged message
//     (exactly once) and mark the original intake Resolved. Never creates
//     or selects a case — that stays a separate, deliberate step.
//
// A third action, archiving, is handled by the generic archiveReviewItem()
// below (shared across every review_type).
function resolveUnknownSmsReview(db, { intakeId, action, contactId, firstName, lastName, actor }) {
  if (!actor) throw new Error('resolveUnknownSmsReview: actor is required for the audit trail');
  const intake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId);
  if (!intake) throw new Error(`resolveUnknownSmsReview: intake ${intakeId} does not exist`);
  if (intake.review_type !== 'unknown_sms_sender') throw new Error(`resolveUnknownSmsReview: intake ${intakeId} is not an unknown-SMS-sender item`);
  if (intake.status !== 'Pending') throw new Error(`resolveUnknownSmsReview: intake ${intakeId} is not pending (status: ${intake.status})`);

  let payload = {};
  try { payload = JSON.parse(intake.raw_payload || '{}'); } catch { payload = {}; }

  if (action === 'attach_existing') {
    if (!contactId) {
      throw new Error('resolveUnknownSmsReview: contactId is required to attach this message to an existing client');
    }
    const link = db.prepare(`
      SELECT cb.id AS contact_brand_id, b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id
      WHERE cb.contact_id = ? AND cb.status = 'Active'
    `).get(contactId);
    if (!link || link.slug !== 'prosperity') {
      throw new Error('resolveUnknownSmsReview: this message can only be attached to a client whose active company is Prosperity');
    }

    const insertResult = db.prepare(`
      INSERT OR IGNORE INTO sms_messages (contact_id, contact_brand_id, direction, from_number, to_number, body, status, twilio_sid)
      VALUES (?, ?, 'inbound', ?, ?, ?, 'received', ?)
    `).run(contactId, link.contact_brand_id, payload.From || null, payload.To || null, payload.Body || '', payload.MessageSid || null);

    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Resolved', decision = 'attached_to_client', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, resolved_contact_brand_id = ?
      WHERE id = ?
    `).run(actor, link.contact_brand_id, intakeId);

    return {
      outcome: 'attached', contactId, messageCreated: insertResult.changes > 0,
      intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId),
    };
  }

  if (action === 'create_new') {
    const clientResult = createClient(db, {
      firstName: firstName || null, lastName: lastName || null,
      phone: payload.From || null, brandSlug: 'prosperity',
    }, actor);

    if (clientResult.outcome === 'company_conflict') {
      // This number actually belongs to someone with a different active
      // company (most notably Insurance Lady) — never silently create a
      // second relationship. The conflict now has its own review item;
      // this unknown_sms_sender intake is left Pending, untouched, so the
      // reviewer can come back to it once the conflict is resolved.
      return {
        outcome: 'company_conflict',
        conflictIntake: clientResult.unresolvedIntake,
        intake,
      };
    }

    const insertResult = db.prepare(`
      INSERT OR IGNORE INTO sms_messages (contact_id, contact_brand_id, direction, from_number, to_number, body, status, twilio_sid)
      VALUES (?, ?, 'inbound', ?, ?, ?, 'received', ?)
    `).run(clientResult.contact.id, clientResult.contactBrand.id, payload.From || null, payload.To || null, payload.Body || '', payload.MessageSid || null);

    db.prepare(`
      UPDATE unresolved_intake
      SET status = 'Resolved', decision = 'created_new_client', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP, resolved_contact_brand_id = ?
      WHERE id = ?
    `).run(actor, clientResult.contactBrand.id, intakeId);

    return {
      outcome: 'created', contact: clientResult.contact, contactBrand: clientResult.contactBrand,
      messageCreated: insertResult.changes > 0,
      intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId),
    };
  }

  throw new Error(`resolveUnknownSmsReview: unknown action '${action}' (must be 'attach_existing' or 'create_new')`);
}

// Generic "archive this review item" for any pending item regardless of
// review_type — a thin, explicit wrapper so the frontend has one action
// name for "dismiss this without a business decision" everywhere.
function archiveReviewItem(db, { intakeId, actor }) {
  if (!actor) throw new Error('archiveReviewItem: actor is required for the audit trail');
  const intake = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId);
  if (!intake) throw new Error(`archiveReviewItem: intake ${intakeId} does not exist`);
  if (intake.status !== 'Pending') throw new Error(`archiveReviewItem: intake ${intakeId} is not pending (status: ${intake.status})`);
  db.prepare(`
    UPDATE unresolved_intake
    SET status = 'Archived', decision = 'test_archive', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(actor, intakeId);
  return { outcome: 'archived', intake: db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intakeId) };
}

module.exports = { archiveCase, resolveBrandReviewItem, resolveCaseReviewItem, resolveCompanyConflict, resolveContactConflict, resolveUnknownSmsReview, archiveReviewItem };
