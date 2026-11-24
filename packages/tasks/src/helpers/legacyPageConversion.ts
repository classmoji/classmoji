/**
 * Converting legacy pages (a content folder with `index.html` and no
 * `content.json`) to blocks, IN PLACE: same page row, same id, same links.
 * The logic of `scripts/convertLegacyPages.ts`, with every database, git and
 * collab call injected so the rules are testable with fakes.
 *
 * ## Why the blocks must be exactly what collab seeded
 *
 * Collab no longer converts legacy pages: it refuses their rooms
 * (`legacy-html`) and stores nothing for them, so for a page with no
 * `collab_docs` row the snapshot below answers 422 and the page is written
 * as for any page nobody has open. But collab used to seed a legacy page's
 * room from its own conversion of `index.html`, and such rows may remain. A
 * `content.json` written by anything but the checkpoint worker is an OUTSIDE
 * edit: hook-station (Github) or the checkpoint worker's `expectBase`
 * backstop (any provider) triggers `collab-external`, and for a row that is
 * open or dirty collab's `mergeExternal` 3-way merges theirs (the new
 * `content.json`) into the live document (seeded from that conversion). So
 * the file written here is built exactly as collab seeded a legacy page
 * (`convertLegacyPageHtml` with the same inputs,
 * `normalizeBlockStructure(ensureBlockIds(..))`, the DB cover columns, through
 * the page schema's Y.Doc) and prepared exactly as the checkpoint worker
 * prepares a page (`yDocToPageContent` → `preparePageContent` with an explicit
 * cover). Before anything is written the merge is run here, and the page is
 * skipped unless it provably changes nothing, and unless the collab server's
 * own document of the page (when it holds one) equals the blocks (the check
 * against converter or schema skew).
 *
 * ## What happens to each page once `content.json` lands
 *
 *  - no `collab_docs` row (or a reseed marker): nothing is live (collab
 *    refused the room); the next open seeds from `content.json`.
 *  - a clean row, closed: `/external` marks it for reseed (Github push), or
 *    the next open sees git's sha moved and reseeds (`load()`); either way it
 *    reopens from `content.json`, same blocks.
 *  - a clean row, open in memory: `/external` merges. Collab no longer reads
 *    a legacy `index.html` as a merge base, so with that blob as the row's
 *    `source_sha` it keeps the live document and records `no-merge-base`
 *    (alerted, not applied): the live document already equals the file.
 *  - a dirty row (live edits not yet checkpointed): SKIPPED: someone is
 *    working on that page, and their own first checkpoint converts it.
 *  - a row open in a browser right now: SKIPPED (reported), as above.
 */

import { isDeepStrictEqual } from 'node:util';

import { FRAGMENT, SCHEMA_VERSION, type PageCoverImage } from '@classmoji/page-schema';
import { pageContentToYDoc, yDocToPageContent } from '@classmoji/page-schema/server';
import * as Y from 'yjs';

import { checkPageRender } from './checkpointGuards.ts';

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface LegacyGitOrganization {
  provider: string;
  login: string;
  [key: string]: unknown;
}

export interface LegacyClassroom {
  id: string;
  slug: string;
  status: string;
  collab_enabled: boolean;
  content_repo: string | null;
  content_key_version: number;
  content_delivery_enabled: boolean | null;
  is_archived?: boolean;
  git_organization: LegacyGitOrganization | null;
  [key: string]: unknown;
}

/** A page row with its classroom, as `findPages` returns it. */
export interface LegacyPageRow {
  id: string;
  title: string;
  content_path: string;
  is_draft: boolean;
  is_public: boolean;
  header_image_url: string | null;
  header_image_position: number | null;
  classroom_id: string;
  classroom: LegacyClassroom;
}

/** The `collab_docs` columns the rules read. */
export interface CollabRowMeta {
  version: number;
  pushed_version: number;
  source_sha: string | null;
  schema_version: number;
  /** Full Y update; empty = a reseed marker. */
  state: Uint8Array;
}

