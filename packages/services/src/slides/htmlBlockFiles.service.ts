/**
 * htmlBlockFiles.service.ts — the files behind html blocks (server only).
 *
 * An html block's code is a file in the classroom's content repo, named by
 * the block's `data-cm-src` relative to the deck folder (deckBlocks.ts).
 * Pasted code lives at `<deck>/blocks/<8 hex>.html`; this module writes,
 * reads and deletes those files for the slides editor (`api.slides.$slideId
 * .html-block`), the MCP (`deck_apply` html `source`, `deck_get`) and nothing
 * else. Stored files hold exactly what the author wrote: the content service
 * adds its storage shim when it serves them.
 *
 * Every entry point takes the slide id and the acting user id and decides
 * the rest from the database: the classroom is the slide row's own, and the
 * user's role is read for that classroom (never taken from the caller).
 *
 *   - write / delete / list: the deck EDIT rule — OWNER/TEACHER any deck, an
 *     ASSISTANT their own decks or decks with allow_team_edit — and the
 *     classroom mutation rule (owners always, everyone else only while the
 *     classroom is ACTIVE). The same rule as `assertSlideAccess` edit
 *     (packages/auth), MCP `assertSlideEditable` and the collab server's
 *     `canEditDeck`; repeated here because this package cannot import auth.
 *   - read: `edit` as above, or `view` for any member of the teaching team
 *     (deck_get is a teaching-team read).
 *
 * Writes and deletes are audited (`data.tool` `<surface>:html_block.save` /
 * `.delete`, one row per call); reads are not.
 */

import getPrisma from '@classmoji/database';
import type { Role } from '@prisma/client';
import { ContentService } from '../content/ContentService.ts';
import { create as createAudit } from '../classmoji/audit.service.ts';
import {
  recordContentAsset,
  recordFolderTreesAfterCommit,
  removeContentAssets,
} from '../classmoji/contentAssets.service.ts';
import {
  isHtmlBlockFileSrc,
  isHtmlBlockRev,
  MAX_HTML_BLOCK_FILE_BYTES,
  mintHtmlBlockFileSrc,
} from './deckBlocks.ts';
import { isDeckSlide } from './slideSource.ts';

// ─── Errors ──────────────────────────────────────────────────────────────────

export type HtmlBlockFileErrorCode =
  | 'not-found'
  | 'forbidden'
  | 'invalid'
  | 'too-large'
  | 'changed'
  | 'unavailable';

const STATUS: Record<HtmlBlockFileErrorCode, number> = {
  'not-found': 404,
  forbidden: 403,
  invalid: 400,
  'too-large': 413,
  changed: 409,
  unavailable: 409,
};

/** A refusal with a code a route or tool maps to its own answer (`status` is the HTTP one). */
export class HtmlBlockFileError extends Error {
  readonly code: HtmlBlockFileErrorCode;
  readonly status: number;

  constructor(code: HtmlBlockFileErrorCode, message: string) {
    super(message);
    this.name = 'HtmlBlockFileError';
    this.code = code;
    this.status = STATUS[code];
  }
}

// ─── The gate ────────────────────────────────────────────────────────────────

/** Where the call came from, for the audit row's `data.tool`. */
export type HtmlBlockSurface = 'slides' | 'mcp';

type Access = 'edit' | 'view';

const ROLE_RANK: Record<Role, number> = { OWNER: 4, TEACHER: 3, ASSISTANT: 2, STUDENT: 1 };

interface DeckTarget {
  slideId: string;
  title: string;
  classroomId: string;
  /** `slides/<slug>`, the deck folder. */
  deckFolder: string;
  role: Role;
  gitOrganization: { provider: string; login: string; [key: string]: unknown };
  repo: string;
}

/** The actor's highest role in the classroom, or null. */
async function highestRole(classroomId: string, userId: string): Promise<Role | null> {
  const rows = await getPrisma().classroomMembership.findMany({
    where: { classroom_id: classroomId, user_id: userId },
    select: { role: true },
  });
  let best: Role | null = null;
  for (const { role } of rows) if (!best || ROLE_RANK[role] > ROLE_RANK[best]) best = role;
  return best;
}

/**
 * The deck `slideId` and the actor's role in ITS classroom, once the actor
 * passes `access`. Refusals: not-found (no such deck), forbidden (rule),
 * unavailable (the classroom has no content repo).
 */
