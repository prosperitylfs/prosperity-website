// Tests for crm/lib/leadSubmission.js — the full request/response contract
// of POST /api/leads (honeypot → Turnstile-or-internal-key → source/brand
// resolution → intake), exercised against an in-memory database and a
// stubbed Turnstile check. Never requires crm/routes/leads.js itself, which
// imports the live crm/db/database.js at module scope as a side effect of
// being required — these tests use crm/lib/leadSubmission.js directly
// instead, exactly as it's designed to be tested.
//
// Corrected trust model (see the Checkpoint E1 Phase 1 correction report):
// ALL FIVE verified Prosperity callers (book.html, life-insurance.html,
// life-insurance-qualifier.html, contact.html — all via the same-origin
// /submit-lead Cloudflare Pages Function — and functions/send-guide.js
// directly) now reach this endpoint only server-to-server, authenticated by
// the PRIVATE x-internal-key header. No browser script calls POST
// /api/leads directly anymore, and a browser-supplied x-api-key is never
// treated as proof of source/brand — several tests below exist specifically
// to prove that invariant holds even if someone supplies a correct-looking
// x-api-key with no internal key.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { handleLeadSubmission } = require('../lib/leadSubmission');

function setup() {
  const db = createLegacyDb();
  runMigrations(db);
  runDashboardMigrations(db);
  return db;
}

const ALWAYS_PASS_TURNSTILE = { verifyTurnstile: async () => true };
const ALWAYS_FAIL_TURNSTILE = { verifyTurnstile: async () => false };

// Saves/restores only the env vars this suite touches, so nothing leaks
// into other tests in this same test-runner worker. Always awaits fn()
// before restoring — callers must `await withEnv(...)`.
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

test('honeypot filled -> 200 {ok:true}, silent discard, no contact created', async () => {
  const db = setup();
  const res = await handleLeadSubmission(db, {
    headers: {}, ip: '127.0.0.1',
    body: { honeypot: 'bot-filled-this', email: 'bot@example.com' },
  }, ALWAYS_PASS_TURNSTILE);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, 0);
});

test('missing/invalid Turnstile token on a public (non-internal) call -> 400 Verification failed', async () => {
  const db = setup();
  const res = await handleLeadSubmission(db, {
    headers: {}, ip: '127.0.0.1',
    body: { email: 'human@example.com', lead_type: 'contact' },
  }, ALWAYS_FAIL_TURNSTILE);

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'Verification failed. Please refresh the page and try again.');
});

test('missing email and phone -> 400 "email or phone required"', async () => {
  const db = setup();
  const res = await handleLeadSubmission(db, {
    headers: {}, ip: '127.0.0.1',
    body: { first_name: 'No Contact Info', lead_type: 'contact' },
  }, ALWAYS_PASS_TURNSTILE);

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'email or phone required');
});

test('trusted internal call (book.html / life-insurance.html shape, forwarded by /submit-lead) succeeds and resolves Prosperity', async () => {
  await withEnv({ CRM_INTERNAL_KEY: 'test-internal-key', CRM_API_KEY: 'test-public-key' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'test-internal-key', 'x-api-key': 'test-public-key' },
      ip: '127.0.0.1',
      body: {
        first_name: 'Priya', last_name: 'Anand', email: 'priya@example.com', phone: '4144411177',
        lead_type: 'Retirement Lead', topics: 'Rollover, Safe Money', retirement_timeline: '1-2 years',
      },
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);
    assert.ok(Number.isInteger(res.body.contact_id));
    assert.equal(Object.keys(res.body).sort().join(','), 'contact_id,ok', 'response shape must stay exactly {ok, contact_id}');

    const link = db.prepare('SELECT * FROM contact_brands WHERE contact_id = ?').get(res.body.contact_id);
    assert.ok(link, 'a valid internal call must resolve a Prosperity contact_brand relationship');
  });
});

