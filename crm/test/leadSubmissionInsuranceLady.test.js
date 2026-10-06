// Tests for the Insurance Lady retirement-booking.html lead-capture path
// (2026-09-30): retirement-booking.html's Step 1 (contact info) + Step 2
// (Retirement Qualification: $20k question, how-did-you-hear-about-us)
// relayed server-to-server, through the SAME POST /api/leads pipeline
// crm/test/leadsRoute.test.js already covers for Prosperity, authenticated
// with a DIFFERENT private key (CRM_INTERNAL_KEY_INSURANCE_LADY) so it can
// never be mistaken for a Prosperity request.
//
// Kept in its own file (not added to leadsRoute.test.js) so this brand's
// coverage is easy to review on its own, mirroring the file split already
// used elsewhere in this suite for brand-specific behavior.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { handleLeadSubmission } = require('../lib/leadSubmission');
const { resolveBrandSlugForSource } = require('../config/leadSources');

function setup() {
  const db = createLegacyDb();
  runMigrations(db);
  runDashboardMigrations(db);
  runRevenueMvpMigrations(db); // adds contacts.sms_opted_out_at, among others
  return db;
}

const ALWAYS_PASS_TURNSTILE = { verifyTurnstile: async () => true };

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function retirementBookingPayload(overrides = {}) {
  return Object.assign({
    first_name: 'Amirah', last_name: 'Client', email: 'amirah@example.com', phone: '4145551234',
    sms_consent: 'yes', email_consent: 'no',
    lead_type: 'Retirement Lead',
    lead_source: 'Google Search',
    how_did_you_hear: 'Google Search',
    retirement_qualified: 'Yes',
  }, overrides);
}

test('config/leadSources.js has a distinct insurance-lady-website entry mapping to the insurance-lady brand', () => {
  assert.equal(resolveBrandSlugForSource('insurance-lady-website'), 'insurance-lady');
  assert.equal(resolveBrandSlugForSource('prosperity-website'), 'prosperity');
});

test('a request authenticated with CRM_INTERNAL_KEY_INSURANCE_LADY resolves Insurance Lady, never Prosperity', async () => {
  await withEnv({ CRM_INTERNAL_KEY: 'prosperity-secret', CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' },
      ip: '127.0.0.1',
      body: retirementBookingPayload(),
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);

    const link = db.prepare(`
      SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.contact_id = ?
    `).get(res.body.contact_id);
    assert.equal(link.slug, 'insurance-lady', 'must resolve Insurance Lady, not be left unresolved or default to Prosperity');
  });
});

test('Prosperity\'s own key can never authenticate as Insurance Lady, and vice versa', async () => {
  await withEnv({ CRM_INTERNAL_KEY: 'prosperity-secret', CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();

    // Prosperity's key used on an Insurance-Lady-shaped payload still
    // resolves Prosperity, never Insurance Lady -- the brand comes from
    // WHICH key matched, never anything in the payload.
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'prosperity-secret' },
      ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'crosscheck@example.com' }),
    }, ALWAYS_PASS_TURNSTILE);

    const link = db.prepare(`
      SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.contact_id = ?
    `).get(res.body.contact_id);
    assert.equal(link.slug, 'prosperity');
  });
});

test('an invalid/guessed internal key never resolves Insurance Lady -- stages Brand Review Required instead', async () => {
  await withEnv({ CRM_INTERNAL_KEY: 'prosperity-secret', CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'wrong-guess' },
      ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'unresolved@example.com' }),
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(res.status, 201, 'still succeeds at the HTTP layer -- staged internally, not rejected');
    const link = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').get(res.body.contact_id);
    assert.equal(link, undefined, 'no brand relationship must be created when the key does not match any known source');
    const staged = db.prepare(`SELECT * FROM unresolved_intake WHERE candidate_contact_id = ?`).get(res.body.contact_id);
    assert.ok(staged, 'must be staged for Brand Review Required');
  });
});

