import getPrisma from '@classmoji/database';

/** One instructor, shaped the way a marketing contact record wants them. */
export interface InstructorContact {
  email: string;
  firstName: string;
  lastName: string;
}

// First token is the first name, the rest is the last name. No parse is right
// for every row; only the first name matters, since that greets them in a mail.
const splitName = (fullName: string): { firstName: string; lastName: string } => {
  const trimmed = fullName.trim();
  const boundary = trimmed.indexOf(' ');
  if (boundary === -1) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.slice(0, boundary),
    lastName: trimmed.slice(boundary + 1).trim(),
  };
};

/**
 * Every user who owns at least one real classroom.
 *
 * The `is_example` filter is load-bearing: everyone who finishes onboarding
 * owns a sandbox classroom, so without it this returns every user who has ever
 * signed in.
 */
export const listInstructorContacts = async (): Promise<InstructorContact[]> => {
  const users = await getPrisma().user.findMany({
    where: {
      banned: false,
      classroom_memberships: {
        some: { role: 'OWNER', classroom: { is_example: false } },
      },
    },
    select: { email: true, provider_email: true, name: true },
  });

  // `email` and `provider_email` are both nullable and distinct, so reading
  // either alone silently drops users. `provider_email` is not unique, so two
  // rows can coalesce onto one address: dedupe on the address the mail provider
  // keys on.
  const seen = new Set<string>();
  const contacts: InstructorContact[] = [];

  for (const user of users) {
    const email = (user.email || user.provider_email || '').trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    contacts.push({ email, ...splitName(user.name || '') });
  }

  return contacts;
};
