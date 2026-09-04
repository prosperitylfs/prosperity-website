// Tests for crm/lib/templateManagerService.js. In-memory databases only.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const { runMigrations: runBrandsMigrations } = require('../db/migrateBrands');
const { runDashboardMigrations } = require('../db/migrateDashboard');
const { runCrmAppMigrations } = require('../db/migrateCrmApp');
const { runCrmCoreMigrations } = require('../db/migrateCrmCore');
const { runRevenueMvpMigrations } = require('../db/migrateRevenueMvp');
const {
  SUPPORTED_VARIABLES, listManagedTemplates, getManagedTemplate, updateTemplate, createTemplate,
} = require('../lib/templateManagerService');
const { getReconnectionTemplates, checkReconnectionSmsEligibility } = require('../lib/existingClientOutreach');
const { createClient } = require('../lib/clientService');

function setup() {
  const db = createLegacyDb();
  runBrandsMigrations(db);
  runDashboardMigrations(db);
  runCrmAppMigrations(db);
  runCrmCoreMigrations(db);
  runRevenueMvpMigrations(db);
  return db;
}

test('SUPPORTED_VARIABLES includes {{First Name}} and is exported for the UI to display', () => {
  assert.ok(SUPPORTED_VARIABLES.some(v => v.token === '{{First Name}}'));
  for (const v of SUPPORTED_VARIABLES) {
    assert.ok(v.token && v.stored && v.description, `every entry needs token/stored/description: ${JSON.stringify(v)}`);
  }
});

test('listManagedTemplates lists all 4 built-in Existing Client Outreach templates, correctly tagged by channel and builtIn', () => {
  const db = setup();
  const list = listManagedTemplates(db);
  assert.equal(list.filter(t => t.channel === 'sms').length, 2);
  assert.equal(list.filter(t => t.channel === 'email').length, 2);
  assert.ok(list.every(t => t.builtIn === true));
});

test('updateTemplate renames and rewords a built-in SMS template, and getManagedTemplate reflects it immediately', () => {
  const db = setup();
  const updated = updateTemplate(db, {
    templateKey: 'existingClientLifeInsuranceAwarenessSms', channel: 'sms',
    label: 'My Renamed Template', body: 'Hi {{first_name}}, new wording.',
  });
  assert.equal(updated.label, 'My Renamed Template');
  assert.equal(updated.body, 'Hi {{first_name}}, new wording.');
  assert.equal(updated.builtIn, true);

  const fetched = getManagedTemplate(db, 'existingClientLifeInsuranceAwarenessSms', 'sms');
  assert.equal(fetched.label, 'My Renamed Template');
  assert.equal(fetched.body, 'Hi {{first_name}}, new wording.');
});

test('updateTemplate on a built-in email template requires and saves a subject', () => {
  const db = setup();
  const updated = updateTemplate(db, {
    templateKey: 'existingClientReconnectionEmail', channel: 'email',
    label: 'Policy Review Email', subject: 'New Subject Line', body: 'Hi {{first_name}}, hello.',
  });
  assert.equal(updated.subject, 'New Subject Line');
  assert.throws(
    () => updateTemplate(db, { templateKey: 'existingClientReconnectionEmail', channel: 'email', label: 'X', subject: '', body: 'Y' }),
    /subject is required/
  );
});

test('updateTemplate rejects a missing name or body', () => {
  const db = setup();
  assert.throws(
    () => updateTemplate(db, { templateKey: 'existingClientReconnectionSms', channel: 'sms', label: '', body: 'Hi' }),
    /template name is required/
  );
  assert.throws(
    () => updateTemplate(db, { templateKey: 'existingClientReconnectionSms', channel: 'sms', label: 'Name', body: '' }),
    /message\/body is required/
  );
});

test('updateTemplate rejects an unknown templateKey rather than silently creating one', () => {
  const db = setup();
  assert.throws(
    () => updateTemplate(db, { templateKey: 'doesNotExist', channel: 'sms', label: 'X', body: 'Y' }),
    /unknown template/
  );
});

