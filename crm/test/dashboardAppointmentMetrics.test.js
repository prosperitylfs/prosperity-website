// Tests for the Dashboard's "Today's Appointments" (corrected, 2026-09-30)
// and new "Upcoming Appointments" metrics in crm/lib/dashboardQueries.js's
// getDashboardSummary. Kept in its own file rather than added to
// test/appQueries.test.js or test/dashboardQueries.test.js, both of which
// currently hold an unrelated, still-uncommitted, on-hold feature's changes
// that must not be touched or built on top of.
//
// Covers: America/Chicago day-boundary correctness (not UTC), brand
// scoping via appointments.booking_brand (not contact_brands), the
// Scheduled-only status filter (so Cancelled/Rescheduled/Completed/
// No-Show never count in either metric), and that Today's + Upcoming
// never double-count the same appointment.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { dedupeContact } = require('../lib/caseMatching');
const { getDashboardSummary } = require('../lib/dashboardQueries');

function setup() {
  const db = createLegacyDb();
  runMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  runRevenueMvpMigrations(db);
  return { db };
}

function seedAppt(db, contactId, { apptDatetime, status = 'Scheduled', bookingBrand = null }) {
  return db.prepare(`
    INSERT INTO appointments (contact_id, appt_type, appt_datetime, status, booking_brand)
    VALUES (?, 'Safe Money & Retirement Consultation', ?, ?, ?)
  `).run(contactId, apptDatetime, status, bookingBrand).lastInsertRowid;
}

// A Chicago wall-clock date/time expressed as its correct UTC ISO instant,
// so tests don't have to hardcode a DST offset by hand.
function chicagoToUtcIso(y, m, d, hh, mm) {
  // Find the UTC instant whose America/Chicago rendering matches the
  // requested wall-clock date/time, by probing both plausible offsets
  // (CDT -5 / CST -6) -- avoids depending on any timezone library.
  for (const offsetHours of [5, 6]) {
    const guess = new Date(Date.UTC(y, m - 1, d, hh + offsetHours, mm));
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(guess);
    const get = (t) => parts.find(p => p.type === t).value;
    if (Number(get('year')) === y && Number(get('month')) === m && Number(get('day')) === d
      && Number(get('hour')) === hh % 24 && Number(get('minute')) === mm) {
      return guess.toISOString();
    }
  }
  throw new Error('could not resolve Chicago wall-clock time to UTC for this test');
}

function todayChicagoParts() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (t) => Number(parts.find(p => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

test('todaysAppointments counts a Scheduled appointment on the current Chicago calendar day', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'today@example.com', first_name: 'Amirah' });
  const { y, m, d } = todayChicagoParts();
  seedAppt(db, contact.id, { apptDatetime: chicagoToUtcIso(y, m, d, 10, 0) });

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.todaysAppointments, 1);
  assert.equal(summary.upcomingAppointments, 0);
});

test('upcomingAppointments counts a Scheduled appointment strictly AFTER today, never inside todaysAppointments too', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'tomorrow@example.com', first_name: 'Renee' });
  const { y, m, d } = todayChicagoParts();
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  seedAppt(db, contact.id, { apptDatetime: chicagoToUtcIso(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 10, 0) });

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.todaysAppointments, 0);
  assert.equal(summary.upcomingAppointments, 1);
});

test('an appointment yesterday counts toward neither metric', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'yesterday@example.com', first_name: 'Old' });
  const { y, m, d } = todayChicagoParts();
  const yesterday = new Date(Date.UTC(y, m - 1, d - 1));
  seedAppt(db, contact.id, { apptDatetime: chicagoToUtcIso(yesterday.getUTCFullYear(), yesterday.getUTCMonth() + 1, yesterday.getUTCDate(), 10, 0) });

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.todaysAppointments, 0);
  assert.equal(summary.upcomingAppointments, 0);
});

