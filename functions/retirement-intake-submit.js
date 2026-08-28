// Relays a completed Retirement Intake Form submission to the CRM's public
// token-gated endpoint, after verifying the visitor's Turnstile token —
// same siteverify pattern as functions/submit-lead.js, reusing the same
// TURNSTILE_SECRET_KEY Cloudflare Pages env var (no new secret needed).
//
// Unlike /submit-lead, this does NOT send x-api-key/x-internal-key — the
// CRM's POST /api/retirement-intake/:token is intentionally public and
// gated by the token itself (an unguessable per-appointment secret, not a
// site-wide credential), not by proving the request came from our backend.
// This function's only job is the Turnstile check; the CRM route does its
// own required-field validation independently.

const CRM_INTAKE_ENDPOINT = 'https://prosperity-crm.onrender.com/api/retirement-intake';

async function verifyTurnstile(env, token, remoteIp) {
  if (!token) return false;
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('[retirement-intake-submit] TURNSTILE_SECRET_KEY is not set. Rejecting all submissions until configured.');
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
      console.warn('[retirement-intake-submit] siteverify failed, error-codes:', result['error-codes']);
    }
    return result.success === true;
  } catch (err) {
    console.error('[retirement-intake-submit] turnstile verification request error:', err.message);
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

  const { turnstile_token, token, responses } = data;

  if (!token || typeof token !== 'string') {
    return json({ error: 'Missing or invalid link token.' }, 400);
  }

  const remoteIp = request.headers.get('CF-Connecting-IP');
  const turnstileOk = await verifyTurnstile(env, turnstile_token, remoteIp);
  if (!turnstileOk) {
    return json({ error: 'Verification failed. Please refresh the page and try again.' }, 400);
  }

  try {
    const res = await fetch(`${CRM_INTAKE_ENDPOINT}/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responses }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return json({ error: body.error || 'Something went wrong. Please try again.', details: body.details }, res.status);
    }
    return json({ ok: true }, 200);
  } catch (err) {
    console.error('[retirement-intake-submit] CRM relay failed:', err.message);
    return json({ error: 'Something went wrong. Please try again or call us at 414-441-1177.' }, 502);
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
