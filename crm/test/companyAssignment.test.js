// Tests for the permanent-company rule enforced inside
// crm/lib/leadIntake.js's processLeadIntake(): a contact keeps ONE active
// originating company for active business. A verified source resolving to a
// DIFFERENT brand than a contact's existing active relationship must never
// silently create a second active relationship, transfer the contact, or
// send anything — it must stage a company-assignment conflict for
// deliberate, audited review instead. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { processLeadIntake } = require('../lib/leadIntake');
const { resolveContactBrand } = require('../lib/caseMatching');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

const PROSPERITY_SOURCE = 'prosperity-website';
const IL_SOURCE = 'test-il-source';

// This suite needs a verified source that resolves to Insurance Lady to
// exercise the conflict path — Phase 1's real crm/config/leadSources.js
// intentionally has no such source yet (Insurance Lady isn't wired to any
// real caller). Simulated via processLeadIntake's
// deps.resolveBrandSlugForSource injection point (the same substitution
// pattern crm/lib/leadSubmission.js uses for deps.verifyTurnstile) — this
// never mutates crm/config/leadSources.js's real, shared exports, so there
// is no risk of leaking a fake source mapping into any other test file.
const { resolveBrandSlugForSource: realResolve } = require('../config/leadSources');
const SIMULATED_IL_DEPS = {
  resolveBrandSlugForSource: (id) => (id === IL_SOURCE ? 'insurance-lady' : realResolve(id)),
};
function intake(db, args) {
  return processLeadIntake(db, args, SIMULATED_IL_DEPS);
}

test('a brand-new contact establishes Prosperity with no conflict', () => {
  const { db, prosperityId } = setup();
  const result = intake(db, {
    sourceId: PROSPERITY_SOURCE,
    payload: { first_name: 'Amara', email: 'amara@example.com', lead_type: 'life_insurance' },
  });
  assert.equal(result.outcome, 'created');
  assert.equal(result.contactBrand.brand_id, prosperityId);
});

test('a repeat lead for the same brand is never treated as a conflict', () => {
  const { db } = setup();
  const first = intake(db, {
    sourceId: PROSPERITY_SOURCE,
    payload: { first_name: 'Beau', email: 'beau@example.com', lead_type: 'life_insurance' },
  });
  const second = intake(db, {
    sourceId: PROSPERITY_SOURCE,
    payload: { first_name: 'Beau', email: 'beau@example.com', lead_type: 'retirement' },
  });
  assert.equal(first.outcome, 'created');
  assert.notEqual(second.outcome, 'company_conflict');
  assert.equal(second.contactBrand.id, first.contactBrand.id);
});

test('a verified conflicting incoming company source stages a company_conflict review item, not a second relationship', () => {
  const { db } = setup();
  const first = intake(db, {
    sourceId: PROSPERITY_SOURCE,
    payload: { first_name: 'Casey', last_name: 'Nolan', email: 'casey@example.com', lead_type: 'life_insurance' },
  });
  assert.equal(first.outcome, 'created');

  const second = intake(db, {
    sourceId: IL_SOURCE,
    payload: { first_name: 'Casey', last_name: 'Nolan', email: 'casey@example.com', lead_type: 'life_insurance' },
  });

  assert.equal(second.outcome, 'company_conflict');
  assert.equal(second.contact.id, first.contact.id);
  assert.equal(second.unresolvedIntake.review_type, 'company_conflict');
});

test('conflicting source never silently creates a second active contact_brands row', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const first = intake(db, {
    sourceId: PROSPERITY_SOURCE,
    payload: { first_name: 'Dev', email: 'dev@example.com', lead_type: 'life_insurance' },
  });
  intake(db, {
    sourceId: IL_SOURCE,
    payload: { first_name: 'Dev', email: 'dev@example.com', lead_type: 'life_insurance' },
  });

  const links = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(first.contact.id);
  assert.equal(links.length, 1, 'only the original Prosperity relationship must exist');
  assert.equal(links[0].brand_id, prosperityId);
  assert.notEqual(links[0].brand_id, insuranceLadyId);
});

