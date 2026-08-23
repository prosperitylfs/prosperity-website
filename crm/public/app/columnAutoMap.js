// CSV column auto-mapper for the Import Clients page (crm/public/app/import.html).
// Loaded as a plain <script> in the browser AND require()-able from Node
// tests, so the exact algorithm the browser runs is what gets tested.
//
// Two-pass, claim-once matching: every field's exact full-label match is
// tried first and immediately claims its CSV header, before any field
// falls back to matching just its first word. The first-word pass then
// only considers fields still unmapped, and only headers not already
// claimed. This is what prevents two fields that share a first word (e.g.
// "Policy number" and "Policy status" both starting with "Policy") from
// both auto-mapping to the same lone CSV column — at most one of them can
// claim it; the other is left "Not mapped" for a deliberate manual choice
// rather than silently guessing wrong.
(function (root) {
  function normalizeHeader(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^a-z]/g, '');
  }

  function autoMapColumns(headers, fieldKeys) {
    const mapping = {};
    const claimed = new Set();

    // Pass 1: exact full-label matches.
    for (const [key, label] of fieldKeys) {
      const full = normalizeHeader(label).replace('perrow', '');
      const found = headers.find(h => !claimed.has(h) && normalizeHeader(h) === full);
      if (found) { mapping[key] = found; claimed.add(found); }
    }

    // Pass 2: first-word fallback, only for fields still unmapped and
    // headers not already claimed by pass 1 or an earlier field this pass.
    for (const [key, label] of fieldKeys) {
      if (mapping[key]) continue;
      const firstWord = normalizeHeader(label.split(/[\s/]/)[0]);
      const found = headers.find(h => !claimed.has(h) && normalizeHeader(h) === firstWord);
      if (found) { mapping[key] = found; claimed.add(found); }
    }

    return mapping;
  }

  const api = { autoMapColumns, normalizeHeader };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ColumnAutoMap = api;
})(typeof window !== 'undefined' ? window : this);
