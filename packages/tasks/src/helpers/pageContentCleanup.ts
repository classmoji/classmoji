/**
 * Cleaning stored page content to BlockNote's stock style rules
 * (`cleanPageBlocks`): inline code that is also bold/italic/…, code inside a
 * link, a link stored as a text style. The logic of
 * `scripts/cleanPageContent.ts`, with every database, git and collab call
 * injected so it is testable with fakes.
 *
 * Which copy of a page is read, and how it is written back:
 *
 *  - Live classroom (`collab_enabled`): the collab server's snapshot, as the
 *    MCP's page_content_get reads it (the live document when the page is
 *    open or holds unsaved edits, else what an open would seed from git).
 *    Written back the way the MCP's live apply writes: `update` ops on the
 *    blocks whose own runs changed, through the collab server, so open
 *    editors see the change and the checkpoint carries it to git. Each op is
 *    guarded by the hash of the block as read (`expect`): a block someone
 *    changed meanwhile is refused (nothing applied) and reported.
 *  - A live classroom whose page the collab server cannot load at all (422
 *    `invalid-block`: content no schema builds, such as a `href` style) has
 *    no live document, so git's `content.json` is the page: read and written
 *    there, under its sha. Skipped if a stored row still holds edits not yet
 *    in git.
 *  - Classroom without live editing: git's `content.json`, written under its
 *    sha.
 *
 * Dry run unless `apply`: nothing is written, every page is reported. With
 * `apply`, each page is saved as read (`savePreImage`) before any of it is
 * written, and one audit row is recorded per page written.
 */

import { cleanPageBlocks, type PageContentChange } from '@classmoji/page-schema';

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface CleanupPage {
  id: string;
  title: string;
  content_path: string;
  classroom: { id: string; slug: string; collab_enabled: boolean; [key: string]: unknown };
  [key: string]: unknown;
}

export type Selector = { kind: 'slugs'; slugs: string[] } | { kind: 'all' };

/** The collab server's read of a page. */
export type LiveRead =
  | { kind: 'live'; blocks: unknown[] }
  /** 422 `invalid-block`: nothing live, the server cannot even seed it. */
  | { kind: 'unloadable'; detail: string }
  /** Any other refusal the page is skipped for (legacy HTML, no content…). */
  | { kind: 'refused'; detail: string };

export type GitRead =
  | { kind: 'json'; blocks: unknown[]; sha: string }
  | { kind: 'legacy' }
  | { kind: 'none' };

export interface UpdateOp {
  op: 'update';
  id: string;
  block: unknown;
}

/** A refused live write the page is reported (not failed) for. */
export class LiveWriteConflict extends Error {
  readonly changedIds: string[];
  constructor(changedIds: string[]) {
    super(`changed since it was read: ${changedIds.join(', ')}`);
    this.name = 'LiveWriteConflict';
    this.changedIds = changedIds;
  }
}

/**
 * A failure that ends the whole run, before anything else is written: the
 * collab server refusing the run's credentials, or answering at an address
 * it does not serve (a wrong COLLAB_URL).
 */
export class FatalCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalCleanupError';
  }
}

/** What a write is recorded with (one audit row per page). */
export type WriteRecord =
  | { committed_to: 'live'; blocks: string[] }
  | { committed_to: 'git'; sha: string; commit: string };

export interface CleanupDeps {
  findPages(selector: Selector): Promise<CleanupPage[]>;
  /** Null when the collab server is not configured. */
  readLive: ((pageId: string) => Promise<LiveRead>) | null;
  /** A stored live row with edits not yet in git. */
  hasUnpushedLiveEdits(pageId: string): Promise<boolean>;
  readGit(page: CleanupPage): Promise<GitRead>;
  /** `itemHash` (`@classmoji/collab/hash`): the guard the collab server checks. */
  hash(block: unknown): string;
  /** Problems the cleaned blocks still have (`validatePageBlocks`). */
  remainingProblems(blocks: unknown[]): string[];
  /** Null in a dry run. Throws LiveWriteConflict for a block changed since the read. */
  writeLive:
    | ((page: CleanupPage, ops: UpdateOp[], expect: Record<string, string>) => Promise<void>)
    | null;
  /** Null in a dry run. */
  writeGit:
    | ((
        page: CleanupPage,
        blocks: unknown[],
        sha: string
      ) => Promise<{ sha: string; commit: string }>)
    | null;
  /**
   * Null in a dry run. Saves the page as read before anything of it is
   * written (the pre-image a restore starts from); a failure stops the page.
   */
  savePreImage:
    | ((
        page: CleanupPage,
        read: { source: string; sha?: string; blocks: unknown[] }
      ) => Promise<void>)
    | null;
  /** Null in a dry run. One audit row per page written. */
  recordWrite: ((page: CleanupPage, record: WriteRecord) => Promise<void>) | null;
  log(line: string): void;
}

