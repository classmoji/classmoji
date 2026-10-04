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
