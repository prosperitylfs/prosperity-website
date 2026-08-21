#!/usr/bin/env node
// Seeds a throwaway LOCAL preview database with FAKE data, for visually
// verifying the CRM interface redesign checkpoint only. NEVER touches
// crm/data/crm.db — refuses to run without an explicit --db path, and
// refuses that live path outright, matching the safety pattern established
// by crm/scripts/dryRunClassify.js.
//
// Usage: node scripts/seedCrmAppPreview.js --db <path-to-throwaway-sqlite-file>
//
// Every name, contact detail, and figure below is invented for this preview
// — none of it is real client data.

const path = require('path');
const fs = require('fs');

function parseArgs() {
  const args = process.argv.slice(2);
  const dbIdx = args.indexOf('--db');
  if (dbIdx === -1 || !args[dbIdx + 1]) {
    console.error('Usage: node scripts/seedCrmAppPreview.js --db <path-to-throwaway-sqlite-file>');
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
const { dedupeContact, resolveContactBrand, matchOrCreateCase, stageUnresolvedIntake } = require('../lib/caseMatching');
const { processLeadIntake } = require('../lib/leadIntake');

const { insuranceLadyId, prosperityId } = runMigrations(db);
runDashboardMigrations(db);
runCrmAppMigrations(db);

function pid(brandSlug, name) {
  const brand = db.prepare('SELECT id FROM brands WHERE slug = ?').get(brandSlug);
  return db.prepare('SELECT id FROM products WHERE brand_id = ? AND name = ?').get(brand.id, name).id;
}

function iso(daysFromNow, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}
function dateOnly(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function makeClient({ brandId, first, last, email, phone, product, city, state, secondProduct }) {
  const contact = dedupeContact(db, { first_name: first, last_name: last, email, phone, phone_e164: '+1' + phone.replace(/\D/g, '') });
  db.prepare('UPDATE contacts SET city = ?, state = ?, lead_status = ? WHERE id = ?').run(city, state, 'New Lead', contact.id);
  const link = resolveContactBrand(db, { contactId: contact.id, brandId });
  const case1 = matchOrCreateCase(db, { contactBrandId: link.id, productId: pid(brandId === insuranceLadyId ? 'insurance-lady' : 'prosperity', product), eventType: 'new_inquiry', title: product });
  let case2 = null;
  if (secondProduct) {
    case2 = matchOrCreateCase(db, { contactBrandId: link.id, productId: pid(brandId === insuranceLadyId ? 'insurance-lady' : 'prosperity', secondProduct), eventType: 'new_inquiry', title: secondProduct });
  }
  return { contact, link, case1: case1.case, case2: case2 ? case2.case : null };
}

// ── Prosperity clients ──────────────────────────────────────────────────
const dana = makeClient({ brandId: prosperityId, first: 'Dana', last: 'Furst', email: 'dana.furst@example-mail.com', phone: '4145550101', product: 'Life insurance', secondProduct: 'Annuities', city: 'Milwaukee', state: 'WI' });
db.prepare(`INSERT INTO follow_up_tasks (contact_id, case_id, task_type, due_date, notes, priority) VALUES (?, ?, 'Call', ?, 'Review term life quote options', 'High')`).run(dana.contact.id, dana.case1.id, dateOnly(-2));
db.prepare(`INSERT INTO appointments (contact_id, appt_type, appt_datetime, status) VALUES (?, 'Phone Call', ?, 'Scheduled')`).run(dana.contact.id, iso(0, 14));
db.prepare(`INSERT INTO contact_notes (contact_id, body) VALUES (?, 'Prefers evening calls after 5pm. Has two grandchildren she wants covered under a final expense policy eventually.')`).run(dana.contact.id);
db.prepare(`INSERT INTO policies (case_id, carrier, policy_number, policy_status, effective_date, premium, premium_frequency, coverage_amount, beneficiary, renewal_date) VALUES (?, 'Midland National', 'MN-88213', 'Active', ?, 62.50, 'Monthly', 250000, 'Spouse', ?)`).run(dana.case1.id, dateOnly(-90), dateOnly(275));

const marcus = makeClient({ brandId: prosperityId, first: 'Marcus', last: 'Okafor', email: 'marcus.okafor@example-mail.com', phone: '4145550102', product: 'Rollovers and safe-money solutions', city: 'Wauwatosa', state: 'WI' });
db.prepare(`INSERT INTO follow_up_tasks (contact_id, case_id, task_type, due_date, notes, priority) VALUES (?, ?, 'Call', ?, 'Follow up on 401k rollover paperwork', 'Medium')`).run(marcus.contact.id, marcus.case1.id, dateOnly(3));

const priya = makeClient({ brandId: prosperityId, first: 'Priya', last: 'Anand', email: 'priya.anand@example-mail.com', phone: '4145550103', product: 'Annuities', secondProduct: 'Follow-up/service', city: 'Brookfield', state: 'WI' });
db.prepare("UPDATE cases SET status = 'Archived', closed_at = CURRENT_TIMESTAMP WHERE id = ?").run(priya.case2.id);

const helen = makeClient({ brandId: prosperityId, first: 'Helen', last: 'Marsh', email: 'helen.marsh@example-mail.com', phone: '4145550104', product: 'Life insurance', city: 'Waukesha', state: 'WI' });
db.prepare(`INSERT INTO sms_messages (contact_id, direction, from_number, to_number, body, status, sent_at, contact_brand_id, case_id) VALUES (?, 'outbound', '+14144411177', '+14145550104', '[FAILED] Error: 30006 | Info: Landline or unreachable carrier', 'failed', ?, ?, ?)`).run(helen.contact.id, iso(-1), helen.link.id, helen.case1.id);

// ── Insurance Lady clients ──────────────────────────────────────────────
const jordan = makeClient({ brandId: insuranceLadyId, first: 'Jordan', last: 'Maddox', email: 'jordan.maddox@example-mail.com', phone: '4145550201', product: 'Online life-insurance application', city: 'Wauwatosa', state: 'WI' });
db.prepare(`INSERT INTO policies (case_id, carrier, policy_number, policy_status, effective_date, premium, premium_frequency, coverage_amount, beneficiary, renewal_date) VALUES (?, 'Foresters Financial', 'FF-40217', 'Active', ?, 41.00, 'Monthly', 100000, 'Adult child', ?)`).run(jordan.case1.id, dateOnly(-40), dateOnly(325));

const elena = makeClient({ brandId: insuranceLadyId, first: 'Elena', last: 'Cruz', email: 'elena.cruz@example-mail.com', phone: '4145550202', product: 'Whole life/final expense', city: 'West Allis', state: 'WI' });
db.prepare(`INSERT INTO appointments (contact_id, appt_type, appt_datetime, status) VALUES (?, 'Phone Call', ?, 'Scheduled')`).run(elena.contact.id, iso(1, 11));
db.prepare(`INSERT INTO follow_up_tasks (contact_id, case_id, task_type, due_date, notes, priority) VALUES (?, ?, 'Call', ?, 'Send final expense brochure', 'Medium')`).run(elena.contact.id, elena.case1.id, dateOnly(0));

const sam = makeClient({ brandId: insuranceLadyId, first: 'Sam', last: 'Whitfield', email: 'sam.whitfield@example-mail.com', phone: '4145550203', product: 'Cash cancer insurance', city: 'Franklin', state: 'WI' });
db.prepare(`INSERT INTO emails (contact_id, to_email, subject, body, status, sent_at, contact_brand_id, case_id) VALUES (?, 'sam.whitfield@example-mail.com', 'Your cancer insurance quote', 'preview body', 'delivered', ?, ?, ?)`).run(sam.contact.id, iso(-2), sam.link.id, sam.case1.id);

const rita = makeClient({ brandId: insuranceLadyId, first: 'Rita', last: 'Solis', email: 'rita.solis@example-mail.com', phone: '4145550204', product: 'Annuities and safe-money solutions', city: 'Greenfield', state: 'WI' });
db.prepare(`INSERT INTO emails (contact_id, to_email, subject, body, status, sent_at, contact_brand_id, case_id) VALUES (?, 'rita.solis@example-mail.com', 'Following up on your annuity question', 'preview body', 'failed', ?, ?, ?)`).run(rita.contact.id, iso(-1), rita.link.id, rita.case1.id);

// ── Review Required: Brand Review (unverified source) ───────────────────
processLeadIntake(db, {
  sourceId: null,
  payload: { first_name: 'Taylor', last_name: 'Reyes', email: 'taylor.reyes@example-mail.com', phone: '4145550301', lead_type: 'life_insurance' },
});

// ── Review Required: Case Review (no clean product match) ───────────────
processLeadIntake(db, {
  sourceId: 'prosperity-website',
  payload: { first_name: 'Colette', last_name: 'Wren', email: 'colette.wren@example-mail.com', lead_type: 'guide', lead_source: '13 Retirement & Rollover Mistakes to Avoid' },
});

// ── Review Required: Company-Assignment Conflict (synthetic demo record —
//    Insurance Lady has no real verified source yet in this checkpoint, so
//    this is inserted directly to demonstrate the queue's layout, exactly
//    as processLeadIntake would shape it once a real IL source exists) ────
const casey = makeClient({ brandId: prosperityId, first: 'Casey', last: 'Nolan', email: 'casey.nolan@example-mail.com', phone: '4145550401', product: 'Life insurance', city: 'Cudahy', state: 'WI' });
db.prepare(`
  INSERT INTO unresolved_intake (source, raw_payload, candidate_contact_id, reason, status, review_type, contact_brand_id, incoming_brand_id, created_at)
  VALUES ('insurance-lady-website (preview)', ?, ?, ?, 'Pending', 'company_conflict', ?, ?, ?)
`).run(
  JSON.stringify({ first_name: 'Casey', last_name: 'Nolan', email: 'casey.nolan@example-mail.com', lead_type: 'life_insurance', note: 'SYNTHETIC PREVIEW RECORD' }),
  casey.contact.id,
  "incoming verified source resolved to brand 'insurance-lady', but this contact already has an active company assignment under a different brand — requires deliberate review before any second relationship is created",
  casey.link.id, insuranceLadyId, iso(0)
);

console.log(`Seeded preview database at ${resolved}`);
console.log('Contacts:', db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n);
console.log('Cases:', db.prepare('SELECT COUNT(*) AS n FROM cases').get().n);
console.log('Policies:', db.prepare('SELECT COUNT(*) AS n FROM policies').get().n);
console.log('Unresolved intake:', db.prepare('SELECT COUNT(*) AS n FROM unresolved_intake').get().n);
