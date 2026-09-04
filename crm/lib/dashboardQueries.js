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
  { table: 'activities',      column: 'COALESCE(updated_at, activity_at)' },
  // cases.updated_at itself is folded in separately as the baseline, since
  // it's already selected on the primary case-list query.
];

// activities (crm/db/migrateCrmCore.js) is a newer, optional table — many
// existing callers/tests build a db that never ran that migration. Checked
// dynamically (not assumed present) so every source below keeps working
// unmodified against every already-approved db shape.
function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

// comm_calls.outcome/summary (crm/db/migrateRevenueMvp.js) are newer,
// optional columns — many existing callers/tests build a db that never ran
// that migration. Checked dynamically so every source below keeps working
// unmodified against every already-approved db shape (same pattern as
// tableExists() above).
function columnExists(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
}

// One query per source table (batched across every case id being
// displayed), not one query per case — ready for a real-sized dataset.
function batchLastActivity(db, caseIds) {
  const latest = new Map();
  if (!caseIds.length) return latest;
  const placeholders = caseIds.map(() => '?').join(',');
  for (const { table, column } of LAST_ACTIVITY_SOURCES) {
    if (!tableExists(db, table)) continue;
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
// DB-level ORDER BY for the client list. 'name' is a plain column sort.
// 'dueDate'/'nextAction' order by each contact's nearest PENDING task due
// date (correlated subquery — contacts with no pending task sort last).
// 'lastActivity' orders by each contact's most recent case.updated_at
// (a reasonable, indexable proxy for full activity recency — the complete
// multi-source "last activity" shown on each case, via batchLastActivity,
// still reflects every source; only the SORT key uses this cheaper proxy).
function buildClientListOrderBy(sort) {
  const dueDateExpr = `(
    SELECT MIN(t.due_date) FROM follow_up_tasks t
    JOIN cases cc ON cc.id = t.case_id
    JOIN contact_brands ccb ON ccb.id = cc.contact_brand_id
    WHERE ccb.contact_id = ct.id AND t.status = 'Pending'
  )`;
  const lastActivityExpr = `(
    SELECT MAX(cc.updated_at) FROM cases cc
    JOIN contact_brands ccb ON ccb.id = cc.contact_brand_id
    WHERE ccb.contact_id = ct.id
  )`;
  if (sort === 'dueDate' || sort === 'nextAction') {
    return `${dueDateExpr} IS NULL, ${dueDateExpr} ASC, ct.last_name COLLATE NOCASE, ct.first_name COLLATE NOCASE, ct.id`;
  }
  if (sort === 'lastActivity') {
    return `${lastActivityExpr} IS NULL, ${lastActivityExpr} DESC, ct.last_name COLLATE NOCASE, ct.first_name COLLATE NOCASE, ct.id`;
  }
  // A blank/missing last_name (empty string, not just NULL -- e.g. a
  // contact entered with only a first name) sorts BEFORE every real value
  // under plain COLLATE NOCASE, since '' < any non-empty string -- putting
  // such contacts at the very top of an "alphabetical by last name" list
  // instead of the bottom, where a person reading it would expect them.
  // The leading boolean expression (0 = has a last name, 1 = blank) sorts
  // ascending, so real last names always come first; last_name/first_name
  // remain the actual sort keys for everyone else.
  return `(ct.last_name IS NULL OR ct.last_name = ''), ct.last_name COLLATE NOCASE, ct.first_name COLLATE NOCASE, ct.id`;
}

function getCaseList(db, { brandId = null, statusFilter = 'active', search = '', page = 1, pageSize = 25, sort = 'name' } = {}) {
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
    ORDER BY ${buildClientListOrderBy(sort)}
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

// ── Company-Assignment Conflicts ────────────────────────────────────────────
// See crm/lib/leadIntake.js (permanent-company rule) and
// crm/db/migrateCrmApp.js (incoming_brand_id column).

function friendlyCompanyConflictReason() {
  return 'This person already has an active relationship with one company. A new inquiry verified as coming from the other company was NOT automatically linked — review and choose how to proceed.';
}

// Surfaces BOTH automatically-detected conflicts (review_type
// 'company_conflict', staged by crm/lib/leadIntake.js) and manually
// requested changes (review_type 'company_change', staged by
// crm/lib/clientService.js's requestCompanyChange) in one queue — they
// share the same existing-vs-incoming shape and the same resolution
// actions (crm/lib/reviewResolution.js's resolveCompanyConflict). Each
// item's `kind` field tells the frontend which one it is, so a manual
// request is never mislabeled as something the system caught on its own.
function getCompanyConflictQueue(db) {
  const rows = db.prepare(`
    SELECT * FROM unresolved_intake
    WHERE review_type IN ('company_conflict', 'company_change') AND status = 'Pending'
    ORDER BY created_at ASC
  `).all();

  return rows.map(row => {
    let contactName = null;
    let existingBrandId = null, existingBrandShortName = null;
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
        existingBrandId = link.brand_id;
        const brand = publicBrandIdentity(link.brand_id);
        existingBrandShortName = brand ? brand.shortName : link.brand_id;
      }
    }
    let incomingBrandId = null, incomingBrandShortName = null;
    if (row.incoming_brand_id) {
      const b = db.prepare('SELECT slug FROM brands WHERE id = ?').get(row.incoming_brand_id);
      if (b) {
        incomingBrandId = b.slug;
        const brand = publicBrandIdentity(b.slug);
        incomingBrandShortName = brand ? brand.shortName : b.slug;
      }
    }
    const { evidence } = summarizeIntakeEvidence(row.raw_payload);

    return {
      intakeId: row.id,
      kind: row.review_type, // 'company_conflict' (auto-detected) | 'company_change' (manually requested)
      contactName,
      existingBrandId, existingBrandShortName,
      incomingBrandId, incomingBrandShortName,
      receivedDate: toIsoUtc(row.created_at),
      channelLabel: friendlySourceLabel(row.source),
      evidence,
      reason: row.review_type === 'company_change' ? row.reason : friendlyCompanyConflictReason(),
      technicalDetails: { refType: row.ref_type, refValue: row.ref_value, rawReason: row.reason },
    };
  });
}

// ── Contact Verification Needed ─────────────────────────────────────────────
// A Cal.com booking whose email matched an existing contact but whose phone
// didn't (or vice versa) — crm/routes/calcom.js's matchContactForBooking /
// stageContactMatchReview. Never auto-merged: a genuinely new contact was
// already created from the incoming booking's own data, and this queue item
// is only Loretta's evidence for deciding by hand whether that's the same
// person with updated info or a different person who happens to share one
// identifier. Read-only; resolving one is
// crm/lib/reviewResolution.js's resolveContactConflict.
function friendlyContactConflictReason(row) {
  if (row.reason) return row.reason;
  return 'Possible existing contact — one identifier matches, the other does not. Verify identity before merging or updating.';
}

function getContactConflictQueue(db) {
  const rows = db.prepare(`
    SELECT * FROM unresolved_intake
    WHERE review_type = 'contact_conflict' AND status = 'Pending'
    ORDER BY created_at ASC
  `).all();

  return rows.map(row => {
    let payload = {};
    try { payload = JSON.parse(row.raw_payload || '{}'); } catch { payload = {}; }
    const existingRow = row.candidate_contact_id
      ? db.prepare('SELECT id, first_name, last_name, email, phone FROM contacts WHERE id = ?').get(row.candidate_contact_id)
      : null;
    // Always prefer the live contacts row for the EXISTING contact (it may
    // have changed since this was staged); the INCOMING booking's values
    // are a point-in-time snapshot by nature and always come from the
    // staged payload.
    const existing = existingRow
      ? { contactId: existingRow.id, name: contactDisplayName(existingRow), email: existingRow.email, phone: existingRow.phone }
      : { contactId: row.candidate_contact_id, name: contactDisplayName(payload.existing || {}), email: payload.existing?.email || null, phone: payload.existing?.phone || null };
    const incoming = {
      contactId: payload.new_contact_id || null,
      name: contactDisplayName(payload.incoming || {}),
      email: payload.incoming?.email || null,
      phone: payload.incoming?.phone || null,
    };

    return {
      intakeId: row.id,
      conflictType: payload.conflict_type || null,
      nameMismatch: !!payload.name_mismatch,
      existing,
      incoming,
      receivedDate: toIsoUtc(row.created_at),
      channelLabel: friendlySourceLabel(row.source),
      reason: friendlyContactConflictReason(row),
      technicalDetails: { calBookingUid: payload.cal_booking_uid || null },
    };
  });
}

// Inbound texts to the Prosperity number that couldn't be matched to
// exactly one active Prosperity client (crm/lib/inboundSmsService.js) —
// Prosperity Revenue MVP, Requirement 3 ("route unknown or ambiguous
// numbers to Review Required"). Read-only; resolving one is
// crm/lib/reviewResolution.js's resolveUnknownSmsReview.
function getUnknownSmsReviewQueue(db) {
  const rows = db.prepare(`
    SELECT * FROM unresolved_intake WHERE review_type = 'unknown_sms_sender' AND status = 'Pending' ORDER BY created_at ASC
  `).all();
  return rows.map(row => {
    let payload = {};
    try { payload = JSON.parse(row.raw_payload || '{}'); } catch { payload = {}; }
    return {
      intakeId: row.id,
      fromNumber: payload.From || null,
      toNumber: payload.To || null,
      body: payload.Body || null,
      messageSid: payload.MessageSid || null,
      receivedDate: toIsoUtc(row.created_at),
      reason: row.reason,
    };
  });
}

// ── Client detail ───────────────────────────────────────────────────────────
// Full record for one contact: identity, every contact_brand relationship
// (a contact may historically have more than one — see the permanent-
// company rule for how a SECOND one is now prevented from being created
// silently going forward), every case under each, tasks, appointments,
// communications, notes. Read-only; never selects a sender, never triggers
// anything.

// Real audit entries only — when each company relationship was established,
// and every unresolved_intake decision (pending or resolved) tied to this
// contact, exactly as recorded by crm/lib/reviewResolution.js. Never
// fabricates an event that didn't actually happen.
function getClientAuditHistory(db, contactId, brandLinks) {
  const entries = brandLinks.map(link => {
    const brand = publicBrandIdentity(link.brand_id);
    return {
      type: 'company_established',
      label: `Company assignment established: ${brand ? brand.shortName : link.brand_id}`,
      timestamp: toIsoUtc(link.created_at),
    };
  });

  const intakeRows = db.prepare(`
    SELECT * FROM unresolved_intake WHERE candidate_contact_id = ? ORDER BY created_at ASC
  `).all(contactId);

  for (const row of intakeRows) {
    entries.push({
      type: 'intake_staged',
      label: `Staged for review (${row.review_type.replace('_', ' ')}): ${row.reason}`,
      timestamp: toIsoUtc(row.created_at),
    });
    if (row.status !== 'Pending') {
      entries.push({
        type: 'intake_resolved',
        label: `Review resolved — decision: ${row.decision || row.status}${row.resolved_by ? ` (by ${row.resolved_by})` : ''}`,
        timestamp: toIsoUtc(row.resolved_at),
      });
    }
  }

  return entries.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
}

function getClientDetail(db, contactId) {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!contact) return null;

  const brandLinks = db.prepare(`
    SELECT cb.id AS contact_brand_id, cb.status, cb.created_at, b.slug AS brand_id
    FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id
    WHERE cb.contact_id = ?
    ORDER BY cb.created_at ASC
  `).all(contactId);

  const contactBrands = brandLinks.map(link => {
    const brand = publicBrandIdentity(link.brand_id);
    const caseRows = db.prepare(`
      SELECT c.id AS case_id, c.status, c.title, c.opened_at, c.closed_at, c.updated_at, p.name AS product_name
      FROM cases c LEFT JOIN products p ON p.id = c.product_id
      WHERE c.contact_brand_id = ?
      ORDER BY c.opened_at DESC
    `).all(link.contact_brand_id);

    const caseIds = caseRows.map(c => c.case_id);
    const nextActions = batchNextActions(db, caseIds);
    const lastActivities = batchLastActivity(db, caseIds);
    const policyStmt = db.prepare('SELECT * FROM policies WHERE case_id = ? ORDER BY id ASC');

    const cases = caseRows.map(c => {
      const nextAction = nextActions.get(c.case_id) || null;
      const baseline = toIsoUtc(c.updated_at);
      const fromSources = lastActivities.get(c.case_id) || null;
      return {
        caseId: c.case_id,
        status: c.status,
        title: c.title,
        productName: c.product_name,
        openedAt: toIsoUtc(c.opened_at),
        closedAt: toIsoUtc(c.closed_at),
        lastActivity: fromSources && fromSources > baseline ? fromSources : baseline,
        nextAction: nextAction ? { taskType: nextAction.task_type, notes: nextAction.notes, dueDate: nextAction.due_date, dueTime: nextAction.due_time } : null,
        policies: policyStmt.all(c.case_id),
      };
    });

    return {
      contactBrandId: link.contact_brand_id,
      brandId: link.brand_id,
      brandShortName: brand ? brand.shortName : link.brand_id,
      status: link.status,
      establishedAt: toIsoUtc(link.created_at),
      cases,
    };
  });

  const contactBrandIds = brandLinks.map(l => l.contact_brand_id);
  const idPh = contactBrandIds.length ? contactBrandIds.map(() => '?').join(',') : null;

  const tasks = idPh ? db.prepare(`
    SELECT * FROM follow_up_tasks WHERE contact_id = ? ORDER BY (status = 'Pending') DESC, due_date ASC, due_time ASC
  `).all(contactId) : [];

  const appointments = db.prepare('SELECT * FROM appointments WHERE contact_id = ? ORDER BY appt_datetime DESC').all(contactId);

  // activities (crm/db/migrateCrmCore.js) is optional/newer — only joined in
  // when the table actually exists, so this keeps working unmodified
  // against every already-approved (older) db shape.
  const activitiesUnion = tableExists(db, 'activities')
    ? `UNION ALL
       SELECT 'activity' AS channel, id, (activity_type || ': ' || COALESCE(summary, '')) AS summary, details AS body, NULL AS status, COALESCE(updated_at, activity_at) AS timestamp, contact_brand_id, case_id FROM activities WHERE contact_id = ? AND archived_at IS NULL`
    : '';
  const communicationsParams = [contactId, contactId, contactId, contactId];
  if (activitiesUnion) communicationsParams.push(contactId);

  const communications = db.prepare(`
    SELECT 'form' AS channel, id, subject AS summary, body, status, created_at AS timestamp, contact_brand_id, case_id FROM communications WHERE contact_id = ?
    UNION ALL
    SELECT 'call' AS channel, id, COALESCE(${columnExists(db, 'comm_calls', 'outcome') ? "outcome || ' — ' || summary, summary" : 'NULL'}, notes) AS summary, COALESCE(notes, transcription) AS body, status, COALESCE(started_at, created_at) AS timestamp, contact_brand_id, case_id FROM comm_calls WHERE contact_id = ?
    UNION ALL
    SELECT 'sms' AS channel, id, NULL AS summary, body, status, sent_at AS timestamp, contact_brand_id, case_id FROM sms_messages WHERE contact_id = ?
    UNION ALL
    SELECT 'email' AS channel, id, subject AS summary, body, status, sent_at AS timestamp, contact_brand_id, case_id FROM emails WHERE contact_id = ?
    ${activitiesUnion}
    ORDER BY timestamp DESC
  `).all(...communicationsParams).map(row => ({
    ...row,
    timestamp: toIsoUtc(row.timestamp),
    status: row.status ? normalizeMessageStatus(row.status) : row.status,
  }));

  // Legacy notes (contact_notes) are historical/read-only display records.
  // New notes created via crm/lib/activityService.js's addNote/editNote live
  // in `activities` (activity_type='note') so they can support real edit
  // audit history — see crm/lib/activityService.js. `source` tells the
  // frontend which id-space `id` belongs to (only 'activity' notes are
  // editable through /api/app/notes/:id).
  const legacyNotes = db.prepare('SELECT * FROM contact_notes WHERE contact_id = ? ORDER BY created_at DESC').all(contactId)
    .map(n => ({ id: n.id, source: 'legacy', body: n.body, created_at: toIsoUtc(n.created_at) }));
  const activityNotes = tableExists(db, 'activities')
    ? db.prepare(`SELECT * FROM activities WHERE contact_id = ? AND activity_type = 'note' AND archived_at IS NULL ORDER BY activity_at DESC`).all(contactId)
        .map(n => ({ id: n.id, source: 'activity', body: n.details, created_at: toIsoUtc(n.updated_at || n.activity_at) }))
    : [];
  const notes = [...legacyNotes, ...activityNotes].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  // Dedicated chronological text thread (Prosperity Revenue MVP,
  // Requirement 4) — full raw fields (direction/from/to/failure reason),
  // distinct from the mixed `communications` timeline above which only
  // carries a generic summary/body/status. SELECT * so this keeps working
  // against an older db that hasn't run crm/db/migrateRevenueMvp.js yet
  // (failure_reason just won't be present on each row).
  const smsThread = db.prepare('SELECT * FROM sms_messages WHERE contact_id = ? ORDER BY sent_at ASC, id ASC').all(contactId)
    .map(m => ({ ...m, sent_at: toIsoUtc(m.sent_at), status: normalizeMessageStatus(m.status) }));

  // Real call log (Twilio-tracked + manually logged) for this client, most
  // recent first — the dedicated Call Log UI reads this directly rather
  // than the mixed communications timeline's collapsed one-line summary.
  const callLog = db.prepare('SELECT * FROM comm_calls WHERE contact_id = ? ORDER BY COALESCE(started_at, created_at) DESC').all(contactId)
    .map(c => ({ ...c, started_at: c.started_at ? toIsoUtc(c.started_at) : null, created_at: toIsoUtc(c.created_at) }));

  // A pending 'contact_conflict' review item where THIS contact is the
  // newly-created, possibly-duplicate side (getContactConflictQueue's
  // incoming.contactId) -- never the existing side (candidate_contact_id),
  // matching the feature's own scope: only the auto-created contact needs a
  // "Verification Needed" warning, not the established record it was
  // compared against. null when this contact isn't currently flagged.
  const contactConflict = getContactConflictQueue(db).find(item => item.incoming.contactId === contactId) || null;

  return {
    contact: {
      contactId: contact.id,
      name: contactDisplayName(contact),
      firstName: contact.first_name,
      lastName: contact.last_name,
      middleName: contact.middle_name || null,
      email: contact.email,
      phone: contact.phone,
      phoneE164: contact.phone_e164,
      homePhone: contact.home_phone || null,
      altPhone: contact.alt_phone || null,
      preferredContactMethod: contact.preferred_contact_method || null,
      bestTimeToContact: contact.best_time_to_contact || null,
      address: contact.street_address || null,
      city: contact.city || null,
      state: contact.state || null,
      zip: contact.zip_code || null,
      dateOfBirth: contact.date_of_birth || null,
      age: contact.age ?? null,
      maritalStatus: contact.marital_status || null,
      spouseName: contact.spouse_name || null,
      spouseDateOfBirth: contact.spouse_date_of_birth || null,
      numberOfChildren: contact.number_of_children ?? null,
      numberOfGrandchildren: contact.number_of_grandchildren ?? null,
      familyNotes: contact.family_notes || null,
      occupation: contact.occupation || null,
      employer: contact.employer || null,
      referredBy: contact.referred_by || null,
      // Retirement planning (client-level; no dedicated Retirement Case
      // structure exists, so this stays here -- see clientService.js's
      // applyContactFields comment).
      retirementAccountType: contact.retirement_account_type || null,
      currentInstitution: contact.current_institution || null,
      estimatedRolloverAmount: contact.estimated_rollover_amount ?? null,
      retirementTimeline: contact.retirement_timeline || null,
      hasCurrentAdvisor: !!contact.has_current_advisor,
      interestedInRothConversion: !!contact.interested_in_roth_conversion,
      retirementDateGoal: contact.retirement_date_goal || null,
      // Annuity PLANNING fields with no `policies` table equivalent --
      // editable here. annuityCarrier/annuityPremium below ARE superseded
      // by a real Policy once one exists, so they're read-only/legacy only.
      annuityType: contact.annuity_type || null,
      estimatedIncome: contact.estimated_income ?? null,
      surrenderPeriod: contact.surrender_period || null,
      incomeRider: !!contact.income_rider,
      // Legacy, read-only: pre-Policies-module insurance/annuity data,
      // never written by any current code path (Cases/Policies -- see
      // crm/lib/policyService.js -- is the real system of record now) but
      // preserved and surfaced so old data already on a contact record is
      // never silently hidden. null for any contact created after Policies
      // existed.
      legacyInsurance: {
        insuranceCompany: contact.insurance_company || null,
        policyType: contact.policy_type || null,
        faceAmount: contact.face_amount ?? null,
        monthlyPremium: contact.monthly_premium ?? null,
        annualPremium: contact.annual_premium ?? null,
        policyStatus: contact.policy_status || null,
        applicationDate: contact.application_date || null,
        policyIssueDate: contact.policy_issue_date || null,
      },
      legacyAnnuity: {
        annuityCarrier: contact.annuity_carrier || null,
        annuityPremium: contact.annuity_premium ?? null,
      },
      originalSource: contact.lead_source || null,
      generalNotes: contact.general_notes || null,
      leadStatus: contact.lead_status,
      leadType: contact.lead_type || null,
      relationshipType: contact.relationship_type || null,
      smsConsent: !!contact.sms_consent,
      smsConsentSource: contact.sms_consent_source || null,
      smsConsentAt: contact.sms_consent_at ? toIsoUtc(contact.sms_consent_at) : null,
      smsConsentNotes: contact.sms_consent_notes || null,
      smsOptedOutAt: contact.sms_opted_out_at ? toIsoUtc(contact.sms_opted_out_at) : null,
      archivedAt: contact.archived_at ? toIsoUtc(contact.archived_at) : null,
    },
    contactBrands,
    contactConflict,
    tasks: tasks.map(t => ({ ...t, due_date: t.due_date, created_at: toIsoUtc(t.created_at) })),
    appointments: appointments.map(a => ({ ...a, appt_datetime: toIsoUtc(a.appt_datetime) })),
    communications,
    smsThread,
    callLog,
    notes,
    auditHistory: getClientAuditHistory(db, contactId, brandLinks),
  };
}

