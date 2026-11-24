/**
 * The legacy page conversion (scripts/convertLegacyPages.ts): which pages it
 * picks, which it skips, and the exact file it writes — with fakes for the
 * database, git and collab, and the REAL conversion, page schema and page
 * service functions, since "the same blocks collab seeds with" is the point.
 */

import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { SCHEMA_VERSION } from '@classmoji/page-schema';
import { pageContentToYDoc } from '@classmoji/page-schema/server';
import { convertLegacyPageHtml, legacyPageLinkIds } from '@classmoji/page-schema/html';
import { ClassmojiService } from '@classmoji/services';

import {
  GITLAB_STALE_TOKEN,
  REPOSITORY_NOT_READABLE,
  decideCollab,
  gitlabTokenFreshForDryRun,
  hasFailures,
  pageFileState,
  parseArgs,
  provesNoOpMerge,
  runLegacyConversion,
  seededContent,
  throughSchema,
  type CollabRowMeta,
  type CollabSnapshot,
  type LegacyDeps,
  type LegacyPageRow,
  type PreparedFile,
} from '../legacyPageConversion.ts';

const pageContent = ClassmojiService.pageContent;

const PAGE_A = '11111111-1111-4111-8111-111111111111';
const PAGE_B = '22222222-2222-4222-8222-222222222222';
const PAGE_C = '33333333-3333-4333-8333-333333333333';
const CLASSROOM = '99999999-9999-4999-8999-999999999999';

const HTML_A =
  '<html><body><h1>Week 1</h1><p>Read the <a href="/cs1/pages/22222222-2222-4222-8222-222222222222">intro</a>.</p>' +
  '<ul><li>one</li><li>two</li></ul></body></html>';

function pageRow(id: string, slug: string, extra: Partial<LegacyPageRow> = {}): LegacyPageRow {
  return {
    id,
    title: slug === 'week-1' ? 'Week 1' : slug,
    content_path: `pages/${slug}`,
    is_draft: false,
    is_public: true,
    header_image_url: null,
    header_image_position: null,
    classroom_id: CLASSROOM,
    classroom: {
      id: CLASSROOM,
      slug: 'cs1-26f',
      status: 'ACTIVE',
      collab_enabled: true,
      content_repo: 'content-cs1',
      content_key_version: 1,
      content_delivery_enabled: false,
      git_organization: { provider: 'GITHUB', login: 'org' },
    },
    ...extra,
  };
}

const convertLegacy: LegacyDeps['convertLegacy'] = (html, inputs) =>
  convertLegacyPageHtml(html, { ...inputs, ensureBlockIds: pageContent.ensureBlockIds });

/** What collab's adapter seeds this page with (adapters/page.ts `seed`), for the fake snapshot. */
async function collabSeed(page: LegacyPageRow, html: string, pagesHere: Set<string>) {
  const blocks = await convertLegacy(html, {
    title: page.title,
    classroomSlug: page.classroom.slug,
    pagesInClassroom: pagesHere,
  });
  return seededContent(
    pageContent,
    blocks,
    page.header_image_url
      ? { url: page.header_image_url, position: page.header_image_position ?? 50 }
      : null
  );
}

const realPrepare: LegacyDeps['prepare'] = (page, blocks, coverImage) =>
  pageContent.preparePageContent(page as never, blocks, { coverImage });

interface Fixture {
  pages: LegacyPageRow[];
  files: Map<string, string>;
  blobs: Map<string, string>;
  rows?: Map<string, CollabRowMeta>;
  snapshots?: Map<string, CollabSnapshot> | null;
  write?: LegacyDeps['write'];
}

