import { task, logger } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { ClassmojiService, ContentService } from '@classmoji/services';

import {
  BrowserRunError,
  isBrowserRunConfigured,
  screenshotToBase64,
} from '../helpers/browserRun.ts';

/**
 * Render one deck's card image and commit it into the classroom's content repo.
 *
 * The slides index used to draw every deck as a live `<iframe>` of the deck.
 * This produces the picture that replaces them: Cloudflare Browser Run opens a
 * token-gated route showing the deck's first slide, and the resulting WebP is
 * committed at `{content_path}/thumbnail.webp` — beside `deck.json` and
 * `index.html`, in the classroom's own repo, so it inherits the delivery layer
 * already in place rather than needing storage of its own. Deletion comes free:
 * `deleteSlide` removes the whole folder and drops the asset rows with it.
 *
 * ── THE LOOP GUARD ─────────────────────────────────────────────────────────
 * This task MUST NEVER call `saveDeck`, `saveDeckWithMerge`, `saveDeckFromOps`
 * or `recordDeckFiles`. Those are the deck WRITE paths, and the enqueue for
 * this task lives inside them — a thumbnail commit routed through one would
 * enqueue another render, forever. It commits through `ContentService.upload-
 * Batch` directly and writes its own asset row with `recordContentAsset`, which
 * is the same write-through the save path does, minus the enqueue. A test
 * asserts the absence structurally, because "we remembered not to" is not a
 * guarantee.
 *
 * It also cannot disturb the editor's post-save refresh: `settleSaveRefresh`
 * compares `deck.json`'s blob sha, and a thumbnail commit never touches that
 * file.
 *
 * ── IDEMPOTENCE ────────────────────────────────────────────────────────────
 * Step 2 compares the deck's CURRENT `index.html` blob sha against the one the
 * stored thumbnail was rendered from, and returns without booting a browser
 * when they match. That is what makes a bulk backfill, a Trigger retry and a
 * save that only touched slide 40 all no-ops. It also bounds git growth: a
 * WebP does not delta-compress, so every render that lands is a whole new
 * object in the repo's history whether or not the picture changed.
 *
 * ── FAILURE ────────────────────────────────────────────────────────────────
 * A render that fails keeps the thumbnail already in the repo. Nothing is ever
 * deleted and no placeholder is ever committed — the index draws its own
 * placeholder for a deck that has none, which is strictly better than a repo
 * full of grey rectangles nobody can tell from real ones. 429 and 5xx rethrow
 * so the retry policy can have another go; a 4xx that means "this page will not
 * render" returns quietly, because retrying it three times changes nothing.
 */

/** How long the whole navigation may take. Browser Run caps this at 60s. */
const NAVIGATION_TIMEOUT_MS = 30000;

/** How long to wait for the render page to declare itself painted. */
const READY_TIMEOUT_MS = 15000;

export interface DeckThumbnailPayload {
  slideId: string;
}

export type DeckThumbnailResult =
  | { status: 'skipped'; reason: string }
  | { status: 'unchanged'; sha: string }
  | { status: 'rendered'; path: string; sha: string; bytes: number; commit: string }
  | { status: 'failed'; reason: string };

/**
 * The blob sha of the deck's rendered document.
 *
 * The asset map answers first and usually: the save path writes the row through
 * at commit time, so the sha is already there by the time this runs. A classroom
 * the delivery layer does not serve has no map at all, and one GitHub metadata
 * read is well worth it — without a sha there is no skip check, and without the
 * skip check every save of every deck commits a fresh WebP.
 */
