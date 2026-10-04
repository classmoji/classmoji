/**
 * contentCheckpointCore.ts — the body of the `content-checkpoint` task: push
 * every live document of one classroom that has unpushed changes to the
 * classroom's content repo, in ONE commit.
 *
 * Kept free of Trigger.dev and of the heavy renderers (BlockNote server editor
 * / jsdom, the deck converter) — every outside effect comes in through
 * `CheckpointDeps`, and the renderers are loaded lazily through it — so the
 * bookkeeping is unit-tested with a stubbed Prisma and a local git remote.
 * `workflows/contentCheckpoint.ts` wires the real deps.
 *
 * Per run:
 *   1. Select the classroom's dirty rows in SQL (`version > pushed_version`,
 *      state not a reseed marker) — metadata only. Rows written with another
 *      schema version than this worker's are refused without loading state.
 *   2. Per remaining row, read `(state, version, epoch)` together and render
 *      from a fresh Y.Doc: page -> blocks + cover, deck -> Deck.
 *   3. Guards (pages: not empty, no dropped block, no short column layout;
 *      decks: not empty, no dropped slide; every doc: safe, unshared paths).
 *      A refused doc is logged, left dirty and reported.
 *   4. PREPARE with the same service steps a save runs
 *      (`preparePageContent` / `prepareDeckForSave`).
 *   5. ONE commit with every prepared doc's files; push (rebuild on
 *      rejection). The outside-edit backstop: a doc whose file at the head no
 *      longer has the row's `source_sha` was changed outside the live doc and
 *      collab has not merged it yet — it is left out (dirty, reported) and
 *      `collab-external` is triggered for it.
 *   6. RECORD with the save's own tail (`recordPageFile` / `recordDeckCommit`)
 *      for every doc the head now holds — also when nothing new was committed,
 *      so a retry after a crash between push and record still warms/indexes.
 *   7. Rows: `pushed_version = snapshot version`, `pushed_commit`,
 *      `source_sha`; `dirty_since = null` only when `version` has not moved
 *      since the snapshot. Every update is pinned to the snapshot's `epoch`.
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
  isSafeRepoPath,
  type CommitFilesInput,
  type CommitFilesResult,
  type CommitGroup,
  type GitIdentity,
} from './gitCheckpoint.ts';

// ─── Shapes (structural: the workflow passes the real Prisma and services) ──

export interface CoverImage {
  url: string;
  position: number;
}

/** A dirty row's metadata, as the SQL filter returns it (no state). */
export interface DirtyRowMeta {
  kind: string;
  doc_id: string;
  epoch: number;
  version: number;
  pushed_version: number;
  schema_version: number;
  source_sha: string | null;
}