// ── Dashboard summary ───────────────────────────────────────────────────────
// Counts and a prioritized work list — never decorative metrics. brandId:
// null/'all' for All Companies, or a brand slug to scope everything to one
// company. Every count is derived from real rows, never invented.

function brandFilterClause(brandId, alias) {
  if (!brandId || brandId === 'all') return { clause: '', params: [] };
  return { clause: `AND ${alias}.slug = ?`, params: [brandId] };
}

function getDashboardSummary(db, { brandId = null } = {}) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const { clause: bClause, params: bParams } = brandFilterClause(brandId, 'b');

  const newLeads = db.prepare(`
    SELECT COUNT(*) AS n FROM unresolved_intake WHERE status = 'Pending' AND review_type = 'brand'
  `).get().n;

  const followUpsDue = db.prepare(`
    SELECT COUNT(*) AS n
    FROM follow_up_tasks t
    LEFT JOIN cases c ON c.id = t.case_id
    LEFT JOIN contact_brands cb ON cb.id = c.contact_brand_id
    LEFT JOIN brands b ON b.id = cb.brand_id
    WHERE t.status = 'Pending' AND t.due_date = ? ${bClause}
  `).get(todayStr, ...bParams).n;

  const overdueTasks = db.prepare(`
    SELECT COUNT(*) AS n
    FROM follow_up_tasks t
    LEFT JOIN cases c ON c.id = t.case_id
    LEFT JOIN contact_brands cb ON cb.id = c.contact_brand_id
    LEFT JOIN brands b ON b.id = cb.brand_id
    WHERE t.status = 'Pending' AND t.due_date < ? ${bClause}
  `).get(todayStr, ...bParams).n;

  const todaysAppointments = db.prepare(`
    SELECT COUNT(*) AS n FROM appointments a
    WHERE a.status = 'Scheduled' AND substr(a.appt_datetime, 1, 10) = ?
  `).get(todayStr).n;

  const casesInProgress = db.prepare(`
    SELECT COUNT(*) AS n FROM cases c
    JOIN contact_brands cb ON cb.id = c.contact_brand_id
    JOIN brands b ON b.id = cb.brand_id
    WHERE c.status = 'Open' ${bClause}
  `).get(...bParams).n;

  // Only UNRESOLVED failures -- a Failed communication Loretta has already
  // handled (resolveFailedCommunication) no longer needs her attention, so
  // it must not keep inflating this count even though the underlying
  // sms_messages/emails row (and its status='failed') is never deleted.
  const failedComms = getMessageDeliveryStatus(db, { brandId }).filter(m => m.status === 'Failed' && !m.resolvedAt).length;

  const reviewRequired =
    getBrandReviewQueue(db).length +
    getCaseReviewQueue(db).length +
    getCompanyConflictQueue(db).length;

  // Deliberately its own tile, not folded into reviewRequired above -- a
  // possible-duplicate contact needs Loretta's attention in a way that's
  // easy to miss inside a generic "Review Required" total (see
  // crm/public/app/review.html's 'contact_conflict' queue / dashboard.html).
  const verificationNeeded = getContactConflictQueue(db).length;

  return {
    newLeads, followUpsDue, overdueTasks,
    todaysAppointments, casesInProgress, failedComms, reviewRequired,
    verificationNeeded,
  };
}

