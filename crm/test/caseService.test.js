// Tests for crm/lib/caseService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createCaseForClient, updateCase, archiveCaseForClient, restoreCase } = require('../lib/caseService');
const { createClient } = require('../lib/clientService');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  runCrmCoreMigrations(db);
  return { db, insuranceLadyId, prosperityId };
}
function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

test('a new case inherits the client permanent company and never creates a second company assignment', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Wren', email: 'wren2@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const productId = getProductId(db, prosperityId, 'Life insurance');
  const newCase = createCaseForClient(db, { contactId: client.contact.id, productId, title: 'Life insurance' }, 'Loretta Stewart');
  assert.equal(newCase.contact_brand_id, client.contactBrand.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_brands WHERE contact_id = ?').get(client.contact.id).n, 1);
});

test('separate opportunities remain separate cases', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Ivy', email: 'ivy@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const life = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const annuity = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Annuities') }, 'Loretta Stewart');
  assert.notEqual(life.id, annuity.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE contact_brand_id = ?').get(client.contactBrand.id).n, 2);
});

test('duplicate external references remain blocked for manual case creation', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Kian', email: 'kian@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), externalRef: 'ref-001' }, 'Loretta Stewart');
  assert.throws(() => createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Annuities'), externalRef: 'ref-001' }, 'Loretta Stewart'), /already belongs to case/);
});

test('archiving one case affects only that case', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Lior', email: 'lior@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const life = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const annuity = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Annuities') }, 'Loretta Stewart');
  archiveCaseForClient(db, life.id, 'Loretta Stewart');
  const lifeAfter = db.prepare('SELECT * FROM cases WHERE id = ?').get(life.id);
  const annuityAfter = db.prepare('SELECT * FROM cases WHERE id = ?').get(annuity.id);
  assert.equal(lifeAfter.status, 'Archived');
  assert.equal(annuityAfter.status, 'Open');
  const clientAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(clientAfter.archived_at, null, 'archiving a case must never archive the client');
});

test('restoring a case sets it back to Open', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Mira', email: 'mira@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  archiveCaseForClient(db, c.id, 'Loretta Stewart');
  const restored = restoreCase(db, c.id, 'Loretta Stewart');
  assert.equal(restored.status, 'Open');
  assert.equal(restored.closed_at, null);
});

test('updateCase edits product/status/title but never the contact_brand_id', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Noor', email: 'noor@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const updated = updateCase(db, c.id, { title: 'Updated title', contactBrandId: 999999 });
  assert.equal(updated.title, 'Updated title');
  assert.equal(updated.contact_brand_id, client.contactBrand.id);
});
