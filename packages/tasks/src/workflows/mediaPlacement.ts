import { logger, task } from '@trigger.dev/sdk';
import { ClassmojiService } from '@classmoji/services';

import { UrlImportError, fetchImportUrl, type SafeFetchResult } from '../helpers/safeUrlFetch.ts';

/**
 * The two background halves of agent uploads (MCP `file_upload_*`,
 * `file_import_url`). The protocol, the row states and the admission checks
 * live in `packages/services/src/media/mediaStaging.service.ts`; these tasks
 * only drive its steps and decide what a failure means.
 *
 *   `media-place-staged` — a staged file whose destination is the content repo
 *     (queued by `file_upload_finish`), or any settled URL import: read the
 *     staged object, commit it next to its page or deck (or copy it into media),
 *     record the ref, delete the staged bytes.
 *   `media-import-url` — fetch a URL under the SSRF rules (`safeUrlFetch.ts`),
 *     stream it into the row's staging key, settle its real size and
 *     destination, then hand it to `media-place-staged`.
 *
 * Neither is in `src/index.ts`: the services trigger them by string id, and
 * importing this module there would put the pinned-fetch helper (and undici)
 * into every app bundle that imports the tasks index.
 *
 * ## Failure
 *
 * A failure a retry cannot change — the repository refused the file's type or
 * size, the page was deleted, the URL answered 404 or pointed somewhere private
 * — is recorded on the row at once (`failStagedPlacement`), which is what
 * `file_upload_status` reports. Anything else (GitHub 5xx, an R2 blip) rethrows
 * for the retry policy, and is recorded only when the last attempt fails too.
 * The recorded reason is a sentence for the agent; the raw error goes to the
 * run's log.
 */

/** Attempts for a placement: a GitHub commit is worth a couple of retries. */
const PLACE_MAX_ATTEMPTS = 3;

/** Attempts for a URL import: one retry for a network blip, no more. */
const IMPORT_MAX_ATTEMPTS = 2;

/**
 * The whole fetch — DNS through the last byte, which (with backpressure) is
 * also the last part written to R2. Under the task's `maxDuration` so the fetch
 * gives up with a sentence rather than the run being killed without one.
 */
const IMPORT_TOTAL_TIMEOUT_MS = 13 * 60 * 1000;

export interface MediaPlacePayload {
  mediaId: string;
}

export interface MediaImportPayload {
  mediaId: string;
  url: string;
}

