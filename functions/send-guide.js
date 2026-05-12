export async function onRequestPost(context) {
  const { request, env } = context;

  // Parse JSON body
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const { first_name, email, guide } = data;
  const isRetirementSavingsGuide = guide === 'retirement-savings';

  if (!first_name || !email) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  const guideTitle = isRetirementSavingsGuide
    ? '7 Retirement & Savings Mistakes Guide'
    : 'Your Free Guide';

  const emailIntroLine = isRetirementSavingsGuide
    ? 'Here is your free 7 Retirement & Savings Mistakes Guide.'
    : 'Here is your free guide.';

  const text = [
    `Hi ${first_name},`,
    '',
    'Thank you for requesting your free guide:',
    '',
    `"${guideTitle}"`,
    '',
    'You can view and download your guide here:',
    'https://www.prosperitylfs.com/free-guide-download',
    '',
    'If you have questions or would like to review your retirement or savings options, you can schedule a free consultation here:',
    'https://www.prosperitylfs.com/book',
  ].join('\n');

  const html = `
    <p>Hi ${first_name},</p>
    <p>Thank you for requesting your free guide:</p>
    <p><strong>&quot;${guideTitle}&quot;</strong></p>
    <p>${emailIntroLine}</p>
    <p>You can view and download your guide here:</p>
    <p><a href="https://www.prosperitylfs.com/free-guide-download" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 12px 28px; background-color: #389f72; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">Download Your Free Guide</a></p>
    <p>If you have questions or would like to review your retirement or savings options, you can schedule a free consultation here:</p>
    <p><a href="https://www.prosperitylfs.com/book" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:12px 28px;background:#4e2c94;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px;">Schedule Your Free Consultation</a></p>
    <img src="https://www.prosperitylfs.com/images/Loretta%20email%20signature.png" alt="Loretta Stewart - Prosperity Life & Financial Solutions" width="520" style="display:block; width:520px; max-width:100%; height:auto; border:0; margin-top:24px;">
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
      subject: isRetirementSavingsGuide
        ? 'Your Free 7 Retirement & Savings Mistakes Guide'
        : 'Your Free Guide Is Ready',
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

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
