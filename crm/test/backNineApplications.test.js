// Tests for crm/lib/backNineApplications.js -- storage, status mapping,
// and manual contact matching for BackNine applications.

const test = require('node:test');
const { before } = test;
const assert = require('node:assert/strict');

process.env.DB_PATH = ':memory:';
const db = require('../db/database');
const { runBackNineMigrations } = require('../db/migrateBackNine');
const {
  computeDisplayStatus,
  upsertApplicationFromEapp,
  matchApplicationToContact,
  listApplicationsForContact,
  listNeedsReviewApplications,
  backfillApplicationFields,
  getApplicationById,
} = require('../lib/backNineApplications');
const { extractConfirmedEappSummary } = require('../lib/backNineWebhook');

// Real production payload shape confirmed 2026-10-12 against BackNine case
// #560015 (Janet Jackson) -- product/carrier/face amount/premium/term are
// nested, not top-level as the docs' own illustrative example suggested.
const JANET_560015_PAYLOAD = {
  id: 560015,
  uuid: 'janet-560015-uuid',
  first_name: 'Janet',
  last_name: 'Jackson',
  named_step: 'Quote - 10% Complete',
  product: { name: 'OPTerm 20', carrier: { name: 'Banner' } },
  individuals: [{ quote: { product_category: '20 Year Term', face_amount: 1000000, premium: 224.73, pay_duration: 20 }, phone: null, email: null }],
};

before(() => {
  runBackNineMigrations(db);
});

test('A. computeDisplayStatus: "Issued" anywhere in the timeline maps to Completed', () => {
  assert.equal(computeDisplayStatus({ timeline: ['Submitted to Carrier', 'Approved', 'Issued'] }), 'Completed');
});

test('B. computeDisplayStatus: every other confirmed example value defaults to Needs Review, never a guessed bucket', () => {
  assert.equal(computeDisplayStatus({ timeline: ['Submitted to Carrier', 'Approved'] }), 'Needs Review');
  assert.equal(computeDisplayStatus({ timeline: ['Entered'] }), 'Needs Review');
  assert.equal(computeDisplayStatus({ timeline: [] }), 'Needs Review');
  assert.equal(computeDisplayStatus({ timeline: null }), 'Needs Review');
  assert.equal(computeDisplayStatus({}), 'Needs Review');
});

test('C. upsertApplicationFromEapp: creates a new row, always needs_review / no contact, for a first delivery', () => {
  const summary = { backNineUuid: 'lib-test-c-uuid', backNineId: '1', firstName: 'Ann', lastName: 'Lee', productCategory: 'Term', faceAmount: 500000, premium: 40, eappStatus: 'Completed', namedStep: 'DocuSign', caseStatus: 'Entered', timeline: ['Submitted to Carrier'] };
  const result = upsertApplicationFromEapp(db, summary, { id: 1, uuid: 'lib-test-c-uuid' });
  assert.equal(result.ok, true);
  assert.equal(result.outcome, 'created');
  assert.equal(result.application.match_status, 'needs_review');
  assert.equal(result.application.contact_id, null);
  assert.equal(result.application.display_status, 'Needs Review');
  assert.equal(result.application.first_name, 'Ann');
  assert.deepEqual(JSON.parse(result.application.raw_payload), { id: 1, uuid: 'lib-test-c-uuid' });
});

test('D. upsertApplicationFromEapp: a second delivery for the same uuid updates the same row in place', () => {
  const summary1 = { backNineUuid: 'lib-test-d-uuid', premium: 10, timeline: [] };
  const summary2 = { backNineUuid: 'lib-test-d-uuid', premium: 15, timeline: ['Issued'] };
  const r1 = upsertApplicationFromEapp(db, summary1, {});
  const r2 = upsertApplicationFromEapp(db, summary2, {});
  assert.equal(r2.outcome, 'updated');
  assert.equal(r1.application.id, r2.application.id);
  assert.equal(r2.application.premium, 15);
  assert.equal(r2.application.display_status, 'Completed');

  const all = db.prepare('SELECT * FROM backnine_applications WHERE backnine_uuid = ?').all('lib-test-d-uuid');
  assert.equal(all.length, 1);
});

