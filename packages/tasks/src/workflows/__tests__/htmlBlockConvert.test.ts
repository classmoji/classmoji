/**
 * `html-block-convert`: the payload guard (dry run by default), the plan for
 * one deck (legacy srcdoc blocks → files, nothing else touched), and the run
 * against a mocked ContentService: one commit per deck, compare-and-swap on
 * deck.json, conflicts and failures reported, audit rows written.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@trigger.dev/sdk', () => ({
  schemaTask: (config: object) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@classmoji/database', async importOriginal => ({
  ...(await importOriginal<object>()),
  default: () => ({}),
}));
vi.mock('@classmoji/services', () => ({ ClassmojiService: {}, ContentService: {} }));

const {
  gitBlobSha,
  htmlBlockConvert,
  parseConvertPayload,
  planDeckConversion,
  runHtmlBlockConvert,
} = await import('../htmlBlockConvert.ts');
const { htmlBlockMarkup, normalizeSlideHtml, readSlideBlocks, HTML_BLOCK_STORAGE_SHIM } =
  await import('../../../../services/src/slides/index.ts');
type DeckJson = import('../../../../services/src/slides/deckTypes.ts').DeckJson;
type ConvertDeps = import('../htmlBlockConvert.ts').ConvertDeps;
type ConvertDeck = import('../htmlBlockConvert.ts').ConvertDeck;

const BOX = { left: 10, top: 20, width: 400, height: 300 };
const GAME = '<!doctype html><canvas></canvas><script>let a = 1 < 2 && "x";</script>';

function legacyDeck(): DeckJson {
  const inert = normalizeSlideHtml(
    htmlBlockMarkup({ id: 'old2', box: BOX, source: '<p>inert</p>' }).replace(
      /sandbox="[^"]*"/,
      'sandbox="allow-scripts allow-same-origin"'
    )
  );
  return {
    version: 1,
    theme: 'white',
    codeTheme: 'github',
    slides: [
      {
        id: 's1',
        html: normalizeSlideHtml(htmlBlockMarkup({ id: 'old1', box: BOX, source: GAME })),
      },
      {
        id: 'stack',
        children: [
          { id: 'c1', html: `<h2>Keep</h2>${inert}` },
          {
            id: 'c2',
            html: normalizeSlideHtml(
              htmlBlockMarkup({
                id: 'new1',
                box: BOX,
                src: 'blocks/aaaaaaaa.html',
                rev: 'f'.repeat(40),
              })
            ),
          },
        ],
      },
      { id: 's2', html: '<p>plain</p>' },
    ],
  };
}

const blocksOf = (deck: DeckJson, id: string) => {
  for (const slide of deck.slides) {
    if (slide.id === id) return readSlideBlocks(slide.html ?? '');
    for (const child of slide.children ?? [])
      if (child.id === id) return readSlideBlocks(child.html ?? '');
  }
  throw new Error(id);
};

describe('parseConvertPayload', () => {
  it('defaults to a dry run and takes classroomId and limit', () => {
    expect(parseConvertPayload(undefined)).toEqual({ dryRun: true });
    expect(parseConvertPayload({ classroomId: 'c1', limit: 2 })).toEqual({
      dryRun: true,
      classroomId: 'c1',
      limit: 2,
    });
    expect(parseConvertPayload({ dryRun: false })).toEqual({ dryRun: false });
  });

  it('refuses unknown keys and bad values', () => {
    expect(() => parseConvertPayload({ dry_run: false })).toThrow(/unknown payload key/);
    expect(() => parseConvertPayload({ dryRun: 'false' })).toThrow(/boolean/);
    expect(() => parseConvertPayload({ limit: 0 })).toThrow(/limit/);
    expect(() => parseConvertPayload({ classroomId: 3 })).toThrow(/classroomId/);
    expect(() => parseConvertPayload([])).toThrow(/object/);
  });

  it('is the task schema, one run at a time, no retry', () => {
    expect(htmlBlockConvert).toMatchObject({
      id: 'html-block-convert',
      schema: parseConvertPayload,
      queue: { concurrencyLimit: 1 },
      retry: { maxAttempts: 1 },
    });
  });
});

describe('planDeckConversion', () => {
  it('git blob shas match git hash-object', () => {
    expect(gitBlobSha('hello\n')).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });

  it('moves every srcdoc block’s code (no storage shim) into a new file, nothing else', () => {
    let n = 0;
    const mint = () => `blocks/${String(++n).padStart(8, '0')}.html`;
    const plan = planDeckConversion(legacyDeck(), new Set(['blocks/00000001.html']), mint);
    expect(plan?.files).toEqual([
      {
        slideId: 's1',
        blockId: 'old1',
        src: 'blocks/00000002.html',
        html: GAME,
        rev: gitBlobSha(GAME),
      },
      {
        slideId: 'c1',
        blockId: 'old2',
        src: 'blocks/00000003.html',
        html: '<p>inert</p>',
        rev: gitBlobSha('<p>inert</p>'),
      },
    ]);
    for (const file of plan!.files) expect(file.html).not.toContain(HTML_BLOCK_STORAGE_SHIM);
    const next = plan!.deck;
    expect(JSON.stringify(next)).not.toContain('srcdoc');
    expect(blocksOf(next, 's1')).toEqual([
      { id: 'old1', type: 'html', box: BOX, src: 'blocks/00000002.html', rev: gitBlobSha(GAME) },
    ]);
    expect(blocksOf(next, 'c1')[0]).toMatchObject({ id: 'old2', src: 'blocks/00000003.html' });
    expect(next.slides[1].children?.[0].html?.startsWith('<h2>Keep</h2>')).toBe(true);
    // Already a file, and plain slides: untouched.
    expect(next.slides[1].children?.[1]).toEqual(legacyDeck().slides[1].children?.[1]);
    expect(next.slides[2]).toEqual(legacyDeck().slides[2]);
  });

  it('a deck without srcdoc blocks has no plan (the conversion is idempotent)', () => {
    const plan = planDeckConversion(legacyDeck(), new Set());
    expect(planDeckConversion(plan!.deck, new Set())).toBeNull();
  });
});

// ─── The run ─────────────────────────────────────────────────────────────────

function deckRow(id: string, classroomId = 'class-1'): ConvertDeck {
  return {
    id,
    title: `Deck ${id}`,
    content_path: `slides/${id}`,
    classroom_id: classroomId,
    created_by: 'teacher-1',
    classroom: {
      id: classroomId,
      content_repo: `content-${classroomId}`,
      git_organization: { provider: 'GITHUB', login: 'org' },
    },
  } as ConvertDeck;
}

/** A mocked ContentService over an in-memory repo, plus the other deps. */
function fakeDeps(repo: Map<string, string>, opts: { moveDeck?: string } = {}) {
  const content = {
    getMeta: vi.fn(async ({ path }: { path: string }) =>
      repo.has(path) ? { sha: gitBlobSha(repo.get(path)!), size: repo.get(path)!.length } : null
    ),
    getContent: vi.fn(async ({ path }: { path: string }) =>
      repo.has(path) ? { content: repo.get(path)!, sha: gitBlobSha(repo.get(path)!) } : null
    ),
    getLargeContent: vi.fn(),
    listFolder: vi.fn(async ({ path }: { path: string }) =>
      [...repo.keys()]
        .filter(key => key.startsWith(`${path}/`))
        .map(key => ({ name: key.slice(path.length + 1), path: key, type: 'file', sha: 'x' }))
    ),
    uploadBatch: vi.fn(
      async (args: {
        files: Array<{ path: string; content: string }>;
        verifyBaseTree?: (ctx: {
          getFileSha: (p: string) => Promise<string | null>;
        }) => Promise<void>;
      }) => {
        await args.verifyBaseTree?.({
          getFileSha: async path =>
            opts.moveDeck && path.startsWith(`slides/${opts.moveDeck}/`)
              ? 'someone-else'
              : repo.has(path)
                ? gitBlobSha(repo.get(path)!)
                : null,
        });
        for (const file of args.files) repo.set(file.path, file.content);
        return {
          commit: 'commit-1',
          treeSha: 'tree-1',
          filesUploaded: args.files.length,
          files: args.files.map(file => ({ path: file.path, sha: gitBlobSha(file.content) })),
        };
      }
    ),
  };
  const deps = {
    listDecks: vi.fn(async () => [deckRow('d1'), deckRow('d2'), deckRow('d3')]),
    content: content as unknown as ConvertDeps['content'],
    branchOf: vi.fn(async () => 'main'),
    prepare: vi.fn(async (deck: ConvertDeck, json: DeckJson) => ({
      deckPath: `${deck.content_path}/deck.json`,
      htmlPath: `${deck.content_path}/index.html`,
      deckJson: JSON.stringify(json, null, 2) + '\n',
      html: '<html>generated</html>',
    })),
    record: vi.fn(async () => {}),
    audit: vi.fn(async () => {}),
    log: vi.fn(),
  };
  return { deps: deps as ConvertDeps & typeof deps, content };
}

