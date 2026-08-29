// Tests for GET /api/stats' new apptsUpcoming count (crm/routes/stats.js)
// and its matching GET /api/contacts?appt_upcoming=1 click-through filter
// (crm/routes/contacts.js) -- added alongside the existing, unchanged
// apptsToday card. Mirrors crm/test/contactsRoute.test.js's app-setup
// approach: DB_PATH points at an in-memory database before crm/db/database.js
// is first required, then a real Express app is exercised with real HTTP
// requests.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const savedEnv = { DB_PATH: process.env.DB_PATH };
process.env.DB_PATH = ':memory:';

const db = require('../db/database');
const statsRouter = require('../routes/stats');
const contactsRouter = require('../routes/contacts');

let server, statsUrl, contactsUrl;

before(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/stats', statsRouter);
  app.use('/api/contacts', contactsRouter);
  server = app.listen(0);
  const port = server.address().port;
  statsUrl = `http://127.0.0.1:${port}/api/stats`;
  contactsUrl = `http://127.0.0.1:${port}/api/contacts`;
});

after(() => {
  server.close();
  if (savedEnv.DB_PATH === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = savedEnv.DB_PATH;
});

function makeContact(label) {
  return db.prepare(`INSERT INTO contacts (first_name, last_name) VALUES (?, 'Test')`).run(label).lastInsertRowid;
}
function makeAppt(contactId, { apptDatetime, status = 'Scheduled' }) {
  return db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status)
    VALUES (?, 'Consultation', ?, ?)
  `).run(contactId, apptDatetime, status).lastInsertRowid;
}
function isoIn(hoursFromNow) {
  return new Date(Date.now() + hoursFromNow * 3600 * 1000).toISOString();
}

async function getStats() {
  return (await fetch(statsUrl)).json();
}

test('apptsUpcoming counts a future, non-cancelled appointment', async () => {
  const before_ = await getStats();
  const c = makeContact('Future1');
  makeAppt(c, { apptDatetime: isoIn(5) });
  const after_ = await getStats();
  assert.equal(after_.apptsUpcoming, before_.apptsUpcoming + 1);
});

test('apptsUpcoming does not count a past appointment', async () => {
  const before_ = await getStats();
  const c = makeContact('Past1');
  makeAppt(c, { apptDatetime: isoIn(-5) });
  const after_ = await getStats();
  assert.equal(after_.apptsUpcoming, before_.apptsUpcoming);
});

test('apptsUpcoming does not count a cancelled appointment even if its time is in the future', async () => {
  const before_ = await getStats();
  const c = makeContact('CancelledFuture');
  makeAppt(c, { apptDatetime: isoIn(5), status: 'Cancelled' });
  const after_ = await getStats();
  assert.equal(after_.apptsUpcoming, before_.apptsUpcoming);
});

test('an appointment later today counts in BOTH apptsToday and apptsUpcoming', async () => {
  const before_ = await getStats();
  const c = makeContact('LaterToday');
  // A few hours from now, same UTC calendar day in most cases -- but to be
  // deterministic regardless of what time the test runs, pin explicitly to
  // "later today" in the same way apptsToday itself determines "today"
  // (America/Chicago calendar date), then pick a time within that day that
  // is still in the future relative to right now.
  const todayCT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const soon = isoIn(1); // 1 hour from now -- always still "today" in practice for this test
  makeAppt(c, { apptDatetime: soon });
  const after_ = await getStats();
  assert.equal(after_.apptsUpcoming, before_.apptsUpcoming + 1);
  // Only assert the apptsToday side if the 1-hour-from-now instant is
  // genuinely still within today's CT calendar date (avoids flakiness right
  // at the CT day boundary).
  if (soon.slice(0, 10) === todayCT || new Date(soon).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) === todayCT) {
    assert.equal(after_.apptsToday, before_.apptsToday + 1, 'an appointment later today must also count in Appts Today');
  }
});

test('GET /api/contacts?appt_upcoming=1 returns exactly the contacts with a future, non-cancelled appointment', async () => {
  const withFuture = makeContact('WithFuture');
  makeAppt(withFuture, { apptDatetime: isoIn(24) });

  const withPastOnly = makeContact('WithPastOnly');
  makeAppt(withPastOnly, { apptDatetime: isoIn(-24) });

  const withCancelledFuture = makeContact('WithCancelledFuture');
  makeAppt(withCancelledFuture, { apptDatetime: isoIn(24), status: 'Cancelled' });

  const res = await fetch(`${contactsUrl}?appt_upcoming=1`);
  const contacts = await res.json();
  const ids = contacts.map(c => c.id);

  assert.ok(ids.includes(withFuture), 'a contact with a future scheduled appointment must be included');
  assert.ok(!ids.includes(withPastOnly), 'a contact with only a past appointment must not be included');
  assert.ok(!ids.includes(withCancelledFuture), 'a contact with only a cancelled future appointment must not be included');
});
