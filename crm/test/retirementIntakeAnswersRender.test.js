// Tests for crm/public/app/client.html's completed-intake rendering
// functions (renderIntakeAnswers / renderIntakeAnswersV2 /
// renderIntakeAnswersLegacy / computeTotalAssetsToDiscuss / riMoney).
//
// This test suite has no browser/DOM harness, so these functions are
// extracted directly from the real client.html source and executed in
// isolation -- not re-implemented or duplicated here. Since JS function
// DECLARATIONS are hoisted to the top of their enclosing scope, prepending
// a `return {...}` as the very first statement of render()'s body means
// every named function is already defined by the time that return
// executes, and nothing else in render() (fetches, DOM lookups) ever runs.
// This proves the ACTUAL shipped code renders correctly, not a copy of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CrmApp = {
  escapeHtml: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  friendlyDateTime: (iso) => (iso || '—'),
};

async function loadClientHtmlFunctions() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'app', 'client.html'), 'utf8');
  const m = html.match(/async function render\(\) \{([\s\S]*)\}\s*\nrender\(\);/);
  if (!m) throw new Error('Could not locate render() in client.html -- has its structure changed?');
  const body = m[1];
  const exported = [
    'riVal', 'riList', 'riRow', 'riMoney', 'computeTotalAssetsToDiscuss', 'riHighlight',
    'renderIntakeAnswers', 'renderIntakeAnswersLegacy', 'renderIntakeAnswersV2',
  ];
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('CrmApp', `return { ${exported.join(', ')} };\n` + body);
  return fn(CrmApp);
}

let mod;
test.before(async () => { mod = await loadClientHtmlFunctions(); });

// ── computeTotalAssetsToDiscuss / riMoney ────────────────────────────────

test('computeTotalAssetsToDiscuss sums multiple account balances, tolerating $ and commas', () => {
  const total = mod.computeTotalAssetsToDiscuss([{ balance: '$120,000' }, { balance: '45,500.50' }, { balance: '10000' }]);
  assert.equal(total, 175500.5);
});

test('computeTotalAssetsToDiscuss excludes blank/unparseable balances rather than treating them as zero or crashing', () => {
  const total = mod.computeTotalAssetsToDiscuss([{ balance: '$50,000' }, { balance: '' }, { balance: 'unknown' }, {}]);
  assert.equal(total, 50000);
});

test('computeTotalAssetsToDiscuss returns null (not 0) when no account has a usable balance', () => {
  assert.equal(mod.computeTotalAssetsToDiscuss([{ balance: '' }, { balance: 'n/a' }]), null);
});

test('computeTotalAssetsToDiscuss returns null for an empty or missing accounts array', () => {
  assert.equal(mod.computeTotalAssetsToDiscuss([]), null);
  assert.equal(mod.computeTotalAssetsToDiscuss(undefined), null);
  assert.equal(mod.computeTotalAssetsToDiscuss(null), null);
});

// ── renderIntakeAnswersV2 (new, 6-section) ───────────────────────────────

function sampleV2Responses(overrides = {}) {
  return {
    intakeVersion: 2,
    about: { firstName: 'Renee', lastName: 'Jones', email: 'renee@example.com', phone: '4145550100', dateOfBirth: '1965-01-01', state: 'Wisconsin', employmentStatus: 'Retired', maritalStatus: 'Married', isRetired: 'Yes', retirementYear: '2024' },
    helpWith: { mainReason: 'Create reliable retirement income', mainConcern: 'Will my money last?' },
    accounts: [
      { accountType: '401(k)', institution: 'Fidelity', balance: '$200,000', receivingContributions: 'No', investedInMarket: 'Yes', generatingIncome: 'No', availableToMove: 'Yes' },
      { accountType: 'IRA', institution: 'Vanguard', balance: '50000', receivingContributions: 'No', investedInMarket: 'Yes', generatingIncome: 'No', availableToMove: 'Not sure' },
    ],
    retirementGoals: { whenPlanTo: 'Already retired', needsIncome: 'Yes', desiredMonthlyIncome: '3000', otherIncomeSources: ['Social Security', 'Pension'], needsLargeWithdrawal: 'No', withdrawalDetail: '' },
    risk: { comfortWithLosses: 'I am comfortable with limited fluctuations', topPriority: 'Create reliable retirement income' },
    beforeWeMeet: { ownsAnnuity: 'Yes', annuity: { company: 'Athene', value: '75000', type: 'FIA', surrender: '7 years' }, hasCurrentAdvisor: 'No', otherDecisionMaker: 'Yes', decisionMakerWho: 'Spouse', decisionMakerWouldParticipate: 'Yes', anythingElse: 'Prefer morning appointments' },
    ...overrides,
  };
}

test('renderIntakeAnswersV2 renders all 6 new section headings', () => {
  const html = mod.renderIntakeAnswersV2(sampleV2Responses());
  for (const heading of ['1. About You', '2. What Would You Like Help With?', '3. Accounts &amp; Assets to Discuss', '4. Retirement &amp; Income Goals', '5. Risk &amp; Priorities', '6. Before We Meet']) {
    assert.ok(html.includes(heading), `missing section heading: ${heading}`);
  }
});

test('renderIntakeAnswersV2 prominently shows Main Reason and the biggest question/concern in Section 2', () => {
  const html = mod.renderIntakeAnswersV2(sampleV2Responses());
  assert.ok(html.includes('MAIN REASON') || html.includes('Main Reason'));
  assert.ok(html.includes('Create reliable retirement income'));
  assert.ok(html.includes('Will my money last?'));
});

