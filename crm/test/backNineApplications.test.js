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
} = require('../lib/backNineApplications');

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
