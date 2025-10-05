// services/email.js
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: +process.env.SMTP_PORT,
  secure: +process.env.SMTP_PORT === 465,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

/** Helper to send */
async function send({ to, subject, html, text, attachments, headers }) {
  return transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
    attachments,  // ⬅ pass through
    headers       // ⬅ optional custom headers
  });
}

/** Combined invite: verify + setup */
async function sendInviteEmail({ to, companyName, verifyUrl, setupUrl }) {
  const subject = `Welcome to ${process.env.APP_NAME || 'Reputation System'} – Verify your email`;
  const text = `Welcome to ${companyName} on ${process.env.APP_NAME}.
Verify your email: ${verifyUrl}
Set your password: ${setupUrl}`;

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
    <h2>Welcome to ${process.env.APP_NAME || 'Our Platform'}</h2>
    <p>Hello, and welcome to <b>${companyName}</b> on ${process.env.APP_NAME || 'the platform'}!</p>
    <p>Please verify your email and set your password to get started.</p>
    <p>
      <a href="${verifyUrl}" style="background:#0d6efd;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Verify email</a>
      &nbsp;
      <a href="${setupUrl}" style="background:#198754;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Set password</a>
    </p>
    <p style="font-size:12px;color:#666">If the buttons don't work, use these links:<br>
      Verify: ${verifyUrl}<br>
      Password: ${setupUrl}</p>
  </div>`;

  return send({ to, subject, text, html });
}

async function sendOnboardingEmail({ to, companyName }) {
  const subject = `You're in! 🚀 Welcome to ${process.env.APP_NAME || 'the platform'}`;
  const supportEmail = process.env.SUPPORT_EMAIL || 'support@example.com';
  const whatsapp = process.env.SUPPORT_WHATSAPP || '';
  const socials = (process.env.SOCIAL_LINKS || '').split(',').map(s => s.trim()).filter(Boolean);

  const html = `
  <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
    <h2>Welcome aboard, ${companyName}!</h2>
    <p>We're excited to have you. Here are some helpful links and ways to reach us.</p>
    <ul>
      <li>Email support: <a href="mailto:${supportEmail}">${supportEmail}</a></li>
      ${whatsapp ? `<li>WhatsApp: <a href="${whatsapp}">${whatsapp}</a></li>` : ''}
      ${socials.map(s => `<li><a href="${s}">${s}</a></li>`).join('')}
    </ul>
    <p>Happy analyzing! 🎉</p>
  </div>`;

  return send({ to, subject, html, text: html.replace(/<[^>]+>/g, '') });
}

async function sendPasswordResetEmail({ to, resetUrl }) {
  const subject = `Reset your password`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
      <p>We received a request to reset your password.</p>
      <p><a href="${resetUrl}" style="background:#0d6efd;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Reset password</a></p>
      <p style="font-size:12px;color:#666">If that doesn't work, paste this link in your browser:<br>${resetUrl}</p>
    </div>
  `;
  return send({ to, subject, html, text: `Reset your password: ${resetUrl}` });
}

// Complaints – user acknowledgement
async function sendComplaintAckEmail(data) {
  const to = data.to || data.contact_email;
  if (!to) throw new Error('Complaint ack: missing recipient');

  const subject = `We received your complaint (ID: ${data.complaint_id})`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
      <p>Hi${data.name ? ` ${data.name}` : ''},</p>
      <p>Thanks for reaching out. Your complaint <b>${data.complaint_id}</b> is now <b>Under Review</b>. Our support team will get back to you as soon as possible.</p>
      <p>— ${process.env.APP_NAME || 'Support Team'}</p>
    </div>
  `;
  return send({ to, subject, html });
}