test('E. upsertApplicationFromEapp: updating an already-matched row never touches contact_id/match_status', () => {
  const r1 = upsertApplicationFromEapp(db, { backNineUuid: 'lib-test-e-uuid' }, {});
  const contactId = db.prepare(`INSERT INTO contacts (first_name) VALUES ('Match Target')`).run().lastInsertRowid;
  matchApplicationToContact(db, { applicationId: r1.application.id, contactId, actor: 'test' });

  const r2 = upsertApplicationFromEapp(db, { backNineUuid: 'lib-test-e-uuid', premium: 77 }, {});
  assert.equal(r2.application.match_status, 'matched');
  assert.equal(r2.application.contact_id, contactId);
  assert.equal(r2.application.premium, 77);
});

test('F. upsertApplicationFromEapp: returns ok:false for a missing uuid, writes nothing', () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM backnine_applications').get().n;
  const result = upsertApplicationFromEapp(db, { firstName: 'No Uuid' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'missing_uuid');
  const after = db.prepare('SELECT COUNT(*) AS n FROM backnine_applications').get().n;
  assert.equal(after, before);
});

test('G. upsertApplicationFromEapp: returns ok:false/migration_not_run rather than throwing when the table does not exist', () => {
  const Database = require('better-sqlite3');
  const freshDb = new Database(':memory:');
  freshDb.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY)'); // minimal, no backnine_applications
  const result = upsertApplicationFromEapp(freshDb, { backNineUuid: 'orphan-uuid' }, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'migration_not_run');
  freshDb.close();
});

test('H. matchApplicationToContact: requires an actor', () => {
  const r = upsertApplicationFromEapp(db, { backNineUuid: 'lib-test-h-uuid' }, {});
  assert.throws(() => matchApplicationToContact(db, { applicationId: r.application.id, contactId: 1 }), /actor is required/);
});

test('I. matchApplicationToContact: throws for an unknown application or unknown contact', () => {
  const contactId = db.prepare(`INSERT INTO contacts (first_name) VALUES ('X')`).run().lastInsertRowid;
  assert.throws(() => matchApplicationToContact(db, { applicationId: 999999, contactId, actor: 'test' }), /does not exist/);

  const r = upsertApplicationFromEapp(db, { backNineUuid: 'lib-test-i-uuid' }, {});
  assert.throws(() => matchApplicationToContact(db, { applicationId: r.application.id, contactId: 999999, actor: 'test' }), /does not exist/);
});

test('J. matchApplicationToContact: sets contact_id, match_status, matched_at, matched_by', () => {
  const r = upsertApplicationFromEapp(db, { backNineUuid: 'lib-test-j-uuid' }, {});
  const contactId = db.prepare(`INSERT INTO contacts (first_name) VALUES ('Matched Person')`).run().lastInsertRowid;
  const matched = matchApplicationToContact(db, { applicationId: r.application.id, contactId, actor: 'loretta' });
  assert.equal(matched.contact_id, contactId);
  assert.equal(matched.match_status, 'matched');
  assert.equal(matched.matched_by, 'loretta');
  assert.ok(matched.matched_at);
});

test('K. listApplicationsForContact: only matched applications for that exact contact, never needs_review ones', () => {
  const contactId = db.prepare(`INSERT INTO contacts (first_name) VALUES ('List Target')`).run().lastInsertRowid;
  const otherContactId = db.prepare(`INSERT INTO contacts (first_name) VALUES ('Other')`).run().lastInsertRowid;

  const matched = upsertApplicationFromEapp(db, { backNineUuid: 'lib-test-k-matched' }, {});
  matchApplicationToContact(db, { applicationId: matched.application.id, contactId, actor: 'test' });

  upsertApplicationFromEapp(db, { backNineUuid: 'lib-test-k-needs-review' }, {}); // left unmatched

  const otherMatched = upsertApplicationFromEapp(db, { backNineUuid: 'lib-test-k-other' }, {});
  matchApplicationToContact(db, { applicationId: otherMatched.application.id, contactId: otherContactId, actor: 'test' });

  const results = listApplicationsForContact(db, contactId);
  assert.equal(results.length, 1);
  assert.equal(results[0].backnine_uuid, 'lib-test-k-matched');
});

test('L. listApplicationsForContact: returns [] (never throws) when the table does not exist', () => {
  const Database = require('better-sqlite3');
  const freshDb = new Database(':memory:');
  freshDb.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY)');
  assert.deepEqual(listApplicationsForContact(freshDb, 1), []);
  freshDb.close();
});