// Deliberately narrow: only real, stored totals — clients by company,
// active cases by company, policies by company/status, tasks due/overdue,
// communication delivery status, and review-required totals. No projected
// commissions, renewal estimates, or lead-temperature scoring.
function getReportsSummary(db) {
  const clientsByCompany = db.prepare(`
    SELECT b.slug AS brand_id, COUNT(DISTINCT cb.contact_id) AS n
    FROM contact_brands cb JOIN brands b ON b.id = cb.brand_id
    JOIN contacts ct ON ct.id = cb.contact_id
    WHERE cb.status = 'Active' AND ct.archived_at IS NULL
    GROUP BY b.slug
  `).all();

  const activeCasesByCompany = db.prepare(`
    SELECT b.slug AS brand_id, COUNT(*) AS n
    FROM cases c JOIN contact_brands cb ON cb.id = c.contact_brand_id JOIN brands b ON b.id = cb.brand_id
    WHERE c.status = 'Open'
    GROUP BY b.slug
  `).all();

  const policiesByCompanyStatus = db.prepare(`
    SELECT b.slug AS brand_id, pol.policy_status AS status, COUNT(*) AS n
    FROM policies pol
    JOIN cases c ON c.id = pol.case_id
    JOIN contact_brands cb ON cb.id = c.contact_brand_id JOIN brands b ON b.id = cb.brand_id
    WHERE pol.archived_at IS NULL
    GROUP BY b.slug, pol.policy_status
  `).all();

  const todayStr = new Date().toISOString().slice(0, 10);
  const tasksDue = db.prepare(`SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status = 'Pending' AND due_date = ?`).get(todayStr).n;
  const tasksOverdue = db.prepare(`SELECT COUNT(*) AS n FROM follow_up_tasks WHERE status = 'Pending' AND due_date < ?`).get(todayStr).n;

  const allMessages = getMessageDeliveryStatus(db, {});
  const commsByStatus = ['Queued', 'Sent', 'Delivered', 'Failed'].map(status => ({
    status, n: allMessages.filter(m => m.status === status).length,
  }));

  const reviewTotals = {
    brand: getBrandReviewQueue(db).length,
    case: getCaseReviewQueue(db).length,
    companyConflict: getCompanyConflictQueue(db).length,
  };

  return { clientsByCompany, activeCasesByCompany, policiesByCompanyStatus, tasksDue, tasksOverdue, commsByStatus, reviewTotals };
}

