import getPrisma from '@classmoji/database';

export type GitMode = 'GITHUB' | 'GITLAB';

/**
 * The session's mode: the provider it signed in with (recorded on the session
 * row at sign-in), else the user's own provider for sessions from before that
 * was recorded. A GitLab session is shown only GitLab classrooms and GitLab
 * identity; a Github session only Github ones.
 */
export function sessionMode(session: unknown, userProvider: string | null | undefined): GitMode {
  const recorded = (session as { session?: { sign_in_provider?: string | null } } | null)?.session
    ?.sign_in_provider;
  const mode = recorded ?? userProvider ?? 'GITHUB';
  return mode === 'GITLAB' ? 'GITLAB' : 'GITHUB';
}

/** The user's username on the mode's provider (their connected account's), if known. */
export async function usernameForMode(userId: string, mode: GitMode): Promise<string | null> {
  const account = await getPrisma().account.findFirst({
    where: { user_id: userId, provider_id: mode.toLowerCase(), username: { not: null } },
    select: { username: true },
  });
  return account?.username ?? null;
}

/** `/admin/<slug>/...`-style paths name a classroom as their second segment. */
const CLASSROOM_PREFIXES = new Set(['admin', 'student', 'assistant', 'teacher']);
export function classroomSlugFromPath(pathname: string): string | null {
  const [, prefix, slug] = pathname.split('/');
  return prefix && CLASSROOM_PREFIXES.has(prefix) && slug ? slug : null;
}