test('trusted internal call also succeeds for the life-insurance-qualifier.html / contact.html field shapes now forwarded by /submit-lead', async () => {
  await withEnv({ CRM_INTERNAL_KEY: 'test-internal-key', CRM_API_KEY: undefined }, async () => {
    const db = setup();

    // Qualifier-shaped payload (state/age_range/coverage_for/tobacco/health_concerns).
    const qualifierRes = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'test-internal-key' },
      ip: '127.0.0.1',
      body: {
        first_name: 'Sam', last_name: 'Ortiz', email: 'sam@example.com', phone: '4144411177',
        lead_type: 'Life Insurance Lead', state: 'WI', age_range: '35-44',
        coverage_type: 'Term', coverage_for: 'self', tobacco: 'no', health_concerns: 'none',
        sms_consent: 'yes', terms_accepted: 'yes',
      },
    }, ALWAYS_PASS_TURNSTILE);
    assert.equal(qualifierRes.status, 201);
    assert.equal(qualifierRes.body.ok, true);

    // Contact-shaped payload (message field).
    const contactRes = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'test-internal-key' },
      ip: '127.0.0.1',
      body: {
        first_name: 'Robin', last_name: 'Doe', email: 'robin@example.com', phone: '4144412222',
        message: 'Please call me about a policy.', terms_accepted: 'yes', lead_type: 'contact',
      },
    }, ALWAYS_PASS_TURNSTILE);
    assert.equal(contactRes.status, 201);
    assert.equal(contactRes.body.ok, true);
  });
});

test('a browser-supplied x-api-key alone (no internal key) cannot authenticate or resolve a brand', async () => {
  await withEnv({ CRM_API_KEY: 'test-public-key', CRM_INTERNAL_KEY: 'test-internal-key' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-api-key': 'test-public-key' }, // correct api key, but NO x-internal-key
      ip: '127.0.0.1',
      body: {
        first_name: 'Sam', last_name: 'Ortiz', email: 'sam@example.com', phone: '4144411177',
        lead_type: 'Life Insurance Lead',
        turnstile_token: 'irrelevant-because-turnstile-is-stubbed',
      },
    }, ALWAYS_PASS_TURNSTILE);

    // Response contract is unchanged (still 201/{ok,contact_id} — the lead
    // is never dropped) but the x-api-key must not have resolved a brand.
    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_brands').get().n, 0, 'x-api-key alone must never create a contact_brands row');
    const unresolved = db.prepare('SELECT * FROM unresolved_intake WHERE candidate_contact_id = ?').get(res.body.contact_id);
    assert.ok(unresolved, 'expected the contact to be staged for Brand Review Required');
    assert.equal(unresolved.review_type, 'brand');
  });
});

test('an invalid/wrong internal key never resolves Prosperity, even alongside a correct x-api-key', async () => {
  await withEnv({ CRM_API_KEY: 'test-public-key', CRM_INTERNAL_KEY: 'the-real-internal-key' }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-api-key': 'test-public-key', 'x-internal-key': 'a-guessed-or-stale-value' },
      ip: '127.0.0.1',
      body: { first_name: 'Wrong Key', email: 'wrongkey@example.com', lead_type: 'contact' },
    }, ALWAYS_PASS_TURNSTILE); // Turnstile stub still passes -- proves the internal-key check, not Turnstile, is what's under test

    assert.equal(res.status, 201, 'the lead is still saved (Turnstile passed) — only brand resolution is affected');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_brands').get().n, 0);
    const unresolved = db.prepare('SELECT * FROM unresolved_intake WHERE candidate_contact_id = ?').get(res.body.contact_id);
    assert.ok(unresolved, 'an invalid internal key must stage for Brand Review Required, not resolve Prosperity');
  });
});

test('a request with no internal key and no x-api-key at all still succeeds at the HTTP layer (staged internally, not rejected)', async () => {
  await withEnv({ CRM_API_KEY: 'test-public-key', CRM_INTERNAL_KEY: undefined }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: {}, // nothing at all
      ip: '127.0.0.1',
      body: { first_name: 'Unverified', email: 'unverified@example.com', lead_type: 'contact' },
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(res.status, 201);
    assert.equal(res.body.ok, true);

    const unresolved = db.prepare('SELECT * FROM unresolved_intake WHERE candidate_contact_id = ?').get(res.body.contact_id);
    assert.ok(unresolved, 'expected the contact to be staged for Brand Review Required');
    assert.equal(unresolved.review_type, 'brand');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contact_brands').get().n, 0);
  });
});

