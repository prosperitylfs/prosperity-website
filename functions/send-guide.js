export async function onRequestPost(context) {
  const { request, env } = context;

  // Parse JSON body
  let data;
  try {
    data = await request.json();
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }

  const { first_name, email } = data;

  if (!first_name || !email) {
    return json({ error: 'Missing required fields.' }, 400);
  }

  const text = [
    `Hi ${first_name},`,
    '',
    'Thank you for requesting your free guide:',
    '',
    '"7 Retirement & Savings Mistakes Many People Don\'t Realize They\'re Making"',
    '',
    'You can access your guide here:',
    'https://www.prosperitylfs.com/free-guide/',
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

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Loretta Stewart <loretta@prosperitylfs.com>',
      to: [email],
      subject: 'Your Free Retirement Guide Is Ready',
      text,
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
