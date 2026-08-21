// Tests for crm/lib/leadIntake.js — the brand-aware intake pipeline that
// replaced the flat, brand-blind contact write in crm/routes/leads.js
// (Checkpoint E1 / Phase 1). Uses in-memory databases only, built the same
// way crm/test/caseMatching.test.js does — never touches disk or the live
// database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { processLeadIntake } = require('../lib/leadIntake');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

function countAll(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

const VERIFIED_SOURCE = 'prosperity-website';

// ── 1-3. Response/caller-shape smoke test (full HTTP contract is covered
//         separately in crm/test/leadsRoute.test.js) ───────────────────────

test('a verified Prosperity source resolves the Prosperity brand and creates a case', () => {
  const { db, prosperityId } = setup();
  const result = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Dana', last_name: 'Furst', email: 'dana@example.com', phone: '4144411177', lead_type: 'life_insurance' },
  });

  assert.equal(result.outcome, 'created');
  assert.ok(result.contact.id);
  assert.equal(result.contactBrand.brand_id, prosperityId);
  assert.equal(result.case.product_id, getProductId(db, prosperityId, 'Life insurance'));
});

// ── 5. No source is treated as Insurance Lady merely because it submits a
//        life-insurance product. ────────────────────────────────────────────

test('a life-insurance product never resolves to Insurance Lady on its own', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const result = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Priya', last_name: 'Anand', email: 'priya@example.com', lead_type: 'life_insurance' },
  });

  assert.equal(result.contactBrand.brand_id, prosperityId);
  assert.notEqual(result.contactBrand.brand_id, insuranceLadyId);
});

// ── 6. Unknown source does not silently default. ────────────────────────────

test('an unverified source stages Brand Review Required instead of defaulting to a brand', () => {
  const { db } = setup();
  const result = processLeadIntake(db, {
    sourceId: null,
    payload: { first_name: 'Jordan', last_name: 'Maddox', email: 'jordan@example.com', lead_type: 'contact' },
  });

  assert.equal(result.outcome, 'brand_review_required');
  assert.equal(result.unresolvedIntake.review_type, 'brand');
  assert.equal(result.unresolvedIntake.candidate_contact_id, result.contact.id);
  assert.equal(countAll(db, 'contact_brands'), 0, 'no contact_brands row should exist for an unverified source');
});

test('an unrecognized source id also stages Brand Review Required', () => {
  const { db } = setup();
  const result = processLeadIntake(db, {
    sourceId: 'some-unregistered-caller',
    payload: { first_name: 'Alex', email: 'alex@example.com', lead_type: 'contact' },
  });
  assert.equal(result.outcome, 'brand_review_required');
});

// ── 7. Conflicting source and claimed brand are blocked or staged. ─────────

test('a claimed brand that conflicts with the verified source is staged, not trusted', () => {
  const { db } = setup();
  const result = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE, // resolves to 'prosperity'
    payload: { first_name: 'Sam', email: 'sam@example.com', lead_type: 'contact', brand: 'insurance-lady' },
  });

  assert.equal(result.outcome, 'brand_review_required');
  assert.match(result.unresolvedIntake.reason, /conflicts with verified source brand/);
  assert.equal(countAll(db, 'contact_brands'), 0);
});

// ── 8. Unsupported brand is rejected or staged safely. ──────────────────────

test('a garbage/unsupported claimed brand value is staged, not accepted', () => {
  const { db } = setup();
  const result = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Robin', email: 'robin@example.com', lead_type: 'contact', brandId: 'medicare-lady' },
  });

  assert.equal(result.outcome, 'brand_review_required');
  assert.equal(countAll(db, 'contact_brands'), 0);
});

// ── 9-10. Matching normalized email / phone reuses the master contact. ─────

test('matching normalized email reuses the master contact across submissions', () => {
  const { db } = setup();
  const first = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Casey', email: 'Casey@Example.com', lead_type: 'contact' },
  });
  const second = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Casey', email: 'casey@example.com', lead_type: 'life_insurance' },
  });

  assert.equal(first.contact.id, second.contact.id);
  assert.equal(countAll(db, 'contacts'), 1);
});

test('matching normalized phone reuses the master contact across submissions', () => {
  const { db } = setup();
  const first = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Morgan', phone: '(414) 555-9911', lead_type: 'contact' },
  });
  const second = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Morgan', phone: '4145559911', lead_type: 'life_insurance' },
  });

  assert.equal(first.contact.id, second.contact.id);
  assert.equal(countAll(db, 'contacts'), 1);
});

// ── 11. A new person creates one master contact. ────────────────────────────

