import nodemailer from 'nodemailer';

/**
 * Email delivery for password-reset links. Configure `SMTP_URL`
 * (e.g. smtp://user:pass@host:587) and optionally `SMTP_FROM` in the
 * environment. When SMTP is not configured the API falls back to returning the
 * reset token in the response body for local development and tests.
 */
export function isMailConfigured(): boolean {
  return Boolean(process.env.SMTP_URL?.trim());
}

function mailFrom(): string {
  return process.env.SMTP_FROM?.trim() || 'InterviewSense <no-reply@interviewsense.local>';
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  const transport = nodemailer.createTransport(process.env.SMTP_URL as string);
  const supportsHtml = /^(text|https?):/.test(resetUrl);
  await transport.sendMail({
    from: mailFrom(),
    to,
    subject: 'Reset your InterviewSense password',
    text: [
      'You requested a password reset for your InterviewSense account.',
      '',
      `Open this link within one hour to choose a new password:`,
      resetUrl,
      '',
      'If you did not request a reset, you can ignore this email. Your password stays unchanged.'
    ].join('\n'),
    ...(supportsHtml
      ? {
          html: [
            '<p>You requested a password reset for your InterviewSense account.</p>',
            `<p><a href="${resetUrl}">Reset your password</a> (link expires in one hour).</p>`,
            '<p>If you did not request a reset, you can ignore this email.</p>'
          ].join('')
        }
      : {})
  });
}