/**
 * `unfixable`: nothing to clean, but the page still does not open under the
 * stock rules (a problem the cleaner has no rule for, named in `note`).
 */
export type PageStatus = 'clean' | 'would-clean' | 'cleaned' | 'unfixable' | 'skipped' | 'failed';

export interface PageReport {
  classroom: string;
  pageId: string;
  title: string;
  source: 'live' | 'git' | 'git (live service cannot load it)' | null;
  status: PageStatus;
  /** What was (or would be) changed, counted by kind. */
  changes: string;
  /** Why it was skipped or failed, or problems the cleaner cannot fix. */
  note?: string;
  /** Still would not open after cleaning (its problems are in `note`). */
  stillInvalid?: true;
}

export interface CleanupSummary {
  apply: boolean;
  pages: PageReport[];
  counts: Record<PageStatus, number>;
  /** Pages that still would not open after cleaning (`unfixable`, or cleaned with a note). */
  stillInvalid: number;
}

/** Live ops per request, well under the collab server's 400. */
export const LIVE_OPS_PER_REQUEST = 100;

// ─── Arguments ───────────────────────────────────────────────────────────────

export const USAGE =
  'Usage: cleanPageContent.ts (<classroom-slug> [<classroom-slug> …] | --all) ' +
  '[--apply --out <dir>]';

export interface CleanupOptions {
  selector: Selector;
  apply: boolean;
  /** Where each page's pre-image is saved before it is written (required with --apply). */
  outDir: string | null;
}