async function loadDeckFor(
  slideId: string,
  actorUserId: string,
  access: Access
): Promise<DeckTarget> {
  if (!slideId || !actorUserId)
    throw new HtmlBlockFileError('forbidden', 'Sign in to edit this deck.');
  const slide = await getPrisma().slide.findUnique({
    where: { id: slideId },
    include: { classroom: { include: { git_organization: true } } },
  });
  if (!slide || !isDeckSlide(slide)) {
    throw new HtmlBlockFileError('not-found', 'Slide deck not found');
  }
  const role = await highestRole(slide.classroom_id, actorUserId);
  const status = slide.classroom?.status;
  const staff = role === 'OWNER' || role === 'TEACHER' || role === 'ASSISTANT';
  const allowed =
    access === 'view'
      ? staff && (status !== 'UNPUBLISHED' || role === 'OWNER')
      : (role === 'OWNER' ||
          role === 'TEACHER' ||
          (role === 'ASSISTANT' &&
            (slide.created_by === actorUserId || slide.allow_team_edit === true))) &&
        (role === 'OWNER' || status === 'ACTIVE');
  if (!allowed || !role) {
    throw new HtmlBlockFileError(
      'forbidden',
      access === 'view'
        ? 'You do not have permission to read this deck'
        : 'You do not have permission to edit this deck'
    );
  }
  const gitOrganization = slide.classroom?.git_organization;
  const repo = slide.classroom?.content_repo;
  if (!gitOrganization?.login || !repo) {
    throw new HtmlBlockFileError('unavailable', 'This classroom has no content repository yet.');
  }
  return {
    slideId: slide.id,
    title: slide.title,
    classroomId: slide.classroom_id,
    deckFolder: slide.content_path,
    role,
    gitOrganization: gitOrganization as DeckTarget['gitOrganization'],
    repo,
  };
}

/** `<deck>/blocks/<8 hex>.html` for `src`, or an `invalid` refusal. */
function blockFilePath(target: DeckTarget, src: string): string {
  if (!isHtmlBlockFileSrc(src)) {
    throw new HtmlBlockFileError(
      'invalid',
      'Only a blocks/<id>.html file of this deck can be used here'
    );
  }
  return `${target.deckFolder}/${src}`;
}

async function audit(
  target: DeckTarget,
  actorUserId: string,
  action: 'UPDATE' | 'DELETE',
  data: Record<string, string>
): Promise<void> {
  try {
    await createAudit(
      {
        classroom_id: target.classroomId,
        user_id: actorUserId,
        role: target.role,
        resource_type: 'SLIDES',
        resource_id: target.slideId,
        action,
        data,
      },
      { dedupe: false }
    );
  } catch (error: unknown) {
    // The commit already landed; the row is reported, not the write undone.
    console.error('[htmlBlockFiles] Failed to write audit row', error);
  }
}

/** The map rows for a just-made commit in the deck (never throws). */
async function recordCommit(
  target: DeckTarget,
  commit: string,
  rootTreeSha: string | undefined
): Promise<void> {
  await recordFolderTreesAfterCommit({
    classroomId: target.classroomId,
    commit,
    rootTreeSha,
    folders: [target.deckFolder, `${target.deckFolder}/blocks`],
  });
}

function hasStatus(error: unknown, status: number): boolean {
  return (error as { status?: number } | null)?.status === status;
}

// ─── Write ───────────────────────────────────────────────────────────────────

export interface WriteHtmlBlockFileArgs {
  slideId: string;
  actorUserId: string;
  /** The block's whole document, exactly as the author wrote it. */
  html: string;
  /** The block's current file (`blocks/<8 hex>.html`), when it has one. */
  src?: string;
  /** The blob sha `src` was read at: the write is a compare-and-swap on it. */
  expectedRev?: string;
  /** Another block of the deck names the same file: write a new one. */
  fork?: boolean;
  /** `preview`: always a new file, so the published deck's files stay as they are. */
  mode?: 'live' | 'preview';
  /** For the audit row. */
  blockId?: string;
  surface?: HtmlBlockSurface;
}

/** A block's file as the deck stores it: `data-cm-src` and `data-cm-rev`. */
export interface HtmlBlockFileRef {
  src: string;
  rev: string;
}

/** How many fresh names a write tries before giving up (a name is taken only by a race). */
const NAME_ATTEMPTS = 4;

