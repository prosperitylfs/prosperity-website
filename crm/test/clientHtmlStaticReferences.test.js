// 2026-10-13 PRODUCTION REGRESSION: crm/public/app/client.html's casesHtml()
// called legacyCasesNeedsReviewHtml() -- a function that was never actually
// included in the commit that shipped the call (it's part of a separate,
// still-pending, not-yet-approved feature) -- so every single client's
// Cases tab threw "legacyCasesNeedsReviewHtml is not defined", leaving the
// entire Client Record page blank (confirmed via the browser console).
//
// This file has no browser/DOM test environment (no jsdom/puppeteer in this
// project), so this is a lightweight static check, not a real execution
// test: every call to a local "xxxHtml"-style render helper (the naming
// convention this file uses throughout -- overviewHtml, casesHtml,
// pendingApplicationsHtml, etc., whether declared via `function name()` or
// `const name = (...) => ...`) must have a matching declaration somewhere
// in the same script. It would have caught this exact regression before
// deploy, and will catch the same class of mistake (an isolated commit
// shipping a call to code that isn't actually part of that commit) for any
// future "xxxHtml" helper.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CLIENT_HTML_PATH = path.join(__dirname, '..', 'public', 'app', 'client.html');

function findUndeclaredHtmlHelperCalls(html) {
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('No inline <script> block found in client.html');
  const script = scriptMatch[1];

  const declaredFn = [...script.matchAll(/function\s+([a-zA-Z]+Html)\s*\(/g)].map(m => m[1]);
  const declaredConst = [...script.matchAll(/const\s+([a-zA-Z]+Html)\s*=/g)].map(m => m[1]);
  const declared = new Set([...declaredFn, ...declaredConst]);

  // Excludes method calls (e.g. CrmApp.escapeHtml(...)) by requiring the
  // name NOT be immediately preceded by a '.'.
  const called = new Set([...script.matchAll(/([^.\w]|^)([a-zA-Z]+Html)\s*\(/g)].map(m => m[2]));

  return [...called].filter(name => !declared.has(name));
}

test('client.html: every called "xxxHtml" render helper is actually declared somewhere in the script', () => {
  const html = fs.readFileSync(CLIENT_HTML_PATH, 'utf8');
  const missing = findUndeclaredHtmlHelperCalls(html);
  assert.deepEqual(missing, [], `Called but never declared (would throw "X is not defined" and blank the page): ${missing.join(', ')}`);
});

test('findUndeclaredHtmlHelperCalls: self-check -- correctly flags a reintroduced version of the actual 2026-10-13 regression', () => {
  const fakeHtml = `<script>
    function casesHtml() { return pendingApplicationsHtml() + legacyCasesNeedsReviewHtml(); }
    function pendingApplicationsHtml() { return ''; }
  </script>`;
  assert.deepEqual(findUndeclaredHtmlHelperCalls(fakeHtml), ['legacyCasesNeedsReviewHtml']);
});

test('findUndeclaredHtmlHelperCalls: self-check -- no false positive for a const arrow-function helper or a CrmApp.* method call', () => {
  const fakeHtml = `<script>
    function casesHtml() { return policyFieldsHtml(1) + CrmApp.escapeHtml('x'); }
    const policyFieldsHtml = (p) => '';
  </script>`;
  assert.deepEqual(findUndeclaredHtmlHelperCalls(fakeHtml), []);
});