test('M. listNeedsReviewApplications: only needs_review rows, excludes matched ones', () => {
  const Database = require('better-sqlite3');
  const freshDb = new Database(':memory:');
  freshDb.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY, first_name TEXT)');
  runBackNineMigrations(freshDb);

  upsertApplicationFromEapp(freshDb, { backNineUuid: 'lib-test-m-review-1' }, {});
  upsertApplicationFromEapp(freshDb, { backNineUuid: 'lib-test-m-review-2' }, {});
  const toMatch = upsertApplicationFromEapp(freshDb, { backNineUuid: 'lib-test-m-matched' }, {});
  const contactId = freshDb.prepare(`INSERT INTO contacts (first_name) VALUES ('X')`).run().lastInsertRowid;
  matchApplicationToContact(freshDb, { applicationId: toMatch.application.id, contactId, actor: 'test' });

  const results = listNeedsReviewApplications(freshDb);
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.match_status === 'needs_review'));
  freshDb.close();
});

test('N. upsertApplicationFromEapp + extractConfirmedEappSummary: Janet Jackson (#560015) real payload shape extracts product/carrier/term correctly', () => {
  const summary = extractConfirmedEappSummary(JANET_560015_PAYLOAD);
  const result = upsertApplicationFromEapp(db, summary, JANET_560015_PAYLOAD);
  assert.equal(result.ok, true);
  const app = result.application;
  assert.equal(app.product_name, 'OPTerm 20');
  assert.equal(app.carrier_name, 'Banner');
  assert.equal(app.product_category, '20 Year Term');
  assert.equal(app.face_amount, 1000000);
  assert.equal(app.premium, 224.73);
  assert.equal(app.pay_duration_years, 20);
  assert.equal(app.named_step, 'Quote - 10% Complete');
});

test('O. listNeedsReviewApplications / listApplicationsForContact / getApplicationById never return raw_payload', () => {
  const summary = extractConfirmedEappSummary(JANET_560015_PAYLOAD);
  const created = upsertApplicationFromEapp(db, { ...summary, backNineUuid: 'lib-test-o-uuid' }, JANET_560015_PAYLOAD);

  const needsReview = listNeedsReviewApplications(db).find(a => a.id === created.application.id);
  assert.equal(Object.prototype.hasOwnProperty.call(needsReview, 'raw_payload'), false);

  const contactId = db.prepare(`INSERT INTO contacts (first_name) VALUES ('O Target')`).run().lastInsertRowid;
  matchApplicationToContact(db, { applicationId: created.application.id, contactId, actor: 'test' });
  const matchedList = listApplicationsForContact(db, contactId);
  assert.equal(Object.prototype.hasOwnProperty.call(matchedList[0], 'raw_payload'), false);

  const detail = getApplicationById(db, created.application.id);
  assert.equal(Object.prototype.hasOwnProperty.call(detail, 'raw_payload'), false);
  assert.equal(detail.product_name, 'OPTerm 20');
});

test('P. getApplicationById: returns null for an unknown id, without throwing', () => {
  assert.equal(getApplicationById(db, 999999), null);
});

test('Q. backfillApplicationFields: re-derives product/carrier/face amount/premium/term from stored raw_payload, using the field mapping that existed BEFORE the 2026-10-12 fix', () => {
  // Simulates exactly what happened to Janet's real application: stored
  // under the OLD (docs-only) extraction logic, which only read top-level
  // product_category/face_amount/premium -- none of which exist in the
  // real payload, so they were stored null even though raw_payload always
  // had the full, correct data.
  const Database = require('better-sqlite3');
  const freshDb = new Database(':memory:');
  freshDb.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY, first_name TEXT)');
  runBackNineMigrations(freshDb);

  const oldSummary = {
    backNineUuid: 'lib-test-q-uuid', backNineId: '560015', firstName: 'Janet', lastName: 'Jackson',
    productCategory: null, faceAmount: null, premium: null, namedStep: 'Quote - 10% Complete',
  };
  const created = upsertApplicationFromEapp(freshDb, oldSummary, JANET_560015_PAYLOAD);
  assert.equal(created.application.product_category, null);
  assert.equal(created.application.face_amount, null);

  const contactId = freshDb.prepare(`INSERT INTO contacts (first_name) VALUES ('Janet')`).run().lastInsertRowid;
  matchApplicationToContact(freshDb, { applicationId: created.application.id, contactId, actor: 'loretta' });

  const result = backfillApplicationFields(freshDb, { extractConfirmedEappSummary });
  assert.equal(result.ok, true);
  assert.equal(result.updated, 1);

  const after = freshDb.prepare('SELECT * FROM backnine_applications WHERE id = ?').get(created.application.id);
  assert.equal(after.product_name, 'OPTerm 20');
  assert.equal(after.carrier_name, 'Banner');
  assert.equal(after.face_amount, 1000000);
  assert.equal(after.premium, 224.73);
  assert.equal(after.pay_duration_years, 20);
  // Never touched by the backfill:
  assert.equal(after.contact_id, contactId);
  assert.equal(after.match_status, 'matched');
  assert.deepEqual(JSON.parse(after.raw_payload), JANET_560015_PAYLOAD);

  freshDb.close();
});

