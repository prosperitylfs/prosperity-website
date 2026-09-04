// Tests for crm/lib/clientService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { createClient, updateClient, archiveClient, restoreClient, deleteClientPermanently, requestCompanyChange, RELATIONSHIP_TYPES } = require('../lib/clientService');
const { resolveContactBrand } = require('../lib/caseMatching');
const { createCaseForClient } = require('../lib/caseService');
const { createPolicy } = require('../lib/policyService');
const { matchOrCreateCase, stageUnresolvedIntake } = require('../lib/caseMatching');

function setup() {
  const db = createLegacyDb();
  const { insuranceLadyId, prosperityId } = runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  runCrmCoreMigrations(db);
  runRevenueMvpMigrations(db);
  // legacyDb.js deliberately omits retirement_intakes (see
  // test/retirementIntakeService.test.js's own setup) -- created inline
  // here, identically, so the delete tests below can cover it too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS retirement_intakes (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id     INTEGER NOT NULL,
      appointment_id INTEGER NOT NULL,
      token          TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'Not Sent',
      sent_at        DATETIME,
      completed_at   DATETIME,
      responses_json TEXT,
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (contact_id)     REFERENCES contacts(id)     ON DELETE CASCADE,
      FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE
    );
  `);
  return { db, insuranceLadyId, prosperityId };
}

function getProductId(db, brandId, name) {
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brandId, name).id;
}

// Every table that can hold a row keyed to a contact_id, used to assert "no
// orphaned records remain" after a permanent delete in one place rather
// than repeating the same list in every test below.
const ALL_CONTACT_TABLES = [
  'communications', 'comm_calls', 'sms_messages', 'emails', 'contact_notes',
  'follow_up_tasks', 'appointments', 'activities', 'retirement_intakes',
  'communication_drafts', 'contact_brands',
];
function countAllContactRows(db, contactId) {
  const counts = {};
  for (const table of ALL_CONTACT_TABLES) {
    counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE contact_id = ?`).get(contactId).n;
  }
  return counts;
}
function assertNoRowsRemain(counts, label) {
  for (const [table, n] of Object.entries(counts)) {
    assert.equal(n, 0, `${label}: ${table} still has ${n} row(s) referencing the deleted contact`);
  }
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

// Email Consent was removed as a CRM concept entirely (2026-09-14) -- the
// email_consent COLUMN still exists (crm/db/database.js, never dropped),
// but createClient/updateClient no longer accept or write it, even if a
// caller sends it. sms_consent is completely unaffected.
test('emailConsent is no longer accepted by createClient/updateClient even if a caller sends it -- sms_consent is unaffected', () => {
  const { db } = setup();
  const created = createClient(db, {
    firstName: 'Fay', email: 'fay@example.com', brandSlug: 'prosperity',
    emailConsent: true, smsConsent: true, smsConsentSource: 'Website Form',
  }, 'Loretta Stewart');
  assert.equal(created.contact.email_consent, 0, 'email_consent is never written anymore, regardless of what was sent');
  assert.equal(created.contact.sms_consent, 1, 'sms_consent is completely unaffected by the email_consent removal');

  const updated = updateClient(db, created.contact.id, { emailConsent: true });
  assert.equal(updated.email_consent, 0, 'still never written on update either');
  assert.equal(updated.sms_consent, 1, 'unrelated update never resets sms_consent');
});

// ── Edit Client expansion (2026-09-08): the full "complete contact profile"
//    field set, minus lead_type (source/history, never editable) and every
//    case/policy-shaped or purely historical/activity column ────────────

test('updateClient accepts every new profile field and round-trips them exactly', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Nadia', email: 'nadia@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const updated = updateClient(db, created.contact.id, {
    middleName: 'R', homePhone: '414-555-2000', altPhone: '414-555-2001',
    preferredContactMethod: 'Text', bestTimeToContact: 'Evenings',
    age: '54', maritalStatus: 'Married', spouseName: 'Pat Nadia', spouseDateOfBirth: '1974-03-02',
    numberOfChildren: '2', numberOfGrandchildren: '1', familyNotes: 'Two kids in college',
    occupation: 'Teacher', employer: 'MPS', referredBy: 'Existing client Renee',
    leadStatus: 'Client',
  });
  assert.equal(updated.middle_name, 'R');
  assert.equal(updated.home_phone, '414-555-2000');
  assert.equal(updated.alt_phone, '414-555-2001');
  assert.equal(updated.preferred_contact_method, 'Text');
  assert.equal(updated.best_time_to_contact, 'Evenings');
  assert.equal(updated.age, 54);
  assert.equal(updated.marital_status, 'Married');
  assert.equal(updated.spouse_name, 'Pat Nadia');
  assert.equal(updated.spouse_date_of_birth, '1974-03-02');
  assert.equal(updated.number_of_children, 2);
  assert.equal(updated.number_of_grandchildren, 1);
  assert.equal(updated.family_notes, 'Two kids in college');
  assert.equal(updated.occupation, 'Teacher');
  assert.equal(updated.employer, 'MPS');
  assert.equal(updated.referred_by, 'Existing client Renee');
  assert.equal(updated.lead_status, 'Client');
});

