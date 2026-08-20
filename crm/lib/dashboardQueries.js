// Read-only query helpers for the local dashboard preview. Every function
// takes an explicit better-sqlite3 `db` handle — never opens a connection
// itself, never imports crm/db/database.js. Brand DISPLAY identity (short
// name, phone, etc.) is resolved via crm/config/brands.js — the single
// source of truth from Checkpoint C — never duplicated here.

const { publicBrandIdentity } = require('../config/brands');

function contactDisplayName(contact) {
  const name = [contact.first_name, contact.last_name].filter(Boolean).join(' ').trim();
  return name || 'Unknown';
}

// SQLite's CURRENT_TIMESTAMP produces 'YYYY-MM-DD HH:MM:SS' (UTC, no
// timezone marker). Normalize every timestamp this module emits to a real
// ISO-8601 UTC string so downstream formatting (friendly dates/times) never
// has to guess which of the two shapes a given value is in.
function toIsoUtc(ts) {
  if (!ts) return null;
  if (ts.includes('T')) return ts.endsWith('Z') ? ts : `${ts}Z`;
  return `${ts.replace(' ', 'T')}Z`;
}

// ── Case list ────────────────────────────────────────────────────────────

// Every table below already carries a nullable case_id column (added
// additively in Checkpoint B). "Last activity" is the most recent
// timestamp found for a case across ALL of these sources, not just
// cases.updated_at — so a call, text, email, note, task, or appointment
// change all count as activity, matching how a person would actually judge
// "when did something last happen on this case."
const LAST_ACTIVITY_SOURCES = [
  { table: 'communications',  column: 'created_at' },
  { table: 'comm_calls',      column: 'created_at' },
  { table: 'sms_messages',    column: 'sent_at' },
  { table: 'emails',          column: 'sent_at' },
  { table: 'contact_notes',   column: 'created_at' },
  { table: 'follow_up_tasks', column: 'COALESCE(completed_at, created_at)' },
  { table: 'appointments',    column: 'updated_at' },
  // cases.updated_at itself is folded in separately as the baseline, since
  // it's already selected on the primary case-list query.
];

// One query per source table (batched across every case id being
// displayed), not one query per case — ready for a real-sized dataset.
function batchLastActivity(db, caseIds) {
  const latest = new Map();
  if (!caseIds.length) return latest;
  const placeholders = caseIds.map(() => '?').join(',');
  for (const { table, column } of LAST_ACTIVITY_SOURCES) {
    const rows = db.prepare(`
      SELECT case_id, MAX(${column}) AS ts
      FROM ${table}
      WHERE case_id IN (${placeholders})
      GROUP BY case_id
    `).all(...caseIds);
    for (const r of rows) {
      if (!r.ts) continue;
      const iso = toIsoUtc(r.ts);
      const prev = latest.get(r.case_id);
      if (!prev || iso > prev) latest.set(r.case_id, iso);
    }
  }
  return latest;
}

