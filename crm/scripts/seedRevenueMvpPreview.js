#!/usr/bin/env node
// Seeds a throwaway LOCAL preview database with FAKE data, for verifying
// the "Prosperity Revenue MVP" checkpoint only. NEVER touches
// crm/data/crm.db — refuses to run without an explicit --db path, and
// refuses that live path outright, matching the safety pattern established
// by crm/scripts/seedCrmAppPreview.js / crm/scripts/dryRunClassify.js.
//
// Usage: node scripts/seedRevenueMvpPreview.js --db <path-to-throwaway-sqlite-file>
//
// Every name, phone number, and message body below is invented for this
// preview — none of it is real client data. Deliberately does NOT
// pre-import the ~18 Occidental clients; that CSV import is exactly what
// interactive verification exercises live against this seeded db.

const path = require('path');
const fs = require('fs');

function parseArgs() {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf('--db');
  if (dbIdx === -1 || !args[dbIdx + 1]) {
    console.error('Usage: node scripts/seedRevenueMvpPreview.js --db <path-to-throwaway-sqlite-file>');
    process.exit(1);
  }
  return { dbPath: args[dbIdx + 1] };
}

const { dbPath } = parseArgs();
const resolved = path.resolve(dbPath);
const liveDbPath = path.resolve(__dirname, '..', 'data', 'crm.db');
if (resolved === liveDbPath) {
  console.error('Refusing to seed the live database (crm/data/crm.db). Pass a throwaway path instead.');
  process.exit(1);
}
if (fs.existsSync(resolved)) fs.unlinkSync(resolved); // always start fresh

process.env.DB_PATH = resolved;
const db = require('../db/database'); // creates the real legacy schema at DB_PATH as a side effect
const { runMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const { dedupeContact, resolveContactBrand, matchOrCreateCase } = require('../lib/caseMatching');
const { handleInboundProsperitySms } = require('../lib/inboundSmsService');
const { BRANDS } = require('../config/brands');

const { insuranceLadyId, prosperityId } = runMigrations(db);
runDashboardMigrations(db);
runCrmAppMigrations(db);
runCrmCoreMigrations(db);
runRevenueMvpMigrations(db);

function pid(brandSlug, name) {
  const brand = db.prepare('SELECT id FROM brands WHERE slug = ?').get(brandSlug);
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brand.id, name).id;
}
function dateOnly(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}
function isoAt(daysFromNow, hour, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function makeClient({ brandId, first, last, email, phone, product, city, state }) {
  const phoneE164 = '+1' + phone.replace(/\D/g, '');
  const contact = dedupeContact(db, { first_name: first, last_name: last, email, phone, phone_e164: phoneE164 });
  db.prepare('UPDATE contacts SET city = ?, state = ?, lead_status = ? WHERE id = ?').run(city, state, 'New Lead', contact.id);
  const link = resolveContactBrand(db, { contactId: contact.id, brandId });
  const caseResult = matchOrCreateCase(db, { contactBrandId: link.id, productId: pid(brandId === insuranceLadyId ? 'insurance-lady' : 'prosperity', product), eventType: 'new_inquiry', title: product });
  return { contact, link, case1: caseResult.case, phoneE164 };
}

// ── Prosperity clients (existing book of business, pre-Occidental-import) ─
const nadia = makeClient({ brandId: prosperityId, first: 'Nadia', last: 'Cross', email: 'nadia.cross@example-mail.com', phone: '4145550301', product: 'Life insurance', city: 'Milwaukee', state: 'WI' });
db.prepare('UPDATE contacts SET sms_consent = 1, email_consent = 1 WHERE id = ?').run(nadia.contact.id);
db.prepare(`INSERT INTO policies (case_id, carrier, policy_number, policy_status, effective_date, premium, premium_frequency, coverage_amount, beneficiary, renewal_date) VALUES (?, 'Midland National', 'MN-91002', 'Active', ?, 58.00, 'Monthly', 200000, 'Spouse', ?)`).run(nadia.case1.id, dateOnly(-120), dateOnly(245));

const otis = makeClient({ brandId: prosperityId, first: 'Otis', last: 'Farrow', email: 'otis.farrow@example-mail.com', phone: '4145550302', product: 'Annuities', city: 'Wauwatosa', state: 'WI' });
db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(otis.contact.id);
// Pre-existing text thread — an outbound message already sent (blocked, as
// every send is in this checkpoint) followed by a real inbound reply run
// through the actual webhook handler, so the Texts tab has real chronological
// history to show immediately without waiting on interactive verification.
db.prepare(`INSERT INTO sms_messages (contact_id, contact_brand_id, direction, from_number, to_number, body, status, sent_at) VALUES (?, ?, 'outbound', ?, ?, 'Hi Otis, just confirming your annuity review is still set for Thursday at 2pm.', 'blocked', ?)`)
  .run(otis.contact.id, otis.link.id, BRANDS.prosperity.phone.e164, otis.phoneE164, isoAt(-1, 9, 15));
handleInboundProsperitySms(db, { From: otis.phoneE164, To: BRANDS.prosperity.phone.e164, Body: 'Yes that works, see you then!', MessageSid: 'SM_SEED_OTIS_REPLY_1' });

const priscilla = makeClient({ brandId: prosperityId, first: 'Priscilla', last: 'Duong', email: 'priscilla.duong@example-mail.com', phone: '4145550303', product: 'Rollovers and safe-money solutions', city: 'Brookfield', state: 'WI' });
db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(priscilla.contact.id);

// ── One Insurance Lady client, for cross-brand isolation checks ──────────
const jamal = makeClient({ brandId: insuranceLadyId, first: 'Jamal', last: 'Ortiz', email: 'jamal.ortiz@example-mail.com', phone: '4145550401', product: 'Whole life/final expense', city: 'West Allis', state: 'WI' });
db.prepare('UPDATE contacts SET sms_consent = 1 WHERE id = ?').run(jamal.contact.id);

// ── Unknown SMS sender staged for Review Required (a real inbound message
//    from a number that matches no active Prosperity client) ─────────────
handleInboundProsperitySms(db, { From: '+14145559977', To: BRANDS.prosperity.phone.e164, Body: 'Hi, is this Loretta? I got your card at the expo.', MessageSid: 'SM_SEED_UNKNOWN_1' });

console.log(`Seeded Revenue MVP preview db at ${resolved}`);
console.log(`Prosperity clients: Nadia Cross (id ${nadia.contact.id}), Otis Farrow (id ${otis.contact.id}, has an existing text thread), Priscilla Duong (id ${priscilla.contact.id})`);
console.log(`Insurance Lady client: Jamal Ortiz (id ${jamal.contact.id})`);
console.log('One unknown-SMS-sender review item staged.');
console.log('The ~18 Occidental clients are NOT pre-seeded — import them via the CSV import screen during interactive verification.');