/** `GET /internal/page/:id/snapshot` (no viewer): the live or stored doc. */
export interface CollabSnapshot {
  live: boolean;
  version: number;
  content: { blocks: unknown[]; coverImage?: PageCoverImage | null };
}

/**
 * Collab's answer to the snapshot request: the document, or null when collab
 * refuses the page as legacy HTML (422 `legacy-html`: it holds no document
 * for it and seeds none). Anything else throws: a non-2xx, and a 2xx whose
 * body is not a snapshot (unparseable, or the wrong shape) — only collab's
 * explicit refusal may read as "collab holds nothing".
 */
export function readSnapshotResponse(status: number, body: unknown): CollabSnapshot | null {
  if (status >= 200 && status < 300) {
    const snapshot = body as Partial<CollabSnapshot> | null;
    const ok =
      !!snapshot &&
      typeof snapshot === 'object' &&
      !Array.isArray(snapshot) &&
      typeof snapshot.live === 'boolean' &&
      !!snapshot.content &&
      Array.isArray(snapshot.content.blocks);
    if (!ok) throw new Error(`HTTP ${status}: the body is not a snapshot`);
    return snapshot as CollabSnapshot;
  }
  const error = (body as { error?: unknown } | null)?.error;
  if (status === 422 && error === 'legacy-html') return null;
  throw new Error(`HTTP ${status}${typeof error === 'string' ? ` ${error}` : ''}`);
}

/** What `preparePageContent` returns: the exact bytes to commit. */
export interface PreparedFile {
  path: string;
  content: string;
  coverImage: PageCoverImage | null;
}

export type Selector =
  | { kind: 'page'; pageId: string }
  | { kind: 'classroom'; login: string; slug: string }
  | { kind: 'all' };

export interface Options {
  selector: Selector;
  write: boolean;
  outDir: string | null;
}

type Blocks = unknown[];

/**
 * Equal as JSON: what a file or an HTTP answer carries. A block read from a
 * Y.Doc can hold `undefined` values (BlockNote's `content` on a block without
 * inline content) that JSON drops, so the collab snapshot (JSON) and a local
 * render of the same document would differ for `isDeepStrictEqual` alone.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(asJson(a), asJson(b));
}

function asJson(value: unknown): unknown {
  return value === undefined ? null : (JSON.parse(JSON.stringify(value)) as unknown);
}

export interface PageOps {
  ensureBlockIds<T>(blocks: T[]): T[];
  normalizeBlockStructure<T>(blocks: T[]): T[];
  merge3Blocks(
    base: unknown[],
    ours: unknown[],
    theirs: unknown[]
  ): { merged: unknown[]; conflicts: unknown[] };
}

export interface LegacyDeps {
  findPages(selector: Selector): Promise<LegacyPageRow[]>;
  /** Every file under `pages/` on the default branch, path → blob sha. ONE listing per repo. */
  listPageFiles(classroom: LegacyClassroom): Promise<Map<string, string>>;
  /** A blob's text by sha, null when it does not exist. */
  readBlob(classroom: LegacyClassroom, sha: string): Promise<string | null>;
  /** Which of `ids` are pages of the classroom (as collab's old conversion looked them up). */
  pageIdsInClassroom(classroomId: string, ids: string[]): Promise<Set<string>>;
  collabRow(pageId: string): Promise<CollabRowMeta | null>;
  /**
   * The page's collab document (`readSnapshotResponse`): null when collab
   * holds none and refuses to seed one (a legacy page with no row). The
   * function is null when the collab server is not configured for this run.
   */
  collabSnapshot: ((pageId: string) => Promise<CollabSnapshot | null>) | null;
  legacyPageLinkIds(html: string): string[];
  /** `convertLegacyPageHtml` (`@classmoji/page-schema/html`) with `ensureBlockIds` bound. */
  convertLegacy(
    html: string,
    inputs: { title: string; classroomSlug: string; pagesInClassroom: ReadonlySet<string> }
  ): Promise<Blocks>;
  pageOps: PageOps;
  /** `preparePageContent(page, blocks, { coverImage })`. Reads, never writes. */
  prepare(
    page: LegacyPageRow,
    blocks: Blocks,
    coverImage: PageCoverImage | null
  ): Promise<PreparedFile>;
  /**
   * Commit `content.json` (create-only) and record it. Null in a dry run:
   * nothing in a dry run can write.
   */
  write:
    | ((
        page: LegacyPageRow,
        prepared: PreparedFile
      ) => Promise<{
        commit: string;
        /** Something after the commit failed (the audit row). */ note?: string;
      }>)
    | null;
  /**
   * Whether a Gitlab classroom's stored connection token is fresh enough to
   * use WITHOUT a refresh. Set for a dry run only: a refresh there would spend
   * the refresh token and then fail to store the new one (read-only session),
   * breaking the classroom's Gitlab connection. A stale classroom is skipped
   * before any provider call. Absent (`--write`): providers refresh as usual.
   */
  gitlabTokenFresh?(classroom: LegacyClassroom): Promise<boolean>;
  /** After every page (and every skipped classroom): the summary so far, for `report.json`. */
  onProgress?(summary: RunSummary): Promise<void>;
  /** Dry-run artifacts (`<pageId>.<name>.json`); absent = not saved. */
  save?(pageId: string, name: string, text: string): Promise<void>;
  log?(line: string): void;
}

