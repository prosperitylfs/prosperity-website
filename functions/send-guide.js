export async function onRequestPost(context) {
  const { request, env } = context;

  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const { first_name, email, guide } = data;

  if (!first_name || !email) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  const isRetirementSavings  = guide === 'retirement-savings';
  const isRetirementRollover = !isRetirementSavings; // default for homepage form + any missing/unknown guide type

  // TEMP DEBUG — remove after diagnosing Resend send failures
  console.log('[send-guide] DEBUG key present:', !!env.RESEND_API_KEY, 'key length:', env.RESEND_API_KEY ? env.RESEND_API_KEY.length : 0, 'guide:', guide);

  // ── Retirement & Rollover Mistakes Guide (homepage form) ──────────────────
  if (isRetirementRollover) {
    const guideUrl         = 'https://www.prosperitylfs.com/13-costly-rollover-mistakes-guide.pdf';
    const consultationUrl  = 'https://cal.com/prosperitylfs/retirement-safemoney-consultation';

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

    // TEMP DEBUG — remove after diagnosing Resend send failures
    console.log('[send-guide] DEBUG rollover branch — Resend status:', resendRes.status, resendRes.statusText);

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

    // TEMP DEBUG — remove after diagnosing Resend send failures
    console.log('[send-guide] DEBUG savings branch — Resend status:', resendRes.status, resendRes.statusText);

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
