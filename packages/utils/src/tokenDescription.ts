/**
 * The description a quiz extension writes on its token ledger row, and the
 * title read back from it.
 *
 * A quiz extension row is written as "<title> · +N h" (a purchase) or
 * "<title> · −N h" (its refund), with the assignment's title at the time.
 * Once the assignment is deleted the row keeps no link to it (the link is set
 * null, the row stays), so the title is read back from the description.
 */

const DESCRIPTION = /^(.+) · [+−]\d+ h$/u;

/** The ledger description of a quiz extension row: the title, then the hours. */
export const quizExtensionDescription = (title: string, hours: number): string =>
  hours < 0 ? `${title} · −${Math.abs(hours)} h` : `${title} · +${hours} h`;

/**
 * The title a quiz extension row was written with, or null when the
 * description is not one.
 */
export const titleFromQuizExtensionDescription = (
  description: string | null | undefined
): string | null => DESCRIPTION.exec(description ?? '')?.[1] ?? null;

/** The ledger row fields `transactionAssignmentTitle` reads. Structural. */
export interface LedgerRowAssignmentFields {
  hours_purchased?: number | null;
  description?: string | null;
  assignment_id?: string | null;
  git_repo_assignment_id?: string | null;
  assignment?: { title?: string | null } | null;
  git_repo_assignment?: { assignment?: { title?: string | null } | null } | null;
}

/**
 * The assignment a ledger row is about: a quiz extension's own assignment,
 * else the repo submission's assignment. A row that bought or refunded hours
 * (`hours_purchased` set) and links to nothing any more is a quiz extension
 * whose assignment was deleted: its title is read back from the description.
 * Any other row (a grant, a removal) names no assignment, whatever its free
 * text says. Null when the row names none.
 */
export const transactionAssignmentTitle = (row: LedgerRowAssignmentFields): string | null => {
  const linked = row.assignment?.title ?? row.git_repo_assignment?.assignment?.title;
  if (linked) return linked;
  if (row.hours_purchased == null) return null;
  if (row.assignment_id || row.git_repo_assignment_id || row.git_repo_assignment) return null;
  return titleFromQuizExtensionDescription(row.description);
};
