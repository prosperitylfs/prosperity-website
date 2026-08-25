// Tests for crm/lib/clientService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { createClient, updateClient, archiveClient, restoreClient, requestCompanyChange, RELATIONSHIP_TYPES } = require('../lib/clientService');
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

// ── SMS/email consent recording (Revenue MVP: manually-added clients must
//    be markable as consented, or Text/Email can never be used for them) ──

test('a manually-created client defaults to no SMS consent', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Nora', email: 'nora@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.equal(created.contact.sms_consent, 0);
});

test('sms_consent can be granted at creation time', () => {
  const { db } = setup();
  const created = createClient(db, {
    firstName: 'Wes', email: 'wes@example.com', brandSlug: 'prosperity', smsConsent: true,
    smsConsentSource: 'Website Form',
  }, 'Loretta Stewart');
  assert.equal(created.contact.sms_consent, 1);
});

test('sms_consent can be granted later via updateClient', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Bea', email: 'bea@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.equal(created.contact.sms_consent, 0);
  const updated = updateClient(db, created.contact.id, { smsConsent: true });
  assert.equal(updated.sms_consent, 1);
});

test('sms_consent can be revoked via updateClient (explicit false, not just "not sent")', () => {
  const { db } = setup();
  const created = createClient(db, {
    firstName: 'Cole', email: 'cole@example.com', brandSlug: 'prosperity', smsConsent: true,
    smsConsentSource: 'Verbal Consent',
  }, 'Loretta Stewart');
  assert.equal(created.contact.sms_consent, 1);
  const updated = updateClient(db, created.contact.id, { smsConsent: false });
  assert.equal(updated.sms_consent, 0);
});

test('updateClient calls that never mention smsConsent leave the existing value untouched', () => {
  const { db } = setup();
  const created = createClient(db, {
    firstName: 'Dee', email: 'dee@example.com', brandSlug: 'prosperity', smsConsent: true,
    smsConsentSource: 'Website Form',
  }, 'Loretta Stewart');
  const updated = updateClient(db, created.contact.id, { firstName: 'Deandra' });
  assert.equal(updated.sms_consent, 1, 'an update that never mentions consent must not silently reset it');
});

// ── relationship_type (Lead/Prospect, Active/Former Client, Prior/Declined
//    Applicant) ───────────────────────────────────────────────────────────
// Independent of lead_type, which is untouched by this feature and keeps
// its existing source/history role. Stored as free TEXT (no CHECK
// constraint — crm/db/database.js) specifically so this list can keep
// growing without ever requiring a schema change.

