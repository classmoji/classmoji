/**
 * contentCheckpointCore.ts — the body of the `content-checkpoint` task: push
 * every live document of one classroom that has unpushed changes to the
 * classroom's content repo, in ONE commit.
 *
 * Kept free of Trigger.dev and of the heavy renderers (BlockNote server editor
 * / jsdom, the deck converter) — every outside effect comes in through
 * `CheckpointDeps` — so the bookkeeping is unit-tested with a stubbed Prisma
 * and a local git remote. `workflows/contentCheckpoint.ts` wires the real deps.
 *
 * Per run:
 *   1. Snapshot the classroom's dirty rows (`version > pushed_version`, state
 *      not a reseed marker): `(state, version, epoch)` each.
 *   2. Render from a fresh Y.Doc per row: page -> blocks + cover, deck -> Deck.
 *   3. Guards (pages: no dropped block, no short column layout; decks: no
 *      dropped slide). A refused doc is logged, left dirty and reported.
 *   4. PREPARE with the same service steps a save runs
 *      (`preparePageContent` / `prepareDeckForSave`): canonicalized refs,
 *      normalized structure, stripped runtime attrs, generated index.html.
 *   5. ONE commit with every prepared file; push (rebuild on rejection).
 *   6. RECORD with the save's own tail (`recordPageFile` / `recordDeckCommit`).
 *   7. Rows: `pushed_version = snapshot version`, `pushed_commit`,
 *      `source_sha`; `dirty_since = null` only when `version` has not moved
 *      since the snapshot. Every update is pinned to the snapshot's `epoch`, so
 *      a row reseeded underneath the run is never marked.
 */

import * as Y from 'yjs';

import type {
  CheckpointDocEditors,
  CollabActor,
  ContentCheckpointPayload,
} from '@classmoji/collab';

import { checkPageRender } from './checkpointGuards.ts';
import {
  isRepoNotFound,
  type CommitFilesInput,
  type CommitFilesResult,
  type GitIdentity,
} from './gitCheckpoint.ts';

// ─── Shapes (structural: the workflow passes the real Prisma and services) ──

export interface CoverImage {
  url: string;
  position: number;
}

export interface CheckpointRow {
  kind: string;
  doc_id: string;
  epoch: number;
  version: number;
  pushed_version: number;
  state: Uint8Array;
}

type GitOrgRow = { provider: string; login: string; [key: string]: unknown };

export interface CheckpointClassroom {
  id: string;
  content_repo: string;
  git_namespace?: string | null;
  git_organization: GitOrgRow | null;
  [key: string]: unknown;
}

interface CountResult {
  count: number;
}

/** The slice of Prisma the run uses. Kept narrow so tests can stub it. */
export interface CheckpointPrisma {
  classroom: {
    findUnique(args: {
      where: { id: string };
      include: { git_organization: true };
    }): Promise<CheckpointClassroom | null>;
  };
  collabDoc: {
    findMany(args: {
      where: { classroom_id: string };
      select: {
        kind: true;
        doc_id: true;
        epoch: true;
        version: true;
        pushed_version: true;
        state: true;
      };
    }): Promise<CheckpointRow[]>;
    updateMany(args: {
      where: {
        kind: string;
        doc_id: string;
        epoch: number;
        version?: number;
        pushed_version?: { lt: number };
      };
      data: {
        pushed_version: number;
        pushed_commit: string;
        source_sha: string;
        dirty_since?: null;
      };
    }): Promise<CountResult>;
  };
  page: {
    findMany(args: {
      where: { id: { in: string[] }; classroom_id: string };
      select: { id: true; title: true; content_path: true };
    }): Promise<Array<{ id: string; title: string; content_path: string }>>;
  };
  slide: {
    findMany(args: {
      where: { id: { in: string[] }; classroom_id: string };
      select: { id: true; title: true; content_path: true; kind: true };
    }): Promise<Array<{ id: string; title: string; content_path: string; kind: string }>>;
  };
  account: {
    findMany(args: {
      where: { user_id: { in: string[] }; provider_id: 'github' };
      select: { user_id: true; account_id: true; username: true };
    }): Promise<Array<{ user_id: string; account_id: string; username: string | null }>>;
  };
}