test('a brand-new person creates exactly one contact row', () => {
  const { db } = setup();
  const before = countAll(db, 'contacts');
  processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Taylor', last_name: 'Reyes', email: 'taylor.reyes@example.com', lead_type: 'contact' },
  });
  assert.equal(countAll(db, 'contacts'), before + 1);
});

// ── 12-13. Correct contact-brand relationship created; no NULL-brand
//           relationship is ever created. ──────────────────────────────────

test('the correct contact_brand relationship is created and is idempotent', () => {
  const { db, prosperityId } = setup();
  const r1 = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Nia', email: 'nia@example.com', lead_type: 'contact' },
  });
  const r2 = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Nia', email: 'nia@example.com', lead_type: 'life_insurance' },
  });

  assert.equal(r1.contactBrand.id, r2.contactBrand.id);
  assert.equal(r1.contactBrand.brand_id, prosperityId);
  const rows = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(r1.contact.id);
  assert.equal(rows.length, 1);
});

test('no row in contact_brands ever has a NULL brand_id', () => {
  const { db } = setup();
  processLeadIntake(db, { sourceId: VERIFIED_SOURCE, payload: { first_name: 'A', email: 'a@example.com', lead_type: 'contact' } });
  processLeadIntake(db, { sourceId: null, payload: { first_name: 'B', email: 'b@example.com', lead_type: 'contact' } });
  processLeadIntake(db, { sourceId: VERIFIED_SOURCE, payload: { first_name: 'C', email: 'c@example.com', lead_type: 'contact', brand: 'nonsense' } });

  const nullBrandRows = db.prepare('SELECT * FROM contact_brands WHERE brand_id IS NULL').all();
  assert.equal(nullBrandRows.length, 0);
});

// ── 14. Separate opportunities remain separate cases. ───────────────────────

test('two different products for the same person open two separate cases', () => {
  const { db, prosperityId } = setup();
  processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Ellis', email: 'ellis@example.com', lead_type: 'life_insurance' },
  });
  const second = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Ellis', email: 'ellis@example.com', lead_type: 'retirement' },
  });

  const cases = db.prepare('SELECT * FROM cases WHERE contact_brand_id = ?').all(second.contactBrand.id);
  assert.equal(cases.length, 2);
  const productIds = cases.map(c => c.product_id).sort();
  assert.deepEqual(productIds, [
    getProductId(db, prosperityId, 'Life insurance'),
    getProductId(db, prosperityId, 'Rollovers and safe-money solutions'),
  ].sort());
});

// ── repeat submission for the SAME product reuses the open case (also
//    supports duplicate-case prevention, required-test #14/#18). ───────────

test('resubmitting the same product for the same person reuses the open case, not a duplicate', () => {
  const { db } = setup();
  const first = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Wren', email: 'wren@example.com', lead_type: 'life_insurance' },
  });
  const second = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Wren', email: 'wren@example.com', lead_type: 'life_insurance' },
  });

  assert.equal(first.outcome, 'created');
  assert.equal(second.outcome, 'matched');
  assert.equal(first.case.id, second.case.id);
  const cases = db.prepare('SELECT * FROM cases WHERE contact_brand_id = ?').all(first.contactBrand.id);
  assert.equal(cases.length, 1);
});

// ── 15/16. Ambiguous case enters Case Review Required; missing product does
//           not create an invalid new case. ────────────────────────────────

test('a lead type with no clean product match stages Case Review Required, not an invalid case', () => {
  const { db } = setup();
  const before = countAll(db, 'cases');
  const result = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Ibrahim', email: 'ibrahim@example.com', lead_type: 'contact' },
  });

  assert.equal(result.outcome, 'case_review_required');
  assert.equal(result.unresolvedIntake.review_type, 'case');
  assert.equal(result.unresolvedIntake.contact_brand_id, result.contactBrand.id);
  assert.equal(countAll(db, 'cases'), before, 'no case row should have been created');
});

test('a guide lead (no product mapping) also stages Case Review Required', () => {
  const { db } = setup();
  const result = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Colette', email: 'colette@example.com', lead_type: 'guide', lead_source: '13 Retirement & Rollover Mistakes to Avoid' },
  });
  assert.equal(result.outcome, 'case_review_required');
});

// ── 17. Duplicate external reference does not create a duplicate case. ─────

test('submitting the same external_ref twice resolves to the same case, not a duplicate', () => {
  const { db } = setup();
  const first = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Quinn', email: 'quinn@example.com', lead_type: 'life_insurance', external_ref: 'submission-abc-123' },
  });
  const second = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Quinn', email: 'quinn@example.com', lead_type: 'life_insurance', external_ref: 'submission-abc-123' },
  });

  assert.equal(first.case.id, second.case.id);
  const refRows = db.prepare("SELECT * FROM case_external_refs WHERE ref_value = 'submission-abc-123'").all();
  assert.equal(refRows.length, 1);
});