/** The snapshot: state plus the counters read in the same statement. */
export interface CheckpointRow extends DirtyRowMeta {
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
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  classroom: {
    findUnique(args: {
      where: { id: string };
      include: { git_organization: true };
    }): Promise<CheckpointClassroom | null>;
  };
  collabDoc: {
    findUnique(args: {
      where: { kind_doc_id: { kind: string; doc_id: string } };
      select: {
        kind: true;
        doc_id: true;
        epoch: true;
        version: true;
        pushed_version: true;
        schema_version: true;
        source_sha: true;
        state: true;
      };
    }): Promise<CheckpointRow | null>;
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

export interface PageRenderer {
  /** The page fragment name (`FRAGMENT`). */
  fragment: string;
  /** `SCHEMA_VERSION` this worker was built with. */
  schemaVersion: number;
  /** Y.Doc -> `{ blocks, coverImage }`, read from a clone. */
  render(doc: Y.Doc): { blocks: unknown[]; coverImage?: CoverImage | null };
}

export interface DeckRenderer {
  /** The deck schema version this worker was built with. */
  schemaVersion: number;
  render(doc: Y.Doc): DeckLike;
}

export interface OutsideEditNotice {
  classroomId: string;
  kind: string;
  docId: string;
  /** The head commit that showed the outside change. */
  sha: string;
}

export interface CheckpointDeps {
  prisma: CheckpointPrisma;
  /** Loaded on first use (pulls in BlockNote's server editor and jsdom). */
  loadPageRenderer(): Promise<PageRenderer>;
  /** Loaded on first use; null while the converter is unavailable. */
  loadDeckRenderer(): Promise<DeckRenderer | null>;
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
  /** Clone/push URL (no credentials) and the credentials (mints a token). */
  remote(classroom: CheckpointClassroom): Promise<{
    url: string;
    auth?: { username: string; password: string };
  }>;
  /** Create the content repo if it does not exist (`page.ensureContentRepo`). */
  ensureContentRepo(classroomId: string): Promise<void>;
  commitFiles(input: CommitFilesInput): Promise<CommitFilesResult>;
  /** Tell collab an outside edit is waiting to be merged (`collab-external`). */
  notifyOutsideEdit(notice: OutsideEditNotice): Promise<void>;
  /** The commit author (Classmoji Bot). */
  author: GitIdentity;
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
  /** A guard refused it, or its file changed outside; left dirty. */
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
  /** Machine-readable cause for `refused`/`skipped`. */
  code?:
    | 'schema-mismatch'
    | 'empty-render'
    | 'dropped-content'
    | 'short-columns'
    | 'unsafe-path'
    | 'path-conflict'
    | 'outside-edit-pending'
    | 'not-a-deck'
    | 'doc-missing'
    | 'converter-unavailable'
    | 'unknown-kind';
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
  /**
   * A "Save version" message that reached no commit (nothing was left to push
   * — an earlier run already pushed those edits — or nothing changed). Kept
   * here so it is visible in the run, rather than silently dropped.
   */
  unusedMessage?: string;
  docs: DocReport[];
}

export type CheckpointPayload = ContentCheckpointPayload;

// ─── Commit message ──────────────────────────────────────────────────────────

/** Strip characters that would break a subject/trailer line or the `<email>` part. */
function oneLine(text: string): string {
  return text
    .replace(/[\r\n<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `Update A, B and C (live editing)`; more than three: `Update A, B, C and 2 more …`. */
export function checkpointSubject(titles: string[]): string {
  const unique = [...new Set(titles.map(t => oneLine(t) || 'Untitled'))];
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
  for (const a of coAuthors) lines.push(`Co-authored-by: ${oneLine(a.name)} <${a.email}>`);
  return lines.join('\n') + '\n';
}

/**
 * Co-author trailers per doc (`kind:docId` -> trailers): the payload's per-doc
 * editors resolved to GitHub no-reply addresses. An editor with no GitHub
 * account gets no trailer (no address is invented for them).
 */
async function resolveCoAuthors(
  prisma: CheckpointPrisma,
  editors: CheckpointDocEditors[] | undefined,
  docs: Set<string>
): Promise<Map<string, Array<{ userId: string; name: string; email: string }>>> {
  const out = new Map<string, Array<{ userId: string; name: string; email: string }>>();
  if (!editors?.length) return out;
  const perDoc = new Map<string, CollabActor[]>();
  const userIds = new Set<string>();
  for (const entry of editors) {
    const key = `${entry.kind}:${entry.docId}`;
    if (!docs.has(key)) continue;
    const actors = (entry.editors ?? []).filter(a => a?.userId);
    perDoc.set(key, [...(perDoc.get(key) ?? []), ...actors]);
    for (const a of actors) userIds.add(a.userId);
  }
  if (userIds.size === 0) return out;
  const accounts = await prisma.account.findMany({
    where: { user_id: { in: [...userIds] }, provider_id: 'github' },
    select: { user_id: true, account_id: true, username: true },
  });
  const byUser = new Map(accounts.filter(a => a.username).map(a => [a.user_id, a]));
  for (const [key, actors] of perDoc) {
    const list: Array<{ userId: string; name: string; email: string }> = [];
    for (const actor of actors) {
      const account = byUser.get(actor.userId);
      if (!account?.username) continue;
      list.push({
        userId: actor.userId,
        name: actor.name?.trim() || account.username,
        email: githubNoreply(account.account_id, account.username),
      });
    }
    out.set(key, list);
  }
  return out;
}

/** The trailers for the docs in one commit, deduped by user, in first-seen order. */
function coAuthorsFor(
  perDoc: Map<string, Array<{ userId: string; name: string; email: string }>>,
  docKeys: string[]
): Array<{ name: string; email: string }> {
  const seen = new Map<string, { name: string; email: string }>();
  for (const key of docKeys) {
    for (const a of perDoc.get(key) ?? []) {
      if (!seen.has(a.userId)) seen.set(a.userId, { name: a.name, email: a.email });
    }
  }
  return [...seen.values()];
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
  /** Where a recorded `source_sha` may live at the head, in order. */
  sourcePaths: string[];
  files: Array<{ path: string; content: string }>;
  record: (blobShas: Record<string, string>) => Promise<void>;
}

const errMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const docKey = (kind: string, docId: string) => `${kind}:${docId}`;

/**
 * M4: every path must be safe, and no two docs may write the same path or a
 * path inside another's (a file where the other needs a folder). Offending
 * docs are refused; the rest commit.
 */
function refuseConflictingPaths(candidates: Candidate[]): {
  ok: Candidate[];
  refused: DocReport[];
} {
  const refused = new Map<Candidate, DocReport>();
  for (const c of candidates) {
    const bad = c.files.map(f => f.path).filter(p => !isSafeRepoPath(p));
    if (bad.length) {
      refused.set(c, {
        ...c.report,
        status: 'refused',
        code: 'unsafe-path',
        reason: `unsafe repo path(s): ${bad.join(', ')}`,
      });
    }
  }
  const owners = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (refused.has(c)) continue;
    for (const f of c.files) owners.set(f.path, [...(owners.get(f.path) ?? []), c]);
  }
  const paths = [...owners.keys()];
  for (const p of paths) {
    const clash = new Set(owners.get(p));
    for (const q of paths) {
      if (q !== p && q.startsWith(`${p}/`)) for (const c of owners.get(q) ?? []) clash.add(c);
    }
    const docs = new Set([...clash].map(c => docKey(c.row.kind, c.row.doc_id)));
    if (docs.size < 2) continue;
    for (const c of clash) {
      refused.set(c, {
        ...c.report,
        status: 'refused',
        code: 'path-conflict',
        reason: `another document writes ${p} (or inside it)`,
      });
    }
  }
  return {
    ok: candidates.filter(c => !refused.has(c)),
    refused: [...refused.values()],
  };
}

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
  const noteUnusedMessage = () => {
    if (!payload.message?.trim()) return;
    report.unusedMessage = payload.message;
    log.info('content-checkpoint: Save version message reached no commit', {
      classroomId,
      message: payload.message,
    });
  };

  const classroom = await prisma.classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });
  if (!classroom) {
    log.warn('content-checkpoint: classroom not found', { classroomId });
    return report;
  }

  // 1. The dirty rows, filtered in SQL: metadata only, no state.
  const dirty = await prisma.$queryRaw<DirtyRowMeta[]>`
    SELECT kind, doc_id, epoch, version, pushed_version, schema_version, source_sha
    FROM collab_docs
    WHERE classroom_id = ${classroomId}
      AND version > pushed_version
      AND octet_length(state) > 0
    ORDER BY kind, doc_id`;
  if (dirty.length === 0) {
    log.info('content-checkpoint: nothing to push', { classroomId });
    noteUnusedMessage();
    return report;
  }

  if (!classroom.git_organization?.login || !classroom.content_repo) {
    throw new Error(`Classroom ${classroomId} has no content repo or git organization configured`);
  }

  // Renderers, loaded only for the kinds present.
  let pageRenderer: PageRenderer | null = null;
  let pageRendererError: string | null = null;
  if (dirty.some(r => r.kind === 'page')) {
    try {
      pageRenderer = await deps.loadPageRenderer();
    } catch (error) {
      pageRendererError = errMessage(error);
      log.error('content-checkpoint: page renderer failed to load', { error: pageRendererError });
    }
  }
  const deckRenderer = dirty.some(r => r.kind === 'deck') ? await deps.loadDeckRenderer() : null;

  const pageIds = dirty.filter(r => r.kind === 'page').map(r => r.doc_id);
  const deckIds = dirty.filter(r => r.kind === 'deck').map(r => r.doc_id);
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

  // 2–4. Snapshot, render, guard, prepare — one row at a time.
  const candidates: Candidate[] = [];
  const refuse = (base: DocReport, code: DocReport['code'], reason: string) => {
    log.error('content-checkpoint: refused a document', {
      classroomId,
      kind: base.kind,
      docId: base.docId,
      version: base.version,
      code,
      reason,
    });
    report.docs.push({ ...base, status: 'refused', code, reason });
  };

  for (const meta of dirty) {
    const base: DocReport = {
      kind: meta.kind,
      docId: meta.doc_id,
      version: meta.version,
      status: 'skipped',
    };
    try {
      if (meta.kind !== 'page' && meta.kind !== 'deck') {
        report.docs.push({ ...base, code: 'unknown-kind', reason: `unknown kind ${meta.kind}` });
        continue;
      }
      const target = meta.kind === 'page' ? pageById.get(meta.doc_id) : slideById.get(meta.doc_id);
      if (!target) {
        report.docs.push({
          ...base,
          code: 'doc-missing',
          reason: `${meta.kind} row not found in this classroom`,
        });
        continue;
      }
      base.title = target.title;

      // H1: a row written by a different schema than this worker's.
      if (meta.kind === 'page') {
        if (!pageRenderer) {
          report.docs.push({
            ...base,
            status: 'failed',
            reason: `page renderer unavailable: ${pageRendererError}`,
          });
          continue;
        }
        if (meta.schema_version !== pageRenderer.schemaVersion) {
          refuse(
            base,
            'schema-mismatch',
            `row schema ${meta.schema_version}, worker schema ${pageRenderer.schemaVersion}`
          );
          continue;
        }
      } else {
        if (!deckRenderer) {
          log.warn('content-checkpoint: deck converter unavailable; deck left dirty', {
            classroomId,
            slideId: meta.doc_id,
          });
          report.docs.push({
            ...base,
            code: 'converter-unavailable',
            reason: 'deck converter unavailable',
          });
          continue;
        }
        if (meta.schema_version !== deckRenderer.schemaVersion) {
          refuse(
            base,
            'schema-mismatch',
            `row schema ${meta.schema_version}, worker schema ${deckRenderer.schemaVersion}`
          );
          continue;
        }
      }

      // The snapshot: state and the counters it is credited to, one read.
      const row = await prisma.collabDoc.findUnique({
        where: { kind_doc_id: { kind: meta.kind, doc_id: meta.doc_id } },
        select: {
          kind: true,
          doc_id: true,
          epoch: true,
          version: true,
          pushed_version: true,
          schema_version: true,
          source_sha: true,
          state: true,
        },
      });
      if (
        !row ||
        row.state.byteLength === 0 ||
        row.version <= row.pushed_version ||
        row.schema_version !== meta.schema_version
      ) {
        continue; // reseeded, pushed or rewritten since the filter: not ours now
      }
      base.version = row.version;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, row.state);

      if (meta.kind === 'page' && pageRenderer) {
        const page = target as { id: string; title: string; content_path: string };
        const pageTarget: PageTarget = { ...page, classroom };
        const content = pageRenderer.render(doc);
        if (!Array.isArray(content.blocks) || content.blocks.length === 0) {
          refuse(base, 'empty-render', 'the page rendered to zero blocks');
          continue;
        }
        const guard = checkPageRender(doc, pageRenderer.fragment, content.blocks);
        if (!guard.ok) {
          refuse(
            base,
            guard.droppedIds.length ? 'dropped-content' : 'short-columns',
            guard.reason ?? 'guard refused'
          );
          continue;
        }
        // An explicit cover (null when the doc has none): the document is the
        // truth, so no re-read of the stored file.
        const prepared = await deps.preparePageContent(pageTarget, content.blocks, {
          coverImage: content.coverImage ?? null,
        });
        candidates.push({
          row,
          report: { ...base, paths: [prepared.path] },
          sourcePath: prepared.path,
          sourcePaths: [prepared.path],
          files: [{ path: prepared.path, content: prepared.content }],
          record: shas =>
            deps.recordPageFile(pageTarget, prepared.path, shas[prepared.path], prepared.content, {
              awaitTail: true,
            }),
        });
      } else if (meta.kind === 'deck' && deckRenderer) {
        const slide = target as { id: string; title: string; content_path: string; kind: string };
        const deckTarget: DeckTarget = { ...slide, classroom };
        const deck = deckRenderer.render(doc);
        if (deck?.version !== 1 || !Array.isArray(deck.slides)) {
          refuse(base, 'not-a-deck', 'render is not a version 1 deck');
          continue;
        }
        if (deck.slides.length === 0) {
          refuse(base, 'empty-render', 'the deck rendered to zero slides');
          continue;
        }
        const dropped = droppedSlideIds(doc, deck);
        if (dropped.length) {
          refuse(
            base,
            'dropped-content',
            `the render dropped ${dropped.length} slide(s) the document holds: ${dropped
              .slice(0, 10)
              .join(', ')}`
          );
          continue;
        }
        const themeUrls = await deps.resolveDeckThemeUrls(deckTarget, deck);
        const prepared = await deps.prepareDeckForSave(deckTarget, deck, {
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
          // A legacy deck was seeded from index.html: its source_sha is that
          // file's until deck.json exists.
          sourcePaths: [prepared.deckPath, prepared.htmlPath],
          files: written,
          record: shas =>
            deps.recordDeckCommit(
              deckTarget,
              written.map(f => ({ path: f.path, sha: shas[f.path] })),
              written,
              { awaitTail: true }
            ),
        });
      }
    } catch (error) {
      log.error('content-checkpoint: render/prepare failed; doc left dirty', {
        classroomId,
        kind: meta.kind,
        docId: meta.doc_id,
        error: errMessage(error),
      });
      report.docs.push({ ...base, status: 'failed', reason: errMessage(error) });
    }
  }

