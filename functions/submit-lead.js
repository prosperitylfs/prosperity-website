const CRM_LEADS_ENDPOINT = 'https://prosperity-crm.onrender.com/api/leads';

// Verifies a Turnstile token with Cloudflare's siteverify API — same
// server-side enforcement used by /send-guide. The widget on the frontend
// only proves the *browser* solved a challenge; this proves the token is
// real, unused, and issued for our site, so a script POSTing straight to
// this endpoint (skipping the browser entirely) can't bypass it.
// TURNSTILE_SECRET_KEY must be set as a Cloudflare Pages env var — never
// commit it or expose it to the browser.
async function verifyTurnstile(env, token, remoteIp) {
  if (!token) return false;
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('[submit-lead] TURNSTILE_SECRET_KEY is not set. Rejecting all submissions until configured.');
    return false;
  }
  try {
    const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret:   env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteIp || '',
      }),
    });
    const result = await verifyRes.json();
    if (!result.success) {
      console.warn('[submit-lead] siteverify failed, error-codes:', result['error-codes']);
    }
    return result.success === true;
  } catch (err) {
    console.error('[submit-lead] turnstile verification request error:', err.message);
    return false;
  }
}

// Forwards the lead to the CRM. This call is server-to-server (Cloudflare
// Pages → Render), so unlike a direct browser fetch from book.html or
// life-insurance.html, it is never subject to browser CORS. x-internal-key
// proves to routes/leads.js that this request comes from our own trusted
// backend (which already verified Turnstile above) rather than a public
// browser — same bypass pattern used by /send-guide. Must match
// CRM_INTERNAL_KEY on the Render side exactly.
export async function saveLeadToCRM(env, payload) {
  // Fail closed: no hardcoded fallback credential. A previous version of this
  // function fell back to a literal API-key string when CRM_API_KEY was
  // unset — that string ends up in git history and is effectively a
  // permanent, unrotatable credential. If either required credential is
  // missing, refuse to call the CRM rather than send a request that either
  // uses a leaked fallback or an empty header.
  if (!env.CRM_API_KEY || !env.CRM_INTERNAL_KEY) {
    console.error('[submit-lead] CRM_API_KEY or CRM_INTERNAL_KEY is not configured — refusing to contact the CRM (no fallback credential is used).');
    return false;
  }
  try {
    const res = await fetch(CRM_LEADS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CRM_API_KEY,
        'x-internal-key': env.CRM_INTERNAL_KEY,
      },
      body: JSON.stringify(payload),
    });
    const bodyText = await res.text().catch(() => '');
    if (!res.ok) {
      console.error('[submit-lead] CRM save failed:', res.status, bodyText, 'payload:', JSON.stringify(payload));
    }
    return res.ok;
  } catch (err) {
    console.error('[submit-lead] CRM save threw:', err.message, 'payload:', JSON.stringify(payload));
    return false;
  }
}

// Same-origin entry point for every browser-originated Prosperity lead form
// (book.html, life-insurance.html, life-insurance-qualifier.html,
// contact.html). Whatever JSON fields a form sends (minus turnstile_token)
// are forwarded to the CRM unchanged via saveLeadToCRM() below — this
// function never special-cases individual forms' field shapes, so adding a
// new form here requires no change to this file. The browser never sees or
// sends a CRM credential; CRM_API_KEY/CRM_INTERNAL_KEY are read only from
// this Function's own server-side env (env.*, never request data).
export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const { turnstile_token, ...lead } = data;

  if (!lead.email && !lead.phone) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  // Reject requests with a missing/invalid Turnstile token before doing any
  // CRM work — this is what actually blocks bots and direct-POST bypasses
  // of this endpoint.
  const remoteIp = request.headers.get('CF-Connecting-IP');
  const turnstileOk = await verifyTurnstile(env, turnstile_token, remoteIp);
  if (!turnstileOk) {
    return json({ error: 'Verification failed. Please refresh the page and try again.' }, 400);
  }

  // CRM lead capture is important but must never become a revenue-blocking
  // failure: a qualified prospect must always be able to reach scheduling.
  // saveLeadToCRM() already logs the specific cause of a failure (missing
  // credentials / a non-OK CRM response / a network error) above -- this is
  // an additional, caller-level log line noting that the fail-safe kicked
  // in, so a failed capture is still fully diagnosable later. The response
  // to the browser is success either way, so the calling form (e.g.
  // book.html) always proceeds to scheduling.
  const saved = await saveLeadToCRM(env, lead);
  if (!saved) {
    console.error('[submit-lead] CRM lead save failed -- returning success to the browser anyway so scheduling is never blocked.');
  }

  return json({ ok: true }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
