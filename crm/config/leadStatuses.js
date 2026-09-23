// Canonical lead-status ("Pipeline Stage") vocabulary. Single source of
// truth for crm/routes/calcom.js's booking/reschedule upgrade-eligibility
// check and the Edit Client dropdown (crm/public/app/client.html, fetched
// via GET /api/app/lead-statuses since a static browser page can't
// require() a Node module directly). Approved design, 2026-09-23 audit.
//
// Before this file existed, three independent, only-partially-overlapping
// lists defined this vocabulary: crm/routes/calcom.js's own inline
// upgradeStatuses array, crm/public/app/client.html's KNOWN_LEAD_STATUSES,
// and crm/lib/importService.js's two hardcoded literals. This file
// replaces the first two; importService.js's literals are left exactly as
// they are today -- changing that file is explicitly out of scope for this
// round.

// The approved, deliberate go-forward vocabulary for "where a lead/
// prospect currently is in the sales process." Selectable in the Edit
// Client dropdown and (the pre-Appointment-Scheduled ones) recognized as
// upgrade-eligible by Cal.com -- see UPGRADE_ELIGIBLE_STATUSES below.
// Deliberately does NOT include Warm/Hot/Cold Lead, per the approved
// design.
const PIPELINE_STAGES = [
  'New Lead',
  'Attempting Contact',
  'Contacted',
  'Qualified Prospect',
  'Appointment Scheduled',
  'Appointment Completed',
  'Application Started',
  'Application Submitted',
  'Decision Pending',
];

// Not "stages" in the sales-pipeline sense -- real values crm/routes/
// calcom.js's live automation sets today (booking reschedule / booking
// cancellation) and depends on. Preserved exactly, per the approved
// design -- never rename or remove.
const OPERATIONAL_STATUSES = ['Appointment Rescheduled', 'Cancelled'];

// The one canonical value meaning "this contact is a client" -- kept as
// 'Existing Client' (not renamed to 'Client'), because it's the exact
// string lib/importService.js's automation already writes, and the exact
// string lib/dashboardQueries.js's getNewProspectsQueue/
// getProspectPipelineQueue already exclude on. See this design round's own
// audit for why 'Client' (a value no automation has ever written) was
// retired instead of the other way around.
const CLIENT_STATUS = 'Existing Client';

// Legacy values that predate this design, were never written by any
// current automation, and are NOT part of the approved PIPELINE_STAGES
// vocabulary -- 'Client', 'Illustration Sent', 'Underwriting', 'Sold',
// 'Follow-Up Needed', and 'Long-Term Nurture' were previously offered in
// client.html's now-superseded KNOWN_LEAD_STATUSES dropdown; 'Attempted
// Contact' (past tense) and 'Needs Outcome' were only ever referenced
// inside crm/routes/calcom.js's own upgrade-eligibility array, never
// offered in any dropdown at all. None of these are dropped or renamed on
// any existing record -- they simply are not promoted into the new
// go-forward SELECTABLE_LEAD_STATUSES list below. client.html's own
// existing fallback pattern (always shows the contact's CURRENT value,
// even if it's absent from this list) already handles displaying/editing
// any of these gracefully if a record still has one.
const LEGACY_STATUSES = [
  'Client', 'Illustration Sent', 'Underwriting', 'Sold',
  'Follow-Up Needed', 'Long-Term Nurture', 'Attempted Contact', 'Needs Outcome',
];

// Statuses "early enough in the funnel" that a new/rescheduled Cal.com
// booking should still advance them forward -- mirrors crm/routes/
// calcom.js's PRE-EXISTING upgradeStatuses array exactly (every one of its
// 8 original values is still present here), widened only to add the two
// NEW pre-appointment pipeline stages (Attempting Contact, Qualified
// Prospect). Deliberately does NOT include anything that comes AFTER
// Appointment Scheduled in PIPELINE_STAGES (Appointment Completed,
// Application Started, Application Submitted, Decision Pending) -- the
// original array never advanced anyone past that point either, so a
// contact already further along in the funnel is never regressed by a new
// booking. Also does not include Cancelled or Existing Client, unchanged
// from today -- changing either of those (e.g. so a Cancelled contact who
// books again gets upgraded too) is explicitly out of scope for this round.
const UPGRADE_ELIGIBLE_STATUSES = [
  'New Lead', 'Attempting Contact', 'Attempted Contact', 'Contacted', 'Qualified Prospect',
  'Follow-Up Needed', 'Long-Term Nurture',
  'Appointment Scheduled', 'Appointment Rescheduled', 'Needs Outcome',
];

// What the Edit Client dropdown offers by default (client.html) --
// deliberately excludes LEGACY_STATUSES (superseded by PIPELINE_STAGES,
// per the approved design). Still includes CLIENT_STATUS, since staff can
// legitimately mark someone an Existing Client manually, exactly as the
// old KNOWN_LEAD_STATUSES' closest equivalent ('Client') already allowed.
const SELECTABLE_LEAD_STATUSES = [...PIPELINE_STAGES, ...OPERATIONAL_STATUSES, CLIENT_STATUS];

module.exports = {
  PIPELINE_STAGES,
  OPERATIONAL_STATUSES,
  CLIENT_STATUS,
  LEGACY_STATUSES,
  UPGRADE_ELIGIBLE_STATUSES,
  SELECTABLE_LEAD_STATUSES,
};