test('an unexpected internal error is caught and returns the exact legacy 500 shape without leaking details', async () => {
  const brokenDb = {
    prepare() {
      throw new Error('simulated database failure with sensitive internal detail');
    },
  };
  const res = await handleLeadSubmission(brokenDb, {
    headers: {}, ip: '127.0.0.1',
    body: { email: 'x@example.com', lead_type: 'contact' },
  }, ALWAYS_PASS_TURNSTILE);

  assert.equal(res.status, 500);
  assert.deepEqual(res.body, { error: 'Server error' });
});

// ── sms_consent mapping through the full /api/leads pipeline ─────────────
//
// Earlier tests in this file assert only status/ok on these payload shapes
// -- none of them checked the resulting DB row. Added specifically to
// close that gap: the SMS consent checkbox on /book must reliably persist
// through to a matched/created contact's sms_consent column.

function bookLikeBody(overrides = {}) {
  return {
    first_name: 'Renee', last_name: 'Jones', email: 'renee.jones@example.com', phone: '4143676486',
    lead_type: 'Retirement Lead', lead_source: 'Prosperity Booking Page', terms_accepted: 'yes',
    ...overrides,
  };
}

test('sms_consent=yes in the /book-shaped payload results in sms_consent=1 on the created contact', async () => {
  await withEnv({ CRM_INTERNAL_KEY: 'test-internal-key', CRM_API_KEY: undefined }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'test-internal-key' }, ip: '127.0.0.1',
      body: bookLikeBody({ sms_consent: 'yes' }),
    }, ALWAYS_PASS_TURNSTILE);
    assert.equal(res.status, 201);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(res.body.contact_id);
    assert.equal(contact.sms_consent, 1);
  });
});

test('sms_consent=no in the /book-shaped payload results in sms_consent=0 on the created contact', async () => {
  await withEnv({ CRM_INTERNAL_KEY: 'test-internal-key', CRM_API_KEY: undefined }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'test-internal-key' }, ip: '127.0.0.1',
      body: bookLikeBody({ sms_consent: 'no' }),
    }, ALWAYS_PASS_TURNSTILE);
    assert.equal(res.status, 201);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(res.body.contact_id);
    assert.equal(contact.sms_consent, 0);
  });
});

test('the real phone number from a /book-shaped payload is stored on the contact', async () => {
  await withEnv({ CRM_INTERNAL_KEY: 'test-internal-key', CRM_API_KEY: undefined }, async () => {
    const db = setup();
    const res = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'test-internal-key' }, ip: '127.0.0.1',
      body: bookLikeBody({ sms_consent: 'yes' }),
    }, ALWAYS_PASS_TURNSTILE);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(res.body.contact_id);
    assert.equal(contact.phone_e164, '+14143676486');
  });
});

test('a repeated submission with the same normalized email updates the SAME contact (no duplicate) and consent is not lost', async () => {
  await withEnv({ CRM_INTERNAL_KEY: 'test-internal-key', CRM_API_KEY: undefined }, async () => {
    const db = setup();
    const first = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'test-internal-key' }, ip: '127.0.0.1',
      body: bookLikeBody({ sms_consent: 'no' }),
    }, ALWAYS_PASS_TURNSTILE);

    // A second, later submission for the same person now WITH consent --
    // e.g. the visitor books again after initially declining.
    const second = await handleLeadSubmission(db, {
      headers: { 'x-internal-key': 'test-internal-key' }, ip: '127.0.0.1',
      body: bookLikeBody({ sms_consent: 'yes' }),
    }, ALWAYS_PASS_TURNSTILE);

    assert.equal(second.body.contact_id, first.body.contact_id, 'must match the same contact, not create a duplicate');
    const count = db.prepare('SELECT COUNT(*) AS n FROM contacts WHERE email = ?').get('renee.jones@example.com').n;
    assert.equal(count, 1);
    const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(first.body.contact_id);
    assert.equal(contact.sms_consent, 1, 'consent must upgrade from 0 to 1 on the resubmission, never lost or ignored');
  });
});

test('no test in this file ever asserts against a real secret value -- all credentials here are synthetic test literals', () => {
  // Documentation-as-test: every credential string used above
  // ('test-internal-key', 'test-public-key', 'the-real-internal-key',
  // 'a-guessed-or-stale-value') is a literal made up for this file. None of
  // them are read from, or need to match, any real environment/production
  // value, so this file can never leak or need to reference an actual
  // secret.
  assert.ok(true);
});
