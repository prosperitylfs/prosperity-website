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

module.exports = { archiveCase, resolveBrandReviewItem, resolveCaseReviewItem };
