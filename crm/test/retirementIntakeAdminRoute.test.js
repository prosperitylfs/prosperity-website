// Tests for the STAFF-ONLY crm/routes/retirementIntakeAdmin.js — GET
// /contact/:id and PATCH /:id. In production this sits behind
// dashboardAuth + requireApiKey (crm/server.js); those are generic
// cross-cutting middleware already covered elsewhere, so — matching
// crm/test/tasksRoute.test.js's and calcomWebhookRoute.test.js's own
// approach — this file mounts just the router under test and exercises its
// own request handling directly.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const savedEnv = { DB_PATH: process.env.DB_PATH };
process.env.DB_PATH = ':memory:';

const db = require('../db/database');
const adminRouter = require('../routes/retirementIntakeAdmin');
const { createIntakeForAppointment, submitIntakeResponses } = require('../lib/retirementIntakeService');

let server, baseUrl;

before(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/retirement-intake-admin', adminRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/retirement-intake-admin`;
});

after(() => {
  server.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

let seq = 0;
function seedContactAndAppointment(apptDatetime = '2026-09-10T18:00:00.000Z') {
  seq += 1;
  const contact = db.prepare(`
    INSERT INTO contacts (first_name, last_name, email, phone, phone_e164)
    VALUES (?, ?, ?, ?, ?)
  `).run('Jane', 'Doe', `jane-admin-${Date.now()}-${seq}@example.com`, '(414) 555-0100', '+14145550100');
  const appt = db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status)
    VALUES (?, 'Safe Money & Retirement Consultation', ?, 'Scheduled')
  `).run(contact.lastInsertRowid, apptDatetime);
  const intake = createIntakeForAppointment(db, {
    contactId: contact.lastInsertRowid,
    appointmentId: appt.lastInsertRowid,
  });
  return { contactId: contact.lastInsertRowid, appointmentId: appt.lastInsertRowid, intake };
}

test('GET /contact/:id returns the intake with computed displayStatus and deadline', async () => {
  const { contactId } = seedContactAndAppointment('2026-09-10T18:00:00.000Z');
  const res = await fetch(`${baseUrl}/contact/${contactId}`);
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.length, 1);
  assert.equal(list[0].displayStatus, 'Not Sent');
  assert.equal(list[0].deadline, '2026-09-10T16:00:00.000Z');
});

test('GET /contact/:id returns an empty array for a contact with no retirement appointments', async () => {
  const res = await fetch(`${baseUrl}/contact/999999`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('GET /contact/:id includes the fully parsed responses once completed', async () => {
  const { contactId, intake } = seedContactAndAppointment();
  submitIntakeResponses(db, {
    token: intake.token,
    responses: { about: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '4145550100' } },
  });
  const res = await fetch(`${baseUrl}/contact/${contactId}`);
  const list = await res.json();
  assert.equal(list[0].displayStatus, 'Completed');
  assert.equal(list[0].responses.about.firstName, 'Jane');
});

test('PATCH /:id with action=mark_sent flips Not Sent to Sent', async () => {
  const { intake } = seedContactAndAppointment();
  const res = await fetch(`${baseUrl}/${intake.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'mark_sent' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'Sent');
  assert.ok(body.sent_at);
});

test('PATCH /:id with an unsupported action is rejected (400)', async () => {
  const { intake } = seedContactAndAppointment();
  const res = await fetch(`${baseUrl}/${intake.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'send_email' }),
  });
  assert.equal(res.status, 400);
});

test('PATCH /:id for a nonexistent intake returns 404', async () => {
  const res = await fetch(`${baseUrl}/999999`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'mark_sent' }),
  });
  assert.equal(res.status, 404);
});
