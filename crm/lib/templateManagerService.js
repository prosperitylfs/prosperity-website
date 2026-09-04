// Template Manager: lets Loretta view, edit, and create Existing Client
// Outreach templates (SMS and email) from inside the CRM, without a code
// deploy or editing crm/config/templates.js directly.
//
// Deliberately scoped to the SAME Prosperity-only, Existing-Client-Outreach
// template set crm/lib/existingClientOutreach.js already owns (its
// EXISTING_CLIENT_SMS_TEMPLATES / EXISTING_CLIENT_EMAIL_TEMPLATES registries,
// plus any DB-only custom templates) -- NOT the much larger catalog of
// automated SMS templates in crm/config/templates.js (appointment
// confirmations, reminders, missed-call replies, etc.), which stay
// code-defined and are tightly coupled to their own automated flows.
//
// A template's template_key is its stable, permanent identifier and is
// NEVER exposed as an editable field here -- see
// crm/lib/existingClientOutreach.js's own "Template Manager support"
// comment. Inbound keyword automation (crm/lib/inboundSmsService.js's
// YES/REVIEW/NO/STOP handling) is keyed entirely off inbound message TEXT,
// never off any template at all, so renaming/rewording a template here can
// never change which automation applies to a reply.

const {
  EXISTING_CLIENT_SMS_TEMPLATES, EXISTING_CLIENT_EMAIL_TEMPLATES,
  getReconnectionTemplates, getSmsTemplateRegistry, getEmailTemplateRegistry,
} = require('./existingClientOutreach');
const { toStringOrNull } = require('./leadNormalize');

const BRAND_ID = 'prosperity'; // Existing Client Outreach is Prosperity-only throughout this codebase.

// The personalization variables the Existing Client Outreach compose UI
// (crm/public/app/client.html's reconnectionModal, clients.html's
// bulkSendModal) actually substitutes before display/send -- shown in the
// Template Manager so Loretta knows what's safe to insert. Kept in sync by
// inspection with those two files' own substituted()/substitute() helpers.
const SUPPORTED_VARIABLES = [
  { token: '{{First Name}}', stored: '{{first_name}}', description: "The client's first name (falls back to \"there\" if missing)." },
  { token: '{{Office Phone}}', stored: '{{office_phone}}', description: "Loretta's Prosperity office/text number." },
  { token: '{{Booking Link}}', stored: '{{booking_link}}', description: "Loretta's Prosperity Life Insurance Cal.com booking link." },
];

function staticTemplateKeys() {
  return new Set([...EXISTING_CLIENT_SMS_TEMPLATES, ...EXISTING_CLIENT_EMAIL_TEMPLATES].map(t => t.templateKey));
}

// The full, unified, editable view: every SMS/email template currently
// offered in Existing Client Outreach's Template dropdowns, each tagged
// with its channel and whether it's an original built-in template or one
// created here. Reuses getReconnectionTemplates' own override-aware
// resolution, so this list always matches exactly what the composer
// dropdowns show.
function listManagedTemplates(db) {
  const { smsTemplates, emailTemplates } = getReconnectionTemplates(db);
  const staticKeys = staticTemplateKeys();
  return [
    ...smsTemplates.map(t => ({ ...t, channel: 'sms', builtIn: staticKeys.has(t.templateKey) })),
    ...emailTemplates.map(t => ({ ...t, channel: 'email', builtIn: staticKeys.has(t.templateKey) })),
  ];
}

function getManagedTemplate(db, templateKey, channel) {
  return listManagedTemplates(db).find(t => t.templateKey === templateKey && t.channel === channel) || null;
}

// Generates a fresh, guaranteed-unique template_key for a brand-new
// template -- checked against both the built-in registries and every
// existing crm_templates row, so a new template can never collide with or
// silently overwrite another one, no matter how similar its display name.
function generateTemplateKey(db, label) {
  const base = ('custom' + String(label || 'Template').replace(/[^a-zA-Z0-9]+/g, '')) || 'customTemplate';
  const taken = staticTemplateKeys();
  for (const row of db.prepare('SELECT template_key FROM crm_templates').all()) taken.add(row.template_key);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

function validateFields(channel, { label, body, subject }) {
  if (!toStringOrNull(label)) throw new Error('templateManagerService: a template name is required');
  if (!toStringOrNull(body)) throw new Error('templateManagerService: a message/body is required');
  if (channel === 'email' && !toStringOrNull(subject)) throw new Error('templateManagerService: an email subject is required');
}

// Updates an EXISTING template (built-in or custom) -- upserts an override
// row keyed by template_key/brand_id. Never accepts or touches template_key
// itself; sms_message_type is always derived from the template's own
// registry entry (or, once set, preserved), never client-supplied, so a
// rename/reword can never change what a send is deduped/counted against.
function updateTemplate(db, { templateKey, channel, label, subject, body }) {
  if (!['sms', 'email'].includes(channel)) throw new Error(`templateManagerService: unknown channel '${channel}'`);
  const existing = getManagedTemplate(db, templateKey, channel);
  if (!existing) throw new Error(`templateManagerService: unknown template '${templateKey}' (${channel})`);
  validateFields(channel, { label, body, subject });

  const registryEntry = (channel === 'sms' ? getSmsTemplateRegistry(db) : getEmailTemplateRegistry(db)).find(t => t.templateKey === templateKey);
  const smsMessageType = channel === 'sms' ? (registryEntry.smsMessageType || templateKey) : null;

  db.prepare(`
    INSERT INTO crm_templates (template_key, brand_id, channel, label, subject, body, sms_message_type)
    VALUES (@template_key, @brand_id, @channel, @label, @subject, @body, @sms_message_type)
    ON CONFLICT(template_key, brand_id) DO UPDATE SET
      label = excluded.label, subject = excluded.subject, body = excluded.body,
      sms_message_type = COALESCE(crm_templates.sms_message_type, excluded.sms_message_type),
      updated_at = CURRENT_TIMESTAMP
  `).run({
    template_key: templateKey, brand_id: BRAND_ID, channel,
    label: toStringOrNull(label), subject: channel === 'email' ? toStringOrNull(subject) : null,
    body: toStringOrNull(body), sms_message_type: smsMessageType,
  });
  return getManagedTemplate(db, templateKey, channel);
}

// Creates a genuinely NEW template with its own fresh template_key --
// appears in the appropriate Existing Client Outreach dropdown immediately
// (getSmsTemplateRegistry/getEmailTemplateRegistry pick up any crm_templates
// row not already in the built-in registries), without any code change.
function createTemplate(db, { channel, label, subject, body }) {
  if (!['sms', 'email'].includes(channel)) throw new Error(`templateManagerService: unknown channel '${channel}'`);
  validateFields(channel, { label, body, subject });

  const templateKey = generateTemplateKey(db, label);
  const smsMessageType = channel === 'sms' ? templateKey : null;
  db.prepare(`
    INSERT INTO crm_templates (template_key, brand_id, channel, label, subject, body, sms_message_type)
    VALUES (@template_key, @brand_id, @channel, @label, @subject, @body, @sms_message_type)
  `).run({
    template_key: templateKey, brand_id: BRAND_ID, channel,
    label: toStringOrNull(label), subject: channel === 'email' ? toStringOrNull(subject) : null,
    body: toStringOrNull(body), sms_message_type: smsMessageType,
  });
  return getManagedTemplate(db, templateKey, channel);
}

module.exports = {
  SUPPORTED_VARIABLES,
  listManagedTemplates,
  getManagedTemplate,
  updateTemplate,
  createTemplate,
};