export type PageTarget = {
  id: string;
  title: string;
  content_path: string;
  classroom: CheckpointClassroom;
};

export type DeckTarget = {
  id: string;
  title: string;
  content_path: string;
  kind: string;
  classroom: CheckpointClassroom;
};

/** Deck JSON, opaque here (the services own its shape). */
export type DeckLike = { version: number; slides: unknown[]; [key: string]: unknown };

export interface CheckpointDeps {
  prisma: CheckpointPrisma;
  /** The page fragment name (`FRAGMENT`). */
  pageFragment: string;
  /** Y.Doc -> `{ blocks, coverImage }`, read from a clone. */
  renderPage(doc: Y.Doc): { blocks: unknown[]; coverImage?: CoverImage | null };
  /** The deck Y.Doc -> Deck converter, or null while it is unavailable. */
  loadDeckRenderer(): Promise<((doc: Y.Doc) => DeckLike) | null>;
  preparePageContent(
    page: PageTarget,
    blocks: unknown,
    options: { coverImage: CoverImage | null }
  ): Promise<{ path: string; content: string }>;
  recordPageFile(
    page: PageTarget,
    path: string,
    sha: string,
    content: string,
    options: { awaitTail: boolean }
  ): Promise<void>;
  resolveDeckThemeUrls(slide: DeckTarget, deck: DeckLike): Promise<unknown>;
  prepareDeckForSave(
    slide: DeckTarget,
    deck: DeckLike,
    options: { themeUrls?: unknown }
  ): Promise<{ deckPath: string; htmlPath: string; deckJson: string; html: string }>;
  recordDeckCommit(
    slide: DeckTarget,
    committed: Array<{ path: string; sha: string }>,
    written: Array<{ path: string; content: string }>,
    options: { awaitTail: boolean }
  ): Promise<void>;
  /** Authenticated clone/push URL for the classroom's content repo (mints a token). */
  remoteUrl(classroom: CheckpointClassroom): Promise<string>;
  /** Create the content repo if it does not exist (`page.ensureContentRepo`). */
  ensureContentRepo(classroomId: string): Promise<void>;
  commitFiles(input: CommitFilesInput): Promise<CommitFilesResult>;
  log: {
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
  };
}

// ─── Report ──────────────────────────────────────────────────────────────────

export type DocStatus =
  /** In the pushed commit. */
  | 'pushed'
  /** Rendered to the bytes git already had: marked pushed, nothing committed. */
  | 'unchanged'
  /** A guard refused the render; left dirty. */
  | 'refused'
  /** Not attempted (doc row gone, converter unavailable); left dirty. */
  | 'skipped'
  /** Render/prepare threw; left dirty. */
  | 'failed';

export interface DocReport {
  kind: string;
  docId: string;
  title?: string;
  /** The snapshot version. */
  version: number;
  status: DocStatus;
  reason?: string;
  paths?: string[];
  /** False when `version` moved after the snapshot (the row stays dirty). */
  clean?: boolean;
}

export interface CheckpointReport {
  classroomId: string;
  runId: string;
  reason?: string;
  commit: string | null;
  pushed: boolean;
  attempts: number;
  lazyFetches?: number;
  message?: string;
  docs: DocReport[];
}

export const CHECKPOINT_AUTHOR: GitIdentity = {
  name: 'Classmoji Bot',
  email: 'hello@classmoji.com',
};

export type CheckpointPayload = ContentCheckpointPayload;

// ─── Commit message ──────────────────────────────────────────────────────────