function repoWith(): Map<string, string> {
  const repo = new Map<string, string>();
  repo.set('slides/d1/deck.json', JSON.stringify(legacyDeck()));
  repo.set('slides/d1/blocks/aaaaaaaa.html', '<p>already</p>');
  repo.set(
    'slides/d2/deck.json',
    JSON.stringify({ ...legacyDeck(), slides: [legacyDeck().slides[2]] })
  );
  // d3 has no deck.json (an index.html-only deck).
  return repo;
}

describe('runHtmlBlockConvert', () => {
  it('a dry run reads and plans, and writes nothing', async () => {
    const { deps, content } = fakeDeps(repoWith());
    const result = await runHtmlBlockConvert({ dryRun: true }, deps);
    expect(result).toEqual({
      mode: 'dry-run',
      counts: {
        scanned: 3,
        noDeckJson: 1,
        withLegacyBlocks: 1,
        blocks: 2,
        converted: 0,
        conflicts: 0,
        failed: 0,
      },
      decks: [
        { slideId: 'd1', classroomId: 'class-1', path: 'slides/d1', blocks: 2, status: 'planned' },
        // An index.html-only deck is listed, not skipped in silence.
        {
          slideId: 'd3',
          classroomId: 'class-1',
          path: 'slides/d3',
          blocks: 0,
          status: 'no-deck-json',
        },
      ],
    });
    expect(content.uploadBatch).not.toHaveBeenCalled();
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
    // d2 holds no srcdoc: its blocks folder is never listed.
    expect(content.listFolder).toHaveBeenCalledTimes(1);
  });

  it('converts each deck in ONE commit (files + deck.json + index.html), CAS on deck.json', async () => {
    const repo = repoWith();
    const deckSha = gitBlobSha(repo.get('slides/d1/deck.json')!);
    const { deps, content } = fakeDeps(repo);
    const result = await runHtmlBlockConvert({ dryRun: false, classroomId: 'class-1' }, deps);
    expect(deps.listDecks).toHaveBeenCalledWith({ classroomId: 'class-1' });
    expect(result.counts).toMatchObject({ converted: 1, conflicts: 0, failed: 0, blocks: 2 });
    expect(content.uploadBatch).toHaveBeenCalledTimes(1);
    const batch = content.uploadBatch.mock.calls[0][0] as unknown as {
      files: Array<{ path: string; content: string }>;
      message: string;
      branch: string;
    };
    const paths = batch.files.map(file => file.path);
    expect(paths).toHaveLength(4);
    expect(paths.slice(2)).toEqual(['slides/d1/deck.json', 'slides/d1/index.html']);
    for (const path of paths.slice(0, 2)) {
      expect(path).toMatch(/^slides\/d1\/blocks\/[0-9a-f]{8}\.html$/);
      expect(path).not.toBe('slides/d1/blocks/aaaaaaaa.html');
    }
    expect(batch.files[0].content).toBe(GAME);
    expect(batch.message).not.toMatch(/Classmoji-Collab/);
    expect(batch.branch).toBe('main');

    const saved = JSON.parse(repo.get('slides/d1/deck.json')!) as DeckJson;
    expect(JSON.stringify(saved)).not.toContain('srcdoc');
    expect(blocksOf(saved, 's1')[0]).toMatchObject({
      src: paths[0].slice('slides/d1/'.length),
      rev: gitBlobSha(GAME),
    });
    expect(deckSha).not.toBe(gitBlobSha(repo.get('slides/d1/deck.json')!));

    expect(deps.record).toHaveBeenCalledTimes(1);
    expect((deps.record.mock.calls[0] as unknown[])[1]).toMatchObject({
      commit: 'commit-1',
      treeSha: 'tree-1',
    });
    expect(deps.audit).toHaveBeenCalledWith(deckRow('d1'), {
      tool: 'task:html_block.convert',
      slide_id: 'd1',
      commit: 'commit-1',
      blocks: [
        { block_id: 'old1', path: paths[0] },
        { block_id: 'old2', path: paths[1] },
      ],
    });

    // Run again: nothing left to convert.
    const again = await runHtmlBlockConvert({ dryRun: false }, deps);
    expect(again.counts.withLegacyBlocks).toBe(0);
    expect(content.uploadBatch).toHaveBeenCalledTimes(1);
  });

  it('a deck saved meanwhile is skipped and reported, nothing recorded', async () => {
    const { deps } = fakeDeps(repoWith(), { moveDeck: 'd1' });
    const result = await runHtmlBlockConvert({ dryRun: false }, deps);
    expect(result.counts).toMatchObject({ converted: 0, conflicts: 1 });
    expect(result.decks[0]).toMatchObject({ slideId: 'd1', status: 'conflict' });
    expect(deps.record).not.toHaveBeenCalled();
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it('a failing deck is reported and the run goes on; limit caps the decks handled', async () => {
    const repo = repoWith();
    repo.set('slides/d2/deck.json', JSON.stringify(legacyDeck()));
    const { deps, content } = fakeDeps(repo);
    content.uploadBatch.mockRejectedValueOnce(new Error('GitHub is down'));
    const result = await runHtmlBlockConvert({ dryRun: false }, deps);
    expect(result.decks.map(d => [d.slideId, d.status])).toEqual([
      ['d1', 'failed'],
      ['d2', 'converted'],
      ['d3', 'no-deck-json'],
    ]);
    expect(result.counts).toMatchObject({ failed: 1, converted: 1 });

    const limited = fakeDeps(repoWith());
    const capped = await runHtmlBlockConvert({ dryRun: true, limit: 1 }, limited.deps);
    expect(capped.decks).toHaveLength(1);
    expect(capped.counts.scanned).toBe(1);
  });
});
