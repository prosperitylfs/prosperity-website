const CRM_LEADS_ENDPOINT = 'https://prosperity-crm.onrender.com/api/leads';

// Verifies a Turnstile token with Cloudflare's siteverify API. This is the
// server-side enforcement — the widget on the frontend only proves the
// *browser* solved a challenge; this check proves the token is real, unused,
// and issued for our site, so a script POSTing straight to /send-guide
// (skipping the browser entirely) can't bypass it.
// TURNSTILE_SECRET_KEY must be set as a Cloudflare Pages env var — never
// commit it or expose it to the browser.
async function verifyTurnstile(env, token, remoteIp) {
  // TEMP DEBUG — never logs the secret value itself, only whether it's
  // present and how long it is, to confirm Cloudflare Pages actually
  // injected it into this deployment's env bindings.
  console.log('[send-guide][debug] secret key present:', !!env.TURNSTILE_SECRET_KEY,
    'length:', env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SECRET_KEY.length : 0);

  if (!token) return false;
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('[send-guide] TURNSTILE_SECRET_KEY is not set. Rejecting all submissions until configured.');
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
    // TEMP DEBUG — always logs the outcome (not just failures) plus
    // Cloudflare's exact error-codes array so we can see specifics like
    // 'invalid-input-secret' (wrong key) vs 'timeout-or-duplicate' (token
    // expired or already used) vs 'invalid-input-response' (bad token).
    console.log('[send-guide][debug] siteverify result:', result.success, 'error-codes:', result['error-codes']);
    return result.success === true;
  } catch (err) {
    console.error('[send-guide] turnstile verification request error:', err.message);
    return false;
  }
}

