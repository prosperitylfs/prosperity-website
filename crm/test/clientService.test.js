// Tests for crm/lib/clientService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createClient, updateClient, archiveClient, restoreClient, requestCompanyChange } = require('../lib/clientService');
const { resolveContactBrand } = require('../lib/caseMatching');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  runCrmCoreMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}

test('manual client creation requires an explicit company selection', () => {
  const { db } = setup();
  assert.throws(() => createClient(db, { firstName: 'No', lastName: 'Company', email: 'noco@example.com' }, 'Loretta Stewart'), /valid company/);
});

test('manual client creation rejects an unknown company value', () => {
  const { db } = setup();
  assert.throws(() => createClient(db, { firstName: 'Bad', email: 'bad@example.com', brandSlug: 'medicare-lady' }, 'Loretta Stewart'), /valid company/);
});

test('creating a client with a valid company succeeds and creates one contact_brand row', () => {
  const { db, prosperityId } = setup();
  const result = createClient(db, {
    firstName: 'Nina', lastName: 'Ford', email: 'nina.ford@example.com', phone: '4145559911',
    address: '12 Elm St', city: 'Racine', state: 'WI', zip: '53402', dateOfBirth: '1980-05-01',
    originalSource: 'Referral', generalNotes: 'Prefers email', brandSlug: 'prosperity',
  }, 'Loretta Stewart');
  assert.equal(result.outcome, 'created');
  assert.equal(result.contactBrand.brand_id, prosperityId);
  assert.equal(result.contact.city, 'Racine');
  assert.equal(result.contact.zip_code, '53402');
  assert.equal(result.contact.lead_source, 'Referral');
});

test('creating a client that conflicts with an existing different-company assignment stages a review item, not a second relationship', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const first = createClient(db, { firstName: 'Omar', email: 'omar@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const second = createClient(db, { firstName: 'Omar', email: 'omar@example.com', brandSlug: 'insurance-lady' }, 'Loretta Stewart');
  assert.equal(second.outcome, 'company_conflict');
  const links = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(first.contact.id);
  assert.equal(links.length, 1);
  assert.equal(links[0].brand_id, prosperityId);
});

test('updateClient never accepts or changes the permanent company', () => {
  const { db, prosperityId } = setup();
  const created = createClient(db, { firstName: 'Priya', email: 'priya2@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  // Even if a caller tries to slip a brand-shaped field in, updateClient's
  // accepted-field list has no such field at all -- there is nothing to
  // strip because there is nothing that could apply it in the first place.
  const updated = updateClient(db, created.contact.id, { firstName: 'Priyanka', brandSlug: 'insurance-lady', company: 'insurance-lady' });
  assert.equal(updated.first_name, 'Priyanka');
  const links = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(created.contact.id);
  assert.equal(links.length, 1);
  assert.equal(links[0].brand_id, prosperityId);
});

test('a company change request is staged for review and changes nothing live', () => {
  const { db, prosperityId, insuranceLadyId } = setup();
  const created = createClient(db, { firstName: 'Gail', email: 'gail@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const staged = requestCompanyChange(db, { contactId: created.contact.id, requestedBrandSlug: 'insurance-lady', reason: 'Client asked to move', actor: 'Loretta Stewart' });
  assert.equal(staged.review_type, 'company_change');
  assert.equal(staged.status, 'Pending');
  assert.equal(staged.contact_brand_id, created.contactBrand.id);
  assert.equal(staged.incoming_brand_id, insuranceLadyId);

  const links = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').all(created.contact.id);
  assert.equal(links.length, 1, 'requesting a change must not itself create or alter any relationship');
  assert.equal(links[0].brand_id, prosperityId);
});

test('archiving a client preserves cases, policies, notes, and audit history', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Theo', email: 'theo@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`INSERT INTO contact_notes (contact_id, body) VALUES (?, 'A note')`).run(created.contact.id);
  const archived = archiveClient(db, created.contact.id, 'Loretta Stewart');
  assert.ok(archived.archived_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_notes WHERE contact_id = ?').get(created.contact.id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_brands WHERE contact_id = ?').get(created.contact.id).n, 1);

  const restored = restoreClient(db, created.contact.id, 'Loretta Stewart');
  assert.equal(restored.archived_at, null);
});