test('updateClient leaves every new profile field untouched when the request never mentions them', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Otis', email: 'otis@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  updateClient(db, created.contact.id, { occupation: 'Electrician', numberOfChildren: '3' });
  const untouched = updateClient(db, created.contact.id, { firstName: 'Otis Jr' });
  assert.equal(untouched.occupation, 'Electrician');
  assert.equal(untouched.number_of_children, 3);
});

// ── Retirement & Annuity Planning (2026-09-09, restoring the old standalone
//    CRM's client-detail sections) ─────────────────────────────────────────

test('updateClient accepts every retirement-planning field and round-trips them exactly', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Reba', email: 'reba@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const updated = updateClient(db, created.contact.id, {
    retirementAccountType: '401(k)', currentInstitution: 'Fidelity',
    estimatedRolloverAmount: '250000.50', retirementTimeline: '1-3 Years',
    hasCurrentAdvisor: true, interestedInRothConversion: true,
    retirementDateGoal: '2030-06-01',
  });
  assert.equal(updated.retirement_account_type, '401(k)');
  assert.equal(updated.current_institution, 'Fidelity');
  assert.equal(updated.estimated_rollover_amount, 250000.5);
  assert.equal(updated.retirement_timeline, '1-3 Years');
  assert.equal(updated.has_current_advisor, 1);
  assert.equal(updated.interested_in_roth_conversion, 1);
  assert.equal(updated.retirement_date_goal, '2030-06-01');
});

test('updateClient accepts the annuity PLANNING fields (type, income goal, surrender period, income rider)', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Saul', email: 'saul@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const updated = updateClient(db, created.contact.id, {
    annuityType: 'Fixed Indexed Annuity (FIA)', estimatedIncome: '18000', surrenderPeriod: '7 years', incomeRider: true,
  });
  assert.equal(updated.annuity_type, 'Fixed Indexed Annuity (FIA)');
  assert.equal(updated.estimated_income, 18000);
  assert.equal(updated.surrender_period, '7 years');
  assert.equal(updated.income_rider, 1);
});

test('updateClient never accepts insurance_company/policy_type/face_amount/premiums/policy_status/dates or annuity_carrier/annuity_premium -- these are superseded by the Policies module, not the client profile', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Tara', email: 'tara@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`
    UPDATE contacts SET insurance_company = 'Legacy Co', policy_type = 'Term Life', face_amount = 100000,
      annuity_carrier = 'Legacy Annuity Co', annuity_premium = 5000
    WHERE id = ?
  `).run(created.contact.id);
  const updated = updateClient(db, created.contact.id, {
    insuranceCompany: 'New Co', policyType: 'Whole Life', faceAmount: '999999',
    annuityCarrier: 'New Annuity Co', annuityPremium: '1',
    firstName: 'Tara Marie',
  });
  assert.equal(updated.first_name, 'Tara Marie');
  assert.equal(updated.insurance_company, 'Legacy Co', 'must be completely unaffected -- not an accepted field');
  assert.equal(updated.policy_type, 'Term Life');
  assert.equal(updated.face_amount, 100000);
  assert.equal(updated.annuity_carrier, 'Legacy Annuity Co');
  assert.equal(updated.annuity_premium, 5000);
});