/** `Update A, B and C (live editing)`; more than three: `Update A, B, C and 2 more …`. */
export function checkpointSubject(titles: string[]): string {
  const unique = [...new Set(titles.map(t => t.trim() || 'Untitled'))];
  let list: string;
  if (unique.length <= 1) list = unique[0] ?? 'content';
  else if (unique.length <= 3) list = `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
  else list = `${unique.slice(0, 3).join(', ')} and ${unique.length - 3} more`;
  return `Update ${list} (live editing)`;
}

/** GitHub's no-reply address: `<id>+<login>@users.noreply.github.com`. */
export function githubNoreply(accountId: string, login: string): string {
  return `${accountId}+${login}@users.noreply.github.com`;
}

/** Strip characters that would break a trailer line or the `<email>` part. */
function trailerName(name: string): string {
  return name
    .replace(/[\r\n<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function checkpointMessage({
  titles,
  runId,
  body,
  coAuthors,
}: {
  titles: string[];
  runId: string;
  body?: string;
  coAuthors: Array<{ name: string; email: string }>;
}): string {
  const lines = [checkpointSubject(titles), ''];
  const text = body?.trim();
  if (text) lines.push(text, '');
  lines.push(`Classmoji-Collab: ${runId}`);
  for (const a of coAuthors) lines.push(`Co-authored-by: ${trailerName(a.name)} <${a.email}>`);
  return lines.join('\n') + '\n';
}

/**
 * Co-author trailers for the docs in this commit: the payload's per-doc
 * editors, deduped by user, resolved to GitHub no-reply addresses. An editor
 * with no GitHub account gets no trailer (no address is invented for them).
 */
async function resolveCoAuthors(
  prisma: CheckpointPrisma,
  editors: CheckpointDocEditors[] | undefined,
  committed: Set<string>
): Promise<Array<{ name: string; email: string }>> {
  if (!editors?.length) return [];
  const actors = new Map<string, CollabActor>();
  for (const entry of editors) {
    if (!committed.has(`${entry.kind}:${entry.docId}`)) continue;
    for (const actor of entry.editors ?? []) {
      if (actor?.userId && !actors.has(actor.userId)) actors.set(actor.userId, actor);
    }
  }
  if (actors.size === 0) return [];
  const accounts = await prisma.account.findMany({
    where: { user_id: { in: [...actors.keys()] }, provider_id: 'github' },
    select: { user_id: true, account_id: true, username: true },
  });
  const byUser = new Map(accounts.filter(a => a.username).map(a => [a.user_id, a]));
  const out: Array<{ name: string; email: string }> = [];
  for (const [userId, actor] of actors) {
    const account = byUser.get(userId);
    if (!account?.username) continue;
    out.push({
      name: actor.name?.trim() || account.username,
      email: githubNoreply(account.account_id, account.username),
    });
  }
  return out;
}

// ─── Deck guard ──────────────────────────────────────────────────────────────

/** Slide ids in the deck document's `slides` map that the rendered deck lacks. */
export function droppedSlideIds(doc: Y.Doc, deck: DeckLike): string[] {
  const rendered = new Set<string>();
  const walk = (list: unknown[]) => {
    for (const s of list) {
      if (!s || typeof s !== 'object') continue;
      const slide = s as { id?: unknown; children?: unknown };
      if (typeof slide.id === 'string') rendered.add(slide.id);
      if (Array.isArray(slide.children)) walk(slide.children);
    }
  };
  walk(deck.slides);
  return [...doc.getMap('slides').keys()].filter(id => !rendered.has(id));
}

// ─── The run ─────────────────────────────────────────────────────────────────

interface Candidate {
  row: CheckpointRow;
  report: DocReport;
  /** The file whose blob sha becomes `source_sha` (content.json / deck.json). */
  sourcePath: string;
  files: Array<{ path: string; content: string }>;
  record: (blobShas: Record<string, string>) => Promise<void>;
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runContentCheckpoint(
  payload: CheckpointPayload,
  ctx: { runId: string },
  deps: CheckpointDeps
): Promise<CheckpointReport> {
  const { prisma, log } = deps;
  const { classroomId } = payload;
  const report: CheckpointReport = {
    classroomId,
    runId: ctx.runId,
    ...(payload.reason ? { reason: payload.reason } : {}),
    commit: null,
    pushed: false,
    attempts: 0,
    docs: [],
  };

  const classroom = await prisma.classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });
  if (!classroom) {
    log.warn('content-checkpoint: classroom not found', { classroomId });
    return report;
  }

  // 1. Snapshot. One read: every row's state, version and epoch together, so
  // what is rendered and the version it is credited to cannot drift apart.
  const rows = (
    await prisma.collabDoc.findMany({
      where: { classroom_id: classroomId },
      select: {
        kind: true,
        doc_id: true,
        epoch: true,
        version: true,
        pushed_version: true,
        state: true,
      },
    })
  ).filter(r => r.version > r.pushed_version && r.state.byteLength > 0);
  if (rows.length === 0) {
    log.info('content-checkpoint: nothing to push', { classroomId });
    return report;
  }

  if (!classroom.git_organization?.login || !classroom.content_repo) {
    throw new Error(`Classroom ${classroomId} has no content repo or git organization configured`);
  }

  const pageIds = rows.filter(r => r.kind === 'page').map(r => r.doc_id);
  const deckIds = rows.filter(r => r.kind === 'deck').map(r => r.doc_id);
  const [pages, slides] = await Promise.all([
    pageIds.length
      ? prisma.page.findMany({
          where: { id: { in: pageIds }, classroom_id: classroomId },
          select: { id: true, title: true, content_path: true },
        })
      : [],
    deckIds.length
      ? prisma.slide.findMany({
          where: { id: { in: deckIds }, classroom_id: classroomId },
          select: { id: true, title: true, content_path: true, kind: true },
        })
      : [],
  ]);
  const pageById = new Map(pages.map(p => [p.id, p]));
  const slideById = new Map(slides.map(s => [s.id, s]));

  // 2–4. Render, guard, prepare.
  const candidates: Candidate[] = [];
  let deckRenderer: ((doc: Y.Doc) => DeckLike) | null | undefined;

  for (const row of rows) {
    const base: DocReport = {
      kind: row.kind,
      docId: row.doc_id,
      version: row.version,
      status: 'skipped',
    };
    try {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, row.state);

      if (row.kind === 'page') {
        const page = pageById.get(row.doc_id);
        if (!page) {
          report.docs.push({ ...base, reason: 'page row not found in this classroom' });
          continue;
        }
        base.title = page.title;
        const target: PageTarget = { ...page, classroom };
        const content = deps.renderPage(doc);
        const guard = checkPageRender(doc, deps.pageFragment, content.blocks);
        if (!guard.ok) {
          log.error('content-checkpoint: refused a page render', {
            classroomId,
            pageId: page.id,
            version: row.version,
            reason: guard.reason,
          });
          report.docs.push({ ...base, status: 'refused', reason: guard.reason });
          continue;
        }
        // An explicit cover (null when the doc has none): the document is the
        // truth, so no re-read of the stored file.
        const prepared = await deps.preparePageContent(target, content.blocks, {
          coverImage: content.coverImage ?? null,
        });
        candidates.push({
          row,
          report: { ...base, paths: [prepared.path] },
          sourcePath: prepared.path,
          files: [{ path: prepared.path, content: prepared.content }],
          record: shas =>
            deps.recordPageFile(target, prepared.path, shas[prepared.path], prepared.content, {
              awaitTail: true,
            }),
        });
      } else if (row.kind === 'deck') {
        const slide = slideById.get(row.doc_id);
        if (!slide) {
          report.docs.push({ ...base, reason: 'slide row not found in this classroom' });
          continue;
        }
        base.title = slide.title;
        if (deckRenderer === undefined) deckRenderer = await deps.loadDeckRenderer();
        if (!deckRenderer) {
          log.warn('content-checkpoint: deck converter unavailable; deck left dirty', {
            classroomId,
            slideId: slide.id,
          });
          report.docs.push({ ...base, reason: 'deck converter unavailable' });
          continue;
        }
        const target: DeckTarget = { ...slide, classroom };
        const deck = deckRenderer(doc);
        if (deck?.version !== 1 || !Array.isArray(deck.slides)) {
          report.docs.push({
            ...base,
            status: 'refused',
            reason: 'render is not a version 1 deck',
          });
          continue;
        }
        const dropped = droppedSlideIds(doc, deck);
        if (dropped.length) {
          const reason = `the render dropped ${dropped.length} slide(s) the document holds: ${dropped
            .slice(0, 10)
            .join(', ')}`;
          log.error('content-checkpoint: refused a deck render', {
            classroomId,
            slideId: slide.id,
            version: row.version,
            reason,
          });
          report.docs.push({ ...base, status: 'refused', reason });
          continue;
        }
        const themeUrls = await deps.resolveDeckThemeUrls(target, deck);
        const prepared = await deps.prepareDeckForSave(target, deck, {
          ...(themeUrls ? { themeUrls } : {}),
        });
        const written = [
          { path: prepared.deckPath, content: prepared.deckJson },
          // Every deck checkpoint carries the generated index.html.
          { path: prepared.htmlPath, content: prepared.html },
        ];
        candidates.push({
          row,
          report: { ...base, paths: written.map(f => f.path) },
          sourcePath: prepared.deckPath,
          files: written,
          record: shas =>
            deps.recordDeckCommit(
              target,
              written.map(f => ({ path: f.path, sha: shas[f.path] })),
              written,
              { awaitTail: true }
            ),
        });
      } else {
        report.docs.push({ ...base, reason: `unknown kind ${row.kind}` });
      }
    } catch (error) {
      log.error('content-checkpoint: render/prepare failed; doc left dirty', {
        classroomId,
        kind: row.kind,
        docId: row.doc_id,
        error: errMessage(error),
      });
      report.docs.push({ ...base, status: 'failed', reason: errMessage(error) });
    }
  }

  if (candidates.length === 0) return report;

  // 5. One commit for every prepared file.
  const committedKeys = new Set(candidates.map(c => `${c.row.kind}:${c.row.doc_id}`));
  const coAuthors = await resolveCoAuthors(prisma, payload.editors, committedKeys);
  const message = checkpointMessage({
    titles: candidates.map(c => c.report.title ?? c.row.doc_id),
    runId: ctx.runId,
    ...(payload.message ? { body: payload.message } : {}),
    coAuthors,
  });
  report.message = message;

  const remoteUrl = await deps.remoteUrl(classroom);
  const input: CommitFilesInput = {
    remoteUrl,
    files: candidates.flatMap(c => c.files),
    message,
    author: CHECKPOINT_AUTHOR,
  };
  let result: CommitFilesResult;
  try {
    result = await deps.commitFiles(input);
  } catch (error) {
    if (!isRepoNotFound(error)) throw error;
    // A content repo that does not exist yet: create it through the usual
    // path, then try once more.
    log.warn('content-checkpoint: content repo missing; creating it', { classroomId });
    await deps.ensureContentRepo(classroomId);
    result = await deps.commitFiles(input);
  }
  report.commit = result.commit;
  report.pushed = result.pushed;
  report.attempts = result.attempts;
  report.lazyFetches = result.lazyFetches;
  if (result.lazyFetches > 0) {
    log.warn('content-checkpoint: git fetched objects lazily', {
      classroomId,
      lazyFetches: result.lazyFetches,
    });
  }

  // 6. Record — only for a commit that exists. A failure here does not undo
  // the commit; the push webhook and the nightly reconcile fill the gap.
  if (result.pushed) {
    for (const c of candidates) {
      try {
        await c.record(result.blobShas);
      } catch (error) {
        log.error('content-checkpoint: record step failed after push', {
          classroomId,
          docId: c.row.doc_id,
          error: errMessage(error),
        });
      }
    }
  }

  // 7. Rows. Clean only if nothing was stored since the snapshot.
  for (const c of candidates) {
    const where = { kind: c.row.kind, doc_id: c.row.doc_id, epoch: c.row.epoch };
    const data = {
      pushed_version: c.row.version,
      pushed_commit: result.commit,
      source_sha: result.blobShas[c.sourcePath],
    };
    const cleaned = await prisma.collabDoc.updateMany({
      where: { ...where, version: c.row.version },
      data: { ...data, dirty_since: null },
    });
    const clean = cleaned.count > 0;
    if (!clean) {
      // Edited since the snapshot: credit what was pushed, stay dirty (the
      // store that bumped `version` has already triggered the next run).
      await prisma.collabDoc.updateMany({
        where: { ...where, pushed_version: { lt: c.row.version } },
        data,
      });
    }
    report.docs.push({
      ...c.report,
      status: result.pushed ? 'pushed' : 'unchanged',
      clean,
    });
  }

  log.info('content-checkpoint: done', {
    classroomId,
    commit: result.commit,
    pushed: result.pushed,
    attempts: result.attempts,
    docs: report.docs.map(d => `${d.kind}:${d.docId}=${d.status}`),
  });
  return report;
}
