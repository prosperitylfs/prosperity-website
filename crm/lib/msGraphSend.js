// Shared "send one email via Microsoft Graph + log it" primitive for the
// Insurance Lady mailbox (loretta@insuranceladyllc.com) -- 2026-10-16.
// Mirrors crm/lib/gmailSend.js's shape and its {contact_id, to_email,
// subject, body} logging contract as closely as Microsoft Graph allows,
// so callers (crm/routes/email.js, crm/lib/appointmentConfirmationEmail.js)
// can treat this as a drop-in parallel to sendGmailEmail: throws on any
// failure (not configured, never authorized, Graph API error); returns a
// small result object on success. Never touches Gmail or its GMAIL_* env
// vars -- this file has no import of and no dependency on lib/gmailSend.js
// or googleapis at all.
//
// Single Microsoft identity only (loretta@insuranceladyllc.com /
// MICROSOFT_* env vars, delegated OAuth via lib/msGraphAuth.js) -- this is
// the Insurance Lady email identity (crm/config/brands.js); there is no
// Prosperity Microsoft integration to accidentally reach here, and this
// file never sends through Gmail under any circumstance.
//
// deps.acquireGraphAccessToken / deps.fetch let tests substitute a fake
// token source and a fake HTTP layer without ever making a real network
// call or touching a live Microsoft account -- same injection idea as
// crm/lib/gmailSend.js's deps.gmailClientFactory.

const { acquireGraphAccessToken } = require('./msGraphAuth');

const GRAPH_SEND_MAIL_URL = 'https://graph.microsoft.com/v1.0/me/sendMail';

function fromName() { return process.env.MICROSOFT_FROM_NAME || 'Loretta Stewart'; }
function fromAddr() { return process.env.MICROSOFT_FROM || 'loretta@insuranceladyllc.com'; }

// Returns { sentAt }. Throws on any failure (Microsoft Graph not
// configured, mailbox never authorized, Graph API error) -- callers catch
// and translate, exactly like crm/lib/gmailSend.js's sendGmailEmail does.
// The thrown error's message never contains the access token, refresh
// token, or client secret -- only Graph's own HTTP status and response
// text (which describe the failure, e.g. "insufficient privileges" or a
// rate-limit message, never echo back the credential used to make the
// request).
//
// contactId is optional (omit to send without logging anywhere, matching
// sendGmailEmail's identical `if (contactId) { ... }` guard).
//
// appointmentId / messageType / appointmentOccurrenceAt (all optional,
// default null) support crm/lib/appointmentConfirmationEmail.js's
// automated-workflow-email dedup, mirroring sendGmailEmail's own identical
// parameters and the `emails` table's shared dedup columns.
//
// Unlike Gmail's API, Graph's POST /me/sendMail returns 202 Accepted with
// an EMPTY body on success -- there is no message id to capture here (a
// real limitation of this endpoint, not an omission); `gmail_message_id`
// stays NULL for every row this function logs, exactly as it already does
// for every other non-Gmail row in that column.
async function sendMsGraphEmail(db, { contactId = null, toEmail, subject, body, appointmentId = null, messageType = null, appointmentOccurrenceAt = null }, deps = {}) {
  const acquireToken = deps.acquireGraphAccessToken || acquireGraphAccessToken;
  const accessToken = await acquireToken(db, deps);

  const fetchImpl = deps.fetch || fetch;
  const response = await fetchImpl(GRAPH_SEND_MAIL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: body },
        toRecipients: [{ emailAddress: { address: toEmail } }],
      },
      saveToSentItems: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    // Never includes accessToken -- only Graph's own status/response text.
    throw new Error(`Microsoft Graph sendMail failed (HTTP ${response.status}): ${errorText.slice(0, 300)}`);
  }

  const sentAt = new Date().toISOString();
  const preview = body.length > 400 ? body.slice(0, 397) + '…' : body;

  if (contactId) {
    db.prepare(`
      INSERT OR IGNORE INTO emails
        (contact_id, to_email, from_email, subject, body, status, direction, appointment_id, message_type, appointment_occurrence_at, sent_at)
      VALUES (?, ?, ?, ?, ?, 'sent', 'outbound', ?, ?, ?, ?)
    `).run(contactId, toEmail, fromAddr(), subject, preview, appointmentId, messageType, appointmentOccurrenceAt, sentAt);

    // Also land in the communications timeline (activity feed excludes comm_type='email')
    db.prepare(`
      INSERT INTO communications (contact_id, comm_type, direction, subject, body, status)
      VALUES (?, 'email', 'outbound', ?, ?, 'sent')
    `).run(contactId, subject, preview);
  }

  return { sentAt };
}

module.exports = { sendMsGraphEmail, fromName, fromAddr, GRAPH_SEND_MAIL_URL };
