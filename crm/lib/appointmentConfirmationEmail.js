// Automatic appointment EMAIL -- Workflows-driven ONLY (2026-10-16).
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
// PROSPERITY ONLY. Reuses crm/lib/gmailSend.js's sendGmailEmail --
// loretta@prosperitylfs.com, the same already-working Gmail/OAuth identity
// crm/routes/email.js and crm/lib/existingClientOutreach.js already send
// through. No new email service, no new credentials, no new provider.
// Insurance Lady has no working email sender anywhere in this codebase
// (crm/config/brands.js's Microsoft Graph identity is declared but "not
// yet created in any environment" per that file's own comment) -- a
// matched Insurance Lady send_email workflow FAILS CLOSED here with a
// clear, explicit reason, exactly like crm/lib/appointmentConfirmationSms.js
// already fails closed for an Insurance Lady SMS with no configured Twilio
// number. It is never silently sent, and never sent through Prosperity's
// Gmail identity by mistake -- brandId is checked BEFORE anything else
// happens, before the workflow's own condition is even evaluated.
//
// Duplicate-send protection: crm/db/database.js added
// emails.appointment_id / message_type / appointment_occurrence_at
// (mirroring sms_messages' own identical columns) specifically so
// crm/lib/appointmentReminderScheduler.js can dedupe an automated workflow
// email the exact same way it already dedupes an automated workflow SMS.

const { sendGmailEmail } = require('./gmailSend');
const { BRANDS } = require('../config/brands');
const { selectWorkflowForOccurrence, evaluateCondition, renderWorkflowMessage } = require('./workflowService');
const { buildIntakeUrl } = require('./retirementIntakeService');

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
//   { attempted: true, sent: false, reason, status: 503 }      — blocked:
//     brand isn't Prosperity (Insurance Lady email not yet configured), or
//     the contact has no email address on file.
//   { attempted: true, sent: false, reason, status }           — Gmail
//     send failure (already logged as status='failed' by sendGmailEmail's
//     own error handling -- mirrors sendLegacySms's pattern, though Gmail's
//     own client currently throws rather than returning a failure object,
//     see the try/catch below).
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
  // hard gate, not something a condition could ever override.
  if (brandId !== 'prosperity') {
    return {
      attempted: true, sent: false, status: 503,
      reason: `Email sending is not yet configured for ${brandId === 'insurance-lady' ? 'Insurance Lady' : brandId} -- only Prosperity's Gmail sender (loretta@prosperitylfs.com) is connected.`,
    };
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

  const send = deps.sendGmailEmail || sendGmailEmail;
  try {
    const result = await send(db, {
      contactId, toEmail, subject, body, appointmentId, messageType,
      appointmentOccurrenceAt: appointmentId ? appointmentDatetimeIso : null,
    }, deps);
    return { attempted: true, sent: true, email: result };
  } catch (err) {
    return { attempted: true, sent: false, reason: err.message, status: 500 };
  }
}

module.exports = { fmtApptDateTimeCT, sendAppointmentConfirmationEmail };
