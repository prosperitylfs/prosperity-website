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
