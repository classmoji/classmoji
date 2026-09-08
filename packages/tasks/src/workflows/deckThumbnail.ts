import { task, logger, wait } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { ClassmojiService, ContentService } from '@classmoji/services';

import {
  BrowserRunError,
  isBrowserRunConfigured,
  redactRenderToken,
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
 * Before any of that: a deck whose document is not in the repo is SKIPPED, not
 * rendered and not failed. Step 2a catches it from the same metadata read the
 * skip check already makes, so no token is minted and no browser is booted for
 * a page that could only refuse.
 *
 * A render that fails keeps the thumbnail already in the repo. Nothing is ever
 * deleted and no placeholder is ever committed — the index draws its own
 * placeholder for a deck that has none, which is strictly better than a repo
 * full of grey rectangles nobody can tell from real ones. 429 and 5xx rethrow
 * so the retry policy can have another go; a 4xx that means "this page will not
 * render" returns quietly, because retrying it three times changes nothing.
 *
 * Either way `thumbnail_rendered_at` is stamped. It is the LAST ATTEMPT, not
 * the last success — the index rate-limits its on-view enqueue off that column,
 * and a deck whose renders keep failing is exactly the deck that would otherwise
 * be re-asked for by every page load forever.
 */

/**
 * How long the whole navigation may take — the spec's maximum, deliberately.
 *
 * The render route itself answers in ~460ms. What this budget is actually for
 * is the slides app's Fly machine having scaled to zero: the first staging run
 * spent its entire 30s on a cold start and never reached a page at all. A cold
 * boot is the ordinary case for the first render after a quiet period, not an
 * anomaly, and failing it costs a browser and a retry to learn nothing.
 */
const NAVIGATION_TIMEOUT_MS = 60000;

/**
 * How long to wait for the render page to declare itself painted.
 *
 * This is the gate that means something — `[data-thumbnail-ready]` goes up only
 * on a page the route actually served, and the page's own hard cap on settling
 * is 8s. Thirty seconds leaves room for a deck whose images come from a cold
 * content Worker without ever being the thing that decides a render.
 */
const READY_TIMEOUT_MS = 30000;

/**
 * The longest we will sit on a 429's `Retry-After` before rethrowing.
 *
 * `maxDuration` is 180s and a render costs ~6s of it, so honouring an
 * arbitrarily long back-off would spend the whole run waiting and then be killed
 * for it. Past this the retry policy's own scheduling is the better instrument:
 * it costs nothing to wait between attempts.
 */
const MAX_RETRY_AFTER_SECONDS = 90;

export interface DeckThumbnailPayload {
  slideId: string;
  /**
   * Render even when the deck's `index.html` has not moved.
   *
   * The sha check answers "has the DECK changed?", which is the right question
   * for a save and the wrong one for a THEME edit: the same document renders
   * differently under new CSS, and every deck in the classroom is stale while
   * its sha says otherwise. The new sha is still recorded afterwards.
   */
  force?: boolean;
}

export type DeckThumbnailResult =
  | { status: 'skipped'; reason: string }
  | { status: 'unchanged'; sha: string }
  | { status: 'rendered'; path: string; sha: string; bytes: number; commit: string }
  | { status: 'failed'; reason: string };

/**
 * What is known about the deck's rendered document.
 *
 * Three answers, not two, and the third is the point. "No sha" used to mean
 * both "the file is not there" and "we could not find out", and the task
 * rendered on either — so a classroom whose repo this installation cannot read
 * booted a browser, navigated to a route that could only 500, and then sat out
 * the whole `waitForSelector` budget before failing. Those are different
 * situations with opposite right answers: absent means there is nothing to
 * photograph and the run should end; unknown means render and simply do not
 * touch the recorded sha afterwards.
 */
type IndexDocumentLookup =
  /** The sha to compare against, and to record once a render lands. */
  | { kind: 'known'; sha: string }
  /** GitHub answered 404: no such file, on a repo we can read or cannot. */
  | { kind: 'absent' }
  /** The read failed. Render anyway; the stored sha stays as it was. */
  | { kind: 'unknown' };

/**
 * Resolve that, from the asset map first and GitHub second.
 *
 * The asset map answers first and usually: the save path writes the row through
 * at commit time, so the sha is already there by the time this runs. A classroom
 * the delivery layer does not serve has no map at all, and one GitHub metadata
 * read is well worth it — without a sha there is no skip check, and without the
 * skip check every save of every deck commits a fresh WebP.
 *
 * `getMeta` is what makes `absent` distinguishable at all: it answers `null` for
 * a 404 and RETHROWS everything else, so a null here is GitHub saying the file
 * is not there rather than a request that went wrong.
 */
async function currentIndexSha(
  classroomId: string,
  gitOrganization: unknown,
  repo: string,
  path: string
): Promise<IndexDocumentLookup> {
  const row = await ClassmojiService.contentAssets.lookupContentAsset(classroomId, path);
  if (row?.sha) return { kind: 'known', sha: row.sha };

  try {
    const meta = await ContentService.getMeta({
      gitOrganization: gitOrganization as never,
      repo,
      path,
      skipCache: true,
    });
    if (meta?.sha) return { kind: 'known', sha: meta.sha };
    // A metadata row with no sha is not a 404 and is not an answer either.
    return meta === null ? { kind: 'absent' } : { kind: 'unknown' };
  } catch (error: unknown) {
    logger.warn('Could not read index.html sha; rendering without the skip check', {
      classroomId,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return { kind: 'unknown' };
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
  /**
   * A render is ~6s; this is the ceiling for the case where nothing goes right.
   *
   * It has to exceed the worst legal render end to end — 60s of navigation, then
   * 30s waiting on the readiness selector, then the commit — or the run is
   * killed at the exact moment the budget it was given would have paid off. Two
   * minutes did not clear that; three does, with room for the commit.
   */
  maxDuration: 180,
  retry: { maxAttempts: 3, minTimeoutInMs: 5000 },
  run: async (payload: DeckThumbnailPayload): Promise<DeckThumbnailResult> => {
    const { slideId, force = false } = payload;

    // ERROR, not warn: a deployment missing these renders no thumbnails at all
    // and says so on every run. That is a configuration fault someone has to
    // fix, not a condition to be noted — and the message names the variable so
    // the fix does not need a code read.
    if (!isBrowserRunConfigured()) {
      logger.error(
        'CLOUDFLARE_ACCOUNT_ID and/or CLOUDFLARE_BROWSER_RENDERING_TOKEN are unset; no deck thumbnails can be rendered',
        { slideId }
      );
      return { status: 'skipped', reason: 'browser-run-unconfigured' };
    }

    const slidesOrigin = process.env.SLIDES_URL;
    if (!slidesOrigin) {
      logger.error('SLIDES_URL is unset; no deck thumbnails can be rendered', { slideId });
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

    // 2-3. Skip when the document this thumbnail was taken of has not moved —
    //      unless the caller knows something the sha cannot express. A theme
    //      edit changes how every deck in a classroom LOOKS without touching a
    //      byte of any of them.
    const lookup = await currentIndexSha(slide.classroom_id, gitOrganization, repo, indexPath);

    // 2a. Nothing to photograph. The document this task exists to render is not
    //     in the repo — the deck was never generated, or this installation
    //     cannot read the repo at all, which is the ordinary state of a staging
    //     classroom copied from production.
    //
    //     BEFORE the token is minted, and before Browser Run is called: a render
    //     of a deck with no content cannot succeed, and the way it fails is
    //     expensive. The route answers a refusal, the readiness selector never
    //     appears, and the browser sits out the entire `waitForSelector` budget
    //     to reach a conclusion available here for one metadata read.
    //
    //     `force` does not override this. Force means "the sha is answering the
    //     wrong question"; it cannot conjure a document that is not there.
    //
    //     INFO, not warn: for a staging classroom this is the correct and
    //     permanent state of affairs, and a warning per deck per save would
    //     train everyone to ignore the channel.
    if (lookup.kind === 'absent') {
      logger.info('Deck has no rendered document in the content repo; nothing to screenshot', {
        slideId,
        path: indexPath,
      });
      return { status: 'skipped', reason: 'no-content' };
    }

    const indexSha = lookup.kind === 'known' ? lookup.sha : null;
    if (!force && indexSha && indexSha === slide.thumbnail_rendered_sha && slide.thumbnail_path) {
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

    // 5. Screenshot. The token travels as a host-scoped COOKIE, so the URL
    //    carries no credential and is safe in an access log, and no cross-host
    //    subresource the page fetches can ever receive it — the render route
    //    reads nothing else.
    let base64: string;
    try {
      base64 = await screenshotToBase64({
        url: ClassmojiService.deckThumbnail.thumbnailSourceUrl(slidesOrigin, slide.id),
        cookies: [ClassmojiService.deckThumbnail.renderTokenCookie(slidesOrigin, token)],
        width: ClassmojiService.deckThumbnail.THUMBNAIL_WIDTH,
        height: ClassmojiService.deckThumbnail.THUMBNAIL_HEIGHT,
        readySelector: ClassmojiService.deckThumbnail.THUMBNAIL_READY_SELECTOR,
        quality: ClassmojiService.deckThumbnail.THUMBNAIL_WEBP_QUALITY,
        navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
        readyTimeoutMs: READY_TIMEOUT_MS,
      });
    } catch (error: unknown) {
      // Every message from here on is redacted before it is logged or returned.
      // Cloudflare quotes the request back in some of its errors, and this run's
      // `reason` is stored on the run itself where anyone can read it.
      const reason = redactRenderToken(error instanceof Error ? error.message : String(error));

      if (error instanceof BrowserRunError && error.retryable) {
        // A 429 that names a back-off is HONOURED before the rethrow. Retrying
        // into a closed window just burns the attempt budget and arrives at the
        // same 429; capped, because this run has a `maxDuration` to keep.
        const retryAfter = error.retryAfterSeconds;
        if (retryAfter !== null && retryAfter > 0) {
          const seconds = Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS);
          logger.warn('Browser Run asked us to back off; waiting before the retry', {
            slideId,
            status: error.status,
            retryAfterSeconds: retryAfter,
            waitingSeconds: seconds,
          });
          await wait.for({ seconds });
        } else {
          logger.warn('Browser Run asked us to back off', {
            slideId,
            status: error.status,
            retryAfterSeconds: retryAfter,
          });
        }
        // Rethrow into the task's own retry policy either way: the wait was the
        // server's instruction, the retry is ours.
        throw error;
      }

      // Everything else: the deck keeps whatever thumbnail it has. Nothing is
      // deleted, nothing is committed, and the index falls back to a placeholder
      // only for decks that never had one. The ATTEMPT is recorded, though —
      // see `thumbnail_rendered_at` below.
      logger.error('Thumbnail render failed; keeping the existing thumbnail', {
        slideId,
        error: reason,
      });

      // The path and the sha are left exactly as they were: the row must keep
      // pointing at the picture that is actually in the repo. Only the attempt
      // clock moves, which is what stops the index re-asking on every load.
      await getPrisma().slide.update({
        where: { id: slide.id },
        data: { thumbnail_rendered_at: new Date() },
      });

      return { status: 'failed', reason };
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

      // 7b. Pull it through the Worker at the tier the index will sign, so the
      //     first person to open the index does not wait on a cold origin pull.
      //     This is the one page that asks for twenty cold images at once, which
      //     is the case a warm is for.
      //
      //     AFTER the row above — the warm looks the sha up in the map — and not
      //     awaited: the thumbnail is committed and recorded, and a cache fill
      //     may not fail or delay a run that has already done its work. The
      //     visibility passed is the DECK's own, because that is what
      //     `tierFor` gets on the read side; anything else fills an entry
      //     nobody asks for.
      if (slide.classroom) {
        void ClassmojiService.contentDelivery.warmContentBlob(
          {
            classroom: {
              id: slide.classroom.id,
              content_key_version: slide.classroom.content_key_version,
              content_delivery_enabled: slide.classroom.content_delivery_enabled,
            },
          },
          [thumbnailPath],
          { isPublic: slide.is_public }
        );
      }
    }

    // 8. Record what was rendered and from which document. `thumbnail_rendered_sha`
    //    is the index.html sha, NOT the thumbnail's own — it is the answer to
    //    "has the deck changed since the picture was taken?".
    //
    //    A NULL sha (the map had no row and the metadata read failed) is left
    //    OUT of the update rather than written. Writing null would erase a
    //    perfectly good previous answer and make the next run re-render for no
    //    reason; leaving it costs one stale sha until a read succeeds, which is
    //    strictly the smaller mistake.
    await getPrisma().slide.update({
      where: { id: slide.id },
      data: {
        thumbnail_path: thumbnailPath,
        ...(indexSha ? { thumbnail_rendered_sha: indexSha } : {}),
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
