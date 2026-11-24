import { mapBlockAssetRefs } from '@classmoji/utils';
import { extractOwnRepoPath } from './contentRefs.ts';

/**
 * The asset-path rule for the blocks a page create starts with (a markdown
 * import, a batch import, MCP `page_create`'s `html`).
 *
 * The conversion itself (HTML -> blocks, `htmlToPageBlocks` from
 * `@classmoji/page-html`) no longer runs in this package: it needs
 * jsdom and BlockNote's server editor, which the web app and the MCP server
 * must not load. It runs in the `page-import-convert` Trigger task
 * (`pageImport.service.ts`), and `page.createPage` takes the blocks it made.
 */

/**
 * Point the blocks' references to files THIS create committed at their bare
 * repo paths, when the delivery layer will resolve those.
 *
 * The same rule `uploadPageAsset` applies to an editor upload: a bare path
 * (`pages/lab-1/assets/x.png`) is what follows the file through a re-upload, a
 * content-repo rename and a viewer's tier, but only the delivery layer turns
 * one back into something a browser can fetch. So the import's absolute URLs
 * (`raw.githubusercontent.com/{org}/{repo}/main/pages/…`) are rewritten only
 * when `storeRepoPaths` (the classroom is served signed) and only for a file in
 * `committedPaths`, whose map row the create writes. Everything else is left
 * exactly as the HTML had it, which is what the legacy viewer resolved anyway:
 * external images, files committed elsewhere, other repos.
 *
 * A Gitlab import points at the slides app's content proxy by its absolute
 * address (`${SLIDES_URL}/content/{org}/{repo}/…`); that origin is dropped
 * before matching, so those are read as the relative proxy form
 * `extractOwnRepoPath` knows.
 */
export function storeCommittedAssetPaths<T>(
  blocks: T,
  {
    login,
    repo,
    committedPaths,
    storeRepoPaths,
    slidesOrigin = process.env.SLIDES_URL ?? '',
  }: {
    login: string;
    repo: string;
    committedPaths: ReadonlySet<string>;
    storeRepoPaths: boolean;
    /** The slides app's origin (default `SLIDES_URL`). */
    slidesOrigin?: string;
  }
): T {
  if (!storeRepoPaths || committedPaths.size === 0) return blocks;
  const origin = slidesOrigin.replace(/\/+$/, '');
  const proxyPrefix = `${origin}/content/`;
  return mapBlockAssetRefs(blocks, ref => {
    const local = origin && ref.startsWith(proxyPrefix) ? ref.slice(origin.length) : ref;
    const path = extractOwnRepoPath(local, login, repo);
    return path && committedPaths.has(path) ? path : ref;
  });
}
