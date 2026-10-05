/**
 * `collab-external`: tell the collab service an outside push changed a live
 * page or deck, durably.
 *
 * hook-station triggers this by id (never imports it) for every page/deck file
 * an outside push to a content repo changed: a GitHub web edit, an agent
 * committing directly, anything but the checkpoint worker. The run POSTs
 * `${COLLAB_URL}/internal/:kind/:id/external { sha, before }`; collab reads the
 * file at `sha` and 3-way merges it into the live doc (or reseeds an idle one).
 *
 * Retries: network errors, 5xx, 409 (busy; not `content-missing` or
 * `no-merge-base`) and 429 retry with exponential backoff; any other 4xx is
 * final (bad id, legacy page, wrong secret — another
 * attempt gets the same answer). The queue runs one notification per
 * classroom at a time (hook-station passes `concurrencyKey: classroomId`), so
 * a classroom's pushes reach collab in delivery order.
 *
 * Not in the `@classmoji/tasks` index: Trigger finds it through `dirs`, and
 * the only caller triggers it by string id.
 */
import { AbortTaskRunError, logger, task } from '@trigger.dev/sdk';
import { COLLAB_SECRET_HEADER } from '@classmoji/collab'; // eslint-disable-line import/no-unresolved
import { resolveCollabEnv } from '@classmoji/collab/env'; // eslint-disable-line import/no-unresolved

export const COLLAB_EXTERNAL_TASK = 'collab-external';
export const COLLAB_EXTERNAL_QUEUE = 'collab-external';

export interface CollabExternalPayload {
  classroomId: string;
  kind: 'page' | 'deck';
  docId: string;
  /** The push's head commit: collab reads the file here. */
  sha: string;
  /** The push's `before` commit; null for a branch creation. */
  before: string | null;
}

export interface CollabExternalResult {
  status: number;
  body: unknown;
}

/**
 * 409 answers that stay the same on every attempt:
 *  - `content-missing`: the file is not in the repo at that commit;
 *  - `no-merge-base`: collab can't find the content the live doc descends
 *    from, so it kept the live doc and did NOT merge the outside edit. Needs a
 *    person (alerted below), not another attempt.
 */
export const FINAL_CONFLICTS = new Set(['content-missing', 'no-merge-base']);

/** The `error` code of a collab error body, if any. */
function errorCode(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  return typeof error === 'string' ? error : undefined;
}

/**
 * Whether another attempt can change the answer: 5xx, 429, and 409 (busy) —
 * except the 409s in FINAL_CONFLICTS.
 */
export function isRetryableStatus(status: number, body?: unknown): boolean {
  if (status === 409) return !FINAL_CONFLICTS.has(errorCode(body) ?? '');
  return status >= 500 || status === 429;
}

/** A failure that a retry cannot fix. */
export class CollabExternalRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Collab's `error` code, when it sent one. */
    readonly code?: string
  ) {
    super(message);
    this.name = 'CollabExternalRefused';
  }
}

/**
 * One POST. Resolves on 2xx; throws `CollabExternalRefused` on a final
 * answer (or no collab configured) and a plain Error on a retryable one.
 */
export async function postCollabExternal(
  payload: CollabExternalPayload,
  deps: {
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
    timeoutMs?: number;
  } = {}
): Promise<CollabExternalResult> {
  const collab = resolveCollabEnv(deps.env ?? process.env);
  if (!collab) {
    throw new CollabExternalRefused('COLLAB_URL / COLLAB_INTERNAL_SECRET are not set', 0);
  }
  const { kind, docId, sha, before } = payload;
  const response = await (deps.fetch ?? fetch)(
    `${collab.httpUrl}/internal/${kind}/${encodeURIComponent(docId)}/external`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [COLLAB_SECRET_HEADER]: collab.secret },
      body: JSON.stringify({ sha, before }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000),
    }
  );
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return { status: response.status, body };

  const message = `collab ${kind}/${docId} @ ${sha}: HTTP ${response.status} ${JSON.stringify(body)}`;
  if (isRetryableStatus(response.status, body)) throw new Error(message);
  throw new CollabExternalRefused(message, response.status, errorCode(body));
}

export const collabExternal = task({
  id: COLLAB_EXTERNAL_TASK,
  queue: { name: COLLAB_EXTERNAL_QUEUE, concurrencyLimit: 1 },
  retry: {
    maxAttempts: 8,
    factor: 2,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 120_000,
    randomize: true,
  },
  run: async (payload: CollabExternalPayload) => {
    try {
      const result = await postCollabExternal(payload);
      logger.info('collab external merged', { ...payload, result: result.body });
      return result.body;
    } catch (err) {
      if (err instanceof CollabExternalRefused) {
        // Error level with the doc ids: an outside edit that did not reach the
        // live doc is an alert. For `no-merge-base` collab kept the live doc
        // and recorded the conflict on its row (`last_conflict`, reason
        // no-merge-base): the checkpoint worker stops re-notifying that
        // commit and the sweeper fails its run until a person settles it.
        // (A doc with no file before the push merges against an empty base
        // and never lands here.)
        logger.error(
          err.code === 'no-merge-base'
            ? 'collab external: outside edit NOT merged (no merge base)'
            : 'collab external refused',
          { ...payload, status: err.status, code: err.code, error: err.message }
        );
        throw new AbortTaskRunError(err.message);
      }
      throw err;
    }
  },
});
