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

/**
 * @param repoDir - the fixture repository's directory name under `repos/`
 * @param o.failPaths - paths whose Contents request answers 404
 * @param o.treeStatus - a status for the tree request instead of 200
 */
export function githubStub(
  repoDir: string,
  o: { failPaths?: string[]; treeStatus?: number } = {}
): GithubStub {
  const root = join(FIXTURE_REPOS_DIR, repoDir);
  const files = listFiles(root).sort();
  const requested: string[] = [];

  const fetchImpl = async (input: string | URL): Promise<Response> => {
    const url = String(input);
    requested.push(url);
    if (url.includes('/git/trees/')) {
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
