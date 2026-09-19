/**
 * One-time codes that prove a person can read an email address. Used by
 * registration (the school email on sign-up) and by account settings (changing
 * that email later). Rows live in the better-auth `verification` table keyed by
 * the address itself, so a code sent from either screen is honoured by both.
 */

import getPrisma from '@classmoji/database';
import Tasks from '@classmoji/tasks';

const CODE_TTL_MS = 10 * 60 * 1000;

/** Issue a fresh 6-digit code for `email`, replacing any earlier one, and mail it. */
export const sendEmailVerificationCode = async (email: string): Promise<void> => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await getPrisma().verification.deleteMany({ where: { identifier: email } });
  await getPrisma().verification.create({
    data: {
      identifier: email,
      value: code,
      expires_at: new Date(Date.now() + CODE_TTL_MS),
    },
  });
  // Subject and markup live in the Resend template `verify-email`; source of
  // truth for the HTML is packages/services/src/emails/templates/verify-email.html
  await Tasks.sendEmailTask.trigger({
    to: email,
    template: { id: 'verify-email', variables: { CODE: code } },
  });
};

/** True while `code` is the current, unexpired code for `email`. Does not consume it. */
export const isEmailVerificationCodeValid = async (
  email: string,
  code: string
): Promise<boolean> => {
  const row = await getPrisma().verification.findFirst({
    where: { identifier: email, value: code, expires_at: { gt: new Date() } },
    select: { id: true },
  });
  return row !== null;
};

/** Validate and burn the code in one step, for the write that follows. */
export const consumeEmailVerificationCode = async (
  email: string,
  code: string
): Promise<boolean> => {
  if (!(await isEmailVerificationCodeValid(email, code))) return false;
  await getPrisma().verification.deleteMany({ where: { identifier: email } });
  return true;
};
