import { ContentService } from '@classmoji/services';

import { migrateHtmlToBlockNote } from '~/utils/migration.server.ts';
import { schema } from '~/components/editor/blocks/index.tsx';
import { withServerBlockNoteLock } from './render.server.ts';

/**
 * Content loading for class websites.
 *
 * ## Why this is not `ClassmojiService.pageContent.loadPageContent`
 *
 * That helper is right for the editor and wrong here, for two reasons that
 * both end in a bad cached response:
 *
 *  1. It **swallows every GitHub failure**. A rate limit, a 5xx, or a revoked
 *     App installation is caught, logged, and returned as `format: 'none'` —
 *     indistinguishable from "this page has no content yet". On the editor
 *     that is a blank page you can retry. On a public site it is a blank page
 *     served with `Cache-Control: public, max-age=60`, so one bad minute of
 *     GitHub gets pinned in front of every reader. Here, a 404 means empty and
 *     anything else throws `SiteContentUnavailableError`, which the route
 *     turns into a 503 with `no-store`.
 *
 *  2. It has **no cache-TTL control**. Site reads want a 5-minute TTL (the
 *     content changes when an instructor saves, and a public reader can wait);
 *     the editor's 60s default exists for a different problem entirely.
 *
 * The narrow classroom select a site loader gets carries only
 * `git_organization: { id, login, provider }` — no `github_installation_id`,
 * by design, because a site loader's return value is one `JSON.stringify`
 * away from an anonymous browser. `ContentService.resolveGitOrganization`
 * short-circuits on a truthy `provider` and would hand that partial record
 * straight to the provider factory, which throws "GitHub provider requires
 * github_installation_id". So site reads pass `orgLogin` and let the service
 * do its own privileged lookup.
 */

/** Site content reads are cached for 5 minutes. */
const SITE_CACHE_TTL_MS = 5 * 60 * 1000;

/** GitHub could not be read — the caller must 503, not render an empty page. */
export class SiteContentUnavailableError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SiteContentUnavailableError';
    this.status = status;
  }
}

export type SitePageContent = {
  format: 'json' | 'html' | 'none';
  /** BlockNote blocks; already migrated when the source was legacy HTML. */
  blocks: unknown[];
  coverImage: { url: string; position?: number } | null;
};

/** The page fields a content read needs. */
export type SiteContentPage = {
  content_path: string;
};

/** The classroom fields a content read needs (the narrow site select). */
export type SiteContentClassroom = {
  content_repo: string | null;
  git_organization: { login: string | null } | null;
};

const statusOf = (error: unknown): number | null => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
};

/**
 * Read one file from the classroom's content repo.
 *
 * Returns null for a genuine 404; rethrows everything else as a typed
 * unavailability so it can never be mistaken for "no content".
 */
async function readContentFile(
  orgLogin: string,
  repo: string,
  path: string
): Promise<{ content: string; sha: string } | null> {
  try {
    return await ContentService.getContent({
      orgLogin,
      repo,
      path,
      cacheTtl: SITE_CACHE_TTL_MS,
    });
  } catch (error) {
    const status = statusOf(error);
    throw new SiteContentUnavailableError(`Content read failed for ${repo}/${path}`, status, {
      cause: error,
    });
  }
}

/**
 * Load a page's content for public rendering.
 *
 * `content.json` first, `index.html` (legacy) second, empty document last —
 * the same precedence the editor uses, so a page looks the same on both
 * surfaces. Legacy HTML always goes through `migrateHtmlToBlockNote`; there is
 * no second HTML rendering path to keep in sync.
 */
export async function loadSitePageContent(
  page: SiteContentPage,
  classroom: SiteContentClassroom
): Promise<SitePageContent> {
  const orgLogin = classroom.git_organization?.login;
  const repo = classroom.content_repo;

  if (!orgLogin || !repo) {
    // A site whose classroom has no content repo cannot have page content.
    // Not an error — an unconfigured classroom renders as an empty page.
    return { format: 'none', blocks: [], coverImage: null };
  }

  const jsonFile = await readContentFile(orgLogin, repo, `${page.content_path}/content.json`);

  if (jsonFile?.content) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonFile.content);
    } catch (error) {
      // Corrupt JSON is a render failure, not an empty page: publishing a
      // blank page over a real one (and caching it) is the worse outcome.
      throw new SiteContentUnavailableError('Page content is not valid JSON', null, {
        cause: error,
      });
    }

    // Two stored shapes: the `{ blocks, coverImage? }` wrapper, and a bare
    // blocks array from before the wrapper existed.
    if (
      parsed &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as { blocks?: unknown }).blocks)
    ) {
      const wrapper = parsed as { blocks: unknown[]; coverImage?: SitePageContent['coverImage'] };
      return {
        format: 'json',
        blocks: wrapper.blocks,
        coverImage: wrapper.coverImage || null,
      };
    }

    return {
      format: 'json',
      blocks: Array.isArray(parsed) ? parsed : [],
      coverImage: null,
    };
  }

  const htmlFile = await readContentFile(orgLogin, repo, `${page.content_path}/index.html`);

  if (htmlFile?.content) {
    // The migration builds its own ServerBlockNoteEditor, so it contends for
    // the same process-global JSDOM as a render — same lock, or the two
    // corrupt each other under concurrency.
    const blocks = await withServerBlockNoteLock(() =>
      migrateHtmlToBlockNote(htmlFile.content, schema)
    );
    return { format: 'html', blocks: blocks as unknown[], coverImage: null };
  }

  return { format: 'none', blocks: [], coverImage: null };
}
