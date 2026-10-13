import { mapBlockAssetRefs } from '@classmoji/utils';
import { extractOwnRepoPath } from './contentRefs.ts';

/**
 * HTML handed to a page create (a markdown import, a batch import, MCP
 * `page_create`'s `html`) -> the blocks its `content.json` starts with.
 *
 * The conversion is `htmlToPageBlocks` from `@classmoji/page-schema/server`,
 * the converter the viewer, the class site and live editing already run on a
 * legacy `index.html`, so a page created from HTML holds exactly the blocks it
 * would have been shown as.
 *
 * Loaded on first use, and on purpose: the server entry pulls in BlockNote's
 * server editor and jsdom, which nothing else in this package needs and which
 * every service that imports `@classmoji/services` would otherwise load at
 * startup. `@classmoji/page-schema` is a workspace package resolved from the
 * root node_modules; this package's package.json does not list it (adding it
 * needs a lockfile refresh).
 */

type PageSchemaServer = {
  htmlToPageBlocks: (html: string, options?: { title?: string }) => Promise<unknown[]>;
};

let loading: Promise<PageSchemaServer> | null = null;

function loadPageSchemaServer(): Promise<PageSchemaServer> {
  // eslint-disable-next-line import/no-unresolved -- a workspace package, see above
  loading ??= import('@classmoji/page-schema/server').then(
    module => module as unknown as PageSchemaServer,
    error => {
      // A failed load is not cached: the next create tries again.
      loading = null;
      throw error;
    }
  );
  return loading;
}

/**
 * Legacy page HTML -> page blocks. The converter runs one conversion at a
 * time per process itself (BlockNote's server editor swaps the process's
 * `window`/`document` while it parses), so concurrent creates need no queue
 * here.
 */
export async function convertPageHtml(html: string, { title }: { title?: string } = {}) {
  const { htmlToPageBlocks } = await loadPageSchemaServer();
  return htmlToPageBlocks(html, title ? { title } : {});
}

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
 */
export function storeCommittedAssetPaths<T>(
  blocks: T,
  {
    login,
    repo,
    committedPaths,
    storeRepoPaths,
  }: {
    login: string;
    repo: string;
    committedPaths: ReadonlySet<string>;
    storeRepoPaths: boolean;
  }
): T {
  if (!storeRepoPaths || committedPaths.size === 0) return blocks;
  return mapBlockAssetRefs(blocks, ref => {
    const path = extractOwnRepoPath(ref, login, repo);
    return path && committedPaths.has(path) ? path : ref;
  });
}
