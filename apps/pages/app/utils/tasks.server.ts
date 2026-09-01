/**
 * Server-only access to the Trigger.dev task registry, plus the one decision
 * about whether to use it.
 *
 * `@classmoji/tasks` pulls in the Trigger SDK, Resend, and `simple-git`. None of
 * that belongs in a browser bundle, and a bare `import Tasks from
 * '@classmoji/tasks'` inside a route module puts it there — the `.server.ts`
 * suffix is what makes React Router's Vite plugin drop it, exactly as
 * `db.server.ts` does for Prisma.
 */
import Tasks from '@classmoji/tasks';

export { Tasks };

/**
 * Should this process actually dispatch mail?
 *
 * BOTH conditions, deliberately. `TRIGGER_SECRET_KEY` alone is not enough: a
 * developer with production secrets in their `.env` would otherwise mail real
 * people every time they tested a form, and the address they typed is usually
 * their own but sometimes is not. Requiring production as well means the
 * dangerous direction (send) needs an explicit deployment, and the safe
 * direction (log it) is what a laptop does.
 */
export const canDispatchEmail = (): boolean =>
  Boolean(process.env.TRIGGER_SECRET_KEY) && process.env.NODE_ENV === 'production';

/**
 * The dev escape: write the link to stdout instead of mailing it.
 *
 * Lands in `/tmp/classmoji-dev-<devport>.log`, which is where a developer (and
 * the e2e suite) goes to find it — the raw token is returned by
 * `beginPublicSubmission` exactly once and is stored only as a sha256 digest, so
 * this line is the ONLY place it can be recovered from.
 *
 * The recipient is included so a reader can tell whose link this is: the log is
 * shared by every service in the stack, and a test that submits one of several
 * fixtures needs to match its own line rather than the most recent one.
 */
export const logMagicLink = (to: string, verifyUrl: string): void => {
  // eslint-disable-next-line no-console
  console.log(`[forms:magic-link] to=${to} ${verifyUrl}`);
};

/**
 * Send a composed verification mail, or log it. NEVER both — a dev run that
 * also mailed would be the surprise this whole split exists to prevent.
 *
 * Failure is swallowed on purpose. The response row and its token are already
 * committed; throwing here would show the filler an error for a submission that
 * was in fact stored, and invite them to submit again into the cooldown.
 */
export async function dispatchVerifyEmail(
  emails: Array<{
    payload: { to: string; template: { id: string; variables: Record<string, string | number> } };
  }>,
  verifyUrl: string
): Promise<void> {
  if (!canDispatchEmail()) {
    for (const email of emails) logMagicLink(email.payload.to, verifyUrl);
    return;
  }

  for (const email of emails) {
    try {
      await Tasks.sendEmailTask.trigger(email.payload);
    } catch (error) {
      console.error('[forms:magic-link] dispatch failed', {
        to: email.payload.to,
        error: (error as Error).message,
      });
    }
  }
}
