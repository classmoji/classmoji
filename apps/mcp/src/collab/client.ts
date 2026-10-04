/**
 * The MCP side of live collaborative editing: when a classroom edits pages
 * and decks live (`Classroom.collab_enabled`), the content tools read and
 * write the LIVE document through the collab server's internal HTTP API
 * (`${COLLAB_URL}/internal`, header `x-collab-secret`) instead of git main —
 * main is only the last checkpoint there. Unflagged classrooms never reach
 * this module: `liveEnvFor` checks the flag before anything else.
 *
 * Versions: a live document has no blob sha. Reads report its
 * `collab_docs.version` as `live:<n>` in the `sha` field (the same marker the
 * pages app uses for a live merge's `ours_sha`), and writes take it back as
 * `expected_sha`.
 */

import {
  COLLAB_INTERNAL_PREFIX,
  COLLAB_SECRET_HEADER,
  type CollabActor,
  type CollabKind,
  type OpsResponse,
  type PageCoverImage,
  type SlideLock,
  type SnapshotResponse,
} from '@classmoji/collab';
import { resolveCollabEnv, type CollabEnv } from '@classmoji/collab/env';
import { ClassmojiService } from '@classmoji/services';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext } from '../mcp/registry.ts';

export type { CollabEnv };

/** The classroom flag, read defensively (absent on an older row = off). */
export function classroomCollabEnabled(classroom: unknown): boolean {
  return Boolean(
    classroom &&
    typeof classroom === 'object' &&
    (classroom as { collab_enabled?: unknown }).collab_enabled === true
  );
}

let warnedMissingEnv = false;

/**
 * The collab env when this classroom edits live, else null. The flag is read
 * FIRST: an unflagged classroom never resolves the env, so it never talks to
 * the collab server. Without the collab env (production with COLLAB_URL or
 * COLLAB_INTERNAL_SECRET unset) live editing is off everywhere — the pages
 * and slides apps fall back to their git editors the same way — so the tools
 * keep today's git paths, with one error in the log.
 */
export function liveEnvFor(classroom: unknown): CollabEnv | null {
  if (!classroomCollabEnabled(classroom)) return null;
  const env = resolveCollabEnv();
  if (!env && !warnedMissingEnv) {
    warnedMissingEnv = true;
    console.error('[mcp] Live editing is off: COLLAB_URL and COLLAB_INTERNAL_SECRET must be set.');
  }
  return env;
}

// ─── Versions ────────────────────────────────────────────────────────────────

const LIVE_PREFIX = 'live:';

/** The `sha` a read reports for a live document. */
export function liveSha(version: number): string {
  return `${LIVE_PREFIX}${version}`;
}

