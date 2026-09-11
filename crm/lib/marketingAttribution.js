// Insurance Lady FIRST-TOUCH marketing attribution (2026-09-11).
//
// SOURCE OF TRUTH: contacts.utm_source/utm_medium/utm_campaign/utm_content/
// utm_term/referrer/landing_page/first_touch_at (crm/db/database.js) --
// captured on the InsuranceLady-v4 website (outside this repo) on the
// visitor's FIRST page view, preserved through later navigation, and
// appended as query parameters to the outbound Cal.com booking link. This
// module's job starts at the CRM boundary: extracting those values from an
// incoming Cal.com webhook payload (crm/routes/calcom.js), and writing them
// onto a contact WITHOUT EVER overwriting a value already on file.
//
// WHERE THE DATA ARRIVES IN THE PAYLOAD -- genuinely UNCONFIRMED as of this
// writing (2026-09-11). Cal.com's own docs describe `payload.metadata` as
// one possible passthrough mechanism, but this has NOT been proven against
// a real Insurance Lady booking on our live Cal.com account, and there are
// reported Cal.com regressions around metadata delivery. This module
// therefore checks BOTH of the two plausible locations, in order:
//   1. payload.metadata -- a flat object Cal.com is documented to pass
//      through from the booking page's own query string, if the site's
//      Cal.com embed is configured to forward it.
//   2. payload.responses -- this codebase's own PROVEN, already-working
//      mechanism (see crm/routes/calcom.js, which already reads
//      name/email/phone/consent this way from real production bookings)
//      for a hidden custom booking question whose Cal.com response key is
//      exactly "utm_source" etc. -- the fallback if the site's Cal.com
//      integration instead passes attribution as prefilled hidden
//      questions rather than true booking metadata.
// Whichever location has a real (non-empty) value for a given field wins;
// metadata is checked first only because it's the field Cal.com's own docs
// name for this purpose. Neither being present is not an error -- it just
// means this booking carries no first-touch data (e.g. a booking Loretta
// made directly rather than through the site), and every field is
// independently optional: a payload with utm_source but no utm_term is
// completely normal, never treated as malformed.
//
// A TEMPORARY diagnostic in crm/routes/calcom.js (search "TEMP DIAGNOSTIC")
// logs the raw structure of the next real Insurance Lady BOOKING_CREATED
// payload so production Render logs can confirm which of the two locations
// Cal.com is actually using -- remove that block, and this comment's
// uncertainty note, once confirmed.

// A Cal.com custom-question response entry is normally { label, value, ... }
// (see crm/routes/calcom.js's own extraction of name/email/phone the same
// way); payload.metadata entries, if present, are expected to be plain
// strings. This accepts either shape so a value is never missed just
// because it arrived wrapped differently than expected, and never crashes
// on an unexpected type (an array, a number, null) -- unrecognized shapes
// are simply treated as "not provided" rather than guessed at.
function readString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') { const t = value.trim(); return t || null; }
  if (typeof value === 'object' && typeof value.value === 'string') { const t = value.value.trim(); return t || null; }
  return null;
}

// Returns null (never a partially-filled object) when NEITHER metadata nor
// responses carries a single recognized attribution field -- callers must
// treat null as "nothing to record," not "an error occurred."
function extractAttributionFromCalcomPayload(payload) {
  const metadata  = (payload && typeof payload.metadata  === 'object' && payload.metadata)  || {};
  const responses = (payload && typeof payload.responses === 'object' && payload.responses) || {};
  const pick = (key) => readString(metadata[key]) ?? readString(responses[key]);

  const attribution = {
    utmSource:    pick('utm_source'),
    utmMedium:    pick('utm_medium'),
    utmCampaign:  pick('utm_campaign'),
    utmContent:   pick('utm_content'),
    utmTerm:      pick('utm_term'),
    referrer:     pick('referrer'),
    landingPage:  pick('landing_page'),
    firstTouchAt: pick('first_touch_at'),
  };

  const hasAny = Object.values(attribution).some(Boolean);
  return hasAny ? attribution : null;
}

const ATTRIBUTION_COLUMNS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'referrer', 'landing_page', 'first_touch_at',
];

// THE first-touch enforcement point. Writes ONLY columns currently NULL on
// the contact -- a contact that already has utm_source='tiktok' keeps it
// forever, even if a LATER booking (a different campaign, a direct Cal.com
// booking with no attribution at all) arrives for the same contact. Safe
// to call unconditionally for every booking (new or matched contact,
// attribution present or not) -- a no-op attribution argument, or a
// contact whose columns are already all filled in, changes nothing.
function applyFirstTouchAttribution(db, contactId, attribution) {
  if (!attribution) return;
  const values = {
    utm_source:     attribution.utmSource    || null,
    utm_medium:     attribution.utmMedium    || null,
    utm_campaign:   attribution.utmCampaign  || null,
    utm_content:    attribution.utmContent   || null,
    utm_term:       attribution.utmTerm      || null,
    referrer:       attribution.referrer     || null,
    landing_page:   attribution.landingPage  || null,
    first_touch_at: attribution.firstTouchAt || null,
  };
  const setClause = ATTRIBUTION_COLUMNS.map(c => `${c} = COALESCE(${c}, @${c})`).join(', ');
  db.prepare(`UPDATE contacts SET ${setClause} WHERE id = @id`).run({ ...values, id: contactId });
}

// Display formatting -- computed server-side (not duplicated in browser JS)
// so crm/public/app/client.html's Marketing tab only ever renders an
// already-human-readable string. "Do not make Loretta read raw UTM syntax."
// Hyphens/underscores -> spaces, Title Case each word -- covers the general
// case (utm_campaign='liam-2026' -> 'Liam 2026', utm_content='test-video'
// -> 'Test Video') without needing a lookup table for every possible value.
function humanizeSlug(value) {
  if (!value) return null;
  return String(value)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// utm_source gets its own formatter because a handful of platform names are
// proper nouns that plain Title Case gets wrong (tiktok -> "Tiktok", not
// "TikTok"). facebook-personal/facebook-business/instagram all already
// come out correctly from humanizeSlug's general rule, so only genuine
// exceptions need listing here -- extend this map, never invent a new
// formatting scheme, if another platform needs a specific casing.
const SOURCE_LABEL_OVERRIDES = { tiktok: 'TikTok' };
function formatUtmSourceLabel(value) {
  if (!value) return null;
  const key = String(value).trim().toLowerCase();
  return SOURCE_LABEL_OVERRIDES[key] || humanizeSlug(value);
}

module.exports = {
  extractAttributionFromCalcomPayload,
  applyFirstTouchAttribution,
  humanizeSlug,
  formatUtmSourceLabel,
};