export type CollabState = 'no row' | 'clean' | 'dirty' | 'open' | 'not checked';

export interface PageReport {
  pageId: string;
  classroom: string;
  title: string;
  contentPath: string;
  visibility: 'draft' | 'public' | 'members';
  blockCount: number | null;
  collab: CollabState;
  /** `failed`: an error (a read, the write, anything thrown); a `skipped` page was left on purpose. */
  action: 'converted' | 'would convert' | 'skipped' | 'failed';
  reason?: string;
  commit?: string;
  /** Reported, never a reason to skip: e.g. the classroom is LOCKED or archived. */
  flags?: string[];
  /**
   * Git was read and holds the page as legacy (`index.html`, no
   * `content.json`). False for a page reported for its CLASSROOM before its
   * own files were read (the repository not readable or not listed, a stale
   * Gitlab token): whether it is legacy is not known.
   */
  legacy: boolean;
}

export interface RunSummary {
  pages: PageReport[];
  /** Pages looked at that are not legacy: with content.json, with no file at all, without a repo. */
  notLegacy: { converted: number; noFiles: number; noRepo: number };
}

// ─── Arguments ───────────────────────────────────────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valueOf(argv: string[], flag: string): string | null {
  const at = argv.indexOf(flag);
  if (at !== -1) {
    const next = argv[at + 1];
    if (!next || next.startsWith('--')) throw new Error(`${flag} needs a value`);
    return next;
  }
  const inline = argv.find(arg => arg.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) || null : null;
}

const KNOWN_FLAGS = new Set(['--page', '--classroom', '--all', '--write', '--out']);

/**
 * Exactly one selector: `--page <id>`, `--classroom <git-org-login>/<slug>`
 * (a classroom slug is unique only within its git organization) or `--all`.
 * A dry run unless `--write`.
 */
export function parseArgs(argv: string[]): Options {
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!KNOWN_FLAGS.has(name)) throw new Error(`Unknown option ${name}`);
  }
  const pageId = valueOf(argv, '--page');
  const classroom = valueOf(argv, '--classroom');
  const all = argv.includes('--all');
  const count = [pageId, classroom, all || null].filter(Boolean).length;
  if (count !== 1) {
    throw new Error('Pass exactly one of --page <id>, --classroom <org>/<slug> or --all.');
  }
  let selector: Selector;
  if (pageId) {
    if (!UUID.test(pageId)) throw new Error('--page must be a page id (uuid)');
    selector = { kind: 'page', pageId: pageId.toLowerCase() };
  } else if (classroom) {
    const slash = classroom.indexOf('/');
    const login = slash > 0 ? classroom.slice(0, slash) : '';
    const slug = slash > 0 ? classroom.slice(slash + 1) : '';
    if (!login || !slug || slug.includes('/')) {
      throw new Error('--classroom must be <git-org-login>/<classroom-slug>');
    }
    selector = { kind: 'classroom', login, slug };
  } else {
    selector = { kind: 'all' };
  }
  return { selector, write: argv.includes('--write'), outDir: valueOf(argv, '--out') };
}