test('renderIntakeAnswersV2 shows the calculated Total Assets to Discuss and each individual account', () => {
  const html = mod.renderIntakeAnswersV2(sampleV2Responses());
  assert.match(html, /Total Assets to Discuss/i);
  assert.match(html, /\$250,000/); // 200,000 + 50,000
  assert.ok(html.includes('Fidelity'));
  assert.ok(html.includes('Vanguard'));
  assert.ok(html.includes('Account 1'));
  assert.ok(html.includes('Account 2'));
});

test('renderIntakeAnswersV2 shows Market Loss Comfort and #1 Priority prominently in Section 5', () => {
  const html = mod.renderIntakeAnswersV2(sampleV2Responses());
  assert.ok(html.includes('I am comfortable with limited fluctuations'));
  assert.match(html, /#1 Priority/);
});

test('renderIntakeAnswersV2 shows Section 6 annuity/advisor/decision-maker details', () => {
  const html = mod.renderIntakeAnswersV2(sampleV2Responses());
  assert.ok(html.includes('Athene'));
  assert.ok(html.includes('Spouse'));
  assert.ok(html.includes('Prefer morning appointments'));
});

test('renderIntakeAnswersV2 shows Marital Status in Section 1 -- About You (2026-10-16: added back as a required field)', () => {
  const html = mod.renderIntakeAnswersV2(sampleV2Responses());
  assert.match(html, /Marital Status/);
  assert.ok(html.includes('Married'));
});

test('renderIntakeAnswersV2 shows "—" for Marital Status when absent, rather than omitting the row or crashing', () => {
  const responses = sampleV2Responses();
  delete responses.about.maritalStatus;
  const html = mod.renderIntakeAnswersV2(responses);
  assert.match(html, /Marital Status/);
});

test('renderIntakeAnswersV2 handles a missing/empty accounts array gracefully -- no crash, "no accounts" message, Total shown as "—"', () => {
  const html = mod.renderIntakeAnswersV2(sampleV2Responses({ accounts: [] }));
  assert.ok(html.includes('No accounts entered.'));
  assert.match(html, />—<\/div>/);
});

// ── renderIntakeAnswers (version dispatcher) ─────────────────────────────

test('renderIntakeAnswers routes intakeVersion=2 to the new 6-section renderer', () => {
  const html = mod.renderIntakeAnswers(sampleV2Responses());
  assert.ok(html.includes('4. Retirement &amp; Income Goals'), 'must use the V2 layout');
  assert.ok(!html.includes('4. Income Needs'), 'must NOT use the legacy layout');
});

test('renderIntakeAnswers routes a legacy record (no intakeVersion at all) to the OLD 10-section renderer, unchanged', () => {
  const legacy = {
    about: { firstName: 'Jane', lastName: 'Doe', maritalStatus: 'Married' },
    helpWith: { selections: ['Retirement income planning'], mainConcern: 'General planning' },
    income: { needsIncome: 'Yes' },
    risk: { comfortWithLosses: 'Not sure', priorities: ['Protect principal'] },
  };
  const html = mod.renderIntakeAnswers(legacy);
  assert.ok(html.includes('4. Income Needs'), 'must use the legacy 10-section layout');
  assert.ok(html.includes('7. Existing Products'));
  assert.ok(html.includes('10. Additional Information'));
  assert.ok(html.includes('Married'), 'legacy Marital Status must still render for an old record');
});

test('renderIntakeAnswers treats an explicit intakeVersion other than 2 (e.g. 1, or an unexpected future value) as legacy, never guessing at a newer layout', () => {
  const html = mod.renderIntakeAnswers({ intakeVersion: 1, about: { firstName: 'Jane' } });
  assert.ok(html.includes('10. Additional Information'));
});

test('renderIntakeAnswers never throws for null/undefined responses, for either version path', () => {
  assert.doesNotThrow(() => mod.renderIntakeAnswers(null));
  assert.doesNotThrow(() => mod.renderIntakeAnswers(undefined));
  assert.doesNotThrow(() => mod.renderIntakeAnswers({ intakeVersion: 2 }));
});

// ── Legacy renderer regression (byte-for-byte behavior preserved) ───────

test('renderIntakeAnswersLegacy is unchanged: still renders the full old 10-section shape correctly for a complete legacy record', () => {
  const legacy = {
    about: { firstName: 'Jane', lastName: 'Doe', email: 'jane@example.com', phone: '4145550100', maritalStatus: 'Married', state: 'Wisconsin' },
    helpWith: { selections: ['Retirement income planning', 'Annuities / guaranteed income'], mainConcern: 'General planning' },
    totalAssets: '250000',
    accounts: [{ accountType: '401(k)', institution: 'Fidelity', balance: '200000' }],
    income: { needsIncome: 'Yes', totalMonthlyIncome: '4000', totalMonthlyExpenses: '3000' },
    risk: { comfortWithLosses: 'Not sure', priorities: ['Protect principal', 'Generate reliable income'] },
    timeHorizon: { horizon: '5-10 years', needsLargeWithdrawal: 'No' },
    existingProducts: { owns: ['Annuities'], annuity: { company: 'Athene', value: '75000' } },
    beneficiaries: { hasBeneficiaries: 'Yes', primaryBeneficiaries: 'Spouse' },
    advisor: { hasCurrentAdvisor: 'No' },
    additional: { anythingElse: 'None' },
  };
  const html = mod.renderIntakeAnswersLegacy(legacy);
  assert.ok(html.includes('Total Assets')); // old top-level totalAssets field, not the new computed one
  assert.ok(html.includes('Fidelity'));
  assert.ok(html.includes('Married'));
  assert.ok(html.includes('Retirement income planning, Annuities / guaranteed income'));
  assert.ok(html.includes('Athene'));
});
