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
    : 'Retirement Guide';

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
    'https://calendly.com/loretta-prosperitylfs/30min',
    '',
    'Best,',
    'Loretta Stewart',
    'Life & Retirement Advisor',
    'Prosperity Life & Financial Solutions',
    '414-441-1177',
  ].join('\n');

  const html = `
    <p>Hi ${first_name},</p>
    <p>Thank you for requesting your free guide:</p>
    <p><strong>&quot;${guideTitle}&quot;</strong></p>
    <p>You can view and download your guide here:</p>
    <p><a href="https://www.prosperitylfs.com/free-guide-download" target="_blank" rel="noopener noreferrer" style="display: inline-block; padding: 12px 28px; background-color: #389f72; color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 16px;">Download Your Free Guide</a></p>
    <p>If you have questions or would like to review your retirement or savings options, you can schedule a free consultation here:</p>
    <p><a href="https://calendly.com/loretta-prosperitylfs/30min" target="_blank" rel="noopener noreferrer">https://calendly.com/loretta-prosperitylfs/30min</a></p>
    <p>Best,<br>
    Loretta Stewart<br>
    Life &amp; Retirement Advisor<br>
    Prosperity Life &amp; Financial Solutions<br>
    414-441-1177</p>
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
        ? 'Your Free “7 Retirement & Savings Mistakes Guide”'
        : 'Your Free Retirement Guide Is Ready',
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