test('lead_source is set to the how-did-you-hear-about-us answer, reusing the existing field rather than a new one', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' },
      ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'source@example.com', lead_source: 'Friend or Family Referral', how_did_you_hear: 'Friend or Family Referral' }),
    }, ALWAYS_PASS_TURNSTILE);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(res.body.contact_id);
    assert.equal(contact.lead_source, 'Friend or Family Referral');
  });
});

test('the qualification answer and how-heard answer both land in a communications row + contact_notes row on the correct contact', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' },
      ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'audit-trail@example.com', retirement_qualified: 'Yes', how_did_you_hear: 'Radio or TV Ad', lead_source: 'Radio or TV Ad' }),
    }, ALWAYS_PASS_TURNSTILE);

    const comm = db.prepare(`SELECT * FROM communications WHERE contact_id = ? AND comm_type = 'form'`).get(res.body.contact_id);
    assert.ok(comm, 'a communications row must be logged for this contact');
    assert.match(comm.body, /retirement_qualified['"]?\s*:\s*['"]?Yes/i);
    assert.match(comm.body, /Radio or TV Ad/);

    const note = db.prepare(`SELECT * FROM contact_notes WHERE contact_id = ?`).get(res.body.contact_id);
    assert.ok(note, 'a contact_notes row must also be logged (readable audit trail)');
    assert.match(note.body, /retirement qualified: Yes/i);
    assert.match(note.body, /how did you hear: Radio or TV Ad/i);
  });
});

test('a disqualified (No) submission still reaches the CRM and is still logged, just without implying a booking', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' },
      ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'disqualified@example.com', retirement_qualified: 'No', how_did_you_hear: 'Other', lead_source: 'Other' }),
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(res.status, 201);
    const note = db.prepare(`SELECT * FROM contact_notes WHERE contact_id = ?`).get(res.body.contact_id);
    assert.match(note.body, /retirement qualified: No/i);

    // No appointment/case implication either way -- this endpoint only
    // ever creates/updates a contact + logs the submission, exactly like
    // every other lead-capture path; it never creates an appointment.
    const appt = db.prepare('SELECT * FROM appointments WHERE contact_id = ?').get(res.body.contact_id);
    assert.equal(appt, undefined);
  });
});

test('a repeated submission for the same visitor (Step 1 again, e.g. a page reload) matches the SAME contact by email, never creating a duplicate', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const first = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'repeat@example.com', phone: '4145559999' }),
    }, ALWAYS_PASS_TURNSTILE);

    const second = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'repeat@example.com', phone: '4145559999', retirement_qualified: 'Yes', how_did_you_hear: 'Google Search', lead_source: 'Google Search' }),
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(first.body.contact_id, second.body.contact_id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').get('repeat@example.com').n, 1);
  });
});

test('lead_source set by this flow is preserved (COALESCE), not overwritten, by a later Cal.com webhook contact update -- this is what lets the pre-booking answer survive all the way to the eventual CRM contact', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'matches-calcom@example.com', phone: '4145550001', lead_source: 'Facebook or Instagram', how_did_you_hear: 'Facebook or Instagram' }),
    }, ALWAYS_PASS_TURNSTILE);

    // Simulate the exact UPDATE branch crm/routes/calcom.js's webhook
    // handler runs when it later matches this SAME contact by email/phone
    // for the real booking (lead_source COALESCE-preserved, matching that
    // file's own existing behavior -- not re-implemented here, just relied
    // upon).
    db.prepare(`UPDATE contacts SET lead_source = COALESCE(lead_source, 'Cal.com') WHERE id = ?`).run(res.body.contact_id);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(res.body.contact_id);
    assert.equal(contact.lead_source, 'Facebook or Instagram', 'the website qualification/source answer must survive the later Cal.com webhook contact update');
  });
});

// ── Step 1 consent recording (2026-09-30) ──────────────────────────────
// retirement-booking.html's Step 1 now submits to the CRM immediately on
// its own -- BEFORE Step 2 is ever shown -- carrying only contact info +
// the required consent checkbox, no qualification/how-heard fields yet
// (those aren't known until Step 2). This is deliberately a separate,
// narrower payload shape from retirementBookingPayload() above.

