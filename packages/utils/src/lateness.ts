/**
 * Lateness of a submission (GitRepoAssignment), measured from the student's
 * deadline pushed out by the extension hours they bought with tokens.
 *
 * Purchased hours are the net `hours_purchased` across ALL of the row's token
 * transactions: a cancelled purchase leaves a REFUND with negative hours,
 * which takes its extension back. Same rules as the `extension_hours` /
 * `num_late_hours` / `is_late` computed fields in packages/database/index.ts,
 * for callers that cannot rely on those (a narrow `select`, or plain rows
 * shaped outside Prisma).
 */

export interface ExtensionTransaction {
  hours_purchased?: number | null;
}

export interface LatenessRow {
  closed_at: Date | string | null;
  assignment: { student_deadline?: Date | string | null } | null;
  token_transactions?: ExtensionTransaction[] | null;
}

const MS_PER_HOUR = 60 * 60 * 1000;

const sumHours = (transactions: ExtensionTransaction[] | null | undefined): number =>
  (transactions ?? []).reduce((acc, t) => acc + (t.hours_purchased || 0), 0);

/** Net purchased extension hours, never below zero. */
export const netExtensionHours = (
  transactions: ExtensionTransaction[] | null | undefined
): number => Math.max(sumHours(transactions), 0);

/**
 * The student's deadline plus their net purchased hours, in epoch ms. Null
 * when there is no valid deadline (nothing is ever late then).
 */
export const extendedDeadlineMs = (
  deadline: Date | string | null | undefined,
  transactions: ExtensionTransaction[] | null | undefined
): number | null => {
  if (!deadline) return null;
  const deadlineMs = new Date(deadline).getTime();
  if (Number.isNaN(deadlineMs)) return null;
  return deadlineMs + netExtensionHours(transactions) * MS_PER_HOUR;
};

/**
 * Whether a submission is past its deadline IGNORING `is_late_override`.
 *
 * Mirrors the `is_late` computed field in packages/database/index.ts minus its
 * first line (`if (is_late_override) return false`): that field reads false
 * for every exempted row, so it cannot say whether an exempted — or
 * about-to-be-cleared — submission was actually late. Same rules otherwise:
 * no valid deadline → not late; not yet closed → late once the deadline plus
 * the purchased extension hours has passed (they can be bought ahead of the
 * deadline), as in `is_late`; closed → whole hours late (dayjs
 * `diff(..., 'hours')` truncation, floored at zero) minus purchased extension
 * hours, late when positive.
 */
export function isPastDeadlineIgnoringOverride(row: LatenessRow, now: Date = new Date()): boolean {
  const deadline = row.assignment?.student_deadline;
  if (!deadline) return false;
  const deadlineMs = new Date(deadline).getTime();
  if (Number.isNaN(deadlineMs)) return false;
  const extensionHours = sumHours(row.token_transactions);
  if (!row.closed_at) {
    return now.getTime() > deadlineMs + Math.max(extensionHours, 0) * MS_PER_HOUR;
  }

  const hoursLate = Math.max(
    Math.trunc((new Date(row.closed_at).getTime() - deadlineMs) / MS_PER_HOUR),
    0
  );
  return hoursLate - extensionHours > 0;
}

/**
 * Whole hours a submitted row is late: from the deadline to `closed_at`
 * (truncated, never below zero) less the purchased extension hours, never
 * below zero. The `num_late_hours` computed field's rule, for a row that has
 * been submitted; 0 without a deadline or a submission time.
 */
export const submissionLateHours = (row: LatenessRow): number => {
  const deadline = row.assignment?.student_deadline;
  if (!deadline || !row.closed_at) return 0;
  const deadlineMs = new Date(deadline).getTime();
  if (Number.isNaN(deadlineMs)) return 0;
  const hoursLate = Math.max(
    Math.trunc((new Date(row.closed_at).getTime() - deadlineMs) / MS_PER_HOUR),
    0
  );
  return Math.max(hoursLate - netExtensionHours(row.token_transactions), 0);
};

/** The Classmoji Bot's commit address (template pushes, content checkpoints). */
export const CLASSMOJI_BOT_EMAIL = 'hello@classmoji.com';

export interface CommitAuthorship {
  author_login?: string | null;
  author_email?: string | null;
  ts: Date | string;
}

/**
 * Whether a commit is the student's own work rather than a bot's: not an app
 * (`[bot]` login, e.g. the autograding workflow), not the Classmoji Bot (its
 * template commit), and not dated before the repo existed (the template's
 * history, pushed as is). Without `repoCreatedAt` the date is not checked.
 */
export const isStudentCommit = (
  commit: CommitAuthorship,
  repoCreatedAt?: Date | string | null
): boolean => {
  if (commit.author_login?.endsWith('[bot]')) return false;
  if (commit.author_email?.toLowerCase() === CLASSMOJI_BOT_EMAIL) return false;
  if (repoCreatedAt == null) return true;
  return new Date(commit.ts).getTime() > new Date(repoCreatedAt).getTime();
};

export interface SubmissionCutoffInput {
  /** When the work was submitted (push mode: the push that counts). */
  closed_at: Date | string | null | undefined;
  student_deadline: Date | string | null | undefined;
  token_transactions?: ExtensionTransaction[] | null;
}

/**
 * The moment a submission's work is read at, in epoch ms: its submission time
 * when it has one (a late first push is the submission; a graded row is
 * frozen), else the deadline plus the purchased extension hours. Null when
 * neither exists.
 */
export const submissionCutoffMs = (row: SubmissionCutoffInput): number | null => {
  if (row.closed_at) {
    const closedMs = new Date(row.closed_at).getTime();
    if (!Number.isNaN(closedMs)) return closedMs;
  }
  return extendedDeadlineMs(row.student_deadline, row.token_transactions);
};

/** A commit as the analytics snapshot stores it (`commits` is JSON, so every field is checked). */
export interface SubmittedCommit {
  sha: string;
  message: string | null;
  ts: string | null;
}

/**
 * The commit that stands as a push-mode submission: the newest of the
 * student's own commits (`isStudentCommit`) in the snapshot's list made at or
 * before the submission's cutoff (`submissionCutoffMs`), or the newest overall
 * when there is no cutoff. Null when the list holds no such commit.
 */
export function submittedCommit(
  commits: unknown,
  row: SubmissionCutoffInput & { repo_created_at?: Date | string | null }
): SubmittedCommit | null {
  if (!Array.isArray(commits)) return null;
  const cutoff = submissionCutoffMs(row);
  let best: { commit: SubmittedCommit; t: number } | null = null;
  for (const c of commits as Array<{
    sha?: unknown;
    ts?: unknown;
    message?: unknown;
    author_login?: unknown;
    author_email?: unknown;
  } | null>) {
    if (typeof c?.sha !== 'string' || !c.sha) continue;
    const t = new Date(String(c.ts ?? '')).getTime();
    if (!Number.isFinite(t)) continue;
    if (cutoff !== null && t > cutoff) continue;
    const authorship = {
      author_login: typeof c.author_login === 'string' ? c.author_login : null,
      author_email: typeof c.author_email === 'string' ? c.author_email : null,
      ts: new Date(t),
    };
    if (!isStudentCommit(authorship, row.repo_created_at)) continue;
    if (!best || t > best.t) {
      best = {
        t,
        commit: {
          sha: c.sha,
          message: typeof c.message === 'string' ? c.message : null,
          ts: String(c.ts),
        },
      };
    }
  }
  return best?.commit ?? null;
}
