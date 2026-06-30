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
async function saveLeadToCRM(env, payload) {
  try {
    const res = await fetch(CRM_LEADS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CRM_API_KEY || 'prosperity-crm-2025',
        'x-internal-key': env.CRM_INTERNAL_KEY || '',
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

  const saved = await saveLeadToCRM(env, lead);
  if (!saved) {
    return json({ error: 'Something went wrong. Please try again or call us at 414-441-1177.' }, 502);
  }

  return json({ ok: true }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