// ─── Selection ───────────────────────────────────────────────────────────────

/** `<content_path>/content.json` and `index.html` in one listing. */
export function pageFileState(
  files: Map<string, string>,
  contentPath: string
): { kind: 'json' } | { kind: 'legacy'; htmlSha: string } | { kind: 'none' } {
  if (files.has(`${contentPath}/content.json`)) return { kind: 'json' };
  const htmlSha = files.get(`${contentPath}/index.html`);
  return htmlSha ? { kind: 'legacy', htmlSha } : { kind: 'none' };
}

// ─── Collab state ────────────────────────────────────────────────────────────

/** A row that only marks "seed again from git" holds nothing (collab's `isReseedMarker`). */
export function isReseedMarker(row: CollabRowMeta | null): boolean {
  return !!row && row.state.byteLength === 0;
}

export type CollabDecision =
  | { ok: true; state: CollabState }
  | { ok: false; state: CollabState; reason: string };

/**
 * Whether this page may be written, from the snapshot (read FIRST: it stores
 * pending edits) and the row (read after it). Dirty is collab's own rule
 * (`external()`): a stored row whose version is past the pushed one.
 */
export function decideCollab({
  row,
  snapshot,
}: {
  row: CollabRowMeta | null;
  snapshot: CollabSnapshot | null | 'not-configured';
}): CollabDecision {
  const realRow = row && !isReseedMarker(row) ? row : null;
  if (realRow && realRow.schema_version !== SCHEMA_VERSION) {
    return {
      ok: false,
      state: 'clean',
      reason: `collab row written with schema ${realRow.schema_version}, this checkout has ${SCHEMA_VERSION}`,
    };
  }
  if (realRow && realRow.version > realRow.pushed_version) {
    return { ok: false, state: 'dirty', reason: 'live edits not yet saved to git' };
  }
  if (snapshot !== 'not-configured' && snapshot?.live) {
    return { ok: false, state: 'open', reason: 'open in an editor right now' };
  }
  const state: CollabState =
    snapshot === 'not-configured' ? 'not checked' : realRow ? 'clean' : 'no row';
  return { ok: true, state };
}

// ─── The conversion collab seeded with (before it refused legacy pages) ──────

/** The cover a legacy page keeps only in its DB columns (collab's `legacyCover`). */
export function legacyCover(page: LegacyPageRow): PageCoverImage | null {
  return page.header_image_url
    ? { url: page.header_image_url, position: page.header_image_position ?? 50 }
    : null;
}

/**
 * Collab's `throughSchema` (apps/collab/src/adapters/pageDoc.ts) with its
 * `normalize`: what `mergeExternal` turns a merge base or a pushed file into.
 */
export function throughSchema(ops: PageOps, blocks: Blocks): Blocks {
  const prepared = ops.normalizeBlockStructure(ops.ensureBlockIds(blocks));
  const doc = pageContentToYDoc({ blocks: prepared });
  try {
    return yDocToPageContent(doc).blocks;
  } finally {
    doc.destroy();
  }
}

/**
 * The page as collab's `seed` built it from the converted blocks — the same
 * normalisation, the DB cover, through the Y.Doc — read back the way the
 * checkpoint worker renders a page (`yDocToPageContent`), with the
 * worker's render guard.
 */