test('conflicting source never transfers the client — the original relationship is untouched', () => {
  const { db, prosperityId } = setup();
  const first = intake(db, {
    sourceId: PROSPERITY_SOURCE,
    payload: { first_name: 'Elle', email: 'elle@example.com', lead_type: 'life_insurance' },
  });
  const originalLink = db.prepare('SELECT * FROM contact_brands WHERE id = ?').get(first.contactBrand.id);

  intake(db, {
    sourceId: IL_SOURCE,
    payload: { first_name: 'Elle', email: 'elle@example.com', lead_type: 'life_insurance' },
  });

  const afterLink = db.prepare('SELECT * FROM contact_brands WHERE id = ?').get(first.contactBrand.id);
  assert.equal(afterLink.brand_id, originalLink.brand_id);
  assert.equal(afterLink.brand_id, prosperityId);
  assert.equal(afterLink.status, 'Active');
});

test('conflicting source preserves raw intake and external reference on the staged record', () => {
  const { db } = setup();
  intake(db, {
    sourceId: PROSPERITY_SOURCE,
    payload: { first_name: 'Farah', email: 'farah@example.com', lead_type: 'life_insurance' },
  });
  const second = intake(db, {
    sourceId: IL_SOURCE,
    payload: { first_name: 'Farah', email: 'farah@example.com', lead_type: 'life_insurance', external_ref: 'il-app-9981', ref_type: 'back9_application_id' },
  });

  const stored = JSON.parse(second.unresolvedIntake.raw_payload);
  assert.equal(stored.first_name, 'Farah');
  assert.equal(stored.external_ref, 'il-app-9981');
  assert.equal(second.unresolvedIntake.ref_value, 'il-app-9981');
  assert.equal(second.unresolvedIntake.ref_type, 'back9_application_id');
});

test('the conflict record shows both the existing company and the incoming source company', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const first = intake(db, {
    sourceId: PROSPERITY_SOURCE,
    payload: { first_name: 'Gio', email: 'gio@example.com', lead_type: 'life_insurance' },
  });
  const second = intake(db, {
    sourceId: IL_SOURCE,
    payload: { first_name: 'Gio', email: 'gio@example.com', lead_type: 'life_insurance' },
  });

  assert.equal(second.unresolvedIntake.contact_brand_id, first.contactBrand.id, 'contact_brand_id must point at the EXISTING relationship');
  assert.equal(second.unresolvedIntake.incoming_brand_id, insuranceLadyId, 'incoming_brand_id must point at the NEW source company');
});

test('no communication table gains a row as a result of a company conflict', () => {
  const { db } = setup();
  intake(db, {
    sourceId: PROSPERITY_SOURCE,
    payload: { first_name: 'Hana', email: 'hana@example.com', lead_type: 'life_insurance' },
  });
  intake(db, {
    sourceId: IL_SOURCE,
    payload: { first_name: 'Hana', email: 'hana@example.com', lead_type: 'life_insurance' },
  });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sms_messages').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM emails').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comm_calls').get().n, 0);
});

test('a pre-existing dual-brand relationship (created directly, not via intake) is left untouched — the schema itself still supports it', () => {
  // Historical/administrative dual-brand contacts (e.g. Loretta manually
  // linking a household member to both businesses) remain fully supported
  // at the schema/helper level — resolveContactBrand() itself is unchanged.
  // This rule only governs what processLeadIntake() does automatically at
  // INTAKE time going forward.
  const { db, prosperityId, insuranceLadyId } = setup();
  const contact = db.prepare(`INSERT INTO contacts (first_name, email) VALUES ('Dual', 'dual@example.com')`).run();
  resolveContactBrand(db, { contactId: contact.lastInsertRowid, brandId: prosperityId });
  resolveContactBrand(db, { contactId: contact.lastInsertRowid, brandId: insuranceLadyId });

  const links = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(contact.lastInsertRowid);
  assert.equal(links.length, 2);
});
