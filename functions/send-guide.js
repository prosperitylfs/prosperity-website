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
    '13 Costly Mistakes to Avoid When Rolling Over Your 401(k), 403(b), or TSP.',
    '',
    'You can view your guide here:',
    'https://www.prosperitylfs.com/guides/7_retirement_savings_mistakes_guide.pdf',
    '',
    'Schedule your free consultation here:',
    'https://calendly.com/loretta-prosperitylfs/30min',
    '',
    'Best,',
    'Loretta Stewart',
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