  const { ok, refused } = refuseConflictingPaths(candidates);
  for (const r of refused) refuse(r, r.code, r.reason ?? 'path refused');
  if (ok.length === 0) {
    noteUnusedMessage();
    return report;
  }

  // 5. One commit for every prepared doc.
  const groups: CommitGroup[] = ok.map(c => ({
    id: docKey(c.row.kind, c.row.doc_id),
    files: c.files,
    ...(c.row.source_sha ? { expectBase: { paths: c.sourcePaths, sha: c.row.source_sha } } : {}),
  }));
  const coAuthorsByDoc = await resolveCoAuthors(
    prisma,
    payload.editors,
    new Set(groups.map(g => g.id))
  );
  const titleOf = new Map(
    ok.map(c => [docKey(c.row.kind, c.row.doc_id), c.report.title ?? c.row.doc_id])
  );
  // Built from the docs actually in the commit: one the backstop leaves out
  // is neither named in the subject nor credited in the trailers.
  const buildMessage = (includedIds: string[]) => {
    const message = checkpointMessage({
      titles: includedIds.map(id => titleOf.get(id) ?? id),
      runId: ctx.runId,
      ...(payload.message ? { body: payload.message } : {}),
      coAuthors: coAuthorsFor(coAuthorsByDoc, includedIds),
    });
    report.message = message;
    return message;
  };