// Earliest pending follow-up task per case, batched in a single query
// (previously one query per case) — grouped down to one row per case in JS.
function batchNextActions(db, caseIds) {
  const next = new Map();
  if (!caseIds.length) return next;
  const placeholders = caseIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT case_id, task_type, notes, due_date, due_time
    FROM follow_up_tasks
    WHERE case_id IN (${placeholders}) AND status = 'Pending'
    ORDER BY case_id, due_date ASC, due_time ASC
  `).all(...caseIds);
  for (const r of rows) {
    if (!next.has(r.case_id)) next.set(r.case_id, r); // first row per case_id = earliest due, thanks to ORDER BY
  }
  return next;
}

// statusFilter: 'active' (default, excludes Archived) | 'archived' | 'all'
// brandId: null/'all' for All Brands, or a brand slug to filter to one brand.
// search: matched against contact name, phone, phone_e164, email, and
//   product name (case-insensitive substring). Never reads or matches
//   against anything on `contacts` that would imply a brand — the search
//   clause and the brand clause are independent conditions on the same
//   already-joined row, never merged into a single "brand field."
// page/pageSize: pagination is BY PERSON, not by case — every case
//   belonging to a page's contact is returned together, and pageSize caps
//   how many *contacts* (not case rows) appear per page. All of this is
//   pushed into SQL (WHERE/LIMIT/OFFSET) — the whole contacts table is
//   never loaded into memory just to filter/paginate it in JS.
//
// Returns { contacts: [{ contactId, contactName, cases: [...], activeCaseCount,
//   brandIds, nearestDueDate, nearestDueOverdue }], pagination: {...} }
function getCaseList(db, { brandId = null, statusFilter = 'active', search = '', page = 1, pageSize = 25 } = {}) {
  const clauses = [];
  const params = [];

  if (brandId && brandId !== 'all') {
    clauses.push('b.slug = ?');
    params.push(brandId);
  }
  if (statusFilter === 'active') clauses.push("c.status != 'Archived'");
  else if (statusFilter === 'archived') clauses.push("c.status = 'Archived'");
  // 'all' adds no status clause

  const trimmedSearch = (search || '').trim();
  if (trimmedSearch) {
    const like = `%${trimmedSearch.replace(/[%_]/g, ch => `\\${ch}`)}%`;
    clauses.push(`(
      (ct.first_name || ' ' || ct.last_name) LIKE ? ESCAPE '\\' OR
      ct.first_name LIKE ? ESCAPE '\\' OR ct.last_name LIKE ? ESCAPE '\\' OR
      ct.phone LIKE ? ESCAPE '\\' OR ct.phone_e164 LIKE ? ESCAPE '\\' OR
      ct.email LIKE ? ESCAPE '\\' OR
      p.name LIKE ? ESCAPE '\\'
    )`);
    params.push(like, like, like, like, like, like, like);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const totalRow = db.prepare(`
    SELECT COUNT(DISTINCT ct.id) AS n
    FROM cases c
    JOIN contact_brands cb ON cb.id = c.contact_brand_id
    JOIN contacts ct       ON ct.id = cb.contact_id
    JOIN brands b           ON b.id = cb.brand_id
    LEFT JOIN products p    ON p.id = c.product_id
    ${where}
  `).get(...params);
  const totalContacts = totalRow.n;
  const totalPages = Math.max(1, Math.ceil(totalContacts / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * pageSize;

  const pageContacts = db.prepare(`
    SELECT DISTINCT ct.id AS contact_id, ct.first_name, ct.last_name
    FROM cases c
    JOIN contact_brands cb ON cb.id = c.contact_brand_id
    JOIN contacts ct       ON ct.id = cb.contact_id
    JOIN brands b           ON b.id = cb.brand_id
    LEFT JOIN products p    ON p.id = c.product_id
    ${where}
    ORDER BY ct.last_name COLLATE NOCASE, ct.first_name COLLATE NOCASE, ct.id
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, offset);

  const emptyPagination = { page: safePage, pageSize, totalContacts, totalPages, rangeStart: 0, rangeEnd: 0 };
  if (!pageContacts.length) return { contacts: [], pagination: emptyPagination };

  // Re-fetch every qualifying CASE for exactly this page's contacts — same
  // brand/status filter, but no search clause (a contact already earned its
  // spot on the page; every case of theirs that also matches brand/status
  // shows, not only the one that happened to match the search text — this
  // is what keeps "all of a person's cases together").
  const contactIds = pageContacts.map(c => c.contact_id);
  const idPlaceholders = contactIds.map(() => '?').join(',');
  const caseClauses = [`ct.id IN (${idPlaceholders})`];
  const caseParams = [...contactIds];
  if (brandId && brandId !== 'all') { caseClauses.push('b.slug = ?'); caseParams.push(brandId); }
  if (statusFilter === 'active') caseClauses.push("c.status != 'Archived'");
  else if (statusFilter === 'archived') caseClauses.push("c.status = 'Archived'");

  const rows = db.prepare(`
    SELECT
      c.id AS case_id, ct.id AS contact_id, ct.first_name, ct.last_name,
      b.slug AS brand_id, p.name AS product_name, c.status AS case_status, c.updated_at AS case_updated_at
    FROM cases c
    JOIN contact_brands cb ON cb.id = c.contact_brand_id
    JOIN contacts ct       ON ct.id = cb.contact_id
    JOIN brands b           ON b.id = cb.brand_id
    LEFT JOIN products p    ON p.id = c.product_id
    WHERE ${caseClauses.join(' AND ')}
    ORDER BY ct.last_name COLLATE NOCASE, ct.first_name COLLATE NOCASE, ct.id, c.id
  `).all(...caseParams);

  const caseIds = rows.map(r => r.case_id);
  const nextActions = batchNextActions(db, caseIds);
  const lastActivities = batchLastActivity(db, caseIds);

  const contactsMap = new Map();
  for (const row of rows) {
    const brand = publicBrandIdentity(row.brand_id);
    const nextAction = nextActions.get(row.case_id) || null;
    const baseline = toIsoUtc(row.case_updated_at);
    const fromSources = lastActivities.get(row.case_id) || null;
    const lastActivity = fromSources && fromSources > baseline ? fromSources : baseline;
    const caseObj = {
      caseId: row.case_id,
      brandId: row.brand_id,
      brandShortName: brand ? brand.shortName : row.brand_id,
      productName: row.product_name || null,
      caseStatus: row.case_status,
      nextAction: nextAction ? { taskType: nextAction.task_type, notes: nextAction.notes, dueDate: nextAction.due_date, dueTime: nextAction.due_time } : null,
      dueDate: nextAction ? nextAction.due_date : null,
      lastActivity,
    };
    if (!contactsMap.has(row.contact_id)) {
      contactsMap.set(row.contact_id, { contactId: row.contact_id, contactName: contactDisplayName(row), cases: [] });
    }
    contactsMap.get(row.contact_id).cases.push(caseObj);
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const contactsOut = pageContacts.map(pc => {
    const entry = contactsMap.get(pc.contact_id) || { contactId: pc.contact_id, contactName: contactDisplayName(pc), cases: [] };
    const activeCaseCount = entry.cases.filter(c => c.caseStatus !== 'Archived').length;
    const brandIds = [...new Set(entry.cases.map(c => c.brandId))];
    const dueCases = entry.cases.filter(c => c.dueDate).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
    const nearestDueDate = dueCases.length ? dueCases[0].dueDate : null;
    const nearestDueOverdue = nearestDueDate ? nearestDueDate < todayStr : false;
    return { ...entry, activeCaseCount, brandIds, nearestDueDate, nearestDueOverdue };
  });

  return {
    contacts: contactsOut,
    pagination: { page: safePage, pageSize, totalContacts, totalPages, rangeStart: offset + 1, rangeEnd: offset + contactsOut.length },
  };
}

