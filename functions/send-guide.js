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
        <td valign="top" style="padding-right:12px;width:140px;">
          <a href="https://www.prosperitylfs.com" target="_blank" style="text-decoration:none;display:inline-block;">
            <img src="https://www.prosperitylfs.com/logo.png" width="132" alt="Prosperity Life & Financial Solutions" style="display:block;border:none;outline:none;text-decoration:none;width:132px;height:auto;" />
          </a>
        </td>
        <td valign="top" style="padding-left:12px;">
          <div style="font-size:16px;font-weight:700;color:#2b1062;line-height:1.3;margin-bottom:4px;">Loretta Stewart</div>
          <div style="font-size:13px;color:#4f4f4f;line-height:1.5;margin-bottom:10px;">Life &amp; Retirement Advisor<br>Prosperity Life &amp; Financial Solutions LLC</div>
          <div style="font-size:13px;color:#4f4f4f;line-height:1.6;margin-bottom:12px;">
            <div style="margin-bottom:6px;"><strong style="color:#2b1062;">P:</strong> <a href="tel:+14144411177" style="color:#389f72;text-decoration:none;">414-441-1177</a></div>
            <div style="margin-bottom:6px;"><strong style="color:#2b1062;">E:</strong> <a href="mailto:loretta@prosperitylfs.com" style="color:#389f72;text-decoration:none;">loretta@prosperitylfs.com</a></div>
            <div><strong style="color:#2b1062;">W:</strong> <a href="https://www.prosperitylfs.com" target="_blank" style="color:#389f72;text-decoration:none;">prosperitylfs.com</a></div>
          </div>
          <div>
            <a href="https://www.prosperitylfs.com/book" target="_blank" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#4e2c94;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;">Book a Free Consultation</a>
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
