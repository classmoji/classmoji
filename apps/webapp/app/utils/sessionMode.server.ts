import getPrisma from '@classmoji/database';

export type GitMode = 'GITHUB' | 'GITLAB';

/**
 * The session's mode: the provider it signed in with (recorded on the session
 * row at sign-in). A password sign-in, or a session from before that was
 * recorded, falls back to `fallback`: Github when the user has it connected,
 * else Gitlab when they have that (see `fallbackMode`). A GitLab session is
 * shown only GitLab classrooms and GitLab identity; a Github session only
 * Github ones.
 */
export function sessionMode(session: unknown, fallback: GitMode | null | undefined): GitMode {
  const recorded = (session as { session?: { sign_in_provider?: string | null } } | null)?.session
    ?.sign_in_provider;
  const mode = recorded ?? fallback ?? 'GITHUB';
  return mode === 'GITLAB' ? 'GITLAB' : 'GITHUB';
}

/** Mode for a session that recorded none: Github if connected, else Gitlab if connected. */
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
