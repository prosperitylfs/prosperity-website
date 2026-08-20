// Case-matching logic for the contacts → contact_brands → cases model.
// Every function takes an explicit better-sqlite3 `db` handle supplied by
// the caller — this module never opens a database connection itself and
// never imports crm/db/database.js.

function dedupeContact(db, { email, phone, phone_e164, first_name, last_name }) {
  let existing = null;
  if (email) {
    existing = db.prepare('SELECT * FROM contacts WHERE email = ?').get(email);
  }
  if (!existing && phone_e164) {
    existing = db.prepare('SELECT * FROM contacts WHERE phone_e164 = ?').get(phone_e164);
  }
  if (!existing && phone) {
    existing = db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
  }
  if (existing) return existing;

  const result = db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, phone, phone_e164, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `).run(first_name || null, last_name || null, email || null, phone || null, phone_e164 || null);

  return db.prepare('SELECT * FROM contacts WHERE id = ?').get(result.lastInsertRowid);
}

// Idempotent: a contact can have at most one contact_brands row per brand
// (enforced by the UNIQUE(contact_id, brand_id) index in migrateBrands.js).
// brandId is required — a contact_brands row must never be created with a
// NULL brand.
function resolveContactBrand(db, { contactId, brandId }) {
  if (!contactId) throw new Error('resolveContactBrand: contactId is required');
  if (!brandId) {
    throw new Error('resolveContactBrand: brandId is required — refusing to create a contact_brands row with a NULL brand');
  }

  db.prepare('INSERT OR IGNORE INTO contact_brands (contact_id, brand_id) VALUES (?, ?)')
    .run(contactId, brandId);

  return db.prepare('SELECT * FROM contact_brands WHERE contact_id = ? AND brand_id = ?')
    .get(contactId, brandId);
}

function findCaseByExternalRef(db, refType, refValue) {
  if (!refValue) return null;
  const ref = db.prepare(
    'SELECT case_id FROM case_external_refs WHERE ref_type = ? AND ref_value = ?'
  ).get(refType, refValue);
  if (!ref) return null;
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(ref.case_id);
}

function attachExternalRef(db, caseId, refType, refValue) {
  if (!refValue) return;
  db.prepare('INSERT OR IGNORE INTO case_external_refs (case_id, ref_type, ref_value) VALUES (?, ?, ?)')
    .run(caseId, refType, refValue);
}

function findOpenCaseForMatter(db, contactBrandId, productId) {
  if (!productId) return null;
  return db.prepare(`
    SELECT * FROM cases
    WHERE contact_brand_id = ? AND product_id = ? AND status = 'Open'
    ORDER BY id DESC LIMIT 1
  `).get(contactBrandId, productId);
}

function createCase(db, { contactBrandId, productId, title, status = 'Open' }) {
  const result = db.prepare(`
    INSERT INTO cases (contact_brand_id, product_id, title, status)
    VALUES (?, ?, ?, ?)
  `).run(contactBrandId, productId || null, title || null, status);
  return db.prepare('SELECT * FROM cases WHERE id = ?').get(result.lastInsertRowid);
}

// reviewType: 'brand' (the brand relationship itself is unresolved — Brand
// Review Required) or 'case' (brand relationship is known; which case this
// belongs to is uncertain — Case Review Required). contactBrandId/productId/
// refType/refValue are structured evidence for the dashboard to display —
// see crm/db/migrateDashboard.js.
function stageUnresolvedIntake(db, {
  source, rawPayload, candidateContactId, reason,
  reviewType = 'brand', contactBrandId = null, productId = null,
  refType = null, refValue = null,
}) {
  const result = db.prepare(`
    INSERT INTO unresolved_intake
      (source, raw_payload, candidate_contact_id, reason, status, review_type, contact_brand_id, product_id, ref_type, ref_value)
    VALUES (?, ?, ?, ?, 'Pending', ?, ?, ?, ?, ?)
  `).run(
    source, JSON.stringify(rawPayload || {}), candidateContactId || null, reason,
    reviewType, contactBrandId || null, productId || null, refType || null, refValue || null
  );
  return db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(result.lastInsertRowid);
}

// Central entry point.
//
// params.eventType is one of:
//   'booking_created' | 'booking_rescheduled' | 'booking_cancelled' |
//   'followup_booking' | 'repeat_submission' | 'new_inquiry'
//
// Returns one of:
//   { outcome: 'matched', case }          — an existing case was reused
//   { outcome: 'created', case }          — a genuinely new case was opened
//   { outcome: 'review_required', unresolvedIntake }
function matchOrCreateCase(db, params) {
  const {
    contactBrandId,
    productId,
    externalRef,          // this event's own booking/webhook reference
    refType = 'cal_booking_uid',
    previousExternalRef,  // reschedules only: the ref of the booking being replaced
    eventType,
    title,
    source = 'unknown',
    rawPayload,
  } = params;

  if (!contactBrandId) {
    return {
      outcome: 'review_required',
      unresolvedIntake: stageUnresolvedIntake(db, {
        source, rawPayload, reason: 'missing contact_brand_id — brand relationship could not be resolved',
      }),
    };
  }

  // 1. Idempotency: if this exact external ref has already been attached to
  //    a case, always resolve to that same case. This also transparently
  //    handles a cancellation of a *known* booking — Cal.com reuses the same
  //    booking uid for a cancellation, so it resolves here as a match
  //    without needing special-case handling below.
  const existingByRef = findCaseByExternalRef(db, refType, externalRef);
  if (existingByRef) {
    return { outcome: 'matched', case: existingByRef };
  }

  // 2. Reschedule — same matter as the booking being replaced.
  if (eventType === 'booking_rescheduled') {
    const priorCase = findCaseByExternalRef(db, refType, previousExternalRef);
    if (priorCase) {
      attachExternalRef(db, priorCase.id, refType, externalRef);
      return { outcome: 'matched', case: priorCase };
    }
    return {
      outcome: 'review_required',
      unresolvedIntake: stageUnresolvedIntake(db, {
        source, rawPayload, reason: `reschedule references unknown prior booking ref '${previousExternalRef}'`,
        reviewType: 'case', contactBrandId, productId, refType, refValue: externalRef,
      }),
    };
  }

  // 3. Cancellation that doesn't match any known ref (step 1) is anomalous
  //    — never silently create a case for a cancellation we can't trace.
  if (eventType === 'booking_cancelled') {
    return {
      outcome: 'review_required',
      unresolvedIntake: stageUnresolvedIntake(db, {
        source, rawPayload, reason: `cancellation references unknown booking ref '${externalRef}'`,
        reviewType: 'case', contactBrandId, productId, refType, refValue: externalRef,
      }),
    };
  }

  // 4. Follow-up booking / repeat submission — reuse an existing open case
  //    for the same brand relationship + product ("the same matter") if one
  //    exists.
  if (eventType === 'followup_booking' || eventType === 'repeat_submission') {
    const openCase = findOpenCaseForMatter(db, contactBrandId, productId);
    if (openCase) {
      attachExternalRef(db, openCase.id, refType, externalRef);
      return { outcome: 'matched', case: openCase };
    }
    // No open case to attach to — fall through and open a new one rather
    // than guessing which past (closed) case this belongs to.
  }

  // 5. Genuinely new opportunity.
  if (!productId) {
    return {
      outcome: 'review_required',
      unresolvedIntake: stageUnresolvedIntake(db, {
        source, rawPayload, reason: 'no product/service category could be determined — cannot open a case without one',
        reviewType: 'case', contactBrandId, refType, refValue: externalRef,
      }),
    };
  }

  const newCase = createCase(db, { contactBrandId, productId, title });
  attachExternalRef(db, newCase.id, refType, externalRef);
  return { outcome: 'created', case: newCase };
}

module.exports = {
  dedupeContact,
  resolveContactBrand,
  matchOrCreateCase,
  findCaseByExternalRef,
  findOpenCaseForMatter,
  stageUnresolvedIntake,
  attachExternalRef,
  createCase,
};
