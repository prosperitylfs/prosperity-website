// Tests for the PUBLIC crm/routes/retirementIntake.js — GET/POST
// /api/retirement-intake/:token. Mirrors crm/test/calcomWebhookRoute.test.js's
// approach: DB_PATH is pointed at an in-memory database BEFORE
// crm/db/database.js is first required anywhere in this process, then a
// real Express app is spun up on an ephemeral port with just this router
// mounted (no dashboardAuth/requireApiKey — this route is genuinely public).

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const savedEnv = { DB_PATH: process.env.DB_PATH };
process.env.DB_PATH = ':memory:';

const db = require('../db/database');
const retirementIntakeRouter = require('../routes/retirementIntake');
const { createIntakeForAppointment } = require('../lib/retirementIntakeService');

let server, baseUrl;

before(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/retirement-intake', retirementIntakeRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/retirement-intake`;
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
  `).run('Jane', 'Doe', `jane-${Date.now()}-${seq}@example.com`, '(414) 555-0100', '+14145550100');
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

const validAbout = { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '4145550100' };

test('GET with a valid token returns name/appointment/deadline/status and no raw IDs', async () => {
  const { intake } = seedContactAndAppointment('2026-09-10T18:00:00.000Z');
  const res = await fetch(`${baseUrl}/${intake.token}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.firstName, 'Jane');
  assert.equal(body.appointmentDatetime, '2026-09-10T18:00:00.000Z');
  assert.equal(body.deadline, '2026-09-10T16:00:00.000Z');
  assert.equal(body.status, 'Not Sent');
  assert.equal(body.contact_id, undefined);
  assert.equal(body.appointment_id, undefined);
  assert.equal(body.id, undefined);
});

test('GET with an invalid token returns 404', async () => {
  const res = await fetch(`${baseUrl}/not-a-real-token`);
  assert.equal(res.status, 404);
});

test('POST with a valid token and required fields marks the intake Completed', async () => {
  const { intake, appointmentId } = seedContactAndAppointment();
  const res = await fetch(`${baseUrl}/${intake.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: { about: validAbout, helpWith: { mainConcern: 'Protect principal' } } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  const row = db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(appointmentId);
  assert.equal(row.status, 'Completed');
  assert.ok(row.completed_at);
});

test('POST with missing required fields is rejected (400) and does not mark Completed', async () => {
  const { intake, appointmentId } = seedContactAndAppointment();
  const res = await fetch(`${baseUrl}/${intake.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: { about: { firstName: 'Jane' } } }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(Array.isArray(body.details) && body.details.length > 0);

  const row = db.prepare('SELECT * FROM retirement_intakes WHERE appointment_id = ?').get(appointmentId);
  assert.equal(row.status, 'Not Sent');
});

test('POST with an invalid token returns 404 and writes nothing', async () => {
  const res = await fetch(`${baseUrl}/not-a-real-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: { about: validAbout } }),
  });
  assert.equal(res.status, 404);
});

test('a completed submission never creates a second contact or appointment', async () => {
  const { intake, contactId, appointmentId } = seedContactAndAppointment();
  const before1Contacts = db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n;
  const before1Appts = db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n;

  await fetch(`${baseUrl}/${intake.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ responses: { about: validAbout } }),
  });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n, before1Contacts);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n, before1Appts);
  assert.ok(contactId && appointmentId); // sanity: fixture actually seeded
});
