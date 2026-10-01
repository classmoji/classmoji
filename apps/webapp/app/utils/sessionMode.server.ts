import getPrisma from '@classmoji/database';

export type GitMode = 'GITHUB' | 'GITLAB';

/**
 * Which provider's words and username apply. A person sees every classroom
 * they belong to, Github and Gitlab alike, whichever way they signed in; inside
 * a classroom its provider decides, and outside one this does: Github when they
 * have it connected, else Gitlab when they have that.
 */
export const fallbackMode = (identity: { has_github: boolean; has_gitlab: boolean }): GitMode =>
  !identity.has_github && identity.has_gitlab ? 'GITLAB' : 'GITHUB';

/** `fallbackMode` for a user, read from their connected git accounts. */
export async function userFallbackMode(userId: string): Promise<GitMode> {
  const accounts = await getPrisma().account.findMany({
    where: { user_id: userId, provider_id: { in: ['github', 'gitlab'] }, username: { not: null } },
    select: { provider_id: true },
  });
  return fallbackMode({
    has_github: accounts.some(a => a.provider_id === 'github'),
    has_gitlab: accounts.some(a => a.provider_id === 'gitlab'),
  });
}

/** `/admin/<slug>/...`-style paths name a classroom as their second segment. */
const CLASSROOM_PREFIXES = new Set(['admin', 'student', 'assistant', 'teacher']);
export function classroomSlugFromPath(pathname: string): string | null {
  const [, prefix, slug] = pathname.split('/');
  return prefix && CLASSROOM_PREFIXES.has(prefix) && slug ? slug : null;
}