function makeDeps(f: Fixture) {
  const calls = {
    list: 0,
    convert: 0,
    write: [] as Array<{ page: LegacyPageRow; prepared: PreparedFile }>,
    saved: new Map<string, string>(),
    order: [] as string[],
  };
  const deps: LegacyDeps = {
    findPages: async () => f.pages,
    listPageFiles: async () => {
      calls.list += 1;
      return f.files;
    },
    readBlob: async (_classroom, sha) => f.blobs.get(sha) ?? null,
    pageIdsInClassroom: async (_classroomId, ids) =>
      new Set(ids.filter(id => f.pages.some(p => p.id === id))),
    collabRow: async pageId => {
      calls.order.push(`row:${pageId}`);
      return f.rows?.get(pageId) ?? null;
    },
    collabSnapshot:
      f.snapshots === null
        ? null
        : async pageId => {
            calls.order.push(`snapshot:${pageId}`);
            const snapshot = f.snapshots?.get(pageId);
            if (!snapshot) throw new Error('no snapshot fixture');
            return snapshot;
          },
    legacyPageLinkIds,
    convertLegacy: async (html, inputs) => {
      calls.convert += 1;
      return convertLegacy(html, inputs);
    },
    pageOps: pageContent,
    prepare: realPrepare,
    write: f.write
      ? async (page, prepared) => {
          calls.write.push({ page, prepared });
          return f.write!(page, prepared);
        }
      : null,
    save: async (pageId, name, text) => {
      calls.saved.set(`${pageId}.${name}`, text);
    },
  };
  return { deps, calls };
}

/** A clean, closed row whose state is collab's seed of the page. */
function cleanRow(seed: { blocks: unknown[]; coverImage: unknown }): CollabRowMeta {
  const doc = pageContentToYDoc({ blocks: seed.blocks, coverImage: seed.coverImage as never });
  const state = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return {
    version: 0,
    pushed_version: 0,
    source_sha: 'html-a',
    schema_version: SCHEMA_VERSION,
    state,
  };
}

// ─── Arguments ───────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('takes exactly one selector and defaults to a dry run', () => {
    expect(parseArgs(['--page', PAGE_A])).toEqual({
      selector: { kind: 'page', pageId: PAGE_A },
      write: false,
      outDir: null,
    });
    expect(parseArgs(['--classroom=org/cs1-26f', '--write', '--out', '/tmp/x'])).toEqual({
      selector: { kind: 'classroom', login: 'org', slug: 'cs1-26f' },
      write: true,
      outDir: '/tmp/x',
    });
    expect(parseArgs(['--all']).selector).toEqual({ kind: 'all' });
  });

  it('refuses no selector, two selectors, a bad id or classroom, and unknown flags', () => {
    expect(() => parseArgs([])).toThrow(/exactly one/);
    expect(() => parseArgs(['--all', '--page', PAGE_A])).toThrow(/exactly one/);
    expect(() => parseArgs(['--page', 'abc'])).toThrow(/uuid/);
    expect(() => parseArgs(['--classroom', 'cs1-26f'])).toThrow(
      /<git-org-login>\/<classroom-slug>/
    );
    expect(() => parseArgs(['--all', '--dry'])).toThrow(/Unknown option --dry/);
    expect(() => parseArgs(['--page'])).toThrow(/needs a value/);
  });
});

// ─── Selection and skip rules ────────────────────────────────────────────────

describe('pageFileState', () => {
  const files = new Map([
    ['pages/a/content.json', 's1'],
    ['pages/a/index.html', 's2'],
    ['pages/b/index.html', 's3'],
    ['pages/b/assets/x.png', 's4'],
  ]);
  it('content.json wins; index.html alone is legacy; nothing is none', () => {
    expect(pageFileState(files, 'pages/a')).toEqual({ kind: 'json' });
    expect(pageFileState(files, 'pages/b')).toEqual({ kind: 'legacy', htmlSha: 's3' });
    expect(pageFileState(files, 'pages/c')).toEqual({ kind: 'none' });
    // A prefix is not the folder.
    expect(pageFileState(files, 'pages/b/assets')).toEqual({ kind: 'none' });
  });
});

describe('decideCollab', () => {
  const row = (over: Partial<CollabRowMeta> = {}): CollabRowMeta => ({
    version: 3,
    pushed_version: 3,
    source_sha: 'x',
    schema_version: SCHEMA_VERSION,
    state: new Uint8Array([1, 2]),
    ...over,
  });
  const snap = (live: boolean): CollabSnapshot => ({ live, version: 0, content: { blocks: [] } });

  it('no row and a reseed marker are both "no row"; a clean closed row is fine', () => {
    expect(decideCollab({ row: null, snapshot: snap(false) })).toEqual({
      ok: true,
      state: 'no row',
    });
    expect(decideCollab({ row: row({ state: new Uint8Array() }), snapshot: snap(false) })).toEqual({
      ok: true,
      state: 'no row',
    });
    expect(decideCollab({ row: row(), snapshot: snap(false) })).toEqual({
      ok: true,
      state: 'clean',
    });
  });

  it('skips a dirty row (collab’s own rule: version past pushed_version), even unchecked', () => {
    expect(decideCollab({ row: row({ version: 4 }), snapshot: snap(false) })).toMatchObject({
      ok: false,
      state: 'dirty',
    });
    expect(decideCollab({ row: row({ version: 4 }), snapshot: 'not-configured' })).toMatchObject({
      ok: false,
      state: 'dirty',
    });
  });

  it('skips a page open in an editor, and a row of another schema version', () => {
    expect(decideCollab({ row: null, snapshot: snap(true) })).toMatchObject({
      ok: false,
      state: 'open',
    });
    expect(
      decideCollab({ row: row({ schema_version: SCHEMA_VERSION + 1 }), snapshot: snap(false) })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/schema/) });
  });

  it('without collab it says so', () => {
    expect(decideCollab({ row: null, snapshot: 'not-configured' })).toEqual({
      ok: true,
      state: 'not checked',
    });
  });
});