// Prioritized, openable work items — every item names a concrete next step
// and a concrete target to open (client/case/task/appointment/message/
// review item). Never a decorative metric.
function getWorkList(db, { brandId = null, limit = 15 } = {}) {
  const { clause: bClause, params: bParams } = brandFilterClause(brandId, 'b');
  const todayStr = new Date().toISOString().slice(0, 10);
  const items = [];

  const overdue = db.prepare(`
    SELECT t.id AS task_id, t.notes, t.due_date, t.priority, t.contact_id, ct.first_name, ct.last_name
    FROM follow_up_tasks t
    JOIN contacts ct ON ct.id = t.contact_id
    LEFT JOIN cases c ON c.id = t.case_id
    LEFT JOIN contact_brands cb ON cb.id = c.contact_brand_id
    LEFT JOIN brands b ON b.id = cb.brand_id
    WHERE t.status = 'Pending' AND t.due_date <= ? ${bClause}
    ORDER BY t.due_date ASC, (t.priority = 'High') DESC
    LIMIT ?
  `).all(todayStr, ...bParams, limit).map(r => ({
    type: 'task',
    id: r.task_id,
    label: r.notes || 'Follow up',
    subject: contactDisplayName(r),
    dueDate: r.due_date,
    overdue: r.due_date < todayStr,
    target: { kind: 'client', contactId: r.contact_id },
  }));
  items.push(...overdue);

  const appts = db.prepare(`
    SELECT a.id AS appt_id, a.appt_type, a.appt_datetime, a.contact_id, ct.first_name, ct.last_name
    FROM appointments a
    JOIN contacts ct ON ct.id = a.contact_id
    WHERE a.status = 'Scheduled' AND substr(a.appt_datetime,1,10) >= ?
    ORDER BY a.appt_datetime ASC
    LIMIT ?
  `).all(todayStr, limit).map(r => ({
    type: 'appointment',
    id: r.appt_id,
    label: `${r.appt_type || 'Appointment'} — follow up`,
    subject: contactDisplayName(r),
    dueDate: toIsoUtc(r.appt_datetime),
    overdue: false,
    target: { kind: 'client', contactId: r.contact_id },
  }));
  items.push(...appts);

  for (const item of getBrandReviewQueue(db)) {
    items.push({ type: 'review', id: item.intakeId, label: 'Resolve an intake — brand unclear', subject: item.identifier, dueDate: item.receivedDate, overdue: false, target: { kind: 'review', reviewType: 'brand', intakeId: item.intakeId } });
  }
  for (const item of getCaseReviewQueue(db)) {
    items.push({ type: 'review', id: item.intakeId, label: 'Resolve a case-review item', subject: item.contactName || 'Unnamed contact', dueDate: item.receivedDate, overdue: false, target: { kind: 'review', reviewType: 'case', intakeId: item.intakeId } });
  }
  for (const item of getCompanyConflictQueue(db)) {
    items.push({ type: 'review', id: item.intakeId, label: 'Resolve a company-assignment conflict', subject: item.contactName || 'Unnamed contact', dueDate: item.receivedDate, overdue: false, target: { kind: 'review', reviewType: 'company_conflict', intakeId: item.intakeId } });
  }

  return items
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
    .slice(0, limit);
}

