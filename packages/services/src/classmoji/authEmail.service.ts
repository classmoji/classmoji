/**
 * Mail for email+password accounts: the one-time codes better-auth's emailOTP
 * plugin issues for verifying an address and for resetting a password.
 *
 * Sent through the `send_email` Trigger task by id, so the auth package does
 * not import the task bundle.
 */

import { tasks } from '@trigger.dev/sdk';
import { escapeHtml } from '../emails/escape.ts';

export type AuthOtpType = 'sign-in' | 'email-verification' | 'forget-password' | 'change-email';

const resetPasswordHtml = (code: string): string => {
  const safe = escapeHtml(code);
  return `<!doctype html><html><body style="margin:0;padding:0;background-color:#f5f5f4;" bgcolor="#f5f5f4">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="#f5f5f4" style="background-color:#f5f5f4;"><tr><td align="center" style="padding-top:32px;padding-bottom:32px;padding-left:16px;padding-right:16px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" bgcolor="#ffffff" style="background-color:#ffffff;border-radius:12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1917;">
<tr><td style="padding-top:32px;padding-left:32px;padding-right:32px;font-size:20px;font-weight:600;">Reset your password</td></tr>
<tr><td style="padding-top:12px;padding-left:32px;padding-right:32px;font-size:15px;line-height:22px;color:#44403c;">Enter this code to choose a new password for your Classmoji account.</td></tr>
<tr><td style="padding-top:20px;padding-left:32px;padding-right:32px;font-size:32px;font-weight:700;letter-spacing:6px;">${safe}</td></tr>
<tr><td style="padding-top:20px;padding-bottom:32px;padding-left:32px;padding-right:32px;font-size:13px;line-height:20px;color:#78716c;">This code expires in 10 minutes. If you did not ask to reset your password, you can ignore this email; your password stays the same.</td></tr>
</table></td></tr></table></body></html>`;
};

/** Mails `otp` to `email` for the given better-auth emailOTP purpose. */
export const sendAuthOtp = async (email: string, otp: string, type: AuthOtpType): Promise<void> => {
  if (type === 'forget-password') {
    await tasks.trigger('send_email', {
      to: email,
      subject: 'Reset your Classmoji password',
      html: resetPasswordHtml(otp),
    });
    return;
  }
  // Same template registration and settings use for their codes.
  await tasks.trigger('send_email', {
    to: email,
    template: { id: 'verify-email', variables: { CODE: otp } },
  });
};
