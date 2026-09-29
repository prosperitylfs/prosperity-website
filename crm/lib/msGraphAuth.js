// Microsoft identity platform delegated OAuth2 (Authorization Code flow)
// for the Insurance Lady mailbox (loretta@insuranceladyllc.com), via
// Microsoft's own supported @azure/msal-node library -- 2026-10-16.
//
// Mirrors crm/lib/gmailSend.js's OAuth shape as closely as Microsoft's
// model allows (fresh client built per call, no long-lived singleton --
// see makeClient()/authedClient() there), but token PERSISTENCE differs
// deliberately: Gmail's refresh token is one static Render env var that is
// never rewritten by the app, because Google's refresh tokens don't
// rotate under normal use. Microsoft's frequently DO rotate the refresh
// token on each renewal -- a static env var would silently go stale. MSAL
// Node's cache-plugin extensibility point (beforeCacheAccess/
// afterCacheAccess below) is the officially supported way to persist its
// whole token cache (which contains the refresh token) durably, so MSAL
// itself handles rotation correctly: every renewal re-serializes and
// re-saves the CURRENT cache state atomically (lib/msGraphTokenStore.js's
// single UPSERT), so a concurrent read never sees a half-written value,
// and the newest rotated token is always what's persisted.
//
// Never logs or returns the token cache blob, the access token, or the
// client secret to any caller outside this module and lib/msGraphSend.js
// -- routes/msEmail.js's /callback only ever shows the human a plain
// success/failure message, never any credential.

const { ConfidentialClientApplication } = require('@azure/msal-node');
const { getTokenCache, setTokenCache } = require('./msGraphTokenStore');

// Mail.Send is the one resource permission this flow needs. offline_access
// is requested explicitly (per the Entra app's delegated permissions and
// this feature's own security requirements) so the authorization-code
// exchange returns a refresh token at all -- the v2 identity platform
// endpoint only issues one when offline_access is present in the request.
const GRAPH_SCOPES = ['Mail.Send'];
const AUTH_SCOPES = [...GRAPH_SCOPES, 'offline_access'];

const REQUIRED_ENV_VARS = [
  'MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_FROM', 'MICROSOFT_FROM_NAME',
];

function missingEnvVars() {
  return REQUIRED_ENV_VARS.filter(name => !process.env[name]);
}

function isEnvConfigured() {
  return missingEnvVars().length === 0;
}

function redirectUri() {
  return process.env.MICROSOFT_REDIRECT_URI ||
    (process.env.APP_URL ? `${process.env.APP_URL}/api/ms-email/callback` : 'http://localhost:3001/api/ms-email/callback');
}

function notConfiguredError() {
  const err = new Error(
    `Microsoft Graph email is not configured (missing environment variable(s): ${missingEnvVars().join(', ')}).`
  );
  err.status = 503;
  return err;
}

// A fresh cache-backed client per call -- the cachePlugin loads the
// CURRENT database row into MSAL's in-memory cache at the start of
// whatever operation is about to run, and persists it back (only if MSAL
// says it changed) when that operation finishes. No cache is ever kept
// alive across calls in this process, so there is nothing here that could
// go stale between requests.
function buildConfidentialClient(db, deps = {}) {
  if (!isEnvConfigured()) throw notConfiguredError();

  const cachePlugin = {
    beforeCacheAccess: async (cacheContext) => {
      const cached = getTokenCache(db);
      cacheContext.tokenCache.deserialize(cached || '{}');
    },
    afterCacheAccess: async (cacheContext) => {
      if (cacheContext.cacheHasChanged) {
        setTokenCache(db, cacheContext.tokenCache.serialize());
      }
    },
  };

  const ClientClass = deps.ConfidentialClientApplication || ConfidentialClientApplication;
  return new ClientClass({
    auth: {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}`,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    },
    cache: { cachePlugin },
  });
}

// Step 1 of the interactive one-time authorization -- builds the URL
// routes/msEmail.js's GET /auth redirects the browser to. `state` is the
// caller's responsibility (see lib/oauthStateStore.js) -- this function
// only forwards it into the request, never generates or validates it.
async function getMicrosoftAuthCodeUrl(db, { state }, deps = {}) {
  const cca = buildConfidentialClient(db, deps);
  return cca.getAuthCodeUrl({ scopes: AUTH_SCOPES, redirectUri: redirectUri(), state });
}

// Step 2 -- exchanges the authorization code for tokens. MSAL's cache
// plugin persists the resulting refresh token (inside the serialized
// cache) to the database as a side effect of this call; nothing here
// returns the token itself to the caller.
async function acquireTokenByAuthCode(db, { code }, deps = {}) {
  const cca = buildConfidentialClient(db, deps);
  await cca.acquireTokenByCode({ code, scopes: AUTH_SCOPES, redirectUri: redirectUri() });
}

// Used by lib/msGraphSend.js before every send: returns a valid Graph
// access token, silently renewing (and re-persisting, if Microsoft rotated
// the refresh token) via MSAL's own cache-aware acquireTokenSilent. Throws
// a clear, non-secret-bearing error (never the token) if Microsoft Graph
// isn't configured at all, or if the mailbox has never completed the
// one-time interactive authorization.
async function acquireGraphAccessToken(db, deps = {}) {
  const cca = buildConfidentialClient(db, deps);
  const accounts = await cca.getTokenCache().getAllAccounts();

  if (!accounts.length) {
    const err = new Error(
      'The Insurance Lady mailbox has not yet been authorized for Microsoft Graph email. Visit /api/ms-email/auth to connect it.'
    );
    err.status = 503;
    throw err;
  }

  const result = await cca.acquireTokenSilent({ account: accounts[0], scopes: GRAPH_SCOPES });
  return result.accessToken;
}

module.exports = {
  GRAPH_SCOPES, AUTH_SCOPES,
  isEnvConfigured, missingEnvVars, redirectUri,
  buildConfidentialClient, getMicrosoftAuthCodeUrl, acquireTokenByAuthCode, acquireGraphAccessToken,
};
