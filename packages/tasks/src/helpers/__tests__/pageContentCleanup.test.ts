/**
 * The page-content cleanup's rules (`helpers/pageContentCleanup.ts`) with
 * fakes for the database, git and the collab server: which copy of a page is
 * read, what is written where (live `update` ops guarded by the block hashes
 * as read, or git under its sha), and that a dry run writes nothing.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  FatalCleanupError,
  LIVE_OPS_PER_REQUEST,
  LiveWriteConflict,
  formatPageLine,
  parseArgs,
  runPageCleanup,
  updateOpsFor,
  type CleanupDeps,
  type CleanupPage,
  type GitRead,
  type LiveRead,
} from '../pageContentCleanup.ts';

const run = (text: string, styles: Record<string, unknown> = {}) => ({
  type: 'text',
  text,
  styles,
});
const para = (id: string, content: unknown[], children: unknown[] = []) => ({
  id,
  type: 'paragraph',
  props: {},
  content,
  children,
});

const BOLD_CODE = () => [
  para('p1', [run('fine')]),
  para('p2', [run('useFetcher', { bold: true, code: true })]),
];
const HREF = () => [
  {
    id: 'n1',
    type: 'numberedListItem',
    props: {},
    content: [run('docs', { href: 'https://kotlinlang.org' })],
    children: [],
  },
];

function page(id: string, collab = true, slug = 'cs1'): CleanupPage {
  return {
    id,
    title: `Page ${id}`,
    content_path: `pages/${id}`,
    classroom: { id: `class-${slug}`, slug, collab_enabled: collab },
  };
}

function fakes(
  pages: CleanupPage[],
  {
    live = {},
    git = {},
    unpushed = new Set<string>(),
    apply = false,
  }: {
    live?: Record<string, LiveRead>;
    git?: Record<string, GitRead>;
    unpushed?: Set<string>;
    apply?: boolean;
  } = {}
) {
  const order: string[] = [];
  const writeLive = vi.fn(async (p: CleanupPage) => {
    order.push(`live:${p.id}`);
  });
  const writeGit = vi.fn(async (p: CleanupPage) => {
    order.push(`git:${p.id}`);
    return { sha: 'new-sha', commit: 'c1' };
  });
  const savePreImage = vi.fn(async (p: CleanupPage) => {
    order.push(`pre:${p.id}`);
  });
  const recordWrite = vi.fn(async (_page: CleanupPage, _record: unknown) => {});
  const readGit = vi.fn(async (p: CleanupPage) => git[p.id] ?? { kind: 'none' as const });
  const readLive = vi.fn(async (id: string) => live[id] ?? { kind: 'live' as const, blocks: [] });
  const lines: string[] = [];
  const deps: CleanupDeps = {
    findPages: async () => pages,
    readLive,
    hasUnpushedLiveEdits: async id => unpushed.has(id),
    readGit,
    hash: block => `hash:${(block as { id: string }).id}:${JSON.stringify(block).length}`,
    remainingProblems: () => [],
    writeLive: apply ? writeLive : null,
    writeGit: apply ? writeGit : null,
    savePreImage: apply ? savePreImage : null,
    recordWrite: apply ? recordWrite : null,
    log: line => lines.push(line),
  };
  return { deps, writeLive, writeGit, savePreImage, recordWrite, order, readGit, readLive, lines };
}

describe('parseArgs', () => {
  it('takes slugs (spaces or commas) or --all, and --apply with --out', () => {
    expect(parseArgs(['cs1', 'cs2,cs3'])).toEqual({
      selector: { kind: 'slugs', slugs: ['cs1', 'cs2', 'cs3'] },
      apply: false,
      outDir: null,
    });
    expect(parseArgs(['--all', '--apply', '--out', '/tmp/pre'])).toEqual({
      selector: { kind: 'all' },
      apply: true,
      outDir: '/tmp/pre',
    });
    expect(parseArgs(['cs1', '--out=/tmp/pre']).outDir).toBe('/tmp/pre');
  });

  it('refuses neither, both, unknown flags, and --apply without --out', () => {
    expect(() => parseArgs([])).toThrow(/slugs or --all/);
    expect(() => parseArgs(['cs1', '--all'])).toThrow(/slugs or --all/);
    expect(() => parseArgs(['cs1', '--write'])).toThrow(/Unknown option --write/);
    expect(() => parseArgs(['--all', '--apply'])).toThrow(/--apply needs --out/);
    expect(() => parseArgs(['--all', '--out'])).toThrow(/--out needs a directory/);
  });
});

describe('updateOpsFor', () => {
  it('one update per block whose own runs changed, guarded by its hash as read; nested too', () => {
    const before = [
      para('a', [run('x')]),
      para('b', [run('ok')], [para('kid', [run('k', { code: true, italic: true })])]),
      para('c', [run('c', { code: true, bold: true })], [para('c-kid', [run('fine')])]),
    ];
    const after = [
      before[0],
      { ...before[1], children: [para('kid', [run('k', { code: true })])] },
      {
        ...before[2],
        content: [run('c', { code: true })],
      },
    ];
    const { ops, expect: guard } = updateOpsFor(
      before,
      after,
      b => `h:${(b as { id: string }).id}`
    );
    expect(ops).toEqual([
      { op: 'update', id: 'kid', block: after[1].children[0] },
      { op: 'update', id: 'c', block: after[2] },
    ]);
    expect(guard).toEqual({ kid: 'h:kid', c: 'h:c' });
  });
});

describe('runPageCleanup', () => {
  it('dry run: reports what it would change, reads only, writes nothing', async () => {
    const f = fakes([page('a'), page('b')], {
      live: {
        a: { kind: 'live', blocks: BOLD_CODE() },
        b: { kind: 'live', blocks: [para('x', [])] },
      },
    });
    const summary = await runPageCleanup(f.deps, { kind: 'all' }, { apply: false });
    expect(summary.counts).toMatchObject({ 'would-clean': 1, clean: 1 });
    expect(summary.pages[0]).toMatchObject({
      classroom: 'cs1',
      pageId: 'a',
      title: 'Page a',
      source: 'live',
      status: 'would-clean',
      changes: '1× dropped bold from inline code (the code stays)',
    });
    // Only pages that are not clean are printed.
    expect(f.lines).toEqual([formatPageLine(summary.pages[0])]);
    expect(f.lines[0].split('\t').slice(0, 4)).toEqual(['cs1', 'a', '"Page a"', 'would-clean']);
    expect(f.readGit).not.toHaveBeenCalled();
  });

  it('apply, live: update ops through the live service, guarded; git untouched', async () => {
    const blocks = BOLD_CODE();
    const f = fakes([page('a')], { live: { a: { kind: 'live', blocks } }, apply: true });
    const summary = await runPageCleanup(f.deps, { kind: 'all' }, { apply: true });
    expect(summary.pages[0].status).toBe('cleaned');
    expect(f.writeLive).toHaveBeenCalledTimes(1);
    const [target, ops, guard] = f.writeLive.mock.calls[0] as unknown as [
      CleanupPage,
      Array<{ id: string; block: { content: unknown } }>,
      Record<string, string>,
    ];
    expect(target.id).toBe('a');
    expect(ops).toEqual([
      { op: 'update', id: 'p2', block: para('p2', [run('useFetcher', { code: true })]) },
    ]);
    expect(guard).toEqual({ p2: f.deps.hash(blocks[1]) });
    expect(f.writeGit).not.toHaveBeenCalled();
    // The page as read is saved first; one audit row for the page.
    expect(f.order).toEqual(['pre:a', 'live:a']);
    expect(f.savePreImage).toHaveBeenCalledWith(page('a'), { source: 'live', blocks });
    expect(f.recordWrite).toHaveBeenCalledExactlyOnceWith(page('a'), {
      committed_to: 'live',
      blocks: ['p2'],
    });
  });

  it('a pre-image that cannot be saved stops the page before any write', async () => {
    const f = fakes([page('a')], {
      live: { a: { kind: 'live', blocks: BOLD_CODE() } },
      apply: true,
    });
    f.savePreImage.mockRejectedValueOnce(new Error('disk full'));
    const summary = await runPageCleanup(f.deps, { kind: 'all' }, { apply: true });
    expect(summary.pages[0]).toMatchObject({ status: 'failed', note: 'disk full' });
    expect(f.writeLive).not.toHaveBeenCalled();
  });

  it('apply, live: many changed blocks go in batches, each with its own guards', async () => {
    const blocks = Array.from({ length: LIVE_OPS_PER_REQUEST + 5 }, (_, i) =>
      para(`b${i}`, [run('x', { code: true, bold: true })])
    );
    const f = fakes([page('a')], { live: { a: { kind: 'live', blocks } }, apply: true });
    await runPageCleanup(f.deps, { kind: 'all' }, { apply: true });
    expect(f.writeLive).toHaveBeenCalledTimes(2);
    expect(f.recordWrite).toHaveBeenCalledTimes(1);
    const second = f.writeLive.mock.calls[1] as unknown as [unknown, unknown[], object];
    expect(second[1]).toHaveLength(5);
    expect(Object.keys(second[2])).toEqual(['b100', 'b101', 'b102', 'b103', 'b104']);
  });

  it('a block someone changed meanwhile: the page is skipped and reported, the run goes on', async () => {
    const f = fakes([page('a'), page('b')], {
      live: { a: { kind: 'live', blocks: BOLD_CODE() }, b: { kind: 'live', blocks: BOLD_CODE() } },
      apply: true,
    });
    f.writeLive.mockRejectedValueOnce(new LiveWriteConflict(['p2']));
    const summary = await runPageCleanup(f.deps, { kind: 'all' }, { apply: true });
    expect(summary.pages.map(p => p.status)).toEqual(['skipped', 'cleaned']);
    expect(summary.pages[0].note).toMatch(/edited it meanwhile.*p2.*run again/);
    // Nothing of page a was written: no audit row for it.
    expect(f.recordWrite.mock.calls.map(c => (c[0] as CleanupPage).id)).toEqual(['b']);
  });

  it('batches already applied before a conflict are recorded and reported', async () => {
    const blocks = Array.from({ length: LIVE_OPS_PER_REQUEST + 1 }, (_, i) =>
      para(`b${i}`, [run('x', { code: true, bold: true })])
    );
    const f = fakes([page('a')], { live: { a: { kind: 'live', blocks } }, apply: true });
    f.writeLive.mockResolvedValueOnce().mockRejectedValueOnce(new LiveWriteConflict(['b100']));
    const summary = await runPageCleanup(f.deps, { kind: 'all' }, { apply: true });
    expect(summary.pages[0].note).toMatch(/100 of 101 blocks written; run again/);
    const record = f.recordWrite.mock.calls[0][1] as { blocks: string[] };
    expect(record.blocks).toHaveLength(LIVE_OPS_PER_REQUEST);
  });

  it('a fatal collab refusal stops the run: no later page is read or written', async () => {
    const f = fakes([page('a'), page('b')], {
      live: { b: { kind: 'live', blocks: BOLD_CODE() } },
      apply: true,
    });
    f.readLive.mockRejectedValueOnce(new FatalCleanupError('HTTP 401'));
    await expect(runPageCleanup(f.deps, { kind: 'all' }, { apply: true })).rejects.toThrow(
      'HTTP 401'
    );
    expect(f.readLive).toHaveBeenCalledTimes(1);
    expect(f.writeLive).not.toHaveBeenCalled();
  });

  it('a live page the service cannot load (href style) is read and written in git', async () => {
    const f = fakes([page('k')], {
      live: { k: { kind: 'unloadable', detail: 'style href not found in styleSchema' } },
      git: { k: { kind: 'json', blocks: HREF(), sha: 'git-sha' } },
      apply: true,
    });
    const summary = await runPageCleanup(f.deps, { kind: 'all' }, { apply: true });
    expect(summary.pages[0]).toMatchObject({
      source: 'git (live service cannot load it)',
      status: 'cleaned',
      changes: '1× turned a link stored as a text style into a link',
    });
    expect(f.writeGit).toHaveBeenCalledWith(
      page('k'),
      [
        {
          ...HREF()[0],
          content: [{ type: 'link', href: 'https://kotlinlang.org', content: [run('docs', {})] }],
        },
      ],
      'git-sha'
    );
    expect(f.writeLive).not.toHaveBeenCalled();
    expect(f.savePreImage).toHaveBeenCalledWith(page('k'), {
      source: 'git (live service cannot load it)',
      sha: 'git-sha',
      blocks: HREF(),
    });
    expect(f.recordWrite).toHaveBeenCalledWith(page('k'), {
      committed_to: 'git',
      sha: 'new-sha',
      commit: 'c1',
    });
  });

  it('…unless a stored live row holds edits not yet in git', async () => {
    const f = fakes([page('k')], {
      live: { k: { kind: 'unloadable', detail: 'x' } },
      git: { k: { kind: 'json', blocks: HREF(), sha: 'git-sha' } },
      unpushed: new Set(['k']),
      apply: true,
    });
    const summary = await runPageCleanup(f.deps, { kind: 'all' }, { apply: true });
    expect(summary.pages[0]).toMatchObject({ status: 'skipped' });
    expect(f.writeGit).not.toHaveBeenCalled();
  });

  it('a classroom without live editing reads and writes git only', async () => {
    const f = fakes([page('g', false)], {
      git: { g: { kind: 'json', blocks: BOLD_CODE(), sha: 's1' } },
      apply: true,
    });
    const summary = await runPageCleanup(f.deps, { kind: 'all' }, { apply: true });
    expect(summary.pages[0]).toMatchObject({ source: 'git', status: 'cleaned' });
    expect(f.readLive).not.toHaveBeenCalled();
    expect(f.writeGit).toHaveBeenCalledTimes(1);
  });

  it('skips legacy pages and refusals, fails (and goes on) on errors', async () => {
    const f = fakes([page('l', false), page('r'), page('e'), page('ok')], {
      git: { l: { kind: 'legacy' } },
      live: {
        r: { kind: 'refused', detail: 'HTTP 422 legacy-html' },
        ok: { kind: 'live', blocks: BOLD_CODE() },
      },
    });
    f.readLive.mockImplementation(async (id: string) => {
      if (id === 'e') throw new Error('live service HTTP 503');
      return (
        {
          r: { kind: 'refused', detail: 'HTTP 422 legacy-html' },
          ok: { kind: 'live', blocks: BOLD_CODE() },
        } as Record<string, LiveRead>
      )[id];
    });
    const summary = await runPageCleanup(f.deps, { kind: 'all' }, { apply: false });
    expect(summary.pages.map(p => [p.pageId, p.status, p.note ?? null])).toEqual([
      ['l', 'skipped', 'legacy HTML page (index.html)'],
      ['r', 'skipped', 'live service: HTTP 422 legacy-html'],
      ['e', 'failed', 'live service HTTP 503'],
      ['ok', 'would-clean', null],
    ]);
  });

  it('a live classroom with no collab server configured fails its pages', async () => {
    const f = fakes([page('a')]);
    const summary = await runPageCleanup(
      { ...f.deps, readLive: null },
      { kind: 'all' },
      { apply: false }
    );
    expect(summary.pages[0]).toMatchObject({
      status: 'failed',
      note: expect.stringMatching(/collab/),
    });
  });

  it('names and counts pages that still would not open, cleaned or not', async () => {
    const f = fakes([page('a'), page('b'), page('c')], {
      live: {
        a: { kind: 'live', blocks: BOLD_CODE() },
        b: { kind: 'live', blocks: [{ id: 'w', type: 'widget' }] },
        c: { kind: 'live', blocks: [para('ok', [run('fine')])] },
      },
    });
    const summary = await runPageCleanup(
      {
        ...f.deps,
        remainingProblems: blocks =>
          (blocks as Array<{ type: string }>).some(b => b.type === 'widget') ||
          (blocks as Array<{ id: string }>)[0].id === 'p1'
            ? ["w: unknown block type 'widget'"]
            : [],
      },
      { kind: 'all' },
      { apply: false }
    );
    expect(summary.pages.map(p => [p.pageId, p.status, p.note ?? null])).toEqual([
      ['a', 'would-clean', "still does not open: w: unknown block type 'widget'"],
      ['b', 'unfixable', "still does not open: w: unknown block type 'widget'"],
      ['c', 'clean', null],
    ]);
    expect(summary.stillInvalid).toBe(2);
    expect(summary.counts.unfixable).toBe(1);
    // The unfixable page is printed even though nothing in it changes.
    expect(f.lines.map(line => line.split('\t')[1])).toEqual(['a', 'b']);
  });
});
