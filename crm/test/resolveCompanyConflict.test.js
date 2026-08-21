// Tests for crm/lib/reviewResolution.js's resolveCompanyConflict() and
// archiveReviewItem() — added for the "CRM Core Functionality Completion"
// checkpoint. In-memory databases only. A separate file from the
// already-approved crm/test/reviewResolution.test.js, left untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { resolveCompanyConflict, archiveReviewItem } = require('../lib/reviewResolution');
const { createClient, requestCompanyChange } = require('../lib/clientService');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

function insertConflict(db, contactId, contactBrandId, incomingBrandId, reviewType = 'company_conflict') {
  const result = db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, candidate_contact_id, reason, status, review_type, contact_brand_id, incoming_brand_id)
    VALUES ('test-il-source', ?, ?, 'conflict', 'Pending', ?, ?, ?)
  `).run(JSON.stringify({ first_name: 'Test' }), contactId, reviewType, contactBrandId, incomingBrandId);
  return db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(result.lastInsertRowid);
}

test('keep_existing resolves the item without touching contact_brands and without relabeling incoming_brand_id', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const client = createClient(db, { firstName: 'Jonas', email: 'jonas@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const intake = insertConflict(db, client.contact.id, client.contactBrand.id, insuranceLadyId);

  const result = resolveCompanyConflict(db, { intakeId: intake.id, action: 'keep_existing', actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'kept_existing');
  assert.equal(result.intake.status, 'Resolved');
  assert.equal(result.intake.decision, 'keep_existing_company');
  // Both sides of the comparison are preserved -- incoming_brand_id is
  // never rewritten to match the kept company.
  assert.equal(result.intake.contact_brand_id, client.contactBrand.id);
  assert.equal(result.intake.incoming_brand_id, insuranceLadyId);

  const links = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(client.contact.id);
  assert.equal(links.length, 1);
  assert.equal(links[0].brand_id, prosperityId);
});

test('there is no transfer action -- only keep_existing and test_archive are implemented', () => {
  const { db, insuranceLadyId } = setup();
  const client = createClient(db, { firstName: 'Kara', email: 'kara@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const intake = insertConflict(db, client.contact.id, client.contactBrand.id, insuranceLadyId);
  assert.throws(() => resolveCompanyConflict(db, { intakeId: intake.id, action: 'transfer', actor: 'Loretta Stewart' }), /unknown action/);
});

test('test_archive archives the conflict without any brand resolution', () => {
  const { db, insuranceLadyId } = setup();
  const client = createClient(db, { firstName: 'Lena', email: 'lena@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const intake = insertConflict(db, client.contact.id, client.contactBrand.id, insuranceLadyId);
  const result = resolveCompanyConflict(db, { intakeId: intake.id, action: 'test_archive', actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'archived');
  assert.equal(result.intake.status, 'Archived');
});

test('resolveCompanyConflict also resolves a manually-requested company_change item, keeping both sides intact', () => {
  const { db, insuranceLadyId } = setup();
  const client = createClient(db, { firstName: 'Milo', email: 'milo@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const staged = requestCompanyChange(db, { contactId: client.contact.id, requestedBrandSlug: 'insurance-lady', reason: 'client request', actor: 'Loretta Stewart' });
  assert.equal(staged.review_type, 'company_change');

  const result = resolveCompanyConflict(db, { intakeId: staged.id, action: 'keep_existing', actor: 'Loretta Stewart' });
  assert.equal(result.outcome, 'kept_existing');
  assert.equal(result.intake.incoming_brand_id, insuranceLadyId, 'the requested company must remain visible in the resolved audit record');
});

test('rejects resolving an intake that is not a company_conflict/company_change item', () => {
  const { db } = setup();
  const result = db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type)
    VALUES ('x', '{}', 'x', 'Pending', 'brand')
  `).run();
  assert.throws(() => resolveCompanyConflict(db, { intakeId: result.lastInsertRowid, action: 'keep_existing', actor: 'Loretta Stewart' }), /not a company-conflict/);
});

test('archiveReviewItem archives any pending review item regardless of type', () => {
  const { db } = setup();
  const result = db.prepare(`
    INSERT INTO unresolved_intake (source, raw_payload, reason, status, review_type)
    VALUES ('x', '{}', 'ambiguous', 'Pending', 'case')
  `).run();
  const outcome = archiveReviewItem(db, { intakeId: result.lastInsertRowid, actor: 'Loretta Stewart' });
  assert.equal(outcome.outcome, 'archived');
  assert.equal(outcome.intake.resolved_by, 'Loretta Stewart');
});

test('every resolution records date, actor, and previous/resulting state', () => {
  const { db, insuranceLadyId } = setup();
  const client = createClient(db, { firstName: 'Nash', email: 'nash@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const intake = insertConflict(db, client.contact.id, client.contactBrand.id, insuranceLadyId);
  const result = resolveCompanyConflict(db, { intakeId: intake.id, action: 'keep_existing', actor: 'Loretta Stewart' });
  assert.ok(result.intake.resolved_at);
  assert.equal(result.intake.resolved_by, 'Loretta Stewart');
  assert.equal(result.intake.reason, 'conflict'); // original reason (previous state) preserved verbatim
  assert.equal(result.intake.decision, 'keep_existing_company'); // resulting state
});