/** `live:12` or `12` → 12; anything else (a git sha) → null. */
export function parseLiveVersion(value: string | undefined | null): number | null {
  if (!value) return null;
  const raw = value.startsWith(LIVE_PREFIX) ? value.slice(LIVE_PREFIX.length) : value;
  if (!/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

// ─── Version errors ───

/** CONTENT_CONFLICT for a live apply whose version is stale or missing. */
export function liveVersionConflict(
  expected: string,
  current: number,
  kind: 'page' | 'deck'
): ToolError {
  const read = kind === 'page' ? 'page_content_get/outline' : 'deck_get/deck_outline';
  return new ToolError(
    'invalid_params',
    `The live ${kind} changed since you read it (you read '${expected}', it is now ` +
      `'${liveSha(current)}') — someone may be editing it right now. Re-read with ${read} and ` +
      "retry; for a larger edit use mode: 'preview'.",
    'CONTENT_CONFLICT'
  );
}

/** expected_sha that is not a live version, in live mode. */
export function notALiveVersion(kind: 'page' | 'deck'): ToolError {
  const read =
    kind === 'page' ? 'page_content_get or page_content_outline' : 'deck_get or deck_outline';
  return new ToolError(
    'invalid_params',
    `This ${kind} is edited live: expected_sha must be the live version a read returned ` +
      `(like 'live:12'), not a git sha — call ${read} for it.`,
    'CONTENT_CONFLICT'
  );
}

// ─── Internal API ────────────────────────────────────────────────────────────

/** A non-2xx answer from the collab server, or none at all (status 0). */
export class CollabRequestError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown = null) {
    super(message);
    this.name = 'CollabRequestError';
    this.status = status;
    this.body = body;
  }

  /** The server's `error` code, when it sent one. */
  get code(): string | null {
    const body = this.body as { error?: unknown } | null;
    return body && typeof body === 'object' && typeof body.error === 'string' ? body.error : null;
  }

  /** The server's human message, when it sent one. */
  get detail(): string | null {
    const body = this.body as { message?: unknown } | null;
    return body && typeof body === 'object' && typeof body.message === 'string'
      ? body.message
      : null;
  }

  /** Unreachable, timed out, or a server fault: reads may fall back to git. */
  get unavailable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function collabRequest<T>(
  env: CollabEnv,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${env.httpUrl}${COLLAB_INTERNAL_PREFIX}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        [COLLAB_SECRET_HEADER]: env.secret,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    throw new CollabRequestError(
      `Live editing service unreachable: ${error instanceof Error ? error.message : String(error)}`,
      0
    );
  }
  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!response.ok) {
    const code =
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `HTTP ${response.status}`;
    throw new CollabRequestError(`Live editing service refused: ${code}`, response.status, parsed);
  }
  return parsed as T;
}

const docPath = (kind: CollabKind, id: string, action: string) =>
  `/${kind}/${encodeURIComponent(id)}/${action}`;

/** The live document (from a clone on the server), with its version. */
export function fetchSnapshot<K extends CollabKind>(
  env: CollabEnv,
  kind: K,
  id: string
): Promise<SnapshotResponse<K>> {
  return collabRequest<SnapshotResponse<K>>(env, 'GET', docPath(kind, id, 'snapshot'));
}

/** Apply id-aware ops to the live document as `actor`. */
export function postOps(
  env: CollabEnv,
  kind: CollabKind,
  id: string,
  ops: unknown[],
  actor: CollabActor
): Promise<OpsResponse> {
  return collabRequest<OpsResponse>(env, 'POST', docPath(kind, id, 'ops'), { ops, actor });
}

/** Set (or clear, with null) a live page's cover. */
export function postCover(
  env: CollabEnv,
  pageId: string,
  coverImage: PageCoverImage | null,
  actor: CollabActor
): Promise<OpsResponse> {
  return collabRequest<OpsResponse>(env, 'POST', docPath('page', pageId, 'cover'), {
    coverImage,
    actor,
  });
}

/**
 * `POST /internal/:kind/:id/merge-preview` (spec, added after review): the
 * collab server runs the 3-way merge (base, LIVE, theirs) inside the live
 * transaction, so nothing typed between a read and the apply is reverted.
 * `base`/`theirs` are in the snapshot shape (page `{ blocks, coverImage }`,
 * deck `Deck`). Conflicts → 409 `{ error: 'conflicts', conflicts }` with
 * nothing applied; else 200 `{ applied: true, version }`.
 */
export interface MergePreviewRequest {
  base: unknown;
  theirs: unknown;
  resolutions?: Array<{ id: string; choose: 'ours' | 'theirs' }>;
  actor: CollabActor;
}

export interface MergePreviewResponse {
  applied: true;
  version: number;
}

export type MergePreviewOutcome =
  | { applied: true; version: number }
  | { applied: false; conflicts: Array<Record<string, unknown>>; autoMerged?: number };