export type MediaTaskResult =
  | { status: 'placed'; ref: string }
  | { status: 'queued' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

type StagingSteps = Awaited<ReturnType<typeof ClassmojiService.media.stagingTaskSteps>>;

/** The sentence recorded for a failure, safe to show an agent. */
function failureReason(error: unknown, fallback: string): string {
  if (error instanceof UrlImportError) return error.message;
  const name = (error as { name?: unknown } | null)?.name;
  const code = (error as { code?: unknown } | null)?.code;
  if (
    name === 'MediaError' ||
    name === 'PlacementRefused' ||
    code === 'FILE_REFUSED' ||
    code === 'REPO_FILE_TOO_LARGE' ||
    code === 'USE_MEDIA'
  ) {
    return (error as Error).message;
  }
  return fallback;
}

/**
 * Is a URL-import failure final? The fetch helper's refusals are about the URL
 * itself — it will say the same thing next time — except a timeout or a
 * dropped connection, and a 5xx from the far end.
 */
function isPermanentImportError(error: unknown, steps: StagingSteps): boolean {
  if (error instanceof UrlImportError) {
    if (error.code === 'TIMEOUT' || error.code === 'FETCH_FAILED' || error.code === 'DNS_FAILED') {
      return false;
    }
    if (error.code === 'HTTP_ERROR') return !(error.status !== undefined && error.status >= 500);
    return true;
  }
  return steps.isPermanentPlacementError(error);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const mediaPlaceStaged = task({
  id: 'media-place-staged',
  /**
   * Two placements at a time PER CLASSROOM — the services trigger with the
   * classroom as `concurrencyKey`, which gives each classroom its own pool of
   * this size. Every placement is a content-creating GitHub request on an
   * installation the whole org shares, so one class uploading forty files is
   * metered rather than fired at once.
   */
  queue: { name: 'media-placement', concurrencyLimit: 2 },
  /**
   * A repo placement holds one staged file (≤ the 35 MiB repo cap) in memory
   * and its base64 form on the way to GitHub — well inside 1 GB. A media
   * placement is an R2 server-side copy and holds nothing.
   */
  machine: 'small-2x',
  /** A 35 MiB commit and its asset-map row, with room for a slow GitHub. */
  maxDuration: 300,
  retry: {
    maxAttempts: PLACE_MAX_ATTEMPTS,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 60000,
    factor: 2,
  },
  run: async (payload: MediaPlacePayload, { ctx }): Promise<MediaTaskResult> => {
    const steps = await ClassmojiService.media.stagingTaskSteps();
    try {
      return await steps.placeStagedObject(payload.mediaId);
    } catch (error) {
      const final =
        steps.isPermanentPlacementError(error) || ctx.attempt.number >= PLACE_MAX_ATTEMPTS;
      logger.warn('Placement failed', {
        mediaId: payload.mediaId,
        attempt: ctx.attempt.number,
        final,
        error: describeError(error),
      });
      if (!final) throw error;
      const reason = failureReason(
        error,
        'The file could not be added to the course repository. Upload it again.'
      );
      await steps.failStagedPlacement(payload.mediaId, reason);
      return { status: 'failed', reason };
    }
  },
});

export const mediaImportUrl = task({
  id: 'media-import-url',
  /** Two imports at a time per classroom (`concurrencyKey`), like placement. */
  queue: { name: 'media-import', concurrencyLimit: 2 },
  /**
   * Streaming, not buffering: the body is re-chunked into 16 MiB parts, one in
   * memory at a time, so a 2 GiB import needs tens of megabytes, not gigabytes.
   * What it needs is time, which is `maxDuration`.
   */
  machine: 'small-2x',
  /** 15 minutes: the fetch's own 13-minute deadline, plus the settle and hand-off. */
  maxDuration: 900,
  retry: {
    maxAttempts: IMPORT_MAX_ATTEMPTS,
    minTimeoutInMs: 10000,
    maxTimeoutInMs: 30000,
    factor: 2,
  },
  run: async (payload: MediaImportPayload, { ctx }): Promise<MediaTaskResult> => {
    const steps = await ClassmojiService.media.stagingTaskSteps();
    const context = await steps.stagedImportContext(payload.mediaId);
    // Cancelled, deleted or already done — a duplicate or late run.
    if (!context) return { status: 'skipped', reason: 'not-staging' };

    let fetched: SafeFetchResult | null = null;
    try {
      fetched = await fetchImportUrl(payload.url, {
        maxBytes: context.maxBytes,
        totalTimeoutMs: IMPORT_TOTAL_TIMEOUT_MS,
      });
      const size = await steps.streamIntoStage(context.row, fetched.body, context.maxBytes);
      await steps.settleStagedImport(payload.mediaId, size);
    } catch (error) {
      await fetched?.cancel().catch(() => {});
      const final =
        isPermanentImportError(error, steps) || ctx.attempt.number >= IMPORT_MAX_ATTEMPTS;
      logger.warn('URL import failed', {
        mediaId: payload.mediaId,
        attempt: ctx.attempt.number,
        final,
        error: describeError(error),
      });
      if (!final) throw error;
      const reason = failureReason(error, 'The file at that URL could not be imported. Try again.');
      await steps.failStagedPlacement(payload.mediaId, reason);
      return { status: 'failed', reason };
    }

    // Placement is its own task, with its own retries: a GitHub hiccup after a
    // 2 GiB fetch must not mean fetching it again.
    await mediaPlaceStaged.trigger(
      { mediaId: payload.mediaId },
      {
        idempotencyKey: `media-place:${payload.mediaId}`,
        concurrencyKey: context.row.classroom_id,
      }
    );
    return { status: 'queued' };
  },
});
