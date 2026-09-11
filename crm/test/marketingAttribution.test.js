// Tests for crm/lib/marketingAttribution.js. Pure functions plus one
// in-memory-database test for applyFirstTouchAttribution's UPDATE. No
// network, no real Cal.com payload -- the full webhook integration is
// covered separately in test/calcomWebhookRoute.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const {
  extractAttributionFromCalcomPayload, applyFirstTouchAttribution,
  humanizeSlug, formatUtmSourceLabel,
} = require('../lib/marketingAttribution');

// ── extractAttributionFromCalcomPayload ───────────────────────────────────

test('extracts attribution from payload.metadata when present', () => {
  const payload = {
    metadata: {
      utm_source: 'tiktok', utm_medium: 'social', utm_campaign: 'liam-2026',
      utm_content: 'test-video', utm_term: 'life insurance',
      referrer: 'https://tiktok.com/@insuranceladyllc', landing_page: 'https://insuranceladyllc.com/life-insurance',
      first_touch_at: '2026-09-09T14:00:00.000Z',
    },
  };
  const result = extractAttributionFromCalcomPayload(payload);
  assert.deepEqual(result, {
    utmSource: 'tiktok', utmMedium: 'social', utmCampaign: 'liam-2026',
    utmContent: 'test-video', utmTerm: 'life insurance',
    referrer: 'https://tiktok.com/@insuranceladyllc', landingPage: 'https://insuranceladyllc.com/life-insurance',
    firstTouchAt: '2026-09-09T14:00:00.000Z',
  });
});

test('falls back to payload.responses (Cal.com custom-question shape) when metadata is absent', () => {
  const payload = {
    responses: {
      utm_source: { label: 'utm_source', value: 'facebook-personal' },
      utm_medium: { label: 'utm_medium', value: 'social' },
      name: { label: 'Your name', value: 'Real Prospect' }, // unrelated field, must be ignored
    },
  };
  const result = extractAttributionFromCalcomPayload(payload);
  assert.equal(result.utmSource, 'facebook-personal');
  assert.equal(result.utmMedium, 'social');
  assert.equal(result.utmCampaign, null);
});

test('metadata wins over responses when both carry a value for the same field', () => {
  const payload = {
    metadata: { utm_source: 'tiktok' },
    responses: { utm_source: { label: 'utm_source', value: 'instagram' } },
  };
  const result = extractAttributionFromCalcomPayload(payload);
  assert.equal(result.utmSource, 'tiktok');
});

test('a field missing from metadata still falls through to responses for that ONE field', () => {
  const payload = {
    metadata: { utm_source: 'tiktok' }, // no utm_medium here
    responses: { utm_medium: { label: 'utm_medium', value: 'social' } },
  };
  const result = extractAttributionFromCalcomPayload(payload);
  assert.equal(result.utmSource, 'tiktok');
  assert.equal(result.utmMedium, 'social', 'must independently fall back per-field, not all-or-nothing');
});

test('returns null (not a partially-filled object) when neither location carries any attribution field', () => {
  const payload = { responses: { name: { label: 'Your name', value: 'Real Prospect' } } };
  assert.equal(extractAttributionFromCalcomPayload(payload), null);
});

test('never crashes on a missing/malformed payload shape', () => {
  assert.equal(extractAttributionFromCalcomPayload({}), null);
  assert.equal(extractAttributionFromCalcomPayload({ metadata: null, responses: null }), null);
  assert.equal(extractAttributionFromCalcomPayload({ metadata: 'not an object' }), null);
});

test('blank/whitespace-only values are treated as absent', () => {
  const payload = { metadata: { utm_source: '   ', utm_medium: 'social' } };
  const result = extractAttributionFromCalcomPayload(payload);
  assert.equal(result.utmSource, null);
  assert.equal(result.utmMedium, 'social');
});

// ── applyFirstTouchAttribution (the first-touch enforcement point) ───────

function setup() {
  const db = createLegacyDb();
  return db;
}

