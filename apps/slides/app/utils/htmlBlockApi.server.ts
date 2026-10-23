/**
 * The html-block API's body: one JSON request (`intent` save / read / delete /
 * list) → one JSON answer, against the services in `htmlBlockFiles.service`.
 *
 * Pure apart from the deps it is handed, so the route stays a gate plus a
 * call and this part is tested without a database. The slide id comes from
 * the URL and the user from the session (the route's gate): neither is ever
 * read from the body. The services decide the classroom from the slide row
 * and re-check the edit rule themselves.
 */

import type {
  HtmlBlockFileError,
  HtmlBlockFileRef,
  HtmlBlockSource,
  RepoFolderEntry,
} from '@classmoji/services/slides';

export interface HtmlBlockApiDeps {
  write(args: {
    slideId: string;
    actorUserId: string;
    html: string;
    src?: string;
    expectedRev?: string;
    fork?: boolean;
    blockId?: string;
    surface: 'slides';
  }): Promise<HtmlBlockFileRef>;
  read(args: {
    slideId: string;
    actorUserId: string;
    src: string;
    rev?: string;
  }): Promise<HtmlBlockSource>;
  remove(args: {
    slideId: string;
    actorUserId: string;
    src: string;
    blockId?: string;
    surface: 'slides';
  }): Promise<{ deleted: boolean }>;
  list(args: {
    slideId: string;
    actorUserId: string;
    path: string;
  }): Promise<{ path: string; deckFolder: string; entries: RepoFolderEntry[] }>;
  /** The service's typed refusal, recognised by instance. */
  isServiceError(error: unknown): error is HtmlBlockFileError;
}

export interface HtmlBlockApiAnswer {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, error: string, code: string): HtmlBlockApiAnswer => ({
  status,
  body: { error, code },
});

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

/**
 * One request. `body` is the parsed JSON (anything); the answer's status is
 * 200 on success, the service refusal's own status (400/403/404/409/413), or
 * 400 for a body that does not fit an intent.
 */
export async function handleHtmlBlockRequest(
  { slideId, userId, body }: { slideId: string; userId: string; body: unknown },
  deps: HtmlBlockApiDeps
): Promise<HtmlBlockApiAnswer> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'Expected a JSON object', 'invalid');
  }
  const input = body as Record<string, unknown>;
  const base = { slideId, actorUserId: userId };
  try {
    switch (input.intent) {
      case 'save': {
        const { html, src, rev, fork, blockId } = input;
        if (typeof html !== 'string' || !optionalString(src) || !optionalString(rev)) {
          return fail(400, 'save needs html (and optionally src, rev)', 'invalid');
        }
        if (fork !== undefined && typeof fork !== 'boolean') {
          return fail(400, 'fork must be true or false', 'invalid');
        }
        const ref = await deps.write({
          ...base,
          html,
          ...(src !== undefined ? { src } : {}),
          ...(rev !== undefined ? { expectedRev: rev } : {}),
          ...(fork ? { fork } : {}),
          ...(typeof blockId === 'string' ? { blockId: blockId.slice(0, 64) } : {}),
          surface: 'slides',
        });
        return { status: 200, body: { src: ref.src, rev: ref.rev } };
      }
      case 'read': {
        const { src, rev } = input;
        if (typeof src !== 'string' || !optionalString(rev)) {
          return fail(400, 'read needs src', 'invalid');
        }
        const file = await deps.read({ ...base, src, ...(rev !== undefined ? { rev } : {}) });
        return {
          status: 200,
          body: { src: file.src, html: file.html, rev: file.rev, stale: file.stale },
        };
      }
      case 'delete': {
        const { src, blockId } = input;
        if (typeof src !== 'string') return fail(400, 'delete needs src', 'invalid');
        const result = await deps.remove({
          ...base,
          src,
          ...(typeof blockId === 'string' ? { blockId: blockId.slice(0, 64) } : {}),
          surface: 'slides',
        });
        return { status: 200, body: { deleted: result.deleted } };
      }
      case 'list': {
        const { path } = input;
        if (!optionalString(path)) return fail(400, 'path must be a string', 'invalid');
        const listing = await deps.list({ ...base, path: path ?? '' });
        return { status: 200, body: { ...listing } };
      }
      default:
        return fail(400, 'intent must be save, read, delete or list', 'invalid');
    }
  } catch (error: unknown) {
    if (deps.isServiceError(error)) return fail(error.status, error.message, error.code);
    throw error;
  }
}