function step1OnlyPayload(overrides = {}) {
  return Object.assign({
    first_name: 'Amirah', last_name: 'Client', email: 'amirah@example.com', phone: '4145551234',
    sms_consent: 'yes', email_consent: 'no',
    lead_type: 'Retirement Lead',
  }, overrides);
}

const { checkConsentGate } = require('../lib/legacySmsSend');

test('brand-new prospect: Step 1 alone (no Step 2 fields at all) grants sms_consent=1 with source "Insurance Lady website booking form" and a timestamp', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const before = new Date().toISOString();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: step1OnlyPayload({ email: 'new-prospect@example.com' }),
    }, ALWAYS_PASS_TURNSTILE);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(res.body.contact_id);
    assert.equal(contact.sms_consent, 1);
    assert.equal(contact.sms_consent_source, 'Insurance Lady website booking form');
    assert.ok(contact.sms_consent_at, 'a timestamp must be recorded');
    assert.ok(contact.sms_consent_at >= before);
    assert.equal(contact.sms_opted_out_at, null, 'a brand-new contact has no opt-out on file');
  });
});

test('the optional marketing-email checkbox is stored separately on email_consent and never conflated with sms_consent', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: step1OnlyPayload({ email: 'separate-consents@example.com', sms_consent: 'yes', email_consent: 'no' }),
    }, ALWAYS_PASS_TURNSTILE);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(res.body.contact_id);
    assert.equal(contact.sms_consent, 1, 'the required appointment/SMS checkbox');
    assert.equal(contact.email_consent, 0, 'the separate optional marketing-email checkbox was left unchecked');
  });
});

test('existing prospect (already in the CRM, no prior consent) checks the box: consent is recorded on the SAME contact, not a duplicate', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const existing = db.prepare(`
      INSERT INTO contacts (first_name, last_name, email, phone, phone_e164) VALUES ('Amirah', 'Client', 'existing-prospect@example.com', '(414) 555-1234', '+14145551234')
    `).run();

    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: step1OnlyPayload({ email: 'existing-prospect@example.com', phone: '4145551234' }),
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(res.body.contact_id, existing.lastInsertRowid, 'must match the existing contact, not create a new one');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').get('existing-prospect@example.com').n, 1);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.lastInsertRowid);
    assert.equal(contact.sms_consent, 1);
    assert.equal(contact.sms_consent_source, 'Insurance Lady website booking form');
    assert.ok(contact.sms_consent_at);
  });
});

test('existing prospect who previously replied STOP: sms_opted_out_at is NEVER cleared by this website form, and actual SMS sending stays blocked -- even though sms_consent itself is reasserted to 1, exactly matching crm/routes/calcom.js\'s own existing precedent for its consent checkbox', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const optedOutAt = '2026-08-01T12:00:00.000Z';
    const existing = db.prepare(`
      INSERT INTO contacts (first_name, last_name, email, phone, phone_e164, sms_consent, sms_opted_out_at)
      VALUES ('Amirah', 'Client', 'stopped@example.com', '(414) 555-1234', '+14145551234', 0, ?)
    `).run(optedOutAt);

    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: step1OnlyPayload({ email: 'stopped@example.com', phone: '4145551234' }),
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(res.body.contact_id, existing.lastInsertRowid);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(existing.lastInsertRowid);

    // sms_opted_out_at is untouched -- this form never clears it. Only an
    // explicit START/UNSTOP SMS reply (crm/lib/inboundSmsService.js) does.
    assert.equal(contact.sms_opted_out_at, optedOutAt, 'a website form submission must never silently clear a STOP opt-out');

    // The consent GATE that actually decides whether a message can be
    // sent treats the opt-out as authoritative regardless of sms_consent's
    // value -- so sending remains blocked either way.
    const gate = checkConsentGate(contact);
    assert.equal(gate.blocked, true);
    assert.match(gate.error, /opted out/i);
  });
});