test('a blank estimated rollover/income amount leaves the existing value unchanged, matching every other numeric profile field', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Uma', email: 'uma@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  updateClient(db, created.contact.id, { estimatedRolloverAmount: '100000', estimatedIncome: '9000' });
  const unchanged = updateClient(db, created.contact.id, { estimatedRolloverAmount: '', estimatedIncome: '' });
  assert.equal(unchanged.estimated_rollover_amount, 100000);
  assert.equal(unchanged.estimated_income, 9000);
});

test('updateClient never accepts or writes lead_type -- it stays a source/history field, not part of the editable profile', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Pam', email: 'pam@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`UPDATE contacts SET lead_type = 'Retirement Guide Lead' WHERE id = ?`).run(created.contact.id);
  const updated = updateClient(db, created.contact.id, { leadType: 'Existing Client', firstName: 'Pamela' });
  assert.equal(updated.first_name, 'Pamela');
  assert.equal(updated.lead_type, 'Retirement Guide Lead', 'lead_type must be completely unaffected -- it is not an accepted field at all');
});

test('a blank/empty numeric profile field leaves the existing value unchanged rather than writing 0', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Quinn', email: 'quinn@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  updateClient(db, created.contact.id, { age: '40' });
  const stillForty = updateClient(db, created.contact.id, { age: '' });
  assert.equal(stillForty.age, 40, 'an empty string must COALESCE to "unchanged", matching every other field here');
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

// ── Permanent delete (Delete Client) ─────────────────────────────────────
// Separate, permanent, irreversible -- distinct from archive above, which
// stays exactly as it was and is untouched by any of this.

test('deleteClientPermanently requires an explicit confirmDelete flag', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Deleteless', email: 'deleteless@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => deleteClientPermanently(db, created.contact.id, 'Loretta Stewart', {}), /confirmation is required/);
  assert.throws(() => deleteClientPermanently(db, created.contact.id, 'Loretta Stewart', { confirmDelete: false }), /confirmation is required/);
  // Nothing was deleted by either rejected attempt.
  assert.ok(db.prepare('SELECT * FROM contacts WHERE id = ?').get(created.contact.id));
});

test('deleteClientPermanently requires an actor for the audit trail', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Noactor', email: 'noactor@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  assert.throws(() => deleteClientPermanently(db, created.contact.id, null, { confirmDelete: true }), /actor is required/);
});

test('deleteClientPermanently rejects a contact id that does not exist', () => {
  const { db } = setup();
  assert.throws(() => deleteClientPermanently(db, 999999, 'Loretta Stewart', { confirmDelete: true }), /does not exist/);
});

test('1. delete a client with no linked records at all', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Bare', lastName: 'Record', email: 'bare@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const contactId = created.contact.id;

  const result = deleteClientPermanently(db, contactId, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.outcome, 'deleted');
  assert.equal(result.contactId, contactId);
  assert.equal(db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId), undefined);
});

test('2. delete a client with texts and communications', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Sasha', email: 'sasha@example.com', phone: '4145557100', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const contactId = created.contact.id;
  db.prepare(`INSERT INTO sms_messages (contact_id, direction, body) VALUES (?, 'inbound', 'hi')`).run(contactId);
  db.prepare(`INSERT INTO sms_messages (contact_id, direction, body) VALUES (?, 'outbound', 'hello back')`).run(contactId);
  db.prepare(`INSERT INTO communications (contact_id, comm_type, direction, body) VALUES (?, 'sms', 'inbound', 'logged comm')`).run(contactId);

  deleteClientPermanently(db, contactId, 'Loretta Stewart', { confirmDelete: true });
  assertNoRowsRemain(countAllContactRows(db, contactId), 'texts/communications');
  assert.equal(db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId), undefined);
});