// ── Brand Review Required ───────────────────────────────────────────────────

const FIELD_LABELS = { email: 'Email', phone: 'Phone', lead_type: 'Inquiry type', lead_source: 'How they reached us' };
const SOURCE_LABELS = {
  fake_webform: 'Website Form', website_form: 'Website Form',
  fake_inbound_call: 'Inbound Phone Call', inbound_call: 'Inbound Phone Call',
  inbound_sms: 'Inbound Text Message', calcom_webhook: 'Online Booking',
};
function friendlySourceLabel(source) {
  if (SOURCE_LABELS[source]) return SOURCE_LABELS[source];
  return String(source || 'Unknown').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
function friendlyBrandReviewReason(reason) {
  if (!reason) return 'We could not automatically match this inquiry to either business.';
  if (/no recognized/i.test(reason)) return 'We could not automatically match this inquiry to either business — nothing about how it came in matched a known pattern for either one.';
  return reason;
}

function summarizeIntakeEvidence(rawPayloadJson) {
  let payload = {};
  try { payload = JSON.parse(rawPayloadJson || '{}'); } catch { payload = {}; }
  const evidence = [];
  const name = [payload.first_name, payload.last_name].filter(Boolean).join(' ');
  if (name) evidence.push(`Name: ${name}`);
  for (const field of ['email', 'phone', 'lead_type', 'lead_source']) {
    if (payload[field]) evidence.push(`${FIELD_LABELS[field]}: ${payload[field]}`);
  }
  return { payload, evidence };
}

function getBrandReviewQueue(db) {
  const rows = db.prepare(`
    SELECT * FROM unresolved_intake
    WHERE review_type = 'brand' AND status = 'Pending'
    ORDER BY created_at ASC
  `).all();

  return rows.map(row => {
    const { payload, evidence } = summarizeIntakeEvidence(row.raw_payload);
    const identifier = [payload.first_name, payload.last_name].filter(Boolean).join(' ')
      || payload.email || payload.phone || `Unidentified inquiry #${row.id}`;
    return {
      intakeId: row.id,
      identifier,
      receivedDate: toIsoUtc(row.created_at),
      channelLabel: friendlySourceLabel(row.source),
      evidence,
      reason: friendlyBrandReviewReason(row.reason),
    };
  });
}

// ── Case Review Required ────────────────────────────────────────────────────

function getOpenCasesForContactBrand(db, contactBrandId) {
  return db.prepare(`
    SELECT c.id AS case_id, p.name AS product_name, c.title, c.opened_at
    FROM cases c
    LEFT JOIN products p ON p.id = c.product_id
    WHERE c.contact_brand_id = ? AND c.status = 'Open'
    ORDER BY c.opened_at DESC
  `).all(contactBrandId).map(c => ({
    caseId: c.case_id,
    // Descriptive label first — product name if we have one, else the
    // case's own title, else a generic label. The database id is kept
    // separately for an optional technical-details disclosure only.
    label: c.product_name || c.title || `Case #${c.case_id}`,
    openedAt: toIsoUtc(c.opened_at),
  }));
}

function friendlyCaseReviewReason(reason) {
  if (!reason) return 'We know who this is and which business it belongs to, but not which case it concerns.';
  if (/reschedule references unknown prior booking/i.test(reason)) return 'This looks like a reschedule, but we could not find the original booking to match it to.';
  if (/cancellation references unknown booking/i.test(reason)) return 'This looks like a cancellation, but we could not find the original booking to match it to.';
  if (/no product\/service category/i.test(reason)) return 'We know who this is and which business it belongs to, but not which product or service it concerns.';
  return reason;
}

function getCaseReviewQueue(db) {
  const rows = db.prepare(`
    SELECT * FROM unresolved_intake
    WHERE review_type = 'case' AND status = 'Pending'
    ORDER BY created_at ASC
  `).all();

  return rows.map(row => {
    let contactName = null, brandShortName = null, brandId = null;
    if (row.contact_brand_id) {
      const link = db.prepare(`
        SELECT ct.first_name, ct.last_name, b.slug AS brand_id
        FROM contact_brands cb
        JOIN contacts ct ON ct.id = cb.contact_id
        JOIN brands b     ON b.id = cb.brand_id
        WHERE cb.id = ?
      `).get(row.contact_brand_id);
      if (link) {
        contactName = contactDisplayName(link);
        brandId = link.brand_id;
        const brand = publicBrandIdentity(link.brand_id);
        brandShortName = brand ? brand.shortName : link.brand_id;
      }
    }
    const product = row.product_id ? db.prepare('SELECT name FROM products WHERE id = ?').get(row.product_id) : null;
    const candidateCases = row.contact_brand_id ? getOpenCasesForContactBrand(db, row.contact_brand_id) : [];

    return {
      intakeId: row.id,
      contactName,
      brandId,
      brandShortName,
      productName: product ? product.name : null,
      receivedDate: toIsoUtc(row.created_at),
      channelLabel: friendlySourceLabel(row.source),
      reason: friendlyCaseReviewReason(row.reason),
      candidateCases,
      // Kept for an optional "Technical details" disclosure only — never
      // shown as the primary label in the UI.
      technicalDetails: { refType: row.ref_type, refValue: row.ref_value, rawReason: row.reason },
    };
  });
}

// ── Message delivery status ─────────────────────────────────────────────────

function normalizeMessageStatus(raw) {
  const s = (raw || '').toLowerCase();
  if (['queued', 'sending', 'accepted'].includes(s)) return 'Queued';
  if (s === 'sent') return 'Sent';
  if (s === 'delivered') return 'Delivered';
  if (['failed', 'undelivered'].includes(s)) return 'Failed';
  return 'Queued';
}

// SMS failures store their detail inside sms_messages.body itself, prefixed
// "[FAILED] ..." (see crm/routes/twilio.js sendMissedCallSms) — there is no
// separate error/reason column in the schema. Emails have no equivalent
// stored detail at all. Never returns provider credentials or a raw API
// response — only ever this app's own stored text.
function extractFailureReason(channel, status, body) {
  if (normalizeMessageStatus(status) !== 'Failed') return null;
  if (channel === 'sms' && body && body.startsWith('[FAILED]')) {
    const match = body.match(/^\[FAILED\]\s*([\s\S]+?)(?:\n\n|$)/);
    return match ? match[1].trim() : 'No further detail is stored for this message.';
  }
  return 'No further detail is stored for this message.';
}

function getMessageDeliveryStatus(db, { brandId = null } = {}) {
  const smsRows = db.prepare(`
    SELECT 'sms' AS channel, id, to_number AS recipient, status, body, sent_at AS timestamp, contact_brand_id, case_id
    FROM sms_messages
  `).all();
  const emailRows = db.prepare(`
    SELECT 'email' AS channel, id, to_email AS recipient, status, NULL AS body, sent_at AS timestamp, contact_brand_id, case_id
    FROM emails
  `).all();

  const caseStmt = db.prepare('SELECT c.title, p.name AS product_name FROM cases c LEFT JOIN products p ON p.id = c.product_id WHERE c.id = ?');
  const contactBrandStmt = db.prepare('SELECT slug FROM brands b JOIN contact_brands cb ON cb.brand_id = b.id WHERE cb.id = ?');

  const all = [...smsRows, ...emailRows].map(row => {
    let rowBrandId = null;
    if (row.contact_brand_id) {
      const b = contactBrandStmt.get(row.contact_brand_id);
      rowBrandId = b ? b.slug : null;
    }
    const brand = rowBrandId ? publicBrandIdentity(rowBrandId) : null;
    const relatedCase = row.case_id ? caseStmt.get(row.case_id) : null;
    const status = normalizeMessageStatus(row.status);
    return {
      id: row.id,
      channel: row.channel,
      recipient: row.recipient,
      status,
      failureReason: status === 'Failed' ? extractFailureReason(row.channel, row.status, row.body) : null,
      timestamp: toIsoUtc(row.timestamp),
      brandId: rowBrandId,
      brandShortName: brand ? brand.shortName : null,
      relatedCase: relatedCase ? (relatedCase.title || relatedCase.product_name || null) : null,
    };
  });

  const filtered = brandId && brandId !== 'all' ? all.filter(r => r.brandId === brandId) : all;
  return filtered.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

module.exports = {
  getCaseList,
  getBrandReviewQueue,
  getCaseReviewQueue,
  getOpenCasesForContactBrand,
  getMessageDeliveryStatus,
  normalizeMessageStatus,
};