export function parseArgs(argv: string[]): CleanupOptions {
  const slugs: string[] = [];
  let all = false;
  let apply = false;
  let outDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') all = true;
    else if (arg === '--apply') apply = true;
    else if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? argv[++i] : arg.slice('--out='.length);
      if (!value || value.startsWith('--')) throw new Error(`--out needs a directory\n${USAGE}`);
      outDir = value;
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}\n${USAGE}`);
    else slugs.push(...arg.split(',').filter(Boolean));
  }
  if (all ? slugs.length > 0 : slugs.length === 0) {
    throw new Error(`Pass classroom slugs or --all (not both).\n${USAGE}`);
  }
  if (apply && !outDir) {
    throw new Error(`--apply needs --out <dir> (each page is saved there before it is written)`);
  }
  return { selector: all ? { kind: 'all' } : { kind: 'slugs', slugs }, apply, outDir };
}

// ─── The plan for one page ───────────────────────────────────────────────────

type Block = { id?: unknown; content?: unknown; children?: unknown };

/**
 * `update` ops turning `before` into `after` (the same tree, as
 * `cleanPageBlocks` returns it): one per block whose own runs changed, its
 * cleaned children riding along; a block whose children changed but not its
 * own runs is descended into instead. `expect` holds the hash of each block
 * as read.
 */
export function updateOpsFor(
  before: unknown[],
  after: unknown[],
  hash: (block: unknown) => string
): { ops: UpdateOp[]; expect: Record<string, string> } {
  const ops: UpdateOp[] = [];
  const expect: Record<string, string> = {};
  const walk = (was: unknown[], now: unknown[]) => {
    now.forEach((block, i) => {
      const old = was[i];
      if (block === old) return;
      const b = block as Block;
      const o = old as Block;
      if (b.content !== o.content) {
        if (typeof o.id !== 'string') throw new Error('a changed block has no id');
        ops.push({ op: 'update', id: o.id, block });
        expect[o.id] = hash(old);
        return;
      }
      if (Array.isArray(b.children) && Array.isArray(o.children)) walk(o.children, b.children);
    });
  };
  walk(before, after);
  return { ops, expect };
}

/** Changes counted by kind: `2× dropped bold from inline code …; 1× …`. */
export function summarizeChanges(changes: PageContentChange[]): string {
  const counts = new Map<string, number>();
  for (const { change } of changes) counts.set(change, (counts.get(change) ?? 0) + 1);
  return [...counts].map(([change, n]) => `${n}× ${change}`).join('; ');
}

// ─── The run ─────────────────────────────────────────────────────────────────

type Read =
  | { kind: 'live'; blocks: unknown[] }
  | { kind: 'git'; blocks: unknown[]; sha: string; source: PageReport['source'] }
  | { kind: 'skip'; note: string };

async function readPage(deps: CleanupDeps, page: CleanupPage): Promise<Read> {
  const fromGit = async (source: PageReport['source']): Promise<Read> => {
    const git = await deps.readGit(page);
    if (git.kind === 'legacy') return { kind: 'skip', note: 'legacy HTML page (index.html)' };
    if (git.kind === 'none') return { kind: 'skip', note: 'no content.json' };
    return { kind: 'git', blocks: git.blocks, sha: git.sha, source };
  };
  if (!page.classroom.collab_enabled) return fromGit('git');
  if (!deps.readLive) throw new Error('live classroom, but the collab server is not configured');
  const live = await deps.readLive(page.id);
  if (live.kind === 'live') return live;
  if (live.kind === 'refused') return { kind: 'skip', note: `live service: ${live.detail}` };
  if (await deps.hasUnpushedLiveEdits(page.id)) {
    return {
      kind: 'skip',
      note: `live service cannot load it (${live.detail}) and a stored row has edits not in git`,
    };
  }
  return fromGit('git (live service cannot load it)');
}

async function cleanOne(deps: CleanupDeps, page: CleanupPage, apply: boolean): Promise<PageReport> {
  const base = { classroom: page.classroom.slug, pageId: page.id, title: page.title };
  const read = await readPage(deps, page);
  if (read.kind === 'skip') {
    return { ...base, source: null, status: 'skipped', changes: '', note: read.note };
  }
  const source = read.kind === 'live' ? 'live' : read.source;
  const { blocks, changes } = cleanPageBlocks(read.blocks);
  const remaining = deps.remainingProblems(blocks);
  const note =
    remaining.length > 0
      ? `still does not open: ${remaining.slice(0, 5).join('; ')}` +
        (remaining.length > 5 ? `; and ${remaining.length - 5} more` : '')
      : undefined;
  const report = (status: PageStatus, extra?: string): PageReport => {
    const notes = [note, extra].filter(Boolean).join('; ');
    return {
      ...base,
      source,
      status,
      changes: summarizeChanges(changes),
      ...(notes ? { note: notes } : {}),
      ...(remaining.length > 0 ? { stillInvalid: true as const } : {}),
    };
  };
  if (changes.length === 0) return report(remaining.length > 0 ? 'unfixable' : 'clean');
  if (!apply) return report('would-clean');

  if (!deps.savePreImage || !deps.recordWrite) throw new Error('apply without a pre-image store');
  await deps.savePreImage(page, {
    source: source ?? 'git',
    ...(read.kind === 'git' ? { sha: read.sha } : {}),
    blocks: read.blocks,
  });
  if (read.kind === 'live') {
    if (!deps.writeLive) throw new Error('apply without a live writer');
    const { ops, expect } = updateOpsFor(read.blocks, blocks, deps.hash);
    let written = 0;
    try {
      for (let i = 0; i < ops.length; i += LIVE_OPS_PER_REQUEST) {
        const batch = ops.slice(i, i + LIVE_OPS_PER_REQUEST);
        const batchExpect = Object.fromEntries(batch.map(op => [op.id, expect[op.id]]));
        await deps.writeLive(page, batch, batchExpect);
        written += batch.length;
      }
    } catch (error) {
      // Batches already applied stay applied: recorded, and a rerun finishes.
      if (written > 0) {
        await deps.recordWrite(page, {
          committed_to: 'live',
          blocks: ops.slice(0, written).map(op => op.id),
        });
      }
      if (error instanceof LiveWriteConflict) {
        return report(
          'skipped',
          `someone edited it meanwhile (${error.message}); ` +
            `${written > 0 ? `${written} of ${ops.length} blocks written; ` : ''}run again`
        );
      }
      throw error;
    }
    await deps.recordWrite(page, { committed_to: 'live', blocks: ops.map(op => op.id) });
    return report('cleaned');
  }
  if (!deps.writeGit) throw new Error('apply without a git writer');
  const written = await deps.writeGit(page, blocks, read.sha);
  await deps.recordWrite(page, { committed_to: 'git', ...written });
  return report('cleaned');
}

/** One line per page: classroom, page id, title, status, source, changes, note. */
export function formatPageLine(report: PageReport): string {
  return [
    report.classroom,
    report.pageId,
    JSON.stringify(report.title),
    report.status,
    report.source ?? '-',
    report.changes || '-',
    ...(report.note ? [report.note] : []),
  ].join('\t');
}

export async function runPageCleanup(
  deps: CleanupDeps,
  selector: Selector,
  { apply }: { apply: boolean }
): Promise<CleanupSummary> {
  const pages = await deps.findPages(selector);
  const counts: CleanupSummary['counts'] = {
    clean: 0,
    'would-clean': 0,
    cleaned: 0,
    unfixable: 0,
    skipped: 0,
    failed: 0,
  };
  let stillInvalid = 0;
  const reports: PageReport[] = [];
  for (const page of pages) {
    let report: PageReport;
    try {
      report = await cleanOne(deps, page, apply);
    } catch (error) {
      // The run's credentials or address are wrong: stop before any other write.
      if (error instanceof FatalCleanupError) throw error;
      report = {
        classroom: page.classroom.slug,
        pageId: page.id,
        title: page.title,
        source: null,
        status: 'failed',
        changes: '',
        note: error instanceof Error ? error.message : String(error),
      };
    }
    counts[report.status] += 1;
    if (report.stillInvalid) stillInvalid += 1;
    reports.push(report);
    // Every page that is not already clean, as it goes.
    if (report.status !== 'clean') deps.log(formatPageLine(report));
  }
  return { apply, pages: reports, counts, stillInvalid };
}
