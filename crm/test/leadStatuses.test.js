// Tests for crm/config/leadStatuses.js -- the canonical lead-status
// ("Pipeline Stage") vocabulary approved in the 2026-09-23 design round.
// Pure data/config, no database involved.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PIPELINE_STAGES,
  OPERATIONAL_STATUSES,
  CLIENT_STATUS,
  LEGACY_STATUSES,
  UPGRADE_ELIGIBLE_STATUSES,
  SELECTABLE_LEAD_STATUSES,
} = require('../config/leadStatuses');

function assertNoDuplicates(arr, label) {
  assert.equal(new Set(arr).size, arr.length, `${label} must not contain duplicate values`);
}

test('PIPELINE_STAGES matches the exact approved 9-stage vocabulary, in order', () => {
  assert.deepEqual(PIPELINE_STAGES, [
    'New Lead', 'Attempting Contact', 'Contacted', 'Qualified Prospect',
    'Appointment Scheduled', 'Appointment Completed',
    'Application Started', 'Application Submitted', 'Decision Pending',
  ]);
});

test('PIPELINE_STAGES never includes Warm/Hot/Cold Lead -- explicitly rejected by the approved design', () => {
  for (const rejected of ['Warm Lead', 'Hot Lead', 'Cold Lead']) {
    assert.ok(!PIPELINE_STAGES.includes(rejected), `${rejected} must never be added`);
  }
});

test('OPERATIONAL_STATUSES preserves both existing automation-set values exactly', () => {
  assert.deepEqual(OPERATIONAL_STATUSES, ['Appointment Rescheduled', 'Cancelled']);
});

test('CLIENT_STATUS is the canonical "Existing Client" value, matching what lib/importService.js already writes', () => {
  assert.equal(CLIENT_STATUS, 'Existing Client');
});

test('UPGRADE_ELIGIBLE_STATUSES preserves every one of the 8 original crm/routes/calcom.js upgradeStatuses values', () => {
  const original8 = [
    'New Lead', 'Attempted Contact', 'Contacted',
    'Follow-Up Needed', 'Long-Term Nurture',
    'Appointment Scheduled', 'Appointment Rescheduled', 'Needs Outcome',
  ];
  for (const status of original8) {
    assert.ok(UPGRADE_ELIGIBLE_STATUSES.includes(status), `must still include pre-existing value '${status}'`);
  }
});

test('UPGRADE_ELIGIBLE_STATUSES is widened to include the two new pre-appointment pipeline stages', () => {
  assert.ok(UPGRADE_ELIGIBLE_STATUSES.includes('Attempting Contact'));
  assert.ok(UPGRADE_ELIGIBLE_STATUSES.includes('Qualified Prospect'));
});

test('UPGRADE_ELIGIBLE_STATUSES never includes Cancelled or Existing Client -- unchanged from today, out of scope for this round', () => {
  assert.ok(!UPGRADE_ELIGIBLE_STATUSES.includes('Cancelled'));
  assert.ok(!UPGRADE_ELIGIBLE_STATUSES.includes(CLIENT_STATUS));
});

test('UPGRADE_ELIGIBLE_STATUSES never includes any stage that comes AFTER Appointment Scheduled -- a new booking must never regress someone further along', () => {
  for (const laterStage of ['Appointment Completed', 'Application Started', 'Application Submitted', 'Decision Pending']) {
    assert.ok(!UPGRADE_ELIGIBLE_STATUSES.includes(laterStage), `${laterStage} must not be upgrade-eligible`);
  }
});

test('SELECTABLE_LEAD_STATUSES (the Edit Client dropdown) offers the 9 pipeline stages, the 2 operational statuses, and Existing Client', () => {
  assert.deepEqual(SELECTABLE_LEAD_STATUSES, [...PIPELINE_STAGES, ...OPERATIONAL_STATUSES, CLIENT_STATUS]);
  assert.equal(SELECTABLE_LEAD_STATUSES.length, 12);
});

test('SELECTABLE_LEAD_STATUSES never offers the retired legacy values (Client, Illustration Sent, Underwriting, Sold, Follow-Up Needed, Long-Term Nurture)', () => {
  for (const retired of LEGACY_STATUSES) {
    assert.ok(!SELECTABLE_LEAD_STATUSES.includes(retired), `${retired} must not be offered going forward`);
  }
});

test('LEGACY_STATUSES contains the values retired from the dropdown, for documentation -- and none of them collide with the approved go-forward vocabulary', () => {
  for (const legacy of LEGACY_STATUSES) {
    assert.ok(!PIPELINE_STAGES.includes(legacy) && !OPERATIONAL_STATUSES.includes(legacy) && legacy !== CLIENT_STATUS);
  }
});

test('none of the exported lists contain internal duplicates', () => {
  assertNoDuplicates(PIPELINE_STAGES, 'PIPELINE_STAGES');
  assertNoDuplicates(OPERATIONAL_STATUSES, 'OPERATIONAL_STATUSES');
  assertNoDuplicates(LEGACY_STATUSES, 'LEGACY_STATUSES');
  assertNoDuplicates(SELECTABLE_LEAD_STATUSES, 'SELECTABLE_LEAD_STATUSES');
  // UPGRADE_ELIGIBLE_STATUSES intentionally lists both 'Attempting Contact'
  // (new) and 'Attempted Contact' (legacy spelling) as two DIFFERENT
  // strings -- not a duplicate of each other, so this checks true
  // uniqueness rather than asserting a specific count.
  assertNoDuplicates(UPGRADE_ELIGIBLE_STATUSES, 'UPGRADE_ELIGIBLE_STATUSES');
});