export function seededContent(
  ops: PageOps,
  converted: Blocks,
  cover: PageCoverImage | null
): { blocks: Blocks; coverImage: PageCoverImage | null; guard: string | null } {
  const prepared = ops.normalizeBlockStructure(ops.ensureBlockIds(converted));
  if (prepared.length === 0) throw new Error('the conversion produced no blocks');
  const doc = pageContentToYDoc({ blocks: prepared, coverImage: cover });
  try {
    const content = yDocToPageContent(doc);
    const guard = checkPageRender(doc, FRAGMENT, content.blocks);
    return {
      blocks: content.blocks,
      coverImage: content.coverImage ?? null,
      guard: guard.ok ? null : (guard.reason ?? 'the render guard refused it'),
    };
  } finally {
    doc.destroy();
  }
}

/** A stored `collab_docs.state` as page content (when collab itself cannot be asked). */
export function decodeRowState(state: Uint8Array): {
  blocks: Blocks;
  coverImage: PageCoverImage | null;
} {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    const content = yDocToPageContent(doc);
    return { blocks: content.blocks, coverImage: content.coverImage ?? null };
  } finally {
    doc.destroy();
  }
}

/** Where two block trees first differ, for the report (top-level index and ids). */
export function firstDifference(a: Blocks, b: Blocks): string {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (!sameJson(a[i], b[i])) {
      const id = (x: unknown) => (x as { id?: unknown } | undefined)?.id ?? '-';
      return `block ${i} (${String(id(a[i]))} vs ${String(id(b[i]))}) of ${a.length}/${b.length}`;
    }
  }
  return 'no difference';
}

/**
 * The 3-way merge of the file into the document, run here: base is the
 * conversion of the index.html, theirs the prepared file, ours the document
 * collab holds (or, with none, the conversion). Null when it provably changes
 * nothing; otherwise why not.
 */
export function provesNoOpMerge({
  ops,
  converted,
  prepared,
  ours,
}: {
  ops: PageOps;
  converted: Blocks;
  prepared: PreparedFile;
  ours: { blocks: Blocks; coverImage: PageCoverImage | null };
}): string | null {
  const base = throughSchema(ops, converted);
  const file = JSON.parse(prepared.content) as { blocks?: unknown };
  if (!Array.isArray(file.blocks)) return 'the prepared file has no blocks array';
  const theirs = throughSchema(ops, file.blocks);
  if (!sameJson(base, theirs)) {
    return `the written blocks would differ from collab's merge base: ${firstDifference(base, theirs)}`;
  }
  const result = ops.merge3Blocks(base, ours.blocks, theirs);
  if (result.conflicts.length > 0)
    return `the merge would report ${result.conflicts.length} conflicts`;
  const merged = ops.normalizeBlockStructure(ops.ensureBlockIds(result.merged));
  const oursNormalized = ops.normalizeBlockStructure(ops.ensureBlockIds(ours.blocks));
  if (!sameJson(merged, oursNormalized)) {
    return `the merge would change the live page: ${firstDifference(oursNormalized, merged)}`;
  }
  if (!sameJson(prepared.coverImage ?? null, ours.coverImage ?? null)) {
    return 'the written cover would differ from the live page’s';
  }
  return null;
}

// ─── The run ─────────────────────────────────────────────────────────────────

function visibilityOf(page: LegacyPageRow): PageReport['visibility'] {
  return page.is_draft ? 'draft' : page.is_public ? 'public' : 'members';
}

function classroomLabel(classroom: LegacyClassroom): string {
  return `${classroom.git_organization?.login ?? '?'}/${classroom.slug}`;
}

const errText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `gitlabConnection.service.ts` refreshes a token within 5 minutes of expiry. */
export const GITLAB_REFRESH_BUFFER_MS = 5 * 60 * 1000;
/** Our margin on top, so no call during the run itself can reach the refresh. */
export const GITLAB_DRY_RUN_MARGIN_MS = 30 * 60 * 1000;

/**
 * The connection service's freshness rule (`isFresh`: no expiry, or more than
 * the refresh buffer left) with the dry run's margin added.
 */
export function gitlabTokenFreshForDryRun(expiresAt: Date | null, now = Date.now()): boolean {
  return (
    !expiresAt || expiresAt.getTime() - now > GITLAB_REFRESH_BUFFER_MS + GITLAB_DRY_RUN_MARGIN_MS
  );
}

