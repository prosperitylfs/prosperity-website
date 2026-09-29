// Automatic appointment EMAIL -- Workflows-driven ONLY (2026-10-16; brand
// routing to Microsoft Graph added 2026-10-16).
// Unlike crm/lib/appointmentConfirmationSms.js, there is no hardcoded
// fallback template here at all: Version 1's only existing "appointment
// confirmation email" template (config/templates.js's
// appointmentConfirmationEmail, both brands) is documented, unwired
// scaffolding that no code path has ever sent -- confirmed by the 2026-10
// email infrastructure audit -- so there is nothing pre-existing to fall
// back to. An email is sent only when an ENABLED crm/lib/workflowService.js
// row with action_type='send_email' actually matches
// (brandId, appointmentType, messageType); no matching row means nothing
// is attempted, full stop.
//
// Brand -> sender mapping (SENDER_FOR_BRAND below) is the ONLY place this
// module decides which provider to use: prosperity -> crm/lib/gmailSend.js
// (loretta@prosperitylfs.com, unchanged), insurance-lady ->
// crm/lib/msGraphSend.js (loretta@insuranceladyllc.com, Microsoft Graph
// delegated OAuth). Neither sender is ever called for the other brand. A
// brandId that maps to neither (defensive only -- crm/lib/workflowService.js's
// VALID_BRANDS only contains these two) fails closed immediately, before
// the workflow's own condition is even evaluated -- a condition can never
// override brand eligibility. If a brand's sender IS mapped but its
// provider isn't actually configured/authorized yet (e.g. Microsoft Graph
// env vars missing, or the Insurance Lady mailbox has never completed its
// one-time interactive authorization), the sender itself throws a clear,
// non-secret-bearing error, caught below and returned as a normal
// {attempted:true, sent:false, reason} result -- never a silent no-op,
// and never a fallback to the other brand's provider.
//
// Duplicate-send protection: crm/db/database.js added
// emails.appointment_id / message_type / appointment_occurrence_at
// (mirroring sms_messages' own identical columns) specifically so
// crm/lib/appointmentReminderScheduler.js can dedupe an automated workflow
// email the exact same way it already dedupes an automated workflow SMS --
// used identically regardless of which brand/provider actually sent it.

const { sendGmailEmail } = require('./gmailSend');
const { sendMsGraphEmail } = require('./msGraphSend');
const { BRANDS } = require('../config/brands');
const { selectWorkflowForOccurrence, evaluateCondition, renderWorkflowMessage } = require('./workflowService');
const { buildIntakeUrl } = require('./retirementIntakeService');

// Maps brandId -> the deps override key a test can use to inject a fake
// sender for that specific brand, and the real function to fall back to
// otherwise. Deliberately data, not a chain of if/else -- adding a brand
// here later only ever means adding one line, never touching the
// send/catch logic below.
const SENDER_FOR_BRAND = {
  prosperity: { depsKey: 'sendGmailEmail', fn: sendGmailEmail },
  'insurance-lady': { depsKey: 'sendMsGraphEmail', fn: sendMsGraphEmail },
};

function fmtApptDateTimeCT(appointmentDatetimeIso) {
  const d = new Date(appointmentDatetimeIso);
  const date = d.toLocaleDateString('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
  const time = d.toLocaleTimeString('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return { date, time };
}

// `messageType`: any value from crm/lib/workflowService.js's
// MESSAGE_TYPE_OPTIONS (same vocabulary the SMS side uses).
// `appointmentId` is stamped onto the logged `emails` row for dedup and
// SMS-History-style classification, exactly like the SMS sender's own
// `appointmentId` parameter.
// Returns one of:
//   { attempted: true, sent: true, email }                    — sent.
//   { attempted: true, sent: false, reason, status: 503 }      — a brand
//     with no mapped sender at all (defensive-only, see SENDER_FOR_BRAND),
//     or the contact has no email address on file (status: 400 for that
//     specific case).
//   { attempted: true, sent: false, reason, status }           — the
//     brand's own sender (sendGmailEmail or sendMsGraphEmail) threw:
//     provider not configured, mailbox not yet authorized (Microsoft
//     only), or a genuine send failure from that provider's API. `status`
//     comes from the thrown error's own `.status` when set (e.g. 503 for
//     "not configured"/"not authorized"), else 500.
//   { attempted: false, reason: 'no_matching_workflow' }        — no
//     enabled send_email workflow row matches this
//     (brandId, appointmentType, messageType) at all.
//   { attempted: false, reason: 'workflow_condition_not_met' }  — a
//     matching row exists but its condition evaluated false (e.g.
//     retirement intake already completed) -- authoritative, never a
//     fallback trigger.
async function sendAppointmentConfirmationEmail(db, { contactId, toEmail, firstName, appointmentType, appointmentDatetimeIso, brandId, appointmentId = null, messageType }, deps = {}) {
  const workflow = selectWorkflowForOccurrence(db, { brandId, appointmentType, messageType });
  if (!workflow || workflow.actionType !== 'send_email') {
    return { attempted: false, reason: 'no_matching_workflow' };
  }

  // Checked BEFORE the condition is evaluated -- brand eligibility is a
  // hard gate, not something a condition could ever override. Defensive
  // only: every brandId reaching here already passed through
  // crm/lib/workflowService.js's VALID_BRANDS validation, so this can only
  // trip if that list ever adds a brand without a corresponding sender.
  const sender = SENDER_FOR_BRAND[brandId];
  if (!sender) {
    return { attempted: true, sent: false, status: 503, reason: `Email sending is not configured for ${brandId}.` };
  }

  if (!toEmail) {
    return { attempted: true, sent: false, status: 400, reason: 'Contact has no email address on file' };
  }

  if (!evaluateCondition(db, workflow.conditionType, { appointmentId })) {
    return { attempted: false, reason: 'workflow_condition_not_met' };
  }

  const { date, time } = fmtApptDateTimeCT(appointmentDatetimeIso);
  const brand = BRANDS[brandId];
  // Same conditional {{intake_link}} lookup as
  // appointmentConfirmationSms.js's own -- only queried when either the
  // subject or the body actually references it, never generates a new
  // token, only formats the URL for one that already exists.
  const needsIntakeLink = (workflow.messageTemplate + ' ' + (workflow.emailSubject || '')).includes('{{intake_link}}');
  const intakeRow = needsIntakeLink && appointmentId
    ? db.prepare('SELECT token FROM retirement_intakes WHERE appointment_id = ?').get(appointmentId)
    : null;
  const vars = {
    first_name: firstName || 'there', appt_date: date, appt_time: `${time} CT`,
    appointment_type: appointmentType,
    brand_name: brand ? brand.legalName : brandId,
    intake_link: intakeRow ? buildIntakeUrl(intakeRow.token, brandId) : undefined,
  };
  const subject = renderWorkflowMessage(workflow.emailSubject || '', vars);
  const body = renderWorkflowMessage(workflow.messageTemplate, vars);

  const send = deps[sender.depsKey] || sender.fn;
  try {
    const result = await send(db, {
      contactId, toEmail, subject, body, appointmentId, messageType,
      appointmentOccurrenceAt: appointmentId ? appointmentDatetimeIso : null,
    }, deps);
    return { attempted: true, sent: true, email: result };
  } catch (err) {
    return { attempted: true, sent: false, reason: err.message, status: err.status || 500 };
  }
}

module.exports = { fmtApptDateTimeCT, sendAppointmentConfirmationEmail };
