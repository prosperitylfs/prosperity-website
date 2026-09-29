// Tests for crm/lib/msGraphAuth.js -- the MSAL-Node-based delegated OAuth
// wrapper for the Insurance Lady mailbox. A fake ConfidentialClientApplication
// class is injected via deps (mirroring crm/lib/gmailSend.js's
// deps.gmailClientFactory pattern) -- never imports @azure/msal-node's real
// network path or touches a live Microsoft account.
//
// The cache-persistence tests exercise the ACTUAL cachePlugin object
// msGraphAuth.js builds (via a fake CCA class that just captures the
// config it was constructed with), driving it with a fully-controlled
// fake MSAL cacheContext -- this proves the real
// crm/lib/msGraphTokenStore.js read/write wiring is correct without
// needing to simulate MSAL's own internal cache serialization fidelity.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLegacyDb } = require('../testSupport/legacyDb');
const {
  isEnvConfigured, missingEnvVars, buildConfidentialClient,
  getMicrosoftAuthCodeUrl, acquireTokenByAuthCode, acquireGraphAccessToken,
} = require('../lib/msGraphAuth');
const { getTokenCache } = require('../lib/msGraphTokenStore');

const REQUIRED = ['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_FROM', 'MICROSOFT_FROM_NAME'];
const savedEnv = {};
for (const k of REQUIRED) savedEnv[k] = process.env[k];

function setFullEnv() {
  process.env.MICROSOFT_TENANT_ID = 'fake-tenant-id';
  process.env.MICROSOFT_CLIENT_ID = 'fake-client-id';
  process.env.MICROSOFT_CLIENT_SECRET = 'fake-client-secret-value';
  process.env.MICROSOFT_FROM = 'loretta@insuranceladyllc.com';
  process.env.MICROSOFT_FROM_NAME = 'Loretta Stewart';
}
function clearEnv() {
  for (const k of REQUIRED) delete process.env[k];
}

test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

// ── Env-var configuration check ──────────────────────────────────────────

