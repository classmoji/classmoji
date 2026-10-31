/**
 * The editor's side of `POST /api/slides/:slideId/html-block`: read, save and
 * delete the files behind a deck's html blocks, and list repo folders for the
 * "File in repo" picker. Shapes in `htmlBlockApi.server.ts`.
 */

export interface HtmlBlockFileRef {
  src: string;
  rev: string;
}

export interface HtmlBlockFileText extends HtmlBlockFileRef {
  html: string;
  /** The file moved on since the `rev` asked for. */
  stale: boolean;
}

export interface RepoFolderEntry {
  name: string;
  /** Repo path. */
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

export interface RepoFolderListing {
  /** The folder listed (repo path, '' for the root). */
  path: string;
  deckFolder: string;
  entries: RepoFolderEntry[];
}

/** A refusal from the API: `code` is `not-found`, `forbidden`, `invalid`, `too-large`, `changed`, … */
export class HtmlBlockApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'HtmlBlockApiError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(slideId: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/slides/${encodeURIComponent(slideId)}/html-block`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Not JSON (a proxy error page): reported by status below.
  }
  if (!response.ok) {
    const code =
      typeof data.code === 'string'
        ? data.code
        : response.status === 413
          ? 'too-large'
          : response.status === 404
            ? 'not-found'
            : 'error';
    const message =
      typeof data.error === 'string' ? data.error : `The request failed (${response.status}).`;
    throw new HtmlBlockApiError(message, response.status, code);
  }
  return data as T;
}

export function readHtmlBlockFile(
  slideId: string,
  args: { src: string; rev?: string | null }
): Promise<HtmlBlockFileText> {
  return call(slideId, { intent: 'read', src: args.src, ...(args.rev ? { rev: args.rev } : {}) });
}

export function saveHtmlBlockFile(
  slideId: string,
  args: {
    html: string;
    src?: string | null;
    rev?: string | null;
    fork?: boolean;
    blockId?: string | null;
  }
): Promise<HtmlBlockFileRef> {
  return call(slideId, {
    intent: 'save',
    html: args.html,
    ...(args.src ? { src: args.src } : {}),
    ...(args.rev ? { rev: args.rev } : {}),
    ...(args.fork ? { fork: true } : {}),
    ...(args.blockId ? { blockId: args.blockId } : {}),
  });
}

export function deleteHtmlBlockFile(
  slideId: string,
  args: { src: string; blockId?: string | null }
): Promise<{ deleted: boolean }> {
  return call(slideId, {
    intent: 'delete',
    src: args.src,
    ...(args.blockId ? { blockId: args.blockId } : {}),
  });
}

export function listRepoFolder(slideId: string, path: string): Promise<RepoFolderListing> {
  return call(slideId, { intent: 'list', path });
}