  const remote = await deps.remote(classroom);
  const input: CommitFilesInput = {
    remoteUrl: remote.url,
    ...(remote.auth ? { auth: remote.auth } : {}),
    groups,
    message: buildMessage,
    author: deps.author,
  };
  let result: CommitFilesResult;
  try {
    result = await deps.commitFiles(input);
  } catch (error) {
    if (!isRepoNotFound(error)) throw error;
    // A content repo that does not exist yet: create it through the usual
    // path (which asks the API, so a 403 is never mistaken for a 404), then
    // try once more.
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

  // The backstop: docs whose file changed outside. Left dirty; collab is told.
  const excluded = new Map(result.excluded.map(e => [e.id, e]));
  for (const c of ok) {
    const e = excluded.get(docKey(c.row.kind, c.row.doc_id));
    if (!e) continue;
    refuse(
      c.report,
      'outside-edit-pending',
      `${e.path} changed outside the live document (at ${e.headCommit.slice(0, 12)}); waiting for collab to merge it`
    );
    try {
      await deps.notifyOutsideEdit({
        classroomId,
        kind: c.row.kind,
        docId: c.row.doc_id,
        sha: e.headCommit,
      });
    } catch (error) {
      log.error('content-checkpoint: could not notify collab of an outside edit', {
        classroomId,
        docId: c.row.doc_id,
        error: errMessage(error),
      });
    }
  }
  const included = ok.filter(c => !excluded.has(docKey(c.row.kind, c.row.doc_id)));
  if (!result.pushed) noteUnusedMessage();

  // 6. Record every doc the head now holds — pushed now, or already there
  // (idempotent; covers a retry after a crash between push and record). A
  // failure here does not undo the commit; the push webhook and the nightly
  // reconcile fill the gap.
  for (const c of included) {
    try {
      await c.record(result.blobShas);
    } catch (error) {
      log.error('content-checkpoint: record step failed', {
        classroomId,
        docId: c.row.doc_id,
        error: errMessage(error),
      });
    }
  }

  // 7. Rows. Clean only if nothing was stored since the snapshot.
  for (const c of included) {
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