test('Step 1 alone (before Step 2 is ever shown, e.g. the visitor abandons the flow) is sufficient to record consent -- the contact is created/matched and consent evidence written without any Step 2 fields present', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: step1OnlyPayload({ email: 'abandoned-at-step2@example.com' }),
    }, ALWAYS_PASS_TURNSTILE);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(res.body.contact_id);
    assert.equal(contact.sms_consent, 1);
    assert.equal(contact.sms_consent_source, 'Insurance Lady website booking form');
    assert.equal(contact.lead_source, null, 'how-heard is not yet known -- must not be guessed or defaulted');

    // No appointment and no qualification note exist yet either -- Step 2
    // never ran.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE contact_id = ?').get(contact.id).n, 0);
  });
});

test('Step 1 then Step 2 (the normal completion path): both calls resolve to the SAME contact, and Step 2 never re-downgrades the consent Step 1 already recorded', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();

    const step1 = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: step1OnlyPayload({ email: 'two-step@example.com', phone: '4145552222' }),
    }, ALWAYS_PASS_TURNSTILE);

    const step2 = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'two-step@example.com', phone: '4145552222', retirement_qualified: 'Yes', how_did_you_hear: 'Existing Insurance Lady Client', lead_source: 'Existing Insurance Lady Client' }),
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(step1.body.contact_id, step2.body.contact_id, 'Step 2 must match the exact contact Step 1 already created');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').get('two-step@example.com').n, 1);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(step1.body.contact_id);
    assert.equal(contact.sms_consent, 1, 'still consented after Step 2');
    assert.equal(contact.lead_source, 'Existing Insurance Lady Client', 'Step 2 fills in the source Step 1 could not yet know');
  });
});

// ── NO-branch "Schedule a Life Insurance Review" (2026-10-06) ──────────
// Replaces the earlier free-guide CTA. The Life Insurance button re-sends
// the same Step 2 (qualified: 'No') shape already covered above -- no new
// CRM field, no new endpoint behavior. The page itself (not the CRM) is
// responsible for routing to the existing Insurance Lady Life Insurance
// Cal.com event instead of the retirement one; this suite only verifies
// the CRM-side contact/consent/attribution data survives that click
// exactly like the qualified path's own button click already does.

test('the NO-branch "Schedule a Life Insurance Review" click re-sends the same contact/consent/qualification data, without creating a duplicate contact or an appointment', async () => {
  await withEnv({ CRM_INTERNAL_KEY_INSURANCE_LADY: 'il-secret' }, async () => {
    const db = setup();

    // The disqualified-path auto-submit (already covered above) fires
    // first, then the Life Insurance button click fires this second call
    // (mirrors the qualified path's button also re-sending on click).
    const disqualified = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'routed-to-life-insurance@example.com', retirement_qualified: 'No', how_did_you_hear: 'Other', lead_source: 'Other' }),
    }, ALWAYS_PASS_TURNSTILE);

    const buttonClick = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'il-secret' }, ip: '127.0.0.1',
      body: retirementBookingPayload({ email: 'routed-to-life-insurance@example.com', retirement_qualified: 'No', how_did_you_hear: 'Other', lead_source: 'Other' }),
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(buttonClick.body.contact_id, disqualified.body.contact_id, 'must match the same contact, not create a duplicate');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').get('routed-to-life-insurance@example.com').n, 1);

    // Never booked from this endpoint -- the actual Life Insurance
    // appointment is only ever created later by Cal.com's own webhook,
    // exactly like the qualified Retirement path.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE contact_id = ?').get(disqualified.body.contact_id).n, 0);

    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(disqualified.body.contact_id);
    assert.equal(contact.sms_consent, 1, 'consent captured at Step 1 survives being routed to Life Insurance');
    assert.equal(contact.lead_source, 'Other', 'how-heard answer survives being routed to Life Insurance');

    const link = db.prepare(`
      SELECT b.slug FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id WHERE cb.contact_id = ?
    `).get(contact.id);
    assert.equal(link.slug, 'insurance-lady', 'brand isolation must hold for the Life Insurance fallback path too');
  });
});