test('3. delete a client with a Case (and its external refs) cleans up the whole chain', () => {
  const { db, prosperityId } = setup();
  const created = createClient(db, { firstName: 'Case', lastName: 'Owner', email: 'caseowner@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const contactId = created.contact.id;
  const caseResult = createCaseForClient(db, { contactId, productId: getProductId(db, prosperityId, 'Life insurance'), externalRef: 'cal-uid-123', refType: 'calcom_booking_uid' }, 'Loretta Stewart');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM case_external_refs WHERE case_id = ?').get(caseResult.id).n, 1);

  deleteClientPermanently(db, contactId, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(db.prepare('SELECT * FROM cases WHERE id = ?').get(caseResult.id), undefined);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM case_external_refs WHERE case_id = ?').get(caseResult.id).n, 0);
  assertNoRowsRemain(countAllContactRows(db, contactId), 'case chain');
});

test('4. delete a client with a Policy removes the policy along with its case', () => {
  const { db, prosperityId } = setup();
  const created = createClient(db, { firstName: 'Polly', lastName: 'Insured', email: 'polly@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const contactId = created.contact.id;
  const caseResult = createCaseForClient(db, { contactId, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const policy = createPolicy(db, { caseId: caseResult.id, carrier: 'Test Carrier', policyNumber: 'POL-1' }, 'Loretta Stewart');
  assert.ok(db.prepare('SELECT * FROM policies WHERE id = ?').get(policy.id));

  deleteClientPermanently(db, contactId, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(db.prepare('SELECT * FROM policies WHERE id = ?').get(policy.id), undefined, 'policy must be gone once its case is gone');
  assert.equal(db.prepare('SELECT * FROM cases WHERE id = ?').get(caseResult.id), undefined);
});

test('5. delete a client with notes/tasks/appointments/calls/activities removes them all, no orphans', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'Full', lastName: 'Record', email: 'fullrecord@example.com', phone: '4145557200', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const contactId = created.contact.id;

  db.prepare(`INSERT INTO contact_notes (contact_id, body) VALUES (?, 'A note')`).run(contactId);
  db.prepare(`INSERT INTO follow_up_tasks (contact_id, task_type, due_date) VALUES (?, 'Call', '2026-10-01')`).run(contactId);
  db.prepare(`INSERT INTO appointments (contact_id, appt_type, appt_datetime) VALUES (?, 'Phone Call', '2026-10-02T14:00:00')`).run(contactId);
  db.prepare(`INSERT INTO comm_calls (contact_id, direction, status) VALUES (?, 'outbound', 'completed')`).run(contactId);
  db.prepare(`INSERT INTO emails (contact_id, to_email, subject, body) VALUES (?, 'fullrecord@example.com', 'Hi', 'Body')`).run(contactId);
  const activityResult = db.prepare(`INSERT INTO activities (contact_id, activity_type, summary, created_by) VALUES (?, 'Note', 'Did a thing', 'Loretta Stewart')`).run(contactId);
  db.prepare(`INSERT INTO activity_edits (activity_id, previous_summary, edited_by) VALUES (?, 'old summary', 'Loretta Stewart')`).run(activityResult.lastInsertRowid);
  const apptResult = db.prepare('SELECT id FROM appointments WHERE contact_id = ?').get(contactId);
  db.prepare(`INSERT INTO retirement_intakes (contact_id, appointment_id, token) VALUES (?, ?, 'tok-1')`).run(contactId, apptResult.id);
  db.prepare(`INSERT INTO communication_drafts (contact_id, channel, body, status) VALUES (?, 'text', 'draft body', 'draft')`).run(contactId);

  deleteClientPermanently(db, contactId, 'Loretta Stewart', { confirmDelete: true });

  assertNoRowsRemain(countAllContactRows(db, contactId), 'notes/tasks/appointments/calls/activities');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity_edits WHERE activity_id = ?').get(activityResult.lastInsertRowid).n, 0, 'activity_edits must not be orphaned');
  assert.equal(db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId), undefined);
});

test('6/7. deleting one client does not touch an unrelated client\'s own records, and clears (not deletes) shared audit references instead of orphaning them', () => {
  const { db, prosperityId } = setup();
  const target = createClient(db, { firstName: 'Target', email: 'target@example.com', phone: '4145557300', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const bystander = createClient(db, { firstName: 'Bystander', email: 'bystander@example.com', phone: '4145557301', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`INSERT INTO contact_notes (contact_id, body) VALUES (?, 'target note')`).run(target.contact.id);
  db.prepare(`INSERT INTO contact_notes (contact_id, body) VALUES (?, 'bystander note')`).run(bystander.contact.id);
  const bystanderCase = createCaseForClient(db, { contactId: bystander.contact.id, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  // A shared import_batches/import_rows audit row referencing the target
  // contact -- represents a real CSV import event, must survive with its
  // contact_id reference cleared, not be deleted or left dangling.
  const batch = db.prepare(`INSERT INTO import_batches (filename, status) VALUES ('test.csv', 'committed')`).run();
  const row = db.prepare(`INSERT INTO import_rows (batch_id, row_number, raw_row, outcome, contact_id) VALUES (?, 1, '{}', 'created', ?)`).run(batch.lastInsertRowid, target.contact.id);

  deleteClientPermanently(db, target.contact.id, 'Loretta Stewart', { confirmDelete: true });

  // Bystander is completely untouched.
  assert.ok(db.prepare('SELECT * FROM contacts WHERE id = ?').get(bystander.contact.id));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_notes WHERE contact_id = ?').get(bystander.contact.id).n, 1);
  assert.ok(db.prepare('SELECT * FROM cases WHERE id = ?').get(bystanderCase.id), 'bystander case must survive');

  // The import_rows audit row survives, but its now-invalid contact
  // reference is cleared rather than left dangling or deleted outright.
  const rowAfter = db.prepare('SELECT * FROM import_rows WHERE id = ?').get(row.lastInsertRowid);
  assert.ok(rowAfter, 'import_rows audit row must survive the delete');
  assert.equal(rowAfter.contact_id, null);
  assert.equal(rowAfter.outcome, 'created', 'the rest of the audit row is untouched');
});

// Reproduces the exact live bug report: a client with a "Case Review
// Required" queue item (unresolved_intake.review_type='case') pending
// against its OWN brand relationship -- e.g. a Cal.com booking that
// resolved to a known client but no matchable product -- previously made
// deleteClientPermanently fail with "FOREIGN KEY constraint failed"
// because unresolved_intake.contact_brand_id (crm/db/migrateDashboard.js)
// still pointed at the contact_brands row being deleted.
test('reproduces and fixes the live bug: deleting a client with a pending Case Review Required item against its own relationship', () => {
  const { db, prosperityId } = setup();
  const created = createClient(db, { firstName: 'Loretta', lastName: 'LiveBugRepro', email: 'livebugrepro@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const contactId = created.contact.id;
  const contactBrandId = created.contactBrand.id;

  // A booking/event resolves to this exact client's brand relationship but
  // no product could be determined -- stages a Case Review Required item
  // with contact_brand_id set, exactly like the real intake pipeline does.
  const staged = matchOrCreateCase(db, {
    contactBrandId, eventType: 'new_inquiry', source: 'test_repro', rawPayload: {},
  });
  assert.equal(staged.outcome, 'review_required');
  assert.equal(staged.unresolvedIntake.contact_brand_id, contactBrandId);
  assert.equal(staged.unresolvedIntake.status, 'Pending', 'reproduces the bug whether the item is still pending...');

  // Before the fix this threw "FOREIGN KEY constraint failed" -- must now
  // succeed cleanly.
  const result = deleteClientPermanently(db, contactId, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.outcome, 'deleted');
  assert.equal(db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId), undefined);

  // The review-queue item itself survives (it is shared/queue data, not
  // this client's own data) with its now-invalid brand-relationship
  // reference cleared, not left dangling.
  const intakeAfter = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(staged.unresolvedIntake.id);
  assert.ok(intakeAfter, 'the review-queue item must survive the delete');
  assert.equal(intakeAfter.contact_brand_id, null);
});

// Same reproduction, but the item was already Resolved before the client
// is deleted -- resolved_contact_brand_id (not contact_brand_id) is the
// column that matters once resolved, and it must be cleared too.
test('reproduces and fixes the live bug: deleting a client with an already-RESOLVED Case Review Required item', () => {
  const { db, prosperityId } = setup();
  const created = createClient(db, { firstName: 'Loretta', lastName: 'ResolvedRepro', email: 'resolvedrepro@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const contactId = created.contact.id;
  const contactBrandId = created.contactBrand.id;
  const productId = getProductId(db, prosperityId, 'Life insurance');

  const intake = stageUnresolvedIntake(db, {
    source: 'test_repro', rawPayload: {}, reviewType: 'case', contactBrandId,
    reason: 'no product/service category could be determined',
  });
  db.prepare(`
    UPDATE unresolved_intake
    SET status = 'Resolved', resolved_contact_brand_id = ?, resolved_by = 'Loretta Stewart', resolved_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(contactBrandId, intake.id);

  const result = deleteClientPermanently(db, contactId, 'Loretta Stewart', { confirmDelete: true });
  assert.equal(result.outcome, 'deleted');

  const intakeAfter = db.prepare('SELECT * FROM unresolved_intake WHERE id = ?').get(intake.id);
  assert.ok(intakeAfter, 'the resolved review-queue item must survive the delete');
  assert.equal(intakeAfter.contact_brand_id, null);
  assert.equal(intakeAfter.resolved_contact_brand_id, null);
  assert.equal(intakeAfter.status, 'Resolved', 'resolution status/audit fields themselves are untouched');
});

test('improved error logging: a failed delete names the exact step that failed', () => {
  const { db, prosperityId } = setup();
  const created = createClient(db, { firstName: 'Loud', lastName: 'Failure', email: 'loudfailure@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const contactId = created.contact.id;
  const caseResult = createCaseForClient(db, { contactId, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');
  const other = createClient(db, { firstName: 'Other', email: 'other-logging@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`INSERT INTO sms_messages (contact_id, direction, body, case_id) VALUES (?, 'outbound', 'cross-linked', ?)`).run(other.contact.id, caseResult.id);

  assert.throws(
    () => deleteClientPermanently(db, contactId, 'Loretta Stewart', { confirmDelete: true }),
    /failed at step "delete cases"/,
    'the thrown error must name the specific step that failed, not just the bare SQLite message'
  );
});

test('8. Archive Client still works exactly as before, completely independent of Delete', () => {
  const { db } = setup();
  const created = createClient(db, { firstName: 'StillWorks', email: 'stillworks@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`INSERT INTO contact_notes (contact_id, body) VALUES (?, 'A note')`).run(created.contact.id);
  const archived = archiveClient(db, created.contact.id, 'Loretta Stewart');
  assert.ok(archived.archived_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_notes WHERE contact_id = ?').get(created.contact.id).n, 1, 'archive must still fully preserve history');
  const restored = restoreClient(db, created.contact.id, 'Loretta Stewart');
  assert.equal(restored.archived_at, null);
  assert.ok(db.prepare('SELECT * FROM contacts WHERE id = ?').get(created.contact.id), 'archived/restored contact must never be deleted');
});

test('deleteClientPermanently is transactional: a foreign-key failure partway through leaves the client and all its data fully intact', () => {
  const { db, prosperityId } = setup();
  const created = createClient(db, { firstName: 'Rollback', lastName: 'Test', email: 'rollback@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  const contactId = created.contact.id;
  db.prepare(`INSERT INTO contact_notes (contact_id, body) VALUES (?, 'must survive')`).run(contactId);
  const caseResult = createCaseForClient(db, { contactId, productId: getProductId(db, prosperityId, 'Life insurance') }, 'Loretta Stewart');

  // Simulate a data-integrity edge case: some OTHER contact's sms_messages
  // row still references this contact's case via case_id (a column added
  // without an ON DELETE action -- crm/db/migrateBrands.js's
  // addDownstreamReferences). Deleting the case out from under that row
  // must trip a real foreign-key violation and roll back the ENTIRE
  // transaction -- not silently orphan or partially delete anything.
  const other = createClient(db, { firstName: 'Other', email: 'other-fk@example.com', brandSlug: 'prosperity' }, 'Loretta Stewart');
  db.prepare(`INSERT INTO sms_messages (contact_id, direction, body, case_id) VALUES (?, 'outbound', 'cross-linked', ?)`).run(other.contact.id, caseResult.id);

  assert.throws(() => deleteClientPermanently(db, contactId, 'Loretta Stewart', { confirmDelete: true }), /FOREIGN KEY/);
  // The transaction must have rolled back completely -- contact, note, and
  // case all still present, nothing partially deleted.
  assert.ok(db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId), 'contact must still exist after a failed delete');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_notes WHERE contact_id = ?').get(contactId).n, 1, 'note must still exist -- no partial delete');
  assert.ok(db.prepare('SELECT * FROM cases WHERE id = ?').get(caseResult.id), 'case must still exist -- no partial delete');
});