export const GITLAB_STALE_TOKEN = 'Gitlab token needs a refresh; not touched in a dry run';
export const REPOSITORY_NOT_READABLE =
  'repository not readable (its listing of pages/ came back empty or missing)';

function baseReport(page: LegacyPageRow): PageReport {
  return {
    pageId: page.id,
    classroom: classroomLabel(page.classroom),
    title: page.title,
    contentPath: page.content_path,
    visibility: visibilityOf(page),
    blockCount: null,
    collab: 'not checked',
    action: 'skipped',
    legacy: false,
  };
}

/** What the operator should know about the page's classroom (never a skip). */
export function classroomFlags(classroom: LegacyClassroom): string[] {
  const flags: string[] = [];
  if (classroom.status === 'LOCKED') flags.push('classroom LOCKED');
  if (classroom.is_archived === true) flags.push('classroom archived');
  return flags;
}

async function convertOne(
  deps: LegacyDeps,
  page: LegacyPageRow,
  htmlSha: string
): Promise<PageReport> {
  const report = baseReport(page);
  const skip = (reason: string): PageReport => ({ ...report, action: 'skipped', reason });

  // Collab: the snapshot first (it stores pending edits), then the row. A
  // null snapshot is collab refusing the page as legacy HTML: it holds none.
  let snapshot: CollabSnapshot | null | 'not-configured' = 'not-configured';
  if (deps.collabSnapshot) {
    try {
      snapshot = await deps.collabSnapshot(page.id);
    } catch (error) {
      return { ...report, action: 'failed', reason: `collab snapshot failed: ${errText(error)}` };
    }
  }
  const row = await deps.collabRow(page.id);
  const collab = decideCollab({ row, snapshot });
  report.collab = collab.state;
  if (!collab.ok) return skip(collab.reason);

  const html = await deps.readBlob(page.classroom, htmlSha);
  if (html === null) return skip(`index.html blob ${htmlSha} could not be read`);

  // The conversion inputs collab seeded legacy pages with: the links' pages
  // read in ONE query scoped by the row's own classroom.
  const linked = deps.legacyPageLinkIds(html);
  const pagesHere =
    linked.length > 0
      ? await deps.pageIdsInClassroom(page.classroom_id, linked)
      : new Set<string>();
  const inputs = {
    title: page.title,
    classroomSlug: page.classroom.slug,
    pagesInClassroom: pagesHere,
  };
  let converted: Blocks;
  try {
    converted = await deps.convertLegacy(html, inputs);
    const again = await deps.convertLegacy(html, inputs);
    if (!sameJson(converted, again)) return skip('the conversion is not deterministic');
  } catch (error) {
    return skip(`the conversion failed: ${errText(error)}`);
  }

  let seeded: ReturnType<typeof seededContent>;
  try {
    seeded = seededContent(deps.pageOps, converted, legacyCover(page));
  } catch (error) {
    return skip(`the converted blocks do not fit the page schema: ${errText(error)}`);
  }
  report.blockCount = seeded.blocks.length;
  if (seeded.guard) return skip(`the checkpoint render guard refused it: ${seeded.guard}`);

  // The document collab holds for this page: its snapshot (the live or
  // stored doc), else the stored row; none when collab refused the page.
  const realRow = row && !isReseedMarker(row) ? row : null;
  const ours =
    snapshot !== 'not-configured' && snapshot
      ? { blocks: snapshot.content.blocks, coverImage: snapshot.content.coverImage ?? null }
      : realRow
        ? decodeRowState(realRow.state)
        : null;

  const prepared = await deps.prepare(page, seeded.blocks, seeded.coverImage);
  await deps.save?.(page.id, 'content', prepared.content);
  if (ours) await deps.save?.(page.id, 'collab', JSON.stringify(ours, null, 2));

  if (ours && !sameJson(ours.blocks, seeded.blocks)) {
    return skip(`differs from collab's document: ${firstDifference(ours.blocks, seeded.blocks)}`);
  }
  if (ours && !sameJson(ours.coverImage ?? null, seeded.coverImage ?? null)) {
    return skip('the cover differs from collab’s document');
  }
  const unsafe = provesNoOpMerge({
    ops: deps.pageOps,
    converted,
    prepared,
    ours: ours ?? { blocks: seeded.blocks, coverImage: seeded.coverImage },
  });
  if (unsafe) return skip(unsafe);

  if (!deps.write) return { ...report, action: 'would convert' };
  if (snapshot === 'not-configured') return skip('collab was not checked; refusing to write');
  try {
    const { commit, note } = await deps.write(page, prepared);
    return { ...report, action: 'converted', commit, ...(note ? { reason: note } : {}) };
  } catch (error) {
    const status = (error as { status?: unknown } | null)?.status;
    if (status === 409) {
      return skip(`content.json appeared before the write; left alone (${errText(error)})`);
    }
    return { ...report, action: 'failed', reason: `the write failed: ${errText(error)}` };
  }
}