async function currentIndexSha(
  classroomId: string,
  gitOrganization: unknown,
  repo: string,
  path: string
): Promise<string | null> {
  const row = await ClassmojiService.contentAssets.lookupContentAsset(classroomId, path);
  if (row?.sha) return row.sha;

  try {
    const meta = await ContentService.getMeta({
      gitOrganization: gitOrganization as never,
      repo,
      path,
      skipCache: true,
    });
    return meta?.sha ?? null;
  } catch (error: unknown) {
    logger.warn('Could not read index.html sha; rendering without the skip check', {
      classroomId,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export const deckThumbnailRender = task({
  id: 'deck-thumbnail-render',
  /**
   * Four browsers at a time across the whole platform.
   *
   * Two orders of magnitude under Browser Run's ceilings (120 concurrent
   * browsers, 1 new instance/second, 10 REST requests/second), and the throttle
   * for the one-shot backfill as well — the backfill script triggers a run per
   * deck and lets this queue meter them, rather than pacing itself.
   */
  queue: { concurrencyLimit: 4 },
  /** A render is ~6s. Two minutes is the point at which something is wrong. */
  maxDuration: 120,
  retry: { maxAttempts: 3, minTimeoutInMs: 5000 },
  run: async (payload: DeckThumbnailPayload): Promise<DeckThumbnailResult> => {
    const { slideId } = payload;

    if (!isBrowserRunConfigured()) {
      logger.warn('Browser Run is not configured; skipping thumbnail render', { slideId });
      return { status: 'skipped', reason: 'browser-run-unconfigured' };
    }

    const slidesOrigin = process.env.SLIDES_URL;
    if (!slidesOrigin) {
      logger.warn('SLIDES_URL is unset; skipping thumbnail render', { slideId });
      return { status: 'skipped', reason: 'slides-url-unset' };
    }

    // 1. The deck, its classroom, and the git org whose installation commits.
    const slide = await getPrisma().slide.findUnique({
      where: { id: slideId },
      include: { classroom: { include: { git_organization: true } } },
    });
    if (!slide) return { status: 'skipped', reason: 'slide-not-found' };

    const gitOrganization = slide.classroom?.git_organization ?? null;
    const repo = slide.classroom?.content_repo ?? null;
    if (!gitOrganization?.login || !repo) {
      return { status: 'skipped', reason: 'no-content-repo' };
    }

    const indexPath = `${slide.content_path}/index.html`;
    const thumbnailPath = ClassmojiService.deckThumbnail.thumbnailPathFor(slide.content_path);

    // 2-3. Skip when the document this thumbnail was taken of has not moved.
    const indexSha = await currentIndexSha(slide.classroom_id, gitOrganization, repo, indexPath);
    if (indexSha && indexSha === slide.thumbnail_rendered_sha && slide.thumbnail_path) {
      logger.info('Deck unchanged since its thumbnail was rendered', { slideId, sha: indexSha });
      return { status: 'unchanged', sha: indexSha };
    }

    // 4. Mint the token HERE, immediately before the POST. Its 120s life is
    //    what bounds a leak, and it must not be spent waiting on this queue.
    const token = await ClassmojiService.deckRenderToken.signDeckRenderToken({
      origin: slidesOrigin,
      classroomId: slide.classroom_id,
      slideId: slide.id,
      keyVersion: slide.classroom?.content_key_version,
    });
    if (!token) {
      logger.warn('CONTENT_SIGNING_SECRET is unset; skipping thumbnail render', { slideId });
      return { status: 'skipped', reason: 'signing-unconfigured' };
    }

    // 5. Screenshot. The token is in the URL, so the URL is never logged.
    let base64: string;
    try {
      base64 = await screenshotToBase64({
        url: ClassmojiService.deckThumbnail.thumbnailSourceUrl(slidesOrigin, slide.id, token),
        width: ClassmojiService.deckThumbnail.THUMBNAIL_WIDTH,
        height: ClassmojiService.deckThumbnail.THUMBNAIL_HEIGHT,
        readySelector: ClassmojiService.deckThumbnail.THUMBNAIL_READY_SELECTOR,
        quality: ClassmojiService.deckThumbnail.THUMBNAIL_WEBP_QUALITY,
        navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
        readyTimeoutMs: READY_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      if (error instanceof BrowserRunError && error.retryable) {
        // Rethrow so the task's own retry policy handles it. The `Retry-After`
        // a 429 carries is logged rather than slept on: sleeping would spend
        // this run's maxDuration to save a scheduling round trip.
        logger.warn('Browser Run asked us to back off', {
          slideId,
          status: error.status,
          retryAfterSeconds: error.retryAfterSeconds,
        });
        throw error;
      }
      // Everything else: the deck keeps whatever thumbnail it has. Nothing is
      // deleted, nothing is written, and the index falls back to a placeholder
      // only for decks that never had one.
      logger.error('Thumbnail render failed; keeping the existing thumbnail', {
        slideId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      };
    }

    // 6. Commit. `uploadBatch` is the only commit path that carries binary —
    //    `put` and `putFile` are UTF-8 only and would corrupt a WebP.
    //    `primeCache: false` because that cache deliberately skips base64 and
    //    image paths anyway, and nothing reads this file back in-process.
    const upload = await ContentService.uploadBatch({
      gitOrganization: gitOrganization as never,
      repo,
      files: [{ path: thumbnailPath, content: base64, encoding: 'base64' }],
      message: `chore(thumbnail): ${slide.slug}`,
      primeCache: false,
    });

    const committed = upload.files.find(file => file.path === thumbnailPath);
    const bytes = Buffer.from(base64, 'base64').length;

    // 7. Write the asset row through, exactly as a save does. Returns false for
    //    a classroom the delivery layer does not serve; that is not a failure,
    //    and the file is committed either way.
    if (committed?.sha) {
      await ClassmojiService.contentAssets.recordContentAsset(slide.classroom_id, {
        path: thumbnailPath,
        sha: committed.sha,
        size: bytes,
      });
    }

    // 8. Record what was rendered and from which document. `thumbnail_rendered_sha`
    //    is the index.html sha, NOT the thumbnail's own — it is the answer to
    //    "has the deck changed since the picture was taken?".
    await getPrisma().slide.update({
      where: { id: slide.id },
      data: {
        thumbnail_path: thumbnailPath,
        thumbnail_rendered_sha: indexSha,
        thumbnail_rendered_at: new Date(),
      },
    });

    logger.info('Rendered deck thumbnail', {
      slideId,
      path: thumbnailPath,
      bytes,
      commit: upload.commit,
    });

    return {
      status: 'rendered',
      path: thumbnailPath,
      sha: committed?.sha ?? '',
      bytes,
      commit: upload.commit,
    };
  },
});
