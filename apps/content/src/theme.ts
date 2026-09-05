import { treeKey, errorResponse } from './cache.ts';
import { contentTypeForPath } from './content-type.ts';
import type { Env } from './env.ts';
import { GitHubOrigin } from './origins/github.ts';
import type { TreeEntry } from './origins/types.ts';
import { serveBlobBySha } from './blob.ts';
import { withOriginRetry } from './token.ts';
import { cacheControlFor, nowSeconds, type ThemeVerification } from './verify.ts';

/** The success half of the verification union. */
type VerifiedTheme = Extract<ThemeVerification, { ok: true }>;

const origin = new GitHubOrigin();

/**
 * Tree listings are immutable (keyed by tree sha), so R2 is the source of truth
 * after the first fetch.
 *
 * A truncated listing is used for THIS request but never stored: the key is
 * content-addressed and treated as immutable, so a partial listing would 404
 * every omitted file forever, for every classroom sharing that tree sha. Paying
 * the origin fetch again next request is the cheaper mistake.
 */
async function loadTree(
  env: Env,
  ctx: ExecutionContext,
  classroomId: string,
  treeSha: string
): Promise<TreeEntry[]> {
  const key = treeKey(treeSha);
  const hit = await env.CACHE.get(key);
  if (hit) return (await hit.json()) as TreeEntry[];

  const { entries, truncated } = await withOriginRetry(env, classroomId, ref =>
    origin.fetchTree({ ...ref, treeSha })
  );

  if (truncated) {
    console.warn(`[content] refusing to cache truncated tree ${treeSha}`);
    return entries;
  }

  ctx.waitUntil(
    env.CACHE.put(key, JSON.stringify(entries), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
    }).catch(error => {
      console.warn(`[content] failed to cache ${key}:`, error);
    })
  );

  return entries;
}

/** Exact path match against the stored tree — no prefix guessing, no traversal. */
export function findEntry(entries: TreeEntry[], relPath: string): TreeEntry | undefined {
  return entries.find(entry => entry.path === relPath);
}

export async function serveTheme(
  env: Env,
  ctx: ExecutionContext,
  verified: VerifiedTheme,
  head = false
): Promise<Response> {
  // The tree is read either way: a theme URL names a path, and only the listing
  // turns that into the sha a HEAD would look up.
  const entries = await loadTree(env, ctx, verified.classroomId, verified.treeSha);
  const entry = findEntry(entries, verified.relPath);
  if (!entry) return errorResponse(404, 'not found');

  return serveBlobBySha(env, ctx, {
    classroomId: verified.classroomId,
    sha: entry.sha,
    contentType: contentTypeForPath(verified.relPath),
    cacheControl: cacheControlFor(verified.tier, verified.exp, nowSeconds()),
    head,
  });
}