// ─── The run ─────────────────────────────────────────────────────────────────

describe('runLegacyConversion', () => {
  async function fixture(
    over: Partial<Fixture> = {}
  ): Promise<Fixture & { seedA: Awaited<ReturnType<typeof collabSeed>> }> {
    const a = pageRow(PAGE_A, 'week-1', {
      header_image_url: 'https://images.example.test/cover.png',
      header_image_position: 30,
      is_public: false,
    });
    const b = pageRow(PAGE_B, 'intro');
    const c = pageRow(PAGE_C, 'empty');
    const pages = [a, b, c];
    const seedA = await collabSeed(a, HTML_A, new Set([PAGE_B]));
    return {
      pages,
      files: new Map([
        ['pages/week-1/index.html', 'html-a'],
        ['pages/week-1/assets/x.png', 'img'],
        ['pages/intro/content.json', 'json-b'],
        ['pages/intro/index.html', 'html-b'],
      ]),
      blobs: new Map([['html-a', HTML_A]]),
      snapshots: new Map([
        [
          PAGE_A,
          {
            live: false,
            version: 0,
            content: { blocks: seedA.blocks, coverImage: seedA.coverImage },
          },
        ],
      ]),
      seedA,
      ...over,
    };
  }

  it('lists the repository once, and touches only the page with index.html and no content.json', async () => {
    const f = await fixture();
    const { deps, calls } = makeDeps(f);
    const summary = await runLegacyConversion(deps, { kind: 'all' });
    expect(calls.list).toBe(1);
    expect(summary.pages.map(p => p.pageId)).toEqual([PAGE_A]);
    expect(summary.notLegacy).toEqual({ converted: 1, noFiles: 1, noRepo: 0 });
    // Collab's state is read snapshot-first (it stores pending edits), then the row.
    expect(calls.order).toEqual([`snapshot:${PAGE_A}`, `row:${PAGE_A}`]);
  });

  it('a dry run builds nothing that writes and reports what it would write', async () => {
    const f = await fixture();
    const { deps, calls } = makeDeps(f);
    const [report] = (await runLegacyConversion(deps, { kind: 'all' })).pages;
    expect(report).toMatchObject({
      action: 'would convert',
      classroom: 'org/cs1-26f',
      title: 'Week 1',
      contentPath: 'pages/week-1',
      visibility: 'members',
      collab: 'no row',
      blockCount: f.seedA.blocks.length,
    });
    expect(calls.write).toHaveLength(0);
    const written = JSON.parse(calls.saved.get(`${PAGE_A}.content`)!);
    expect(Object.keys(written)).toEqual(['blocks', 'coverImage']);
    expect(written.coverImage).toEqual({
      url: 'https://images.example.test/cover.png',
      position: 30,
    });
    expect(written.blocks).toEqual(f.seedA.blocks);
    expect(JSON.parse(calls.saved.get(`${PAGE_A}.collab`)!).blocks).toEqual(f.seedA.blocks);
  });

  it('writes { blocks, coverImage } — collab’s seed, the DB cover — and rewrites links in this classroom only', async () => {
    const f = await fixture({ write: async () => ({ commit: 'c0ffee' }) });
    const { deps, calls } = makeDeps(f);
    const [report] = (await runLegacyConversion(deps, { kind: 'all' })).pages;
    expect(report).toMatchObject({ action: 'converted', commit: 'c0ffee' });
    expect(calls.write).toHaveLength(1);
    const { page, prepared } = calls.write[0]!;
    expect(page.id).toBe(PAGE_A);
    expect(prepared.path).toBe('pages/week-1/content.json');
    const file = JSON.parse(prepared.content);
    expect(file.blocks).toEqual(f.seedA.blocks);
    expect(file.coverImage).toEqual({ url: 'https://images.example.test/cover.png', position: 30 });
    // The title <h1> is dropped; the old link points at this classroom's page.
    expect(prepared.content).not.toContain('"Week 1"');
    expect(prepared.content).toContain(`/cs1-26f/${PAGE_B}`);
    // Deterministic, content-derived ids: the ones collab gives.
    expect(file.blocks.every((b: { id?: unknown }) => typeof b.id === 'string')).toBe(true);
  });

  it('the written file merges into collab’s document as a no-op (the merge mergeExternal runs)', async () => {
    const f = await fixture();
    const blocks = await convertLegacy(HTML_A, {
      title: 'Week 1',
      classroomSlug: 'cs1-26f',
      pagesInClassroom: new Set([PAGE_B]),
    });
    const prepared = await realPrepare(f.pages[0]!, f.seedA.blocks, f.seedA.coverImage);
    expect(
      provesNoOpMerge({ ops: pageContent, converted: blocks, prepared, ours: f.seedA })
    ).toBeNull();
    // A file that is NOT collab's conversion is caught (fresh ids, as the old script wrote).
    const random = {
      ...prepared,
      content: JSON.stringify({
        blocks: f.seedA.blocks.map(b => ({ ...(b as object), id: crypto.randomUUID() })),
        coverImage: f.seedA.coverImage,
      }),
    };
    expect(
      provesNoOpMerge({ ops: pageContent, converted: blocks, prepared: random, ours: f.seedA })
    ).toMatch(/differ from collab's merge base/);
    // And so is a cover the live page does not have.
    expect(
      provesNoOpMerge({
        ops: pageContent,
        converted: blocks,
        prepared: { ...prepared, coverImage: null },
        ours: f.seedA,
      })
    ).toMatch(/cover/);
    expect(throughSchema(pageContent, blocks)).toEqual(throughSchema(pageContent, f.seedA.blocks));
  });

  it('compares with the snapshot as JSON: blocks without inline content (image, divider) still match', async () => {
    const html =
      '<html><body><p>Before</p><img src="https://images.example.test/a.png" alt="a">' +
      '<hr><p>After</p></body></html>';
    const f = await fixture({ write: async () => ({ commit: 'c2' }) });
    f.blobs.set('html-a', html);
    const page = f.pages[0]!;
    const seed = await collabSeed(page, html, new Set());
    expect(seed.blocks.map(b => (b as { type: string }).type)).toEqual(
      expect.arrayContaining(['image', 'paragraph'])
    );
    // What the collab server sends: JSON, so any undefined value is gone.
    const overTheWire = JSON.parse(
      JSON.stringify({ blocks: seed.blocks, coverImage: seed.coverImage })
    ) as CollabSnapshot['content'];
    f.snapshots = new Map([[PAGE_A, { live: false, version: 0, content: overTheWire }]]);
    const { deps } = makeDeps(f);
    const [report] = (await runLegacyConversion(deps, { kind: 'all' })).pages;
    expect(report).toMatchObject({ action: 'converted', commit: 'c2' });
  });

  it('a failure after the commit (the audit row) is reported on a converted page', async () => {
    const f = await fixture({
      write: async () => ({
        commit: 'c3',
        note: 'converted, but the audit row was not written: x',
      }),
    });
    const { deps } = makeDeps(f);
    expect((await runLegacyConversion(deps, { kind: 'all' })).pages[0]).toMatchObject({
      action: 'converted',
      commit: 'c3',
      reason: expect.stringMatching(/audit row was not written/),
    });
  });

  it('a clean closed row seeded from this index.html is written', async () => {
    const f = await fixture({ write: async () => ({ commit: 'c1' }) });
    f.rows = new Map([[PAGE_A, cleanRow(f.seedA)]]);
    const { deps } = makeDeps(f);
    const [report] = (await runLegacyConversion(deps, { kind: 'all' })).pages;
    expect(report).toMatchObject({ action: 'converted', collab: 'clean' });
  });

  it('skips a dirty row and a page open in an editor without converting or writing', async () => {
    const write = vi.fn(async () => ({ commit: 'x' }));
    const dirty = await fixture({ write });
    dirty.rows = new Map([[PAGE_A, { ...cleanRow(dirty.seedA), version: 5, pushed_version: 4 }]]);
    const d = makeDeps(dirty);
    expect((await runLegacyConversion(d.deps, { kind: 'all' })).pages[0]).toMatchObject({
      action: 'skipped',
      collab: 'dirty',
    });

    const open = await fixture({ write });
    open.snapshots!.get(PAGE_A)!.live = true;
    const o = makeDeps(open);
    expect((await runLegacyConversion(o.deps, { kind: 'all' })).pages[0]).toMatchObject({
      action: 'skipped',
      collab: 'open',
    });
    expect(write).not.toHaveBeenCalled();
    expect(d.calls.convert + o.calls.convert).toBe(0);
  });

  it('skips a page whose collab document differs (converter or schema skew) and keeps both files', async () => {
    const write = vi.fn(async () => ({ commit: 'x' }));
    const f = await fixture({ write });
    const snap = f.snapshots!.get(PAGE_A)!;
    snap.content = { ...snap.content, blocks: snap.content.blocks.slice(1) };
    const { deps, calls } = makeDeps(f);
    const [report] = (await runLegacyConversion(deps, { kind: 'all' })).pages;
    expect(report).toMatchObject({
      action: 'skipped',
      reason: expect.stringMatching(/differs from collab/),
    });
    expect(write).not.toHaveBeenCalled();
    expect(calls.saved.has(`${PAGE_A}.content`)).toBe(true);
    expect(calls.saved.has(`${PAGE_A}.collab`)).toBe(true);
  });

  it('never writes without collab, and compares with the stored row instead in a dry run', async () => {
    const write = vi.fn(async () => ({ commit: 'x' }));
    const f = await fixture({ snapshots: null, write });
    const { deps } = makeDeps(f);
    expect((await runLegacyConversion(deps, { kind: 'all' })).pages[0]).toMatchObject({
      action: 'skipped',
      collab: 'not checked',
      reason: expect.stringMatching(/collab was not checked/),
    });
    expect(write).not.toHaveBeenCalled();

    const dry = await fixture({ snapshots: null });
    dry.rows = new Map([[PAGE_A, cleanRow(dry.seedA)]]);
    const { deps: dryDeps } = makeDeps(dry);
    expect((await runLegacyConversion(dryDeps, { kind: 'all' })).pages[0]).toMatchObject({
      action: 'would convert',
    });
  });

  it('a content.json that appeared before the write (409) is left alone', async () => {
    const f = await fixture({
      write: async () => {
        throw Object.assign(new Error('exists'), { status: 409 });
      },
    });
    const { deps } = makeDeps(f);
    expect((await runLegacyConversion(deps, { kind: 'all' })).pages[0]).toMatchObject({
      action: 'skipped',
      reason: expect.stringMatching(/content.json appeared/),
    });
  });

  it('is idempotent: once content.json exists the page is not converted again', async () => {
    const f = await fixture({ write: async () => ({ commit: 'c' }) });
    f.files.set('pages/week-1/content.json', 'json-a');
    const { deps, calls } = makeDeps(f);
    const summary = await runLegacyConversion(deps, { kind: 'all' });
    expect(summary.pages).toEqual([]);
    expect(calls.convert).toBe(0);
    expect(calls.write).toHaveLength(0);
  });

  it('a repository that cannot be listed fails its pages with the reason', async () => {
    const f = await fixture();
    const { deps } = makeDeps(f);
    deps.listPageFiles = async () => {
      throw new Error('GitHub 502');
    };
    const summary = await runLegacyConversion(deps, { kind: 'all' });
    expect(summary.pages).toHaveLength(3);
    expect(summary.pages.every(p => p.action === 'failed' && /GitHub 502/.test(p.reason!))).toBe(
      true
    );
    expect(hasFailures(summary)).toBe(true);
  });

  it('an empty listing for a classroom with pages is "repository not readable", not "no content file"', async () => {
    const f = await fixture();
    f.files = new Map();
    const { deps } = makeDeps(f);
    const summary = await runLegacyConversion(deps, { kind: 'all' });
    expect(summary.notLegacy.noFiles).toBe(0);
    expect(summary.pages.map(p => [p.action, p.reason])).toEqual(
      Array(3).fill(['skipped', REPOSITORY_NOT_READABLE])
    );
    expect(hasFailures(summary)).toBe(false);
  });

  it('flags (and still converts) a page in a LOCKED or archived classroom', async () => {
    const f = await fixture({ write: async () => ({ commit: 'c4' }) });
    for (const page of f.pages) {
      page.classroom.status = 'LOCKED';
      page.classroom.is_archived = true;
    }
    const { deps } = makeDeps(f);
    expect((await runLegacyConversion(deps, { kind: 'all' })).pages[0]).toMatchObject({
      action: 'converted',
      flags: ['classroom LOCKED', 'classroom archived'],
    });
  });

  it('one page’s error does not stop the batch, and the report is saved after every page', async () => {
    const f = await fixture({ write: async () => ({ commit: 'c5' }) });
    // Two legacy pages: the first one's collab row read throws.
    f.files.delete('pages/intro/content.json');
    f.blobs.set('html-b', '<p>Intro</p>');
    const seedB = await collabSeed(f.pages[1]!, '<p>Intro</p>', new Set());
    f.snapshots!.set(PAGE_B, { live: false, version: 0, content: seedB });
    const { deps } = makeDeps(f);
    const realRow = deps.collabRow;
    deps.collabRow = async pageId => {
      if (pageId === PAGE_A) throw new Error('db blip');
      return realRow(pageId);
    };
    const saved: number[] = [];
    deps.onProgress = async summary => {
      saved.push(summary.pages.length);
    };
    const summary = await runLegacyConversion(deps, { kind: 'all' });
    expect(summary.pages.map(p => [p.pageId, p.action])).toEqual([
      [PAGE_A, 'failed'],
      [PAGE_B, 'converted'],
    ]);
    expect(summary.pages[0]!.reason).toMatch(/db blip/);
    expect(saved).toEqual([1, 2]);
    expect(hasFailures(summary)).toBe(true);
  });
});

// ─── Gitlab in a dry run ─────────────────────────────────────────────────────

describe('a Gitlab classroom in a dry run', () => {
  it('the freshness rule: the connection service’s 5-minute buffer plus a 30-minute margin', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    expect(gitlabTokenFreshForDryRun(null, now)).toBe(true);
    expect(gitlabTokenFreshForDryRun(new Date(now + 60 * 60_000), now)).toBe(true);
    expect(gitlabTokenFreshForDryRun(new Date(now + 20 * 60_000), now)).toBe(false);
    expect(gitlabTokenFreshForDryRun(new Date(now - 60_000), now)).toBe(false);
  });

  async function gitlabFixture() {
    const page = pageRow(PAGE_A, 'week-1');
    page.classroom.git_organization = {
      provider: 'GITLAB',
      login: 'group',
      gitlab_connection_id: 'conn-1',
    };
    return { page };
  }

  it('a stale token: the classroom is skipped before ANY provider call', async () => {
    const { page } = await gitlabFixture();
    const { deps, calls } = makeDeps({
      pages: [page],
      files: new Map([['pages/week-1/index.html', 'html-a']]),
      blobs: new Map([['html-a', HTML_A]]),
      snapshots: new Map(),
    });
    const readBlob = vi.fn(deps.readBlob);
    deps.readBlob = readBlob;
    deps.gitlabTokenFresh = async () => false;
    const summary = await runLegacyConversion(deps, { kind: 'all' });
    expect(calls.list).toBe(0);
    expect(readBlob).not.toHaveBeenCalled();
    expect(calls.order).toEqual([]);
    expect(summary.pages).toEqual([
      expect.objectContaining({ pageId: PAGE_A, action: 'skipped', reason: GITLAB_STALE_TOKEN }),
    ]);
    expect(hasFailures(summary)).toBe(false);
  });

  it('a fresh token, or a write run (no check), lists as usual', async () => {
    const { page } = await gitlabFixture();
    const fresh = makeDeps({
      pages: [page],
      files: new Map(),
      blobs: new Map(),
      snapshots: new Map(),
    });
    fresh.deps.gitlabTokenFresh = async () => true;
    await runLegacyConversion(fresh.deps, { kind: 'all' });
    expect(fresh.calls.list).toBe(1);

    const writeRun = makeDeps({
      pages: [page],
      files: new Map(),
      blobs: new Map(),
      snapshots: new Map(),
    });
    await runLegacyConversion(writeRun.deps, { kind: 'all' });
    expect(writeRun.calls.list).toBe(1);
  });
});