// Complaints – internal notification to support
async function sendComplaintNotifyEmail(data) {
  const to =
    data.to ||
    data.support_to ||
    process.env.SUPPORT_EMAIL_COMPLAINTS ||
    process.env.SUPPORT_EMAIL ||
    process.env.SMTP_USER;

  if (!to) throw new Error('Complaint notify: missing support recipient');

  const subject = `[Complaint] ${data.priority?.toUpperCase() || 'UNCLASSIFIED'} | ${data.complaint_id}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
      <h3>New Complaint</h3>
      <ul>
        <li><b>ID:</b> ${data.complaint_id}</li>
        <li><b>Priority:</b> ${data.priority || '—'}</li>
        <li><b>From:</b> ${data.name ? `${data.name} &lt;${data.contact_email}&gt;` : data.contact_email}</li>
        <li><b>Existing user:</b> ${data.is_existing_user || 'No'}</li>
        ${data.user_id ? `<li><b>User ID:</b> ${data.user_id}</li>` : ''}
        ${data.company_name ? `<li><b>Company:</b> ${data.company_name}</li>` : ''}
        ${typeof data.is_deleted === 'boolean' ? `<li><b>is_deleted:</b> ${data.is_deleted}</li>` : ''}
        ${typeof data.is_suspended === 'boolean' ? `<li><b>is_suspended:</b> ${data.is_suspended}</li>` : ''}
      </ul>
      <p><b>Description</b></p>
      <pre style="white-space:pre-wrap">${(data.description || '').trim()}</pre>
      ${data.image_url ? `<p><b>Image:</b> <a href="${data.image_url}">${data.image_url}</a></p>` : ''}
    </div>
  `;

  const attachments = data.image_url
    ? [{ filename: data.image_url.split('/').pop() || 'attachment', path: data.image_url }]
    : undefined;

  return send({ to, subject, html, attachments });
}

// Contact – user acknowledgement
async function sendContactAckEmail(data) {
  const to = data.to || data.email;
  if (!to) throw new Error('Contact ack: missing recipient');

  const subject = `Thanks for contacting ${process.env.APP_NAME || 'us'}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
      <p>Hi,</p>
      <p>Thanks for reaching out. We’ve received your message and will respond soon.</p>
      <blockquote style="border-left:4px solid #ddd;padding-left:12px;color:#555">${(data.message || '').trim()}</blockquote>
      <p>— ${process.env.APP_NAME || 'Support Team'}</p>
    </div>
  `;
  return send({ to, subject, html });
}

// Contact – internal notification to support
async function sendContactNotifyEmail(data) {
  const to =
    data.to ||
    data.support_to ||
    process.env.SUPPORT_EMAIL_CONTACT ||
    process.env.SUPPORT_EMAIL ||
    process.env.SMTP_USER;

  if (!to) throw new Error('Contact notify: missing support recipient');

  const subject = `[Contact] ${data.email}`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
      <h3>New Contact Message</h3>
      <ul>
        <li><b>From:</b> ${data.email}</li>
        <li><b>Existing user:</b> ${data.is_existing_user || 'No'}</li>
        ${data.user_id ? `<li><b>User ID:</b> ${data.user_id}</li>` : ''}
      </ul>
      <p><b>Message</b></p>
      <pre style="white-space:pre-wrap">${(data.message || '').trim()}</pre>
      ${data.image_url ? `<p><b>Image:</b> <a href="${data.image_url}">${data.image_url}</a></p>` : ''}
    </div>
  `;

  const attachments = data.image_url
    ? [{ filename: data.image_url.split('/').pop() || 'attachment', path: data.image_url }]
    : undefined;

  return send({ to, subject, html, attachments });
}

/* ──────────────────────────────────────────────────────────
   NEW: AI Summary Email
   Data shape from controller:
   {
     to, subject?, companyName, summaryDay, html_content,
     attachments?: [{ filename, content | path, contentType? }]
   }
────────────────────────────────────────────────────────── */
async function sendAiSummaryEmail({ to, subject, companyName, summaryDay, html_content, attachments }) {
  if (!to) throw new Error('AI summary: missing recipient');
  if (!html_content) throw new Error('AI summary: missing html_content');

  const subj = subject || `Your 7-day AI Reputation Summary — ${companyName || ''}${summaryDay ? ` (${summaryDay})` : ''}`.trim();
  const text = html_content.replace(/<[^>]+>/g, ' '); // basic text fallback

  return send({ to, subject: subj, html: html_content, text, attachments });
}

module.exports = {
  sendInviteEmail,
  sendOnboardingEmail,
  sendPasswordResetEmail,
  sendComplaintAckEmail,
  sendComplaintNotifyEmail,
  sendContactAckEmail,
  sendContactNotifyEmail,
  sendAiSummaryEmail,   // ⬅ export new sender
};
