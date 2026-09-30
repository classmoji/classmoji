/**
 * A stand-in for the two GitHub REST endpoints exploration reads (the Git
 * Trees API and the Contents API), served from a fixture directory. Tests pass
 * `fetchImpl` to `vi.stubGlobal('fetch', ...)`; nothing leaves the process.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_REPOS_DIR = fileURLToPath(new URL('./repos/', import.meta.url));

function listFiles(root: string, dir = root): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(root, full) : [relative(root, full)];
  });
}

export type GithubStub = {
  fetchImpl: (url: string | URL, init?: unknown) => Promise<Response>;
  /** Every URL requested, in order. */
  requested: string[];
};

/** GitHub's answer body when a secondary rate limit is hit. */
export const SECONDARY_RATE_LIMIT_BODY =
  '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again.","documentation_url":"https://docs.github.com/rest/overview/rate-limits-for-the-rest-api","status":"403"}';

/**
 * @param repoDir - the fixture repository's directory name under `repos/`
 * @param o.failPaths - paths whose Contents request answers 404
 * @param o.treeStatus - a status for the tree request instead of 200
 * @param o.limited - how many times the tree (`tree`) or a path answers
 *   `limitStatus` with `limitBody` (default: 403 with the secondary rate limit
 *   body, no retry-after) before answering normally
 */
export function githubStub(
  repoDir: string,
  o: {
    failPaths?: string[];
    treeStatus?: number;
    limited?: { tree?: number; paths?: Record<string, number> };
    limitStatus?: number;
    limitBody?: string;
  } = {}
): GithubStub {
  const root = join(FIXTURE_REPOS_DIR, repoDir);
  const files = listFiles(root).sort();
  const requested: string[] = [];
  let treeLimitsLeft = o.limited?.tree ?? 0;
  const pathLimitsLeft = new Map<string, number>(Object.entries(o.limited?.paths ?? {}));
  const limitedAnswer = () =>
    new Response(o.limitBody ?? SECONDARY_RATE_LIMIT_BODY, { status: o.limitStatus ?? 403 });

  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/git/trees/')) {
      if (treeLimitsLeft > 0) {
        treeLimitsLeft -= 1;
        return limitedAnswer();
      }
      if (o.treeStatus && o.treeStatus !== 200) {
        return new Response('{"message":"Not Found"}', { status: o.treeStatus });
      }
      const tree = files.map(path => ({
        path,
        type: 'blob',
        mode: '100644',
        size: statSync(join(root, path)).size,
      }));
      return Response.json({ tree });
    }
    const match = url.match(/\/contents\/(.+)$/);
    if (match) {
      const path = match[1].split('/').map(decodeURIComponent).join('/');
      const left = pathLimitsLeft.get(path) ?? 0;
      if (left > 0) {
        pathLimitsLeft.set(path, left - 1);
        return limitedAnswer();
      }
      if (o.failPaths?.includes(path) || !files.includes(path)) {
        return new Response('{"message":"Not Found"}', { status: 404 });
      }
      return Response.json({
        type: 'file',
        path,
        encoding: 'base64',
        content: readFileSync(join(root, path)).toString('base64'),
      });
    }
    return new Response('{}', { status: 404 });
  };

  return { fetchImpl, requested };
}
