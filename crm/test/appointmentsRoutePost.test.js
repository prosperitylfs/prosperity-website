// Focused test for POST /api/appointments after 2026-10-14's change to
// route through crm/lib/appointmentService.js's createAppointment --
// confirms the HTTP-level contract (status codes, duplicate handling)
// still matches what crm/public/app/appointments.html's existing "Add
// Appointment" form expects, now with duplicate protection.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

process.env.DB_PATH = ':memory:';
const db = require('../db/database');
const router = require('../routes/appointments');

let server, baseUrl, contactId;

before(() => {
  contactId = db.prepare(`INSERT INTO contacts (first_name, last_name) VALUES ('Route', 'Test')`).run().lastInsertRowid;
  const app = express();
  app.use(express.json());
  app.use('/api/appointments', router);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/appointments`;
});

after(() => { server.close(); });

async function postAppt(body) {
  return fetch(baseUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('A. POST /: 201 and a real appointment row for a new booking', async () => {
  const res = await postAppt({ contact_id: contactId, appt_type: 'Phone Call', appt_datetime: '2026-12-01T10:00' });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.contact_id, contactId);
  assert.equal(body.status, 'Scheduled');
});

test('B. POST /: a retried/double-submitted identical booking returns 200 with the SAME appointment, not a new one', async () => {
  const first = await (await postAppt({ contact_id: contactId, appt_type: 'Phone Call', appt_datetime: '2026-12-02T10:00' })).json();
  const res2 = await postAppt({ contact_id: contactId, appt_type: 'Phone Call', appt_datetime: '2026-12-02T10:00' });
  assert.equal(res2.status, 200);
  const second = await res2.json();
  assert.equal(second.id, first.id);
});

test('C. POST /: 400 for missing required fields', async () => {
  assert.equal((await postAppt({ appt_type: 'x', appt_datetime: '2026-12-03T10:00' })).status, 400);
  assert.equal((await postAppt({ contact_id: contactId, appt_datetime: '2026-12-03T10:00' })).status, 400);
  assert.equal((await postAppt({ contact_id: contactId, appt_type: 'x' })).status, 400);
});

test('D. POST /: 404 for an unknown contact', async () => {
  const res = await postAppt({ contact_id: 999999, appt_type: 'x', appt_datetime: '2026-12-04T10:00' });
  assert.equal(res.status, 404);
});