function getUpcomingAppointments(db, { limit = 10 } = {}) {
  const todayStr = new Date().toISOString().slice(0, 10);
  return db.prepare(`
    SELECT a.id, a.appt_type, a.appt_datetime, a.contact_id, ct.first_name, ct.last_name
    FROM appointments a JOIN contacts ct ON ct.id = a.contact_id
    WHERE a.status = 'Scheduled' AND substr(a.appt_datetime,1,10) >= ?
    ORDER BY a.appt_datetime ASC LIMIT ?
  `).all(todayStr, limit).map(r => ({
    appointmentId: r.id, apptType: r.appt_type, apptDatetime: toIsoUtc(r.appt_datetime),
    contactId: r.contact_id, contactName: contactDisplayName(r),
  }));
}

function getRecentlyActiveClients(db, { limit = 8 } = {}) {
  return db.prepare(`
    SELECT ct.id AS contact_id, ct.first_name, ct.last_name, MAX(ct.updated_at) AS ts
    FROM contacts ct
    GROUP BY ct.id
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit).map(r => ({ contactId: r.contact_id, contactName: contactDisplayName(r), lastActivity: toIsoUtc(r.ts) }));
}

// ── Policies (see crm/db/migrateCrmApp.js — real, empty-by-default table) ──

function getPoliciesList(db, { brandId = null } = {}) {
  const { clause: bClause, params: bParams } = brandFilterClause(brandId, 'b');
  const rows = db.prepare(`
    SELECT
      pol.*, ct.id AS contact_id, ct.first_name, ct.last_name,
      b.slug AS brand_id, p.name AS product_name
    FROM policies pol
    JOIN cases c ON c.id = pol.case_id
    JOIN contact_brands cb ON cb.id = c.contact_brand_id
    JOIN contacts ct ON ct.id = cb.contact_id
    JOIN brands b ON b.id = cb.brand_id
    LEFT JOIN products p ON p.id = c.product_id
    WHERE 1=1 ${bClause}
    ORDER BY pol.updated_at DESC
  `).all(...bParams);

  return rows.map(row => {
    const brand = publicBrandIdentity(row.brand_id);
    return {
      policyId: row.id,
      caseId: row.case_id,
      contactId: row.contact_id,
      contactName: contactDisplayName(row),
      brandId: row.brand_id,
      brandShortName: brand ? brand.shortName : row.brand_id,
      productName: row.product_name,
      carrier: row.carrier,
      policyNumber: row.policy_number,
      policyStatus: row.policy_status,
      effectiveDate: row.effective_date,
      premium: row.premium,
      premiumFrequency: row.premium_frequency,
      coverageAmount: row.coverage_amount,
      beneficiary: row.beneficiary,
      renewalDate: row.renewal_date,
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
  // 'blocked' is the fake adapter's terminus (crm/lib/providers/fakeAdapter.js)
  // for every send attempted in this checkpoint — kept visually and
  // semantically distinct from 'Queued' so the threaded text view never
  // implies a message is still in flight when sending was never attempted.
  if (s === 'blocked') return 'Blocked';
  if (s === 'received') return 'Received';
  return 'Queued';
}

// sms_messages.failure_reason (see crm/lib/smsStatusService.js and
// crm/lib/legacySmsSend.js) is the current, preferred source -- populated
// for both a synchronous Twilio API rejection and an async
// undelivered/failed status-callback result. storedFailureReason is passed
// in from the row for that. Older rows written before failure_reason
// existed fall back to the "[FAILED] ..." prefix historically stuffed into
// sms_messages.body itself (see crm/lib/legacySmsSend.js's still-unchanged
// body-prefix). Emails have no equivalent stored detail at all. Never
// returns provider credentials or a raw API response — only ever this
// app's own stored text.
function extractFailureReason(channel, status, body, storedFailureReason) {
  if (normalizeMessageStatus(status) !== 'Failed') return null;
  if (storedFailureReason) return storedFailureReason;
  if (channel === 'sms' && body && body.startsWith('[FAILED]')) {
    const match = body.match(/^\[FAILED\]\s*([\s\S]+?)(?:\n\n|$)/);
    return match ? match[1].trim() : 'No further detail is stored for this message.';
  }
  return 'No further detail is stored for this message.';
}

function getMessageDeliveryStatus(db, { brandId = null } = {}) {
  const smsRows = db.prepare(`
    SELECT 'sms' AS channel, id, to_number AS recipient, status, body, failure_reason, failure_resolved_at, sent_at AS timestamp, contact_brand_id, case_id
    FROM sms_messages
  `).all();
  const emailRows = db.prepare(`
    SELECT 'email' AS channel, id, to_email AS recipient, status, NULL AS body, NULL AS failure_reason, failure_resolved_at, sent_at AS timestamp, contact_brand_id, case_id
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
      failureReason: status === 'Failed' ? extractFailureReason(row.channel, row.status, row.body, row.failure_reason) : null,
      // Set only once Loretta has explicitly handled a Failed communication
      // (resolveFailedCommunication below) -- status itself never changes,
      // so the original record and its failure reason stay in history
      // forever; this is purely "does this still need my attention."
      resolvedAt: status === 'Failed' ? toIsoUtc(row.failure_resolved_at) : null,
      timestamp: toIsoUtc(row.timestamp),
      brandId: rowBrandId,
      brandShortName: brand ? brand.shortName : null,
      relatedCase: relatedCase ? (relatedCase.title || relatedCase.product_name || null) : null,
    };
  });

  const filtered = brandId && brandId !== 'all' ? all.filter(r => r.brandId === brandId) : all;
  return filtered.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
}