test('isEnvConfigured/missingEnvVars correctly report an incomplete environment', () => {
  clearEnv();
  process.env.MICROSOFT_TENANT_ID = 'only-this-one';
  assert.equal(isEnvConfigured(), false);
  assert.deepEqual(missingEnvVars(), ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_FROM', 'MICROSOFT_FROM_NAME']);
  clearEnv();
});

test('isEnvConfigured reports true once every required variable is present', () => {
  setFullEnv();
  assert.equal(isEnvConfigured(), true);
  assert.deepEqual(missingEnvVars(), []);
  clearEnv();
});

test('buildConfidentialClient throws a clear, status-503 error when Microsoft Graph is not configured, and never constructs a client', () => {
  clearEnv();
  const db = createLegacyDb();
  let constructed = false;
  class Spy { constructor() { constructed = true; } }
  assert.throws(() => buildConfidentialClient(db, { ConfidentialClientApplication: Spy }), /not configured/i);
  assert.equal(constructed, false);
});

// ── Fake CCA for request-shape / dispatch tests ──────────────────────────

class FakeCCA {
  constructor(config) {
    this.config = config;
    FakeCCA.lastInstance = this;
  }
  async getAuthCodeUrl(request) {
    this.authCodeUrlRequest = request;
    return `https://fake.microsoftonline.example/authorize?state=${request.state}`;
  }
  async acquireTokenByCode(request) {
    this.acquireTokenByCodeRequest = request;
    return { accessToken: 'fake-token-from-code' };
  }
  getTokenCache() {
    return { getAllAccounts: async () => FakeCCA.nextAccounts || [] };
  }
  async acquireTokenSilent(request) {
    this.acquireTokenSilentRequest = request;
    return { accessToken: 'fake-silent-access-token' };
  }
}

test('getMicrosoftAuthCodeUrl requests Mail.Send + offline_access, the configured redirect URI, and forwards the caller\'s state', async () => {
  setFullEnv();
  process.env.MICROSOFT_REDIRECT_URI = 'https://prosperity-crm.onrender.com/api/ms-email/callback';
  const db = createLegacyDb();

  const url = await getMicrosoftAuthCodeUrl(db, { state: 'my-state-value' }, { ConfidentialClientApplication: FakeCCA });

  assert.match(url, /state=my-state-value/);
  const req = FakeCCA.lastInstance.authCodeUrlRequest;
  assert.deepEqual(req.scopes, ['Mail.Send', 'offline_access']);
  assert.equal(req.redirectUri, 'https://prosperity-crm.onrender.com/api/ms-email/callback');
  assert.equal(req.state, 'my-state-value');

  delete process.env.MICROSOFT_REDIRECT_URI;
  clearEnv();
});

test('acquireGraphAccessToken throws "not yet authorized" (status 503) when the mailbox has never completed the interactive flow, and never calls acquireTokenSilent', async () => {
  setFullEnv();
  const db = createLegacyDb();
  FakeCCA.nextAccounts = [];

  let threw = null;
  try {
    await acquireGraphAccessToken(db, { ConfidentialClientApplication: FakeCCA });
  } catch (err) {
    threw = err;
  }
  assert.ok(threw);
  assert.match(threw.message, /not yet been authorized/i);
  assert.match(threw.message, /\/api\/ms-email\/auth/);
  assert.equal(threw.status, 503);
  assert.equal(FakeCCA.lastInstance.acquireTokenSilentRequest, undefined);

  clearEnv();
});

test('acquireGraphAccessToken calls acquireTokenSilent with the cached account and exactly the Mail.Send scope once authorized, returning the access token', async () => {
  setFullEnv();
  const db = createLegacyDb();
  const fakeAccount = { username: 'loretta@insuranceladyllc.com', homeAccountId: 'fake-home-account-id' };
  FakeCCA.nextAccounts = [fakeAccount];

  const token = await acquireGraphAccessToken(db, { ConfidentialClientApplication: FakeCCA });

  assert.equal(token, 'fake-silent-access-token');
  assert.deepEqual(FakeCCA.lastInstance.acquireTokenSilentRequest.scopes, ['Mail.Send']);
  assert.equal(FakeCCA.lastInstance.acquireTokenSilentRequest.account, fakeAccount);

  clearEnv();
});

// ── Cache persistence (rotation) ─────────────────────────────────────────

test('acquireTokenByAuthCode\'s cachePlugin persists the serialized cache to the database, reading nothing but "{}" on a first-ever authorization', async () => {
  setFullEnv();
  const db = createLegacyDb();

  class CapturingClient {
    constructor(config) { this.config = config; }
    async acquireTokenByCode() {
      const ctx = { tokenCache: { _v: null, deserialize(s) { this._v = s; }, serialize() { return 'serialized-cache-blob-A'; } }, cacheHasChanged: true };
      await this.config.cache.cachePlugin.beforeCacheAccess(ctx);
      const seenOnFirstRead = ctx.tokenCache._v;
      await this.config.cache.cachePlugin.afterCacheAccess(ctx);
      this.seenOnFirstRead = seenOnFirstRead;
    }
  }

  await acquireTokenByAuthCode(db, { code: 'fake-code' }, { ConfidentialClientApplication: CapturingClient });

  assert.equal(getTokenCache(db), 'serialized-cache-blob-A');
  clearEnv();
});

test('a later renewal that rotates the refresh token overwrites the stored blob atomically -- the newest value always wins, and a read-only access (cache unchanged) never overwrites it', async () => {
  setFullEnv();
  const db = createLegacyDb();
  const { setTokenCache } = require('../lib/msGraphTokenStore');
  setTokenCache(db, 'serialized-cache-blob-PRE-ROTATION');

  class RotatingClient {
    constructor(config) { this.config = config; }
  }
  const cca = buildConfidentialClient(db, { ConfidentialClientApplication: RotatingClient });
  const plugin = cca.config.cache.cachePlugin;

  // Simulate MSAL rotating the refresh token during a silent renewal:
  // reads back what's currently stored, then writes a NEW blob because
  // cacheHasChanged is true.
  let readDuringRotation = null;
  const rotationCtx = {
    tokenCache: { deserialize(s) { readDuringRotation = s; }, serialize() { return 'serialized-cache-blob-POST-ROTATION'; } },
    cacheHasChanged: true,
  };
  await plugin.beforeCacheAccess(rotationCtx);
  await plugin.afterCacheAccess(rotationCtx);

  assert.equal(readDuringRotation, 'serialized-cache-blob-PRE-ROTATION', 'must read the previously-stored value before rotating');
  assert.equal(getTokenCache(db), 'serialized-cache-blob-POST-ROTATION', 'the newest rotated token must be what is persisted');

  // A subsequent read-only access (e.g. a plain acquireTokenSilent that
  // didn't need to rotate anything) must NOT overwrite the just-rotated value.
  const readOnlyCtx = {
    tokenCache: { deserialize() {}, serialize() { return 'this-must-never-be-written'; } },
    cacheHasChanged: false,
  };
  await plugin.beforeCacheAccess(readOnlyCtx);
  await plugin.afterCacheAccess(readOnlyCtx);
  assert.equal(getTokenCache(db), 'serialized-cache-blob-POST-ROTATION', 'cacheHasChanged=false must never trigger a write');

  clearEnv();
});

test('nothing in the token-persistence path ever logs the cache blob content to the console', async () => {
  setFullEnv();
  const db = createLegacyDb();
  const originalLog = console.log, originalError = console.error, originalWarn = console.warn;
  const logged = [];
  console.log = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));
  console.warn = (...a) => logged.push(a.join(' '));

  try {
    class CapturingClient {
      constructor(config) { this.config = config; }
      async acquireTokenByCode() {
        const ctx = { tokenCache: { deserialize() {}, serialize() { return 'SECRET-CACHE-BLOB-MUST-NOT-BE-LOGGED'; } }, cacheHasChanged: true };
        await this.config.cache.cachePlugin.beforeCacheAccess(ctx);
        await this.config.cache.cachePlugin.afterCacheAccess(ctx);
      }
    }
    await acquireTokenByAuthCode(db, { code: 'fake-code' }, { ConfidentialClientApplication: CapturingClient });
  } finally {
    console.log = originalLog; console.error = originalError; console.warn = originalWarn;
  }

  assert.ok(!logged.some(line => line.includes('SECRET-CACHE-BLOB-MUST-NOT-BE-LOGGED')));
  clearEnv();
});