/**
 * Find the legacy pages in scope and convert (or, in a dry run, check) each.
 * Each classroom's repository is listed once. A page that already has
 * `content.json` is never touched (the run is idempotent).
 */
export async function runLegacyConversion(
  deps: LegacyDeps,
  selector: Selector
): Promise<RunSummary> {
  const log = deps.log ?? (() => {});
  const pages = await deps.findPages(selector);
  const byClassroom = new Map<string, LegacyPageRow[]>();
  for (const page of pages) {
    const list = byClassroom.get(page.classroom_id) ?? [];
    list.push(page);
    byClassroom.set(page.classroom_id, list);
  }

  const summary: RunSummary = { pages: [], notLegacy: { converted: 0, noFiles: 0, noRepo: 0 } };
  const progress = async () => {
    await deps.onProgress?.(summary);
  };
  const reportAll = async (
    group: LegacyPageRow[],
    action: 'skipped' | 'failed',
    reason: string
  ) => {
    const flags = classroomFlags(group[0]!.classroom);
    for (const page of group) {
      summary.pages.push({
        ...baseReport(page),
        action,
        reason,
        ...(flags.length ? { flags } : {}),
      });
    }
    await progress();
  };

  for (const group of byClassroom.values()) {
    const classroom = group[0]!.classroom;
    if (!classroom.content_repo || !classroom.git_organization?.login) {
      summary.notLegacy.noRepo += group.length;
      continue;
    }
    // Before ANY provider call for this classroom (see `gitlabTokenFresh`).
    if (classroom.git_organization.provider === 'GITLAB' && deps.gitlabTokenFresh) {
      let fresh = false;
      try {
        fresh = await deps.gitlabTokenFresh(classroom);
      } catch (error) {
        await reportAll(
          group,
          'failed',
          `the Gitlab connection could not be read: ${errText(error)}`
        );
        continue;
      }
      if (!fresh) {
        await reportAll(group, 'skipped', GITLAB_STALE_TOKEN);
        continue;
      }
    }
    let files: Map<string, string>;
    try {
      files = await deps.listPageFiles(classroom);
    } catch (error) {
      await reportAll(group, 'failed', `the repository could not be listed: ${errText(error)}`);
      continue;
    }
    // Page rows and nothing under pages/ at all: a missing or unreadable
    // repository looks exactly like this (a 404 lists as empty), so it is
    // reported rather than counted as "no content file".
    if (files.size === 0) {
      await reportAll(group, 'skipped', REPOSITORY_NOT_READABLE);
      continue;
    }
    for (const page of group) {
      const state = pageFileState(files, page.content_path);
      if (state.kind === 'json') {
        summary.notLegacy.converted += 1;
        continue;
      }
      if (state.kind === 'none') {
        summary.notLegacy.noFiles += 1;
        continue;
      }
      log(`[legacy-pages] ${classroomLabel(classroom)} ${page.content_path}: legacy`);
      let report: PageReport;
      try {
        report = { ...(await convertOne(deps, page, state.htmlSha)), legacy: true };
      } catch (error) {
        // One page's error never stops the batch.
        report = {
          ...baseReport(page),
          action: 'failed',
          reason: `error: ${errText(error)}`,
          legacy: true,
        };
      }
      const flags = classroomFlags(classroom);
      summary.pages.push(flags.length ? { ...report, flags } : report);
      await progress();
    }
  }
  return summary;
}

