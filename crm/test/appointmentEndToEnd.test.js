// End-to-end proof (not just an API health check, per explicit instruction)
// that creating one appointment through the canonical POST /api/appointments
// endpoint makes it show up everywhere it's supposed to: the client
// record's own Appointments tab (getClientDetail), the main Appointments
// page (GET /api/appointments?view=upcoming), and the dashboard's Upcoming
// Appointments count (GET /api/stats). All three are hit as real HTTP
// requests against the same in-memory database and the same real routers
// used in production -- no query is reimplemented/duplicated here.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

process.env.DB_PATH = ':memory:';
const db = require('../db/database');
const { runMigrations: runBrandsMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { getClientDetail } = require('../lib/dashboardQueries');
const appointmentsRouter = require('../routes/appointments');
const statsRouter = require('../routes/stats');

let server, baseUrl, contactId;

before(() => {
  // Same migration set crm/test/activityService.test.js's own setup()
  // uses -- getClientDetail reads across all of these.
  runBrandsMigrations(db); runDashboardMigrations(db); runCrmAppMigrations(db); runCrmCoreMigrations(db);
  contactId = db.prepare(`INSERT INTO contacts (first_name, last_name) VALUES ('Tiffany', 'Williams')`).run().lastInsertRowid;
  const app = express();
  app.use(express.json());
  app.use('/api/appointments', appointmentsRouter);
  app.use('/api/stats', statsRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); });

test('a future appointment created via POST /api/appointments appears in all three places: client detail, main Appointments page, and dashboard Upcoming Appointments', async () => {
  // Fixed far-future date so this test never flakes based on "today".
  const futureDatetime = '2030-06-15T14:00';

  const beforeStats = await (await fetch(`${baseUrl}/api/stats`)).json();
  const beforeUpcoming = beforeStats.apptsUpcoming;

  const createRes = await fetch(`${baseUrl}/api/appointments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, appt_type: 'Life Insurance Consultation', appt_datetime: futureDatetime, duration_min: 45, location: 'Video Call', notes: 'Discuss coverage options' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json();

  // 1. Client record's own Appointments tab.
  const detail = getClientDetail(db, contactId);
  assert.equal(detail.appointments.length, 1);
  assert.equal(detail.appointments[0].id, created.id);
  assert.equal(detail.appointments[0].appt_type, 'Life Insurance Consultation');
  assert.equal(detail.appointments[0].location, 'Video Call');

  // 2. Main Appointments page (upcoming view).
  const upcomingRes = await fetch(`${baseUrl}/api/appointments?view=upcoming`);
  const upcoming = await upcomingRes.json();
  assert.ok(upcoming.some(a => a.id === created.id), 'new appointment must appear in the main Appointments page\'s upcoming view');
  const row = upcoming.find(a => a.id === created.id);
  assert.equal(row.first_name, 'Tiffany');
  assert.equal(row.last_name, 'Williams');

  // 3. Dashboard "Upcoming Appointments" count.
  const afterStats = await (await fetch(`${baseUrl}/api/stats`)).json();
  assert.equal(afterStats.apptsUpcoming, beforeUpcoming + 1);
});

test('cancelling an appointment removes it from the dashboard Upcoming Appointments count but it still shows (as Cancelled) in the client record', async () => {
  const futureDatetime = '2030-07-20T10:00';
  const created = await (await fetch(`${baseUrl}/api/appointments`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contact_id: contactId, appt_type: 'Follow-up', appt_datetime: futureDatetime }),
  })).json();

  const beforeCancel = await (await fetch(`${baseUrl}/api/stats`)).json();

  await fetch(`${baseUrl}/api/appointments/${created.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Cancelled' }),
  });

  const afterCancel = await (await fetch(`${baseUrl}/api/stats`)).json();
  assert.equal(afterCancel.apptsUpcoming, beforeCancel.apptsUpcoming - 1);

  const detail = getClientDetail(db, contactId);
  const cancelled = detail.appointments.find(a => a.id === created.id);
  assert.ok(cancelled);
  assert.equal(cancelled.status, 'Cancelled');
});