// Marks a Failed sms_messages/emails row as resolved -- Loretta has handled
// the underlying problem (e.g. corrected the phone number and resent) and
// this no longer needs to appear as an active failure. Never touches
// status, body, or any other column -- the original record and its Twilio
// error detail are fully preserved; failure_resolved_at is the only thing
// that changes. Never resends anything, never touches consent, never
// touches the contact -- purely a bookkeeping marker on this one row.
function resolveFailedCommunication(db, { channel, id }, actor) {
  if (!actor) throw new Error('resolveFailedCommunication: actor is required for the audit trail');
  if (channel !== 'sms' && channel !== 'email') {
    throw new Error(`resolveFailedCommunication: unknown channel '${channel}'`);
  }
  const table = channel === 'sms' ? 'sms_messages' : 'emails';
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
  if (!row) throw new Error(`resolveFailedCommunication: ${channel} message ${id} does not exist`);
  if (normalizeMessageStatus(row.status) !== 'Failed') {
    throw new Error(`resolveFailedCommunication: ${channel} message ${id} is not currently Failed (status: ${row.status})`);
  }
  db.prepare(`UPDATE ${table} SET failure_resolved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

module.exports = {
  getCaseList,
  getBrandReviewQueue,
  getCaseReviewQueue,
  getOpenCasesForContactBrand,
  getMessageDeliveryStatus,
  resolveFailedCommunication,
  normalizeMessageStatus,
  getCompanyConflictQueue,
  getContactConflictQueue,
  getUnknownSmsReviewQueue,
  getClientDetail,
  getDashboardSummary,
  getWorkList,
  getUpcomingAppointments,
  getRecentlyActiveClients,
  getPoliciesList,
  getReportsSummary,
};