test('a late-evening Central Time appointment today is correctly counted as TODAY, not miscounted as tomorrow due to its UTC date rolling over (the exact boundary bug the audit found)', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'evening@example.com', first_name: 'Late' });
  const { y, m, d } = todayChicagoParts();
  // 10:00 PM Central today -- its UTC date is already "tomorrow" (UTC is
  // 5-6 hours ahead), which is exactly what the old substr(UTC-date)
  // comparison got wrong.
  seedAppt(db, contact.id, { apptDatetime: chicagoToUtcIso(y, m, d, 22, 0) });

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.todaysAppointments, 1, 'a 10pm CT appointment today must count as today, even though its UTC date is tomorrow');
  assert.equal(summary.upcomingAppointments, 0);
});

test('Cancelled and Rescheduled appointments never count toward either metric, even when dated today or in the future', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'cancelled@example.com', first_name: 'Gone' });
  const { y, m, d } = todayChicagoParts();
  seedAppt(db, contact.id, { apptDatetime: chicagoToUtcIso(y, m, d, 10, 0), status: 'Cancelled' });
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  seedAppt(db, contact.id, { apptDatetime: chicagoToUtcIso(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 10, 0), status: 'Rescheduled' });

  const summary = getDashboardSummary(db, { brandId: null });
  assert.equal(summary.todaysAppointments, 0);
  assert.equal(summary.upcomingAppointments, 0);
});

test('both metrics are scoped by appointments.booking_brand, matching Insurance Lady vs Prosperity vs All Companies', () => {
  const { db } = setup();
  const ilContact = dedupeContact(db, { email: 'il@example.com', first_name: 'Amirah' });
  const prosperityContact = dedupeContact(db, { email: 'prosperity@example.com', first_name: 'Sam' });
  const { y, m, d } = todayChicagoParts();
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));

  seedAppt(db, ilContact.id, { apptDatetime: chicagoToUtcIso(y, m, d, 10, 0), bookingBrand: 'insurance-lady' });
  seedAppt(db, ilContact.id, { apptDatetime: chicagoToUtcIso(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 10, 0), bookingBrand: 'insurance-lady' });
  seedAppt(db, prosperityContact.id, { apptDatetime: chicagoToUtcIso(y, m, d, 11, 0), bookingBrand: 'prosperity' });

  const all = getDashboardSummary(db, { brandId: null });
  assert.equal(all.todaysAppointments, 2);
  assert.equal(all.upcomingAppointments, 1);

  const il = getDashboardSummary(db, { brandId: 'insurance-lady' });
  assert.equal(il.todaysAppointments, 1);
  assert.equal(il.upcomingAppointments, 1);

  const prosperity = getDashboardSummary(db, { brandId: 'prosperity' });
  assert.equal(prosperity.todaysAppointments, 1);
  assert.equal(prosperity.upcomingAppointments, 0);
});

test('a manually-added appointment with no booking_brand is visible under All Companies but under neither specific brand filter (existing limitation of booking_brand, not new)', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'manual@example.com', first_name: 'Manual' });
  const { y, m, d } = todayChicagoParts();
  seedAppt(db, contact.id, { apptDatetime: chicagoToUtcIso(y, m, d, 10, 0), bookingBrand: null });

  assert.equal(getDashboardSummary(db, { brandId: null }).todaysAppointments, 1);
  assert.equal(getDashboardSummary(db, { brandId: 'insurance-lady' }).todaysAppointments, 0);
  assert.equal(getDashboardSummary(db, { brandId: 'prosperity' }).todaysAppointments, 0);
});

test('Amirah\'s reported case: an appointment scheduled for 10:00 AM CT the day AFTER the check is performed shows 0 in todaysAppointments and 1 in upcomingAppointments -- confirms the original report was correct behavior, not a bug', () => {
  const { db } = setup();
  const contact = dedupeContact(db, { email: 'amirah@example.com', first_name: 'Amirah' });
  const { y, m, d } = todayChicagoParts();
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  seedAppt(db, contact.id, {
    apptDatetime: chicagoToUtcIso(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), 10, 0),
    bookingBrand: 'insurance-lady',
  });

  const summary = getDashboardSummary(db, { brandId: 'insurance-lady' });
  assert.equal(summary.todaysAppointments, 0, 'tomorrow is still correctly not counted as today');
  assert.equal(summary.upcomingAppointments, 1, 'but it now surfaces on the new Upcoming Appointments tile');
});