/**
 * Write an html block's code to its file and return the ref the block stores.
 *
 * The file is the block's own (`src`, overwritten with `expectedRev` as the
 * compare-and-swap) when `src` is a `blocks/` file, `expectedRev` is given,
 * and neither `fork` nor `mode: 'preview'` asks for a new one; otherwise a new
 * `blocks/<8 hex>.html` is created (create-only). The folder versions of the
 * deck and its `blocks/` folder are recorded before returning, so a URL
 * signed right after names the new tree.
 *
 * @throws {HtmlBlockFileError} not-found / forbidden / unavailable (the
 *   gate), invalid (bad src or rev), too-large (over 1,000,000 bytes),
 *   changed (the file is no longer at `expectedRev`).
 */
export async function writeHtmlBlockFile({
  slideId,
  actorUserId,
  html,
  src,
  expectedRev,
  fork = false,
  mode = 'live',
  blockId,
  surface = 'slides',
}: WriteHtmlBlockFileArgs): Promise<HtmlBlockFileRef> {
  const target = await loadDeckFor(slideId, actorUserId, 'edit');
  if (typeof html !== 'string') throw new HtmlBlockFileError('invalid', 'html must be a string');
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > MAX_HTML_BLOCK_FILE_BYTES) {
    throw new HtmlBlockFileError(
      'too-large',
      `This block's code is ${bytes} bytes; the limit is ${MAX_HTML_BLOCK_FILE_BYTES}.`
    );
  }
  if (src !== undefined && !isHtmlBlockFileSrc(src)) {
    throw new HtmlBlockFileError('invalid', 'src must be a blocks/<id>.html file of this deck');
  }
  if (expectedRev !== undefined && !isHtmlBlockRev(expectedRev)) {
    throw new HtmlBlockFileError('invalid', 'expectedRev must be a blob sha');
  }

  const reuse = src !== undefined && expectedRev !== undefined && !fork && mode === 'live';
  const repo = { gitOrganization: target.gitOrganization as never, repo: target.repo };

  let written: { src: string; sha: string; commit: string; treeSha?: string } | null = null;
  if (reuse) {
    const path = blockFilePath(target, src);
    try {
      const result = await ContentService.put({
        ...repo,
        path,
        content: html,
        expectedSha: expectedRev,
        message: `Update html block ${src} in ${target.title}`,
      });
      written = { src, ...result };
    } catch (error: unknown) {
      if (hasStatus(error, 409)) {
        throw new HtmlBlockFileError('changed', "This block's code changed since you opened it");
      }
      throw error;
    }
  } else {
    for (let attempt = 0; attempt < NAME_ATTEMPTS && !written; attempt++) {
      const fresh = mintHtmlBlockFileSrc();
      try {
        const result = await ContentService.put({
          ...repo,
          path: blockFilePath(target, fresh),
          content: html,
          createOnly: true,
          message: `Add html block ${fresh} to ${target.title}`,
        });
        written = { src: fresh, ...result };
      } catch (error: unknown) {
        if (!hasStatus(error, 409)) throw error;
      }
    }
    if (!written) throw new HtmlBlockFileError('changed', 'Could not name a new file. Try again.');
  }

  const path = `${target.deckFolder}/${written.src}`;
  await recordContentAsset(target.classroomId, { path, sha: written.sha, size: bytes });
  await recordCommit(target, written.commit, written.treeSha);
  await audit(target, actorUserId, 'UPDATE', {
    tool: `${surface}:html_block.save`,
    slide_id: target.slideId,
    path,
    rev: written.sha,
    ...(blockId ? { block_id: blockId } : {}),
  });
  return { src: written.src, rev: written.sha };
}

// ─── Read ────────────────────────────────────────────────────────────────────

/** A block file's code, at the version read (`stale`: not the `rev` asked for). */
export interface HtmlBlockSource {
  src: string;
  html: string;
  rev: string;
  stale: boolean;
}

/**
 * Several `blocks/` files of one deck, read through the git blob API (no
 * 1 MB limit). Each is read at the version the path holds now: when that is
 * the `rev` asked for, the blob is read by it; when the file moved on, the
 * current version comes back with `stale: true`. So a `rev` is never a way to
 * read a blob the path does not hold. Null for a file that is gone.
 */