test('R. backfillApplicationFields: returns ok:false/migration_not_run rather than throwing when the table does not exist', () => {
  const Database = require('better-sqlite3');
  const freshDb = new Database(':memory:');
  freshDb.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY)');
  const result = backfillApplicationFields(freshDb, { extractConfirmedEappSummary });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'migration_not_run');
  freshDb.close();
});

// 2026-10-13 PRODUCTION REGRESSION: the table existing with an OLDER
// schema (missing product_name/carrier_name/pay_duration_years, added by
// a later migration) must never crash the Client Record page for EVERY
// client -- it broke in exactly this way in production because the
// follow-up migration hadn't been run yet. These tests build a table that
// deliberately predates that migration (same CREATE TABLE as the original
// Phase 1 schema, minus the 3 later columns) to reproduce it precisely.
function createPreMigrationTable(freshDb) {
  freshDb.exec(`
    CREATE TABLE backnine_applications (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      backnine_uuid     TEXT NOT NULL UNIQUE,
      backnine_id       TEXT,
      contact_id        INTEGER,
      match_status      TEXT NOT NULL DEFAULT 'needs_review',
      first_name        TEXT,
      last_name         TEXT,
      product_category  TEXT,
      face_amount       REAL,
      premium           REAL,
      backnine_status   TEXT,
      named_step        TEXT,
      case_status       TEXT,
      display_status    TEXT NOT NULL DEFAULT 'Needs Review',
      raw_payload       TEXT NOT NULL,
      received_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
      matched_at        DATETIME,
      matched_by        TEXT
    );
  `);
  freshDb.prepare(`
    INSERT INTO backnine_applications (backnine_uuid, backnine_id, contact_id, match_status, raw_payload)
    VALUES ('pre-migration-uuid', '999', ?, 'matched', '{}')
  `).run(freshDb.prepare(`INSERT INTO contacts (first_name) VALUES ('Pre Migration')`).run().lastInsertRowid);
}

test('S. listApplicationsForContact: a table missing the newer columns returns [] instead of crashing every client page', () => {
  const Database = require('better-sqlite3');
  const freshDb = new Database(':memory:');
  freshDb.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY, first_name TEXT)');
  createPreMigrationTable(freshDb);
  const contactId = freshDb.prepare(`SELECT contact_id FROM backnine_applications WHERE backnine_uuid = 'pre-migration-uuid'`).get().contact_id;

  assert.doesNotThrow(() => listApplicationsForContact(freshDb, contactId));
  assert.deepEqual(listApplicationsForContact(freshDb, contactId), []);
  freshDb.close();
});

test('T. listNeedsReviewApplications: same pre-migration table returns [] instead of crashing the admin page', () => {
  const Database = require('better-sqlite3');
  const freshDb = new Database(':memory:');
  freshDb.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY, first_name TEXT)');
  createPreMigrationTable(freshDb);

  assert.doesNotThrow(() => listNeedsReviewApplications(freshDb));
  assert.deepEqual(listNeedsReviewApplications(freshDb), []);
  freshDb.close();
});

test('U. getApplicationById: same pre-migration table returns null instead of crashing the detail view', () => {
  const Database = require('better-sqlite3');
  const freshDb = new Database(':memory:');
  freshDb.exec('CREATE TABLE contacts (id INTEGER PRIMARY KEY, first_name TEXT)');
  createPreMigrationTable(freshDb);
  const row = freshDb.prepare(`SELECT id FROM backnine_applications WHERE backnine_uuid = 'pre-migration-uuid'`).get();

  assert.doesNotThrow(() => getApplicationById(freshDb, row.id));
  // SELECT * still works here (unlike the SAFE_COLUMNS-based list queries)
  // since it never names a specific column -- confirms getApplicationById's
  // own try/catch is a true belt-and-suspenders guard, not masking a
  // different, always-triggered failure.
  assert.ok(getApplicationById(freshDb, row.id));
  freshDb.close();
});