test('relationship_type defaults to null (no relationship asserted) and can be set to active_client at creation', () => {
  const { db } = setup();
  const noRelationship = createClient(db, { firstName: 'Ivy', email: 'ivy@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.equal(noRelationship.contact.relationship_type, null);

  const client = createClient(db, {
    firstName: 'Jon', email: 'jon@example.com', brandSlug: 'prosperity', relationshipType: 'active_client',
  }, 'Loretta Stewart');
  assert.equal(client.contact.relationship_type, 'active_client');
});

test('every approved relationship_type value round-trips through createClient', () => {
  const { db } = setup();
  for (const value of RELATIONSHIP_TYPES) {
    const created = createClient(db, {
      firstName: 'Val', email: `val-${value}@example.com`, brandSlug: 'prosperity', relationshipType: value,
    }, 'Loretta Stewart');
    assert.equal(created.contact.relationship_type, value);
  }
});

test('an unknown relationshipType value is rejected', () => {
  const { db } = setup();
  assert.throws(
    () => createClient(db, { firstName: 'Bad', email: 'badrel@example.com', brandSlug: 'prosperity', relationshipType: 'vip' }, 'Loretta Stewart'),
    /unknown relationshipType/
  );
});

test('marking a contact as Active Client does NOT itself grant SMS consent', () => {
  const { db } = setup();
  const created = createClient(db, {
    firstName: 'Kim', email: 'kim@example.com', brandSlug: 'prosperity', relationshipType: 'active_client',
  }, 'Loretta Stewart');
  assert.equal(created.contact.relationship_type, 'active_client');
  assert.equal(created.contact.sms_consent, 0, 'relationship_type and sms_consent must stay fully independent');
  assert.equal(created.contact.sms_consent_source, null);
});

test('RELATIONSHIP_TYPES exposes exactly the five approved values, in order', () => {
  assert.deepEqual(RELATIONSHIP_TYPES, ['lead', 'active_client', 'former_client', 'prior_applicant', 'declined_applicant']);
});

// ── SMS consent audit trail (source / at / notes) ────────────────────────

test('creating a client with SMS consent checked requires a consent source', () => {
  const { db } = setup();
  assert.throws(
    () => createClient(db, { firstName: 'No', lastName: 'Source', email: 'nosource@example.com', brandSlug: 'prosperity', smsConsent: true }, 'Loretta Stewart'),
    /sms_consent_source is required/
  );
});

test('creating a client with SMS consent unchecked never requires a consent source', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Off', email: 'off@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.equal(created.contact.sms_consent, 0);
  assert.equal(created.contact.sms_consent_source, null);
  assert.equal(created.contact.sms_consent_at, null);
});

test('granting SMS consent at creation stores the source and auto-stamps sms_consent_at to now (never client-supplied)', () => {
  const { db } = setup();
  const before = new Date();
  const created = createClient(db, {
    firstName: 'Amy', email: 'amyconsent@example.com', brandSlug: 'prosperity',
    smsConsent: true, smsConsentSource: 'Phone – Renee', smsConsentNotes: 'Verbally confirmed on inbound call',
  }, 'Loretta Stewart');
  assert.equal(created.contact.sms_consent, 1);
  assert.equal(created.contact.sms_consent_source, 'Phone – Renee');
  assert.equal(created.contact.sms_consent_notes, 'Verbally confirmed on inbound call');
  assert.ok(created.contact.sms_consent_at, 'sms_consent_at must be auto-stamped');
  const stamped = new Date(created.contact.sms_consent_at.replace(' ', 'T') + 'Z');
  assert.ok(stamped.getTime() >= before.getTime() - 5000, 'consent date must be "now", never fabricated/backdated');
});

test('updateClient can grant SMS consent WITHOUT a source (existing Edit Client modal has no source field yet)', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Gus', email: 'gus@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const updated = updateClient(db, created.contact.id, { smsConsent: true });
  assert.equal(updated.sms_consent, 1);
  assert.equal(updated.sms_consent_source, null, 'no source was supplied and none is fabricated');
  assert.ok(updated.sms_consent_at, 'the transition is still auto-stamped even without a source');
});

test('sms_consent_at is stamped only on a genuine false->true transition, never on an unrelated update or a resend of the same true value', () => {
  const { db } = setup();
  const created = createClient(db, {
    firstName: 'Tia', email: 'tia@example.com', brandSlug: 'prosperity', smsConsent: true, smsConsentSource: 'Inbound SMS',
  }, 'Loretta Stewart');
  const firstStamp = created.contact.sms_consent_at;
  assert.ok(firstStamp);

  // Resubmitting smsConsent: true (already true) must not move the stamp.
  const resent = updateClient(db, created.contact.id, { smsConsent: true, smsConsentSource: 'Inbound SMS' });
  assert.equal(resent.sms_consent_at, firstStamp, 're-sending an already-true consent must not re-stamp the date');

  // An unrelated field update must not touch it either.
  const unrelated = updateClient(db, created.contact.id, { firstName: 'Tiana' });
  assert.equal(unrelated.sms_consent_at, firstStamp);
});

test('an existing pre-migration contact (sms_consent already 1, no source/date on file) is never backfilled by an unrelated update', () => {
  const { db, prosperityId } = setup();
  // Simulate a contact that existed before this feature shipped: sms_consent
  // is already 1 but sms_consent_source/_at are NULL, exactly like a real
  // production row would look immediately after the new columns are added.
  const created = createClient(db, { firstName: 'Old', lastName: 'Record', email: 'oldrecord@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare('UPDATE contacts SET sms_consent = 1, sms_consent_source = NULL, sms_consent_at = NULL WHERE id = ?').run(created.contact.id);

  const updated = updateClient(db, created.contact.id, { firstName: 'Oldest' });
  assert.equal(updated.sms_consent, 1);
  assert.equal(updated.sms_consent_source, null, 'must not fabricate a source for a pre-existing record');
  assert.equal(updated.sms_consent_at, null, 'must not backdate/fabricate a consent date for a pre-existing record');
});

test('email_consent follows the same explicit-tri-state rule as sms_consent', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Fay', email: 'fay@example.com', brandSlug: 'prosperity', emailConsent: true }, 'Loretta Stewart');
  assert.equal(created.contact.email_consent, 1);
  const updated = updateClient(db, created.contact.id, { emailConsent: false });
  assert.equal(updated.email_consent, 0);
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
