import { getGitProvider } from '../git/index.ts';

/**
 * The branch a classroom's content repo actually serves.
 *
 * Asked, never assumed. A course imported from an older org is on `master`, and
 * against such a repo a hardcoded `main` does not read stale content — the tree
 * call 404s, the sync throws, and the classroom keeps an empty map while every
 * asset falls back to the legacy path. One `GET /repos` per call buys the
 * difference.
 *
 * Deliberately NOT memoised. A default branch can be renamed, the value is only
 * ever read on the far side of a network call that dwarfs it, and a cache here
 * would need invalidating from a place that has no idea this module exists.
 *
 * Lives here, beside `ContentService`, rather than in `contentAssets.service`
 * (which re-exports it): that module imports `ContentService`, and
 * `ContentService.upload` needs this too.
 */
export async function resolveContentBranch(
  gitOrganization: Parameters<typeof getGitProvider>[0],
  org: string,
  repo: string
): Promise<string> {
  return getGitProvider(gitOrganization).getDefaultBranch(org, repo);
}
