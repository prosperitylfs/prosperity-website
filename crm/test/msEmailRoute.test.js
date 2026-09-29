// Tests for crm/routes/msEmail.js -- the Microsoft Graph OAuth setup route
// for the Insurance Lady mailbox. No MICROSOFT_* environment variables are
// set in this test file (matching crm/test/emailSendRoute.test.js's own
// approach), so every path that would need to actually talk to Microsoft
// deterministically short-circuits first -- no live network call is ever
// made, and no MSAL mocking is needed to prove the CSRF `state` guard
// rejects an invalid callback BEFORE any token exchange is attempted.

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');

const savedEnv = {
  DB_PATH: process.env.DB_PATH,
  MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,
  MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
  MICROSOFT_CLIENT_SECRET: process.env.MICROSOFT_CLIENT_SECRET,
  MICROSOFT_FROM: process.env.MICROSOFT_FROM,
  MICROSOFT_FROM_NAME: process.env.MICROSOFT_FROM_NAME,
  MICROSOFT_REDIRECT_URI: process.env.MICROSOFT_REDIRECT_URI,
};
process.env.DB_PATH = ':memory:';
for (const k of ['MICROSOFT_TENANT_ID', 'MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_FROM', 'MICROSOFT_FROM_NAME', 'MICROSOFT_REDIRECT_URI']) {
  delete process.env[k];
}

require('../db/database'); // opens the in-memory DB before the route requires it
const msEmailRouter = require('../routes/msEmail');
const { createState } = require('../lib/oauthStateStore');

let server, baseUrl;

before(() => {
  const app = express();
  app.use(express.json());
  app.use('/api/ms-email', msEmailRouter);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${server.address().port}/api/ms-email`;
});

after(() => {
  server.close();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test('GET /auth returns 503 and names the missing environment variables when Microsoft Graph is not configured', async () => {
  const res = await fetch(`${baseUrl}/auth`, { redirect: 'manual' });
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.match(text, /MICROSOFT_TENANT_ID/);
  assert.match(text, /MICROSOFT_CLIENT_ID/);
  assert.match(text, /MICROSOFT_CLIENT_SECRET/);
});

test('GET /callback with a missing state is rejected with 400 before any token exchange is attempted', async () => {
  const res = await fetch(`${baseUrl}/callback?code=fake-code-value`);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /invalid or expired/i);
});

test('GET /callback with a garbage/unknown state is rejected with 400', async () => {
  const res = await fetch(`${baseUrl}/callback?code=fake-code-value&state=not-a-real-state`);
  assert.equal(res.status, 400);
});

test('GET /callback with a state this process never issued (e.g. from a different/expired session) is rejected, even if well-formed', async () => {
  const foreignLookingState = 'a'.repeat(48);
  const res = await fetch(`${baseUrl}/callback?code=fake-code-value&state=${foreignLookingState}`);
  assert.equal(res.status, 400);
});

test('GET /callback with a VALID, freshly-issued state still fails safely once it reaches the token exchange, since Microsoft Graph is not configured in this test -- no live network call is made, and the failure is not the state check', async () => {
  const state = createState();
  const res = await fetch(`${baseUrl}/callback?code=fake-code-value&state=${state}`);
  // Passed the state check (would be a generic "invalid or expired" 400
  // otherwise); fails instead at the configuration check inside
  // lib/msGraphAuth.js's buildConfidentialClient(), which is the correct,
  // distinct failure mode for this test environment.
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.doesNotMatch(text, /invalid or expired/i);
});

test('GET /callback with Microsoft\'s own error query params is rejected with 400 and shows the error, without attempting a token exchange', async () => {
  const res = await fetch(`${baseUrl}/callback?error=access_denied&error_description=The%20user%20declined`);
  assert.equal(res.status, 400);
  const text = await res.text();
  assert.match(text, /access_denied/);
});

test('GET /callback with no code at all is rejected with 400', async () => {
  const state = createState();
  const res = await fetch(`${baseUrl}/callback?state=${state}`);
  assert.equal(res.status, 400);
});

test('no response from /auth or /callback ever includes a bearer-token-shaped value or an assigned secret (env var NAMES like MICROSOFT_CLIENT_SECRET are fine -- those are not the secret itself)', async () => {
  const state = createState();
  const responses = await Promise.all([
    fetch(`${baseUrl}/auth`, { redirect: 'manual' }),
    fetch(`${baseUrl}/callback?code=fake&state=${state}`),
  ]);
  for (const res of responses) {
    const text = await res.text();
    assert.doesNotMatch(text, /Bearer [A-Za-z0-9._-]{20,}/i);
    assert.doesNotMatch(text, /client_secret["'=:]\s*["']?[A-Za-z0-9._~-]{8,}/i, 'must never show an assigned secret VALUE');
  }
});