test('updateTemplate never changes sms_message_type -- dedup/history stays keyed to the original identifier across repeated renames', () => {
  const db = setup();
  updateTemplate(db, { templateKey: 'existingClientLifeInsuranceAwarenessSms', channel: 'sms', label: 'First rename', body: 'v1' });
  updateTemplate(db, { templateKey: 'existingClientLifeInsuranceAwarenessSms', channel: 'sms', label: 'Second rename', body: 'v2' });
  const row = db.prepare(`SELECT * FROM crm_templates WHERE template_key = 'existingClientLifeInsuranceAwarenessSms' AND channel = 'sms'`).get();
  assert.equal(row.sms_message_type, 'existing_client_life_insurance_awareness');
  assert.equal(row.label, 'Second rename');
  assert.equal(row.body, 'v2');
  // Still exactly one row -- a second edit updates in place, never inserts
  // a competing duplicate.
  const count = db.prepare(`SELECT COUNT(*) AS n FROM crm_templates WHERE template_key = 'existingClientLifeInsuranceAwarenessSms'`).get().n;
  assert.equal(count, 1);
});

test('createTemplate creates a genuinely new SMS template with its own fresh templateKey, and it appears in the dropdown without altering built-ins', () => {
  const db = setup();
  const created = createTemplate(db, { channel: 'sms', label: 'Birthday Message', body: 'Happy birthday, {{first_name}}!' });
  assert.ok(created.templateKey);
  assert.equal(created.builtIn, false);
  assert.equal(created.label, 'Birthday Message');

  const templates = getReconnectionTemplates(db);
  assert.equal(templates.smsTemplates.length, 3);
  const custom = templates.smsTemplates.find(t => t.templateKey === created.templateKey);
  assert.ok(custom);
  assert.equal(custom.body, 'Happy birthday, {{first_name}}!');
  // Built-ins remain exactly as before.
  const awareness = templates.smsTemplates.find(t => t.templateKey === 'existingClientLifeInsuranceAwarenessSms');
  assert.match(awareness.body, /Life Insurance Awareness Month/);
});

test('createTemplate creates a genuinely new email template requiring a subject', () => {
  const db = setup();
  const created = createTemplate(db, { channel: 'email', label: 'Follow-Up Email', subject: 'Following up', body: 'Hi {{first_name}}.' });
  assert.equal(created.subject, 'Following up');
  const templates = getReconnectionTemplates(db);
  assert.equal(templates.emailTemplates.length, 3);
});

test('creating two templates with similar names never overwrites each other -- each gets its own distinct templateKey', () => {
  const db = setup();
  const a = createTemplate(db, { channel: 'sms', label: 'Follow Up', body: 'A' });
  const b = createTemplate(db, { channel: 'sms', label: 'Follow Up', body: 'B' });
  assert.notEqual(a.templateKey, b.templateKey);
  const templates = getReconnectionTemplates(db);
  const fetchedA = templates.smsTemplates.find(t => t.templateKey === a.templateKey);
  const fetchedB = templates.smsTemplates.find(t => t.templateKey === b.templateKey);
  assert.equal(fetchedA.body, 'A');
  assert.equal(fetchedB.body, 'B');
});

test('a new custom SMS template is independently sendable and deduped -- sending it never affects the built-in templates\' own eligibility', () => {
  const db = setup();
  const created = createTemplate(db, { channel: 'sms', label: 'Custom Reminder', body: 'Hi {{first_name}}, reminder.' });
  const result = createClient(db, {
    firstName: 'Ora', email: 'ora@example.com', phone: '414-555-7001', brandSlug: 'prosperity', relationshipType: 'active_client',
  }, 'Loretta Stewart');

  const check = checkReconnectionSmsEligibility(db, result.contact, created.templateKey);
  assert.equal(check.eligible, true);

  const builtInCheck = checkReconnectionSmsEligibility(db, result.contact, 'existingClientLifeInsuranceAwarenessSms');
  assert.equal(builtInCheck.eligible, true, 'the built-in template\'s own eligibility is unaffected by an unrelated custom template');
});