export async function postMergePreview(
  env: CollabEnv,
  kind: CollabKind,
  id: string,
  request: MergePreviewRequest
): Promise<MergePreviewOutcome> {
  try {
    const result = await collabRequest<MergePreviewResponse>(
      env,
      'POST',
      docPath(kind, id, 'merge-preview'),
      request
    );
    return { applied: true, version: result.version };
  } catch (error) {
    if (error instanceof CollabRequestError && error.status === 409 && error.code === 'conflicts') {
      const { conflicts, autoMerged } = error.body as { conflicts?: unknown; autoMerged?: unknown };
      return {
        applied: false,
        conflicts: Array.isArray(conflicts) ? (conflicts as Array<Record<string, unknown>>) : [],
        ...(typeof autoMerged === 'number' ? { autoMerged } : {}),
      };
    }
    throw error;
  }
}

// ─── Actor ───────────────────────────────────────────────────────────────────

/**
 * Who the agent edits as: the MCP caller, under their name (peers see
 * `<name> (agent)`). Falls back to the login, then a placeholder.
 */
export async function actorFor(ctx: ToolContext): Promise<CollabActor> {
  const userId = ctx.viewer.userId;
  let name = '';
  try {
    const user = (await ClassmojiService.user.findById(userId)) as {
      name?: string | null;
      login?: string | null;
    } | null;
    name = user?.name?.trim() || user?.login?.trim() || '';
  } catch (error) {
    console.warn('[mcp] Could not read the editor name for a live edit:', error);
  }
  return { userId, name: name || 'Teacher' };
}

// ─── Error mapping ───────────────────────────────────────────────────────────

/**
 * A refusal from a live WRITE, as the agent should read it. Reads fall back
 * to git on `unavailable` instead of calling this.
 */
export function liveWriteError(
  error: unknown,
  what: 'page' | 'deck',
  options: { previewHint?: boolean } = {}
): Error {
  if (!(error instanceof CollabRequestError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const previewHint = options.previewHint ?? true;
  const preview = previewHint ? " Retry, or use mode: 'preview'." : ' Retry shortly.';
  if (error.unavailable) {
    return new ToolError(
      'internal',
      `The live editing service did not answer, so nothing was changed.${preview}`,
      'LIVE_UNAVAILABLE'
    );
  }
  if (error.status === 409 && error.code === 'slide-locked') {
    return slideLockedError(error.body);
  }
  if (error.status === 422 && error.code === 'legacy-html') {
    return new ToolError(
      'invalid_params',
      'This page still stores legacy HTML, so it cannot be edited live. Open it once in the web ' +
        'editor to migrate it to BlockNote.'
    );
  }
  if (error.status === 422 && error.code === 'unparseable-deck') {
    return new ToolError(
      'invalid_params',
      "This deck's HTML could not be parsed into a structured deck. Open it once in the web " +
        'slides editor and save to migrate it.'
    );
  }
  if (error.status === 400 || error.status === 422) {
    return new ToolError(
      'invalid_params',
      error.detail ?? `The live ${what} refused these ops (${error.code ?? error.status})`
    );
  }
  if (error.status === 404) {
    return new ToolError('not_found', `The live ${what} was not found`);
  }
  if (error.status === 409) {
    return new ToolError(
      'invalid_params',
      error.detail ?? `The live ${what} refused the edit (${error.code ?? 'conflict'})`,
      'CONTENT_CONFLICT'
    );
  }
  return new ToolError('internal', `${error.message} (HTTP ${error.status})`);
}

/** The 409 slide-locked body as an agent-facing error. */
export function slideLockedError(body: unknown): ToolError {
  const { slideId, holder } = (body ?? {}) as { slideId?: string; holder?: Partial<SlideLock> };
  const who = holder?.name?.trim() || 'Someone';
  const slide = slideId ? `slide '${slideId}'` : 'a slide these ops touch';
  return new ToolError(
    'invalid_params',
    `${who} is editing ${slide} right now, so nothing was changed. Edit another slide, try this ` +
      "one again once they are done, or use mode: 'preview' to propose the change for review.",
    'SLIDE_LOCKED',
    { ...(slideId ? { slide_id: slideId } : {}), held_by: who }
  );
}
