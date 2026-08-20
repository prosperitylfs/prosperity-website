// Tests for crm/config/brands.js and crm/config/products.js — pure config,
// no database.

const test = require('node:test');
const assert = require('node:assert/strict');
const { BRANDS, publicBrandIdentity, isChannelConfigured } = require('../config/brands');
const { getProductsForBrand } = require('../config/products');
const { INSURANCE_LADY_PRODUCTS, PROSPERITY_PRODUCTS } = require('../db/migrateBrands');

test('correct public identity returned for Insurance Lady', () => {
  const identity = publicBrandIdentity('insurance-lady');
  assert.equal(identity.legalName, 'Insurance Lady LLC');
  assert.equal(identity.shortName, 'Insurance Lady');
  assert.equal(identity.phone.e164, '+18559305239');
  assert.equal(identity.website, 'https://insuranceladyllc.com');
  assert.equal(identity.emailSender, 'loretta@insuranceladyllc.com');
  assert.equal(identity.emailProvider, 'microsoft');
  assert.equal(identity.aiReceptionist, 'Jennifer');
});

test('correct public identity returned for Prosperity', () => {
  const identity = publicBrandIdentity('prosperity');
  assert.equal(identity.legalName, 'Prosperity Life & Financial Solutions LLC');
  assert.equal(identity.shortName, 'Prosperity');
  assert.equal(identity.phone.e164, '+14144411177');
  assert.equal(identity.website, 'https://www.prosperitylfs.com');
  assert.equal(identity.emailSender, 'loretta@prosperitylfs.com');
  assert.equal(identity.emailProvider, 'gmail');
  assert.equal(identity.aiReceptionist, 'Renee');
});

test('no credential value is stored anywhere in the brand configuration', () => {
  // credentialEnvVars must only ever contain variable NAMES (all-caps,
  // underscore-separated identifiers) — never an actual credential value.
  for (const brand of Object.values(BRANDS)) {
    for (const varNames of Object.values(brand.credentialEnvVars)) {
      for (const name of varNames) {
        assert.match(name, /^[A-Z][A-Z0-9_]*$/, `'${name}' should look like an env var name, not a value`);
      }
    }
  }

  // No object anywhere in the config tree has a key that names a credential
  // field directly (as opposed to a NAME string living inside
  // credentialEnvVars, which is the only permitted place this vocabulary
  // may appear).
  const forbiddenKeyPattern = /secret|token|password|apikey|api_key|auth/i;
  function walk(node, path) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'credentialEnvVars') {
        assert.doesNotMatch(key, forbiddenKeyPattern, `unexpected credential-shaped key '${path}.${key}'`);
      }
      if (key !== 'credentialEnvVars') walk(value, `${path}.${key}`);
    }
  }
  walk(BRANDS, 'BRANDS');
});

test('isChannelConfigured checks env var NAMES only and never exposes a value', () => {
  const before = process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_ID;
  delete process.env.GMAIL_CLIENT_SECRET;
  delete process.env.GMAIL_REFRESH_TOKEN;
  try {
    const status = isChannelConfigured('prosperity', 'email');
    assert.equal(status.ok, false);
    assert.ok(status.missing.includes('GMAIL_CLIENT_ID'));
    assert.equal(JSON.stringify(status).includes(before || '###'), false);

    process.env.GMAIL_CLIENT_ID = 'unit-test-fake-value';
    process.env.GMAIL_CLIENT_SECRET = 'unit-test-fake-value';
    process.env.GMAIL_REFRESH_TOKEN = 'unit-test-fake-value';
    const status2 = isChannelConfigured('prosperity', 'email');
    assert.equal(status2.ok, true);
    // The return value must never contain the actual credential value.
    assert.equal(JSON.stringify(status2).includes('unit-test-fake-value'), false);
  } finally {
    delete process.env.GMAIL_CLIENT_ID;
    delete process.env.GMAIL_CLIENT_SECRET;
    delete process.env.GMAIL_REFRESH_TOKEN;
    if (before !== undefined) process.env.GMAIL_CLIENT_ID = before;
  }
});

test('email credential env vars never overlap between brands (different providers)', () => {
  const il = new Set(BRANDS['insurance-lady'].credentialEnvVars.email);
  const pr = new Set(BRANDS.prosperity.credentialEnvVars.email);
  for (const name of il) assert.ok(!pr.has(name), `'${name}' should not be shared between brands`);
});

test('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are intentionally shared (one Twilio account), but the FROM number is brand-specific and never shared', () => {
  const il = BRANDS['insurance-lady'].credentialEnvVars.sms;
  const pr = BRANDS.prosperity.credentialEnvVars.sms;

  for (const shared of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN']) {
    assert.ok(il.includes(shared), `insurance-lady sms vars should include shared '${shared}'`);
    assert.ok(pr.includes(shared), `prosperity sms vars should include shared '${shared}'`);
  }

  assert.ok(il.includes('TWILIO_FROM_NUMBER_INSURANCE_LADY'));
  assert.ok(pr.includes('TWILIO_FROM_NUMBER_PROSPERITY'));
  assert.ok(!il.includes('TWILIO_FROM_NUMBER_PROSPERITY'), 'insurance-lady must not reference the Prosperity FROM number');
  assert.ok(!pr.includes('TWILIO_FROM_NUMBER_INSURANCE_LADY'), 'prosperity must not reference the Insurance Lady FROM number');

  // No brand-specific Account SID/Auth Token variable exists anywhere.
  const allSmsVars = [...il, ...pr];
  assert.ok(!allSmsVars.some(v => /INSURANCE_LADY_TWILIO_(ACCOUNT_SID|AUTH_TOKEN)/.test(v)));
  assert.ok(!allSmsVars.some(v => /^TWILIO_(ACCOUNT_SID|AUTH_TOKEN)_PROSPERITY$/.test(v)));
});

test('Microsoft credential vars use the consistent, non-brand-prefixed naming, and omit the delegated-permission-only vars', () => {
  const emailVars = BRANDS['insurance-lady'].credentialEnvVars.email;
  assert.deepEqual(emailVars, ['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_FROM', 'MICROSOFT_FROM_NAME']);
  assert.ok(!emailVars.includes('MICROSOFT_REFRESH_TOKEN'), 'refresh token is delegated-permission-only and not yet needed');
  assert.ok(!emailVars.includes('MICROSOFT_REDIRECT_URI'), 'redirect URI is delegated-permission-only and not yet needed');
});

test('product lists match the exact approved categories and contain no Medicare', () => {
  assert.deepEqual(getProductsForBrand('insurance-lady'), INSURANCE_LADY_PRODUCTS);
  assert.deepEqual(getProductsForBrand('prosperity'), PROSPERITY_PRODUCTS);

  const all = [...getProductsForBrand('insurance-lady'), ...getProductsForBrand('prosperity')].join(' ').toLowerCase();
  assert.ok(!all.includes('medicare'));
  assert.ok(!all.includes('critical illness'));
  assert.ok(!all.includes('mortgage protection'));
});