test('applyFirstTouchAttribution writes attribution onto a contact with none on file', () => {
  const db = setup();
  const ins = db.prepare(`INSERT INTO contacts (first_name, email) VALUES ('New', 'new@example.com')`).run();
  applyFirstTouchAttribution(db, ins.lastInsertRowid, {
    utmSource: 'tiktok', utmMedium: 'social', utmCampaign: 'liam-2026',
    utmContent: 'test-video', utmTerm: null, referrer: null, landingPage: null, firstTouchAt: '2026-09-09T14:00:00.000Z',
  });
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ins.lastInsertRowid);
  assert.equal(row.utm_source, 'tiktok');
  assert.equal(row.utm_medium, 'social');
  assert.equal(row.utm_campaign, 'liam-2026');
  assert.equal(row.utm_content, 'test-video');
  assert.equal(row.first_touch_at, '2026-09-09T14:00:00.000Z');
});

test('applyFirstTouchAttribution NEVER overwrites a value already on file -- the first-touch rule', () => {
  const db = setup();
  const ins = db.prepare(`
    INSERT INTO contacts (first_name, email, utm_source, utm_medium, utm_campaign, first_touch_at)
    VALUES ('Existing', 'existing@example.com', 'tiktok', 'social', 'liam-2026', '2026-09-09T14:00:00.000Z')
  `).run();
  // A later, DIFFERENT booking's attribution arrives for the same contact.
  applyFirstTouchAttribution(db, ins.lastInsertRowid, {
    utmSource: 'facebook-business', utmMedium: 'paid-social', utmCampaign: 'different-campaign',
    utmContent: null, utmTerm: null, referrer: null, landingPage: null, firstTouchAt: '2026-09-15T09:00:00.000Z',
  });
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ins.lastInsertRowid);
  assert.equal(row.utm_source, 'tiktok', 'original source must survive a later, different attribution');
  assert.equal(row.utm_medium, 'social');
  assert.equal(row.utm_campaign, 'liam-2026');
  assert.equal(row.first_touch_at, '2026-09-09T14:00:00.000Z', 'first-touch timestamp must never move');
});

test('applyFirstTouchAttribution fills only the SPECIFIC fields that were empty, leaving already-set fields alone', () => {
  const db = setup();
  const ins = db.prepare(`
    INSERT INTO contacts (first_name, email, utm_source) VALUES ('Partial', 'partial@example.com', 'tiktok')
  `).run();
  applyFirstTouchAttribution(db, ins.lastInsertRowid, {
    utmSource: 'instagram', utmMedium: 'social', utmCampaign: null, utmContent: null, utmTerm: null,
    referrer: null, landingPage: null, firstTouchAt: null,
  });
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ins.lastInsertRowid);
  assert.equal(row.utm_source, 'tiktok', 'already-set field must not be overwritten');
  assert.equal(row.utm_medium, 'social', 'previously-empty field must still be filled in on the same call');
});

test('applyFirstTouchAttribution is a no-op when attribution is null', () => {
  const db = setup();
  const ins = db.prepare(`INSERT INTO contacts (first_name, email) VALUES ('NoAttr', 'noattr@example.com')`).run();
  applyFirstTouchAttribution(db, ins.lastInsertRowid, null);
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(ins.lastInsertRowid);
  assert.equal(row.utm_source, null);
});

// ── Display formatting ────────────────────────────────────────────────────

test('formatUtmSourceLabel: tiktok -> "TikTok" (proper-noun override)', () => {
  assert.equal(formatUtmSourceLabel('tiktok'), 'TikTok');
  assert.equal(formatUtmSourceLabel('TikTok'), 'TikTok', 'case-insensitive match against the override key');
});

test('formatUtmSourceLabel: facebook-personal / facebook-business / instagram humanize correctly with no override needed', () => {
  assert.equal(formatUtmSourceLabel('facebook-personal'), 'Facebook Personal');
  assert.equal(formatUtmSourceLabel('facebook-business'), 'Facebook Business');
  assert.equal(formatUtmSourceLabel('instagram'), 'Instagram');
});

test('formatUtmSourceLabel returns null for a missing value', () => {
  assert.equal(formatUtmSourceLabel(null), null);
  assert.equal(formatUtmSourceLabel(''), null);
});

test('humanizeSlug: hyphens/underscores become spaces, each word Title Cased', () => {
  assert.equal(humanizeSlug('liam-2026'), 'Liam 2026');
  assert.equal(humanizeSlug('test-video'), 'Test Video');
  assert.equal(humanizeSlug('social'), 'Social');
  assert.equal(humanizeSlug('paid_social'), 'Paid Social');
});

test('humanizeSlug returns null for a missing value', () => {
  assert.equal(humanizeSlug(null), null);
  assert.equal(humanizeSlug(''), null);
});