export async function readHtmlBlockSources({
  slideId,
  actorUserId,
  refs,
  access = 'edit',
}: {
  slideId: string;
  actorUserId: string;
  refs: Array<{ src: string; rev?: string }>;
  access?: Access;
}): Promise<Array<HtmlBlockSource | null>> {
  const target = await loadDeckFor(slideId, actorUserId, access);
  const repo = { gitOrganization: target.gitOrganization as never, repo: target.repo };
  return Promise.all(
    refs.map(async ({ src, rev }) => {
      const path = blockFilePath(target, src);
      const meta = await ContentService.getMeta({ ...repo, path, skipCache: true });
      if (!meta) return null;
      const blob = await ContentService.getBlobContent({ ...repo, sha: meta.sha });
      if (!blob) return null;
      return {
        src,
        html: blob.content,
        rev: meta.sha,
        stale: rev !== undefined && rev !== meta.sha,
      };
    })
  );
}

/** One block file's code ({@link readHtmlBlockSources}); not-found when it is gone. */
export async function readHtmlBlockSource(args: {
  slideId: string;
  actorUserId: string;
  src: string;
  rev?: string;
  access?: Access;
}): Promise<HtmlBlockSource> {
  const [result] = await readHtmlBlockSources({
    slideId: args.slideId,
    actorUserId: args.actorUserId,
    refs: [{ src: args.src, ...(args.rev !== undefined ? { rev: args.rev } : {}) }],
    access: args.access,
  });
  if (!result) throw new HtmlBlockFileError('not-found', `${args.src} is not in the repository`);
  return result;
}

// ─── Delete ──────────────────────────────────────────────────────────────────

/**
 * Delete a `blocks/` file of the deck (one commit). A file already gone is
 * `{ deleted: false }`, not an error. Whether another block still names it is
 * the caller's question: the editor asks the author, the MCP checks the deck.
 */
export async function deleteHtmlBlockFile({
  slideId,
  actorUserId,
  src,
  blockId,
  surface = 'slides',
}: {
  slideId: string;
  actorUserId: string;
  src: string;
  blockId?: string;
  surface?: HtmlBlockSurface;
}): Promise<{ deleted: boolean }> {
  const target = await loadDeckFor(slideId, actorUserId, 'edit');
  const path = blockFilePath(target, src);
  let commit: string;
  try {
    ({ commit } = await ContentService.delete({
      gitOrganization: target.gitOrganization as never,
      repo: target.repo,
      path,
      message: `Delete html block ${src} from ${target.title}`,
    }));
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('File not found')) {
      return { deleted: false };
    }
    throw error;
  }
  await removeContentAssets(target.classroomId, [path]);
  await recordCommit(target, commit, undefined);
  await audit(target, actorUserId, 'DELETE', {
    tool: `${surface}:html_block.delete`,
    slide_id: target.slideId,
    path,
    ...(blockId ? { block_id: blockId } : {}),
  });
  return { deleted: true };
}

// ─── Folder listing (the editor's file picker) ──────────────────────────────

export interface RepoFolderEntry {
  name: string;
  /** Repo path. */
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

// eslint-disable-next-line no-control-regex -- refused in a folder path
const FOLDER_BAD_CHARS = /[\u0000-\u001f\u007f\\]/;

/**
 * One folder of the classroom's content repo (`path` a repo path, '' for the
 * root), for choosing an html block's file. Refuses a path with `.` / `..`
 * segments or control characters; a folder that does not exist lists empty.
 */
export async function listRepoFolder({
  slideId,
  actorUserId,
  path,
}: {
  slideId: string;
  actorUserId: string;
  path: string;
}): Promise<{ path: string; deckFolder: string; entries: RepoFolderEntry[] }> {
  const target = await loadDeckFor(slideId, actorUserId, 'edit');
  if (typeof path !== 'string' || path.length > 1_000 || FOLDER_BAD_CHARS.test(path)) {
    throw new HtmlBlockFileError('invalid', 'Not a folder of this repository');
  }
  const segments = path.split('/').filter(Boolean);
  if (segments.some(segment => segment === '.' || segment === '..')) {
    throw new HtmlBlockFileError('invalid', 'Not a folder of this repository');
  }
  const folder = segments.join('/');
  const listing = await ContentService.listFolder({
    gitOrganization: target.gitOrganization as never,
    repo: target.repo,
    path: folder,
    skipCache: true,
  });
  return {
    path: folder,
    deckFolder: target.deckFolder,
    entries: listing.map(({ name, path: entryPath, type, size }) => ({
      name,
      path: entryPath,
      type,
      ...(typeof size === 'number' ? { size } : {}),
    })),
  };
}