// Saves/updates the CRM contact. Best-effort: a CRM failure is logged clearly
// but never blocks guide delivery — the lead still gets their email even if
// the CRM is temporarily down.
//
// x-internal-key proves to leads.js that this call comes from our own
// trusted backend (which already verified Turnstile above) rather than a
// public browser — Turnstile tokens are single-use, so the same token
// couldn't be re-verified by leads.js even if we forwarded it. This key is
// never sent to, or readable by, the browser.
export async function saveLeadToCRM(env, payload) {
  // Fail closed: no hardcoded fallback credential. A previous version of this
  // function fell back to a literal API-key string when CRM_API_KEY was
  // unset — that string ends up in git history and is effectively a
  // permanent, unrotatable credential. If either required credential is
  // missing, refuse to call the CRM (guide delivery below is unaffected,
  // since this save is already best-effort by design).
  if (!env.CRM_API_KEY || !env.CRM_INTERNAL_KEY) {
    console.error('[send-guide] CRM_API_KEY or CRM_INTERNAL_KEY is not configured — refusing to contact the CRM (no fallback credential is used).');
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
      console.error('[send-guide] CRM save failed:', res.status, bodyText, 'payload:', JSON.stringify(payload));
      return false;
    }
    console.log('[send-guide] CRM save succeeded:', res.status, bodyText);
    return true;
  } catch (err) {
    console.error('[send-guide] CRM save threw:', err.message, 'payload:', JSON.stringify(payload));
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

  const { first_name, last_name, email, phone, guide, sms_consent, turnstile_token } = data;

  if (!first_name || !email) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  // Reject requests with a missing/invalid Turnstile token before doing any
  // CRM or email work — this is what actually blocks bots and direct-POST
  // bypasses of this endpoint.
  const remoteIp = request.headers.get('CF-Connecting-IP');
  const turnstileOk = await verifyTurnstile(env, turnstile_token, remoteIp);
  if (!turnstileOk) {
    return json({ error: 'Verification failed. Please refresh the page and try again.' }, 400);
  }

  const isRetirementSavings  = guide === 'retirement-savings';
  const isRetirementRollover = !isRetirementSavings; // default for homepage form + any missing/unknown guide type

  // ── Retirement & Rollover Mistakes Guide (homepage form) ──────────────────
  if (isRetirementRollover) {
    const guideUrl         = 'https://www.prosperitylfs.com/13-costly-rollover-mistakes-guide.pdf';
    const consultationUrl  = 'https://www.prosperitylfs.com/book';

    await saveLeadToCRM(env, {
      first_name,
      last_name,
      email,
      phone,
      lead_type: 'Retirement Guide Lead',
      lead_source: '13 Retirement & Rollover Mistakes to Avoid',
      sms_consent,
      email_consent: true, // submitting this form is an explicit request to receive the guide by email
      guide: 'retirement-rollover',
    });

    const text = [
      `Hi ${first_name},`,
      '',
      'Thank you for requesting your free guide:',
      '',
      '"13 Retirement & Rollover Mistakes to Avoid"',
      '',
      "Inside, you'll discover important strategies and common mistakes many people overlook when reviewing retirement accounts such as:",
      '',
      '• 401(k)s',
      '• 403(b)s',
      '• TSP accounts',
      '• IRAs',
      '• CDs and safe money alternatives',
      '• Retirement income planning strategies',
      '',
      'This guide was designed to help you better understand your options, reduce unnecessary risk, and avoid costly rollover mistakes before making important retirement decisions.',
      '',
      'Click below to access your free guide:',
      guideUrl,
      '',
      'If you would like to discuss your current retirement accounts, rollover options, or safe money strategies, you can also schedule a complimentary consultation below.',
      '',
      consultationUrl,
      '',
      'Warm regards,',
      'Loretta Stewart',
      'Prosperity Life & Financial Solutions',
    ].join('\n');

    const html = `
      <p>Hi ${first_name},</p>
      <p>Thank you for requesting your free guide:</p>
      <p><strong>&ldquo;13 Retirement &amp; Rollover Mistakes to Avoid&rdquo;</strong></p>
      <p>Inside, you&rsquo;ll discover important strategies and common mistakes many people overlook when reviewing retirement accounts such as:</p>
      <ul style="margin:8px 0 16px 20px; padding:0; line-height:1.8;">
        <li>401(k)s</li>
        <li>403(b)s</li>
        <li>TSP accounts</li>
        <li>IRAs</li>
        <li>CDs and safe money alternatives</li>
        <li>Retirement income planning strategies</li>
      </ul>
      <p>This guide was designed to help you better understand your options, reduce unnecessary risk, and avoid costly rollover mistakes before making important retirement decisions.</p>
      <p style="margin-top:20px;">Click below to access your free guide:</p>
      <p><a href="${guideUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 28px;background-color:#389f72;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:16px;">Download Your Free Guide</a></p>
      <p style="margin-top:20px;">If you would like to discuss your current retirement accounts, rollover options, or safe money strategies, you can also schedule a complimentary consultation below.</p>
      <p><a href="${consultationUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 28px;background:#4e2c94;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Schedule Your Free Consultation</a></p>
      <img
        src="https://www.prosperitylfs.com/assets/images/loretta-email-signature.png"
        alt="Loretta Stewart - Prosperity Life &amp; Financial Solutions"
        width="520"
        style="display:block;width:520px;max-width:100%;height:auto;border:0;margin-top:24px;"
      >
    `;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Loretta Stewart <loretta@prosperitylfs.com>',
        to: [email],
        subject: 'Your Free Retirement & Rollover Guide Is Ready',
        text,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error('Resend error:', resendRes.status, errText);
      return json({ error: 'Could not send email. Please try again.' }, 500);
    }

    return json({ ok: true }, 200);
  }

  // ── 7 Retirement & Savings Mistakes Guide (free-guide page) ───────────────
  if (isRetirementSavings) {
    const guideUrl        = 'https://www.prosperitylfs.com/7-retirement-savings-mistakes-guide-new.pdf';
    const consultationUrl = 'https://www.prosperitylfs.com/book';

    await saveLeadToCRM(env, {
      first_name,
      last_name,
      email,
      phone,
      lead_type: 'Retirement Guide Lead',
      lead_source: '7 Retirement & Savings Mistakes Guide',
      sms_consent,
      email_consent: true, // submitting this form is an explicit request to receive the guide by email
      guide: 'retirement-savings',
    });

    const text = [
      `Hi ${first_name},`,
      '',
      'Thank you for requesting your free guide:',
      '',
      '"7 Retirement & Savings Mistakes Guide"',
      '',
      'You can view and download your guide here:',
      guideUrl,
      '',
      'If you have questions or would like to review your retirement or savings options, you can schedule a free consultation here:',
      consultationUrl,
    ].join('\n');

    const html = `
      <p>Hi ${first_name},</p>
      <p>Thank you for requesting your free guide:</p>
      <p><strong>&quot;7 Retirement &amp; Savings Mistakes Guide&quot;</strong></p>
      <p>Here is your free 7 Retirement &amp; Savings Mistakes Guide.</p>
      <p>You can view and download your guide here:</p>
      <p><a href="${guideUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 28px;background-color:#389f72;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600;font-size:16px;">Download Your Free Guide</a></p>
      <p>If you have questions or would like to review your retirement or savings options, you can schedule a free consultation here:</p>
      <p><a href="${consultationUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 28px;background:#4e2c94;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Schedule Your Free Consultation</a></p>
      <img
        src="https://www.prosperitylfs.com/assets/images/loretta-email-signature.png"
        alt="Loretta Stewart - Prosperity Life &amp; Financial Solutions"
        width="520"
        style="display:block;width:520px;max-width:100%;height:auto;border:0;margin-top:24px;"
      >
    `;

    const resendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Loretta Stewart <loretta@prosperitylfs.com>',
        to: [email],
        subject: 'Your Free 7 Retirement & Savings Mistakes Guide',
        text,
        html,
      }),
    });

    if (!resendRes.ok) {
      const errText = await resendRes.text();
      console.error('Resend error:', resendRes.status, errText);
      return json({ error: 'Could not send email. Please try again.' }, 500);
    }

    return json({ ok: true }, 200);
  }

}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
