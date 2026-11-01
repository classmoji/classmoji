/** Pure helpers for people rows (unit-tested). */

export const ROLE_RANK = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'] as const;

/**
 * The one role to show for a person across their classrooms: their highest
 * accepted role, else "PENDING" if every membership is still an invite, else
 * null for nobody's member.
 */
export const highestRole = (
  memberships: Array<{ role: string; has_accepted_invite: boolean }>
): string | null => {
  const accepted = memberships.filter(m => m.has_accepted_invite);
  const top = ROLE_RANK.find(r => accepted.some(m => m.role === r));
  if (top) return top;
  return memberships.length > 0 ? 'PENDING' : null;
};

/** "dartmouth.edu" from an email, or null. */
export const emailDomain = (email: string | null | undefined): string | null => {
  const at = email?.lastIndexOf('@') ?? -1;
  return email && at > 0 ? email.slice(at + 1).toLowerCase() : null;
};

/** Distinct classrooms, not role rows: an owner who also teaches is one class. */
export const distinctClassrooms = (memberships: Array<{ classroom_id: string }>) =>
  new Set(memberships.map(m => m.classroom_id)).size;