/** True when any page failed (skips are not failures): the CLI exits non-zero. */
export function hasFailures(summary: RunSummary): boolean {
  return summary.pages.some(page => page.action === 'failed');
}

/** One line per page, for the terminal. */
export function formatReport(summary: RunSummary): string {
  const lines = summary.pages.map(p =>
    [
      p.action.padEnd(13),
      p.classroom,
      `"${p.title}"`,
      p.contentPath,
      p.visibility,
      `blocks=${p.blockCount ?? '-'}`,
      `collab=${p.collab}`,
      ...(p.commit ? [`commit=${p.commit}`] : []),
      ...(p.flags?.length ? [`[${p.flags.join(', ')}]`] : []),
      ...(p.reason ? [`— ${p.reason}`] : []),
    ].join('  ')
  );
  lines.push(...summaryLines(summaryCounts(summary)));
  return lines.join('\n');
}

export interface SummaryCounts {
  /** Pages git holds as legacy, and what became of them. */
  legacy: {
    found: number;
    wouldConvert: number;
    converted: number;
    skipped: number;
    failed: number;
  };
  /** Legacy pages skipped, by reason. */
  skippedReasons: Record<string, number>;
  /** Pages whose repository could not be read: NOT known to be legacy. */
  repositoryNotReadable: number;
  /** Other pages reported for their classroom before their files were read, by reason. */
  classroomNotChecked: Record<string, number>;
  notLegacy: RunSummary['notLegacy'];
}

/** The run's numbers, legacy pages apart from pages whose files were never read. */
export function summaryCounts(summary: RunSummary): SummaryCounts {
  const counts: SummaryCounts = {
    legacy: { found: 0, wouldConvert: 0, converted: 0, skipped: 0, failed: 0 },
    skippedReasons: {},
    repositoryNotReadable: 0,
    classroomNotChecked: {},
    notLegacy: { ...summary.notLegacy },
  };
  for (const page of summary.pages) {
    if (!page.legacy) {
      if (page.reason === REPOSITORY_NOT_READABLE) counts.repositoryNotReadable += 1;
      else {
        const key = `${page.action}: ${page.reason ?? 'unknown'}`;
        counts.classroomNotChecked[key] = (counts.classroomNotChecked[key] ?? 0) + 1;
      }
      continue;
    }
    counts.legacy.found += 1;
    if (page.action === 'would convert') counts.legacy.wouldConvert += 1;
    else if (page.action === 'converted') counts.legacy.converted += 1;
    else if (page.action === 'failed') counts.legacy.failed += 1;
    else {
      counts.legacy.skipped += 1;
      const reason = page.reason ?? 'unknown';
      counts.skippedReasons[reason] = (counts.skippedReasons[reason] ?? 0) + 1;
    }
  }
  return counts;
}

/** The summary as the terminal prints it. */
export function summaryLines(counts: SummaryCounts): string[] {
  const { legacy, notLegacy } = counts;
  const lines = [
    `${legacy.found} legacy page(s): ${legacy.wouldConvert} would convert, ` +
      `${legacy.converted} converted, ${legacy.skipped} skipped, ${legacy.failed} failed`,
  ];
  for (const [reason, n] of Object.entries(counts.skippedReasons)) {
    lines.push(`  skipped ${n}: ${reason}`);
  }
  lines.push(`${counts.repositoryNotReadable} page(s) in a repository that could not be read`);
  for (const [reason, n] of Object.entries(counts.classroomNotChecked)) {
    lines.push(`${n} page(s) not checked (${reason})`);
  }
  lines.push(
    `not legacy: ${notLegacy.converted} with content.json, ` +
      `${notLegacy.noFiles} with no content file, ${notLegacy.noRepo} without a content repository`
  );
  return lines;
}