// ── 18. Raw intake is preserved. ────────────────────────────────────────────

test('raw intake payload is preserved on a staged unresolved_intake record', () => {
  const { db } = setup();
  const result = processLeadIntake(db, {
    sourceId: null,
    payload: { first_name: 'Harlow', email: 'harlow@example.com', lead_type: 'contact', message: 'Please call me about a policy.' },
  });

  const stored = JSON.parse(result.unresolvedIntake.raw_payload);
  assert.equal(stored.first_name, 'Harlow');
  assert.equal(stored.message, 'Please call me about a policy.');
});

// ── 19. Resolution/audit decision is recorded (staged, pending human
//         review — full resolution workflow already covered by
//         crm/test/reviewResolution.test.js). ──────────────────────────────

test('a staged record is recorded with status Pending and no decision yet', () => {
  const { db } = setup();
  const result = processLeadIntake(db, {
    sourceId: null,
    payload: { first_name: 'Reese', email: 'reese@example.com', lead_type: 'contact' },
  });

  assert.equal(result.unresolvedIntake.status, 'Pending');
  assert.equal(result.unresolvedIntake.decision, null);
  assert.equal(result.unresolvedIntake.resolved_by, null);
});

// ── 20. No sender is selected and no communication occurs. ─────────────────

test('processing a lead never selects a sender or triggers any communication', () => {
  const { db } = setup();
  processLeadIntake(db, { sourceId: VERIFIED_SOURCE, payload: { first_name: 'Uma', email: 'uma@example.com', lead_type: 'life_insurance' } });
  processLeadIntake(db, { sourceId: null, payload: { first_name: 'Vik', email: 'vik@example.com', lead_type: 'contact' } });

  assert.equal(countAll(db, 'sender_identities'), 0);
  assert.equal(countAll(db, 'sms_messages'), 0);
  assert.equal(countAll(db, 'emails'), 0);
  assert.equal(countAll(db, 'comm_calls'), 0);
});

// ── Audit trail is stamped with contact_brand_id/case_id when known. ───────

test('the communication audit row is stamped with contact_brand_id and case_id once resolved', () => {
  const { db } = setup();
  const result = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Elio', email: 'elio@example.com', lead_type: 'life_insurance', coverage_type: 'Term' },
  });

  const comm = db.prepare('SELECT * FROM communications WHERE contact_id = ?').get(result.contact.id);
  assert.equal(comm.contact_brand_id, result.contactBrand.id);
  assert.equal(comm.case_id, result.case.id);
  assert.ok(!comm.subject.includes('Term'), 'coverage/qualifier detail must never appear in the subject line');
  assert.ok(comm.body.includes('Term'), 'coverage/qualifier detail should still be preserved in the audit body');
});

// ── Health/qualifier fields never appear in the case title or subject. ─────

test('health-adjacent qualifier answers are preserved in notes but never in the case title', () => {
  const { db } = setup();
  const result = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: {
      first_name: 'Fern', email: 'fern@example.com', lead_type: 'life_insurance',
      tobacco: 'yes', health_concerns: 'diabetes',
    },
  });

  assert.ok(!String(result.case.title).toLowerCase().includes('diabetes'));
  const note = db.prepare('SELECT * FROM contact_notes WHERE contact_id = ?').get(result.contact.id);
  assert.ok(note.body.includes('diabetes'), 'qualifier answers must still be preserved for Loretta to review before the call');
});

// ── Legacy field enrichment is preserved (Unknown Caller upgrade path). ────

test('an Unknown Caller placeholder contact is upgraded by a matching lead submission', () => {
  const { db } = setup();
  const ins = db.prepare(`
    INSERT INTO contacts (first_name, last_name, phone, phone_e164, lead_type, lead_source, lead_status)
    VALUES ('Unknown Caller', NULL, '(414) 555-3344', '+14145553344', 'Unknown Caller', 'Inbound Call', 'New Lead')
  `).run();

  const result = processLeadIntake(db, {
    sourceId: VERIFIED_SOURCE,
    payload: { first_name: 'Gale', last_name: 'Norton', phone: '4145553344', email: 'gale@example.com', lead_type: 'life_insurance' },
  });

  assert.equal(result.contact.id, ins.lastInsertRowid);
  assert.equal(result.contact.first_name, 'Gale');
  assert.equal(result.contact.lead_type, 'Life Insurance Lead');
});
