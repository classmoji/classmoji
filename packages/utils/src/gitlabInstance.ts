/**
 * Self-managed GitLab instances: host normalization and instance-scoped ids.
 * Client-safe: no env reads.
 *
 * One deployment serves gitlab.com (the default instance) and any number of
 * self-managed GitLabs. A GitLab id (user, group, project, issue) is only
 * unique within its instance, so ids from a self-managed instance are stored
 * as `<instance id>:<id>` in every provider id column. Default-instance ids
 * stay bare, so rows from before instances existed need no migration.
 */

export const GITLAB_COM = 'https://gitlab.com';

const SEPARATOR = ':';

/** The stored form of a GitLab id. A null instance is the default one. */
export function scopeGitlabId(
  instanceId: string | null | undefined,
  rawId: string | number
): string {
  return instanceId ? `${instanceId}${SEPARATOR}${rawId}` : String(rawId);
}

/** Split a stored GitLab id back into its instance and the id GitLab knows. */
export function parseGitlabId(stored: string): { instanceId: string | null; rawId: string } {
  const at = stored.lastIndexOf(SEPARATOR);
  return at === -1
    ? { instanceId: null, rawId: stored }
    : { instanceId: stored.slice(0, at), rawId: stored.slice(at + 1) };
}

/**
 * A GitLab host as typed by a person (`gitlab.school.edu`,
 * `https://gitlab.school.edu/users/sign_in`) reduced to its origin. Null when
 * it isn't a usable URL. Plain http is accepted only when `allowHttp` is set
 * (local development against a GitLab container).
 */
export function normalizeGitlabHost(
  input: string | null | undefined,
  { allowHttp = false }: { allowHttp?: boolean } = {}
): string | null {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return null;
  // A bare host is https, except a local development GitLab on localhost.
  const bareScheme = allowHttp && /^localhost(:|\/|$)/i.test(trimmed) ? 'http' : 'https';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `${bareScheme}://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) return null;
  if (url.username || url.password) return null;
  // `localhost` has no dot but is only ever useful in development.
  if (!url.hostname.includes('.') && !(allowHttp && url.hostname === 'localhost')) return null;
  return url.origin.toLowerCase();
}

/** True for gitlab.com however it was written. */
export function isGitlabCom(host: string | null | undefined): boolean {
  return normalizeGitlabHost(host) === GITLAB_COM;
}
