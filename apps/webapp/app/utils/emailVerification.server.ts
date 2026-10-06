/**
 * One-time codes that prove a person can read an email address. Used by
 * registration (the school email on sign-up) and by account settings (changing
 * that email later). Rows live in the better-auth `verification` table keyed by
 * the address itself, so a code sent from either screen is honoured by both.
 */

import getPrisma from '@classmoji/database';
import Tasks from '@classmoji/tasks';
import { isValidEmail } from './email';

const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Sending a code mails whatever address the caller typed, so it is throttled
 * (email bombing, and each send costs a Trigger.dev run and a Resend email).
 *
 * - Per address: one send a minute. Enough for a real "Resend" (mail is
 *   usually there within seconds) and stops a held-down Resend button. This
 *   applies whoever asks, so two accounts cannot alternate on one inbox.
 * - Per user: five sends an hour across all addresses. Registration needs one
 *   or two (a typo, a resend); a settings change the same. Five leaves room
 *   for a slow inbox, while one account can no longer mail many addresses.
 *
 * State lives in the `verification` table, so it holds across Fly machines
 * (the webapp runs two) and restarts, with no new table: the per-address
 * check reads the code row's `created_at`, and each send also writes a marker
 * row keyed by the user (`identifier` = USER_SEND_PREFIX + user id, `value` =
 * the address, `expires_at` = when it stops counting). Two concurrent requests
 * can both pass a check; that slack of one is acceptable for a throttle.
 */
export const CODE_RESEND_COOLDOWN_MS = 60 * 1000;
export const CODE_SENDS_PER_USER = 5;
export const CODE_SENDS_PER_USER_WINDOW_MS = 60 * 60 * 1000;
const USER_SEND_PREFIX = 'email-code-send:';

export const CODE_COOLDOWN_MESSAGE = 'Please wait a minute before requesting another code.';
export const CODE_USER_CAP_MESSAGE =
  'Too many verification codes requested. Please try again in an hour.';

export type SendEmailVerificationCodeResult =
  | { sent: true }
  | {
      sent: false;
      reason: 'cooldown' | 'user-cap';
      /** Friendly text for the route's `{ error }`. */
      error: string;
      /** A live code for this address already exists, so the code step can stay open. */
      codePending: boolean;
    };

/**
 * Issue a fresh 6-digit code for `email`, replacing any earlier one, and mail
 * it, unless `userId` or the address is over its throttle (see above), in
 * which case nothing is written or sent.
 * `email` must already be normalized (see normalizeEmail in ~/utils/email);
 * callers validate first and show their own error. This throws rather than
 * enqueue an address the email task can never deliver to, which would only
 * burn its retry budget (#396).
 */
export const sendEmailVerificationCode = async (
  email: string,
  userId: string
): Promise<SendEmailVerificationCodeResult> => {
  if (!isValidEmail(email)) {
    throw new Error('sendEmailVerificationCode: refusing to mail an invalid address');
  }
  const prisma = getPrisma();
  const now = new Date();

  const live = await prisma.verification.findFirst({
    where: { identifier: email, expires_at: { gt: now } },
    orderBy: { created_at: 'desc' },
    select: { created_at: true },
  });
  if (live && now.getTime() - live.created_at.getTime() < CODE_RESEND_COOLDOWN_MS) {
    return { sent: false, reason: 'cooldown', error: CODE_COOLDOWN_MESSAGE, codePending: true };
  }

  const userKey = `${USER_SEND_PREFIX}${userId}`;
  await prisma.verification.deleteMany({
    where: { identifier: userKey, expires_at: { lte: now } },
  });
  const recentSends = await prisma.verification.count({
    where: { identifier: userKey, expires_at: { gt: now } },
  });
  if (recentSends >= CODE_SENDS_PER_USER) {
    return {
      sent: false,
      reason: 'user-cap',
      error: CODE_USER_CAP_MESSAGE,
      codePending: live !== null,
    };
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await prisma.verification.create({
    data: {
      identifier: userKey,
      value: email,
      expires_at: new Date(now.getTime() + CODE_SENDS_PER_USER_WINDOW_MS),
    },
  });
  await prisma.verification.deleteMany({ where: { identifier: email } });
  await prisma.verification.create({
    data: {
      identifier: email,
      value: code,
      expires_at: new Date(now.getTime() + CODE_TTL_MS),
    },
  });
  // Subject and markup live in the Resend template `verify-email`; source of
  // truth for the HTML is packages/services/src/emails/templates/verify-email.html
  await Tasks.sendEmailTask.trigger({
    to: email,
    template: { id: 'verify-email', variables: { CODE: code } },
  });
  return { sent: true };
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
