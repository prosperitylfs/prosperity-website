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
    '',
    'Best,',
    'Loretta Stewart',
    'Life & Retirement Advisor',
    'Prosperity Life & Financial Solutions',
    '414-441-1177',
    'Website: https://www.prosperitylfs.com',
    'Book a Free Consultation: https://www.prosperitylfs.com/book',
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
    <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:18px;border-top:1px solid #e8e4f5;padding-top:16px;font-family:Arial,Helvetica,sans-serif;color:#1f1f1f;">
      <tr>
        <td valign="top" style="padding-right:12px;width:110px;">
          <a href="https://www.prosperitylfs.com" target="_blank" style="text-decoration:none;display:inline-block;">
            <img src="https://www.prosperitylfs.com/assets/images/Small%20Logo.png" width="110" alt="Prosperity Life & Financial Solutions" style="display:block;border:none;outline:none;text-decoration:none;width:110px;height:auto;image-rendering:auto;" />
          </a>
        </td>
        <td valign="top" style="padding-left:12px;">
          <div style="font-size:16px;font-weight:700;color:#2b1062;line-height:1.3;margin-bottom:4px;">Loretta Stewart</div>
          <div style="font-size:13px;color:#4f4f4f;line-height:1.5;margin-bottom:10px;">Life &amp; Retirement Advisor<br>Prosperity Life &amp; Financial Solutions LLC</div>
          <div style="font-size:13px;color:#4f4f4f;line-height:1.6;margin-bottom:12px;">
            <div style="margin-bottom:6px;">
              <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23000' d='M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.42 11.42 0 0 0 3.58.57 1 1 0 0 1 1 1v3.62a1 1 0 0 1-1 1A17 17 0 0 1 3 5a1 1 0 0 1 1-1h3.62a1 1 0 0 1 1 1 11.42 11.42 0 0 0 .57 3.58 1 1 0 0 1-.24 1.02l-2.2 2.2Z'/%3E%3C/svg%3E" width="14" height="14" style="display:inline-block;vertical-align:middle;margin-right:6px;" alt="" />
              <a href="tel:+14144411177" style="color:#389f72;text-decoration:none;vertical-align:middle;">414-441-1177</a>
            </div>
            <div style="margin-bottom:6px;">
              <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23000' d='M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 4.3l-8 5-8-5V6l8 5 8-5v2.3z'/%3E%3C/svg%3E" width="14" height="14" style="display:inline-block;vertical-align:middle;margin-right:6px;" alt="" />
              <a href="mailto:loretta@prosperitylfs.com" style="color:#389f72;text-decoration:none;vertical-align:middle;">loretta@prosperitylfs.com</a>
            </div>
            <div>
              <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23000' d='M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm2.09 3.5a7.98 7.98 0 0 1 3.41 2.33A8.01 8.01 0 0 0 14.09 5.5zM12 4c1.46 0 2.83.4 4.01 1.09A8 8 0 0 0 12 4zm-2.09 1.5A8 8 0 0 0 6.5 7.83 7.98 7.98 0 0 1 9.91 5.5zM4.08 10.5A7.96 7.96 0 0 1 4 12a7.96 7.96 0 0 1 .08 1.5 9.99 9.99 0 0 0 3.35-1.57 9.99 9.99 0 0 0-3.35-1.43zM12 20c-1.46 0-2.83-.4-4.01-1.09A8 8 0 0 0 12 20zm2.09-1.5A8 8 0 0 0 17.5 16.17 7.98 7.98 0 0 1 14.09 18.5zM4.08 13.5a9.99 9.99 0 0 0 3.35 1.57 9.99 9.99 0 0 0-3.35-1.57zM19.92 13.5a9.99 9.99 0 0 0-3.35 1.57 9.99 9.99 0 0 0 3.35-1.57z'/%3E%3C/svg%3E" width="14" height="14" style="display:inline-block;vertical-align:middle;margin-right:6px;" alt="" />
              <a href="https://www.prosperitylfs.com" target="_blank" style="color:#389f72;text-decoration:none;vertical-align:middle;">prosperitylfs.com</a>
            </div>
          </div>
        </td>
      </tr>
    </table>
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
