// Tests for crm/lib/caseService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createCaseForClient, updateCase, archiveCaseForClient, restoreCase, getCaseDeletionPreview, deleteCaseForClient } = require('../lib/caseService');
const { createClient } = require('../lib/clientService');
const { createPolicy } = require('../lib/policyService');

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

// ── Permanent case delete (2026-10-07) ──────────────────────────────────
// A case can hold one or more policies (crm/lib/policyService.js) --
// deleting a case must never take a real policy down with it. These tests
// exist specifically to prove a valid/meaningful policy can never be
// deleted this way, no matter how the case is reached.

test('getCaseDeletionPreview reports an empty case (no policies at all) as eligible', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Empty', lastName: 'Case', email: 'empty-case@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');

  const preview = getCaseDeletionPreview(db, c.id);
  assert.equal(preview.eligible, true);
  assert.equal(preview.policyCount, 0);
  assert.deepEqual(preview.policyNumbers, []);
  assert.deepEqual(preview.blockingPolicies, []);
});

test('getCaseDeletionPreview reports a case whose ONLY policy is a blank placeholder row (no carrier, no number, default Pending status) as eligible', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Blank', lastName: 'Policy', email: 'blank-policy@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id }, 'Loretta Stewart'); // every field omitted -- the exact Mae-Bell-style bug shape, minus the carrier/number

  const preview = getCaseDeletionPreview(db, c.id);
  assert.equal(preview.eligible, true);
  assert.equal(preview.policyCount, 1);
});

test('getCaseDeletionPreview blocks a case with a carrier+policy number on file, even if status is still the default Pending', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Mae', lastName: 'Example', email: 'mae-preview@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id, carrier: 'Occidental Life', policyNumber: '005178887E' }, 'Loretta Stewart');

  const preview = getCaseDeletionPreview(db, c.id);
  assert.equal(preview.eligible, false);
  assert.equal(preview.blockingPolicies.length, 1);
  assert.equal(preview.blockingPolicies[0].policyNumber, '005178887E');
  assert.deepEqual(preview.policyNumbers, ['005178887E']);
  assert.deepEqual(preview.carriers, ['Occidental Life']);
});

test('getCaseDeletionPreview blocks a case whose policy has an explicit In Force status, even if every other field happens to be blank', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'InForce', lastName: 'Only', email: 'inforce-only@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id, policyStatus: 'In Force' }, 'Loretta Stewart');

  const preview = getCaseDeletionPreview(db, c.id);
  assert.equal(preview.eligible, false, 'a deliberately-set non-default status must still block deletion');
});

test('deleteCaseForClient requires actor and explicit confirmDelete', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Guard', lastName: 'Rails', email: 'guard-rails@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  assert.throws(() => deleteCaseForClient(db, c.id, null, { confirmDelete: true }));
  assert.throws(() => deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: false }));
  assert.throws(() => deleteCaseForClient(db, c.id, 'Loretta Stewart', {}));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 1, 'none of the rejected calls above may have deleted anything');
});

test('deleteCaseForClient deletes a genuinely empty case', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Delete', lastName: 'Me', email: 'delete-me@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  const result = deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.deleted, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 0);
  // The client and its company relationship must survive untouched.
  const contactAfter = db.prepare('SELECT * FROM contacts WHERE id = ?').get(client.contact.id);
  assert.equal(contactAfter.archived_at, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_brands WHERE contact_id = ?').get(client.contact.id).n, 1);
});

test('deleteCaseForClient deletes a case whose only policy is a blank placeholder row, removing that policy along with it', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Blank', lastName: 'Delete', email: 'blank-delete@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id }, 'Loretta Stewart');

  const result = deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.policiesRemoved, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(policy.id).n, 0, 'the blank policy row is gone along with its case');
});

test('deleteCaseForClient REFUSES to delete a case with a real policy on file (Mae Bell shape) -- the policy and case both survive untouched', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Mae', lastName: 'Example', email: 'mae-delete@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Life insurance' }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: c.id, carrier: 'Occidental Life', policyNumber: '005178887E', policyStatus: 'In Force' }, 'Loretta Stewart');

  assert.throws(
    () => deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true }),
    /005178887E/,
    'the error must name the specific blocking policy'
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(c.id).n, 1, 'the case must still exist');
  const policyAfter = db.prepare('SELECT * FROM policies WHERE id = ?').get(policy.id);
  assert.equal(policyAfter.carrier, 'Occidental Life');
  assert.equal(policyAfter.policy_number, '005178887E');
  assert.equal(policyAfter.policy_status, 'In Force');
});

test('deleteCaseForClient REFUSES to delete a case with even ONE meaningful policy among several (mixed case)', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Mixed', lastName: 'Policies', email: 'mixed-policies@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  createPolicy(db, { caseId: c.id }, 'Loretta Stewart'); // blank
  const realPolicy = createPolicy(db, { caseId: c.id, carrier: 'Real Carrier', policyNumber: 'REAL-1' }, 'Loretta Stewart');

  assert.throws(() => deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true }));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM policies WHERE id = ?').get(realPolicy.id).n, 1, 'the real policy must survive');
});

test('deleteCaseForClient only deletes the ONE selected case, never a different case under the same client', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Two', lastName: 'Cases', email: 'two-cases@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const emptyCase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance'), title: 'Empty one' }, 'Loretta Stewart');
  const otherCase = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Annuities'), title: 'Keep me' }, 'Loretta Stewart');
  createPolicy(db, { caseId: otherCase.id, carrier: 'Keep Carrier', policyNumber: 'KEEP-1' }, 'Loretta Stewart');

  deleteCaseForClient(db, emptyCase.id, 'Loretta Stewart', { confirmDelete: true });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(emptyCase.id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cases WHERE id = ?').get(otherCase.id).n, 1, 'the unrelated case must be completely unaffected');
});

test('deleteCaseForClient never deletes the client itself -- only the case and its policies', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'Client', lastName: 'Survives', email: 'client-survives@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE id = ?').get(client.contact.id).n, 1, 'the client contact row must still exist');
});

test('deleteCaseForClient clears (not deletes) stray case_id references in downstream tables that have no ON DELETE action, instead of throwing a foreign key error', () => {
  const { db, prosperityId } = setup();
  const client = createClient(db, { firstName: 'FkRef', lastName: 'Test', email: 'fk-ref-test@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const c = createCaseForClient(db, { contactId: client.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  const note = db.prepare('INSERT INTO contact_notes (contact_id, body, case_id) VALUES (?, ?, ?)').run(client.contact.id, 'A note tied to this case', c.id);
  const task = db.prepare("INSERT INTO follow_up_tasks (contact_id, task_type, due_date, case_id) VALUES (?, 'Call', '2026-10-10', ?)").run(client.contact.id, c.id);

  deleteCaseForClient(db, c.id, 'Loretta Stewart', { confirmDelete: true });

  const noteAfter = db.prepare('SELECT * FROM contact_notes WHERE id = ?').get(note.lastInsertRowid);
  const taskAfter = db.prepare('SELECT * FROM follow_up_tasks WHERE id = ?').get(task.lastInsertRowid);
  assert.ok(noteAfter, 'the note itself must survive, only losing its case association');
  assert.equal(noteAfter.case_id, null);
  assert.ok(taskAfter, 'the task itself must survive, only losing its case association');
  assert.equal(taskAfter.case_id, null);
});

test('deleteCaseForClient rejects a nonexistent case id', () => {
  const { db } = setup();
  assert.throws(() => deleteCaseForClient(db, 999999, 'Loretta Stewart', { confirmDelete: true }));
});
