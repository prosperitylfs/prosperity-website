// Durable storage for the Microsoft Graph delegated OAuth credential
// (Insurance Lady mailbox, loretta@insuranceladyllc.com) -- 2026-10-16.
//
// Stores MSAL Node's own serialized token cache (a JSON blob that
// internally contains the refresh token, along with any cached access
// tokens), NOT a raw refresh-token string. This is the officially
// supported extensibility point for persisting MSAL's cache outside the
// default in-memory store (see lib/msGraphAuth.js's cachePlugin) --
// letting MSAL handle refresh-token rotation internally rather than this
// codebase trying to parse/manage a raw token itself: every time MSAL
// rotates the refresh token during a silent renewal, its own serialize()
// output already reflects the newest token, so persisting that blob after
// every cache-changed event is sufficient and correct.
//
// Lives in its own table (`oauth_credentials`, crm/db/database.js),
// deliberately separate from `emails`/`communications` -- those hold sent
// message CONTENT; this holds a CREDENTIAL. Nothing else in this codebase
// reads or writes this table.
//
// The single row is keyed by provider='microsoft' -- there is exactly one
// Microsoft-authorized mailbox (Insurance Lady) in this version.

const PROVIDER = 'microsoft';

// Returns the stored serialized cache string, or null if never authorized.
function getTokenCache(db) {
  const row = db.prepare('SELECT token_cache FROM oauth_credentials WHERE provider = ?').get(PROVIDER);
  return row ? row.token_cache : null;
}

// Single UPSERT -- atomic: a concurrent read of this row during the write
// always sees either the fully-old or fully-new blob, never a partial one.
function setTokenCache(db, serializedCache) {
  db.prepare(`
    INSERT INTO oauth_credentials (provider, token_cache, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(provider) DO UPDATE SET token_cache = excluded.token_cache, updated_at = CURRENT_TIMESTAMP
  `).run(PROVIDER, serializedCache);
}

function clearTokenCache(db) {
  db.prepare('DELETE FROM oauth_credentials WHERE provider = ?').run(PROVIDER);
}

module.exports = { getTokenCache, setTokenCache, clearTokenCache };
