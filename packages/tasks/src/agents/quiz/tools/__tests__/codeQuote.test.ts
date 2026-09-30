/**
 * Code quotes: building the card's code from a file's lines (ranges, gaps,
 * omitted lines, one edit), the checks and the model-facing refusals, and
 * reading the file through the per-process cache with GitHub stubbed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { githubStub, FIXTURE_REPOS_DIR } from '../../__fixtures__/githubStub.ts';

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
  metadata: { set: vi.fn(), append: vi.fn(), flush: vi.fn() },
}));

const {
  anchorMatches,
  buildQuote,
  formatLineRanges,
  languageForPath,
  QUOTE_GAP,
  QuoteFileCache,
  QuoteRefusal,
  resolveCodeQuote,
} = await import('../codeQuote.ts');
const { ExplorationStoppedError } = await import('../../../shared/exploration/core.ts');

const STYLE = readFileSync(
  join(FIXTURE_REPOS_DIR, 'landing-page', 'css', 'style.css'),
  'utf8'
).split('\n');
STYLE.pop(); // The trailing newline: 15 lines, as an editor shows them.

/*
 *  1 .hero {                         9 }
 *  2   display: flex;               10
 *  3   flex-direction: column;      11 .features {
 *  4   align-items: center;         12   display: grid;
 *  5 }                              13   grid-template-columns: repeat(2, 1fr);
 *  6                                14   gap: 1rem;
 *  7 .nav a {                       15 }
 *  8   margin: 0 1rem;
 */

const quote = (patch: Record<string, unknown> = {}) => ({
  path: 'css/style.css',
  ranges: [[11, 15]],
  anchor: '.features {',
  ...patch,
});

/** The refusal `fn` throws. */
function refusal(fn: () => unknown): InstanceType<typeof QuoteRefusal> {
  try {
    fn();
  } catch (error) {
    if (error instanceof QuoteRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('buildQuote: the code', () => {
  it('shows one range as the exact lines', () => {
    const built = buildQuote(STYLE, quote() as never);
    expect(built.code).toBe(STYLE.slice(10, 15).join('\n'));
    expect(built.source).toEqual({ path: 'css/style.css', lines: '11-15', changed: false });
    expect(built.shownLines).toBe(5);
  });

  it('puts one "..." line in each gap between ranges', () => {
    const built = buildQuote(
      STYLE,
      quote({
        ranges: [
          [1, 2],
          [7, 7],
          [13, 15],
        ],
        anchor: '.hero {',
      }) as never
    );
    expect(built.code.split('\n')).toEqual([
      '.hero {',
      '  display: flex;',
      QUOTE_GAP,
      '.nav a {',
      QUOTE_GAP,
      '  grid-template-columns: repeat(2, 1fr);',
      '  gap: 1rem;',
      '}',
    ]);
    expect(built.source.lines).toBe('1-2, 7, 13-15');
  });

  it('joins ranges that touch, with no "..." between them', () => {
    const built = buildQuote(
      STYLE,
      quote({
        ranges: [
          [11, 12],
          [13, 15],
        ],
      }) as never
    );
    expect(built.code).not.toContain(QUOTE_GAP);
    expect(built.source.lines).toBe('11-15');
  });

  it('shows each run of omitted lines as one "..." line', () => {
    const built = buildQuote(
      STYLE,
      quote({ ranges: [[1, 9]], anchor: '.hero {', omit: [3, 4, 6] }) as never
    );
    expect(built.code.split('\n')).toEqual([
      '.hero {',
      '  display: flex;',
      QUOTE_GAP,
      '}',
      QUOTE_GAP,
      '.nav a {',
      '  margin: 0 1rem;',
      '}',
    ]);
    expect(built.shownLines).toBe(6);
    // The label names the ranges; omitted lines are inside them.
    expect(built.source.lines).toBe('1-9');
  });

  it('never puts two "..." lines together where an omitted run meets a gap', () => {
    const built = buildQuote(
      STYLE,
      quote({
        ranges: [
          [1, 5],
          [11, 15],
        ],
        anchor: '.hero {',
        omit: [4],
      }) as never
    );
    expect(built.code.split('\n')).toEqual([
      '.hero {',
      '  display: flex;',
      '  flex-direction: column;',
      QUOTE_GAP,
      '}',
      QUOTE_GAP,
      '.features {',
      '  display: grid;',
      '  grid-template-columns: repeat(2, 1fr);',
      '  gap: 1rem;',
      '}',
    ]);
  });

  it('keeps a code line that happens to read "..." as code', () => {
    const lines = ['function f(a) {', '...', '  return a;', '}'];
    const built = buildQuote(lines, {
      path: 'f.js',
      ranges: [[1, 4]],
      anchor: 'function f(a) {',
      omit: [3],
    });
    expect(built.code.split('\n')).toEqual(['function f(a) {', '...', '...', '}']);
  });

  it('replaces the edited line, keeps its indentation, and marks the quote changed', () => {
    const built = buildQuote(
      STYLE,
      quote({ edit: { line: 13, replace: 'grid-template-columns: 1fr;' } }) as never
    );
    expect(built.code.split('\n')[2]).toBe('  grid-template-columns: 1fr;');
    expect(built.code).not.toContain('repeat(2, 1fr)');
    expect(built.source).toEqual({ path: 'css/style.css', lines: '11-15', changed: true });
  });

  it('keeps the indentation the edit gives itself', () => {
    const built = buildQuote(
      STYLE,
      quote({ edit: { line: 12, replace: '    display: block;' } }) as never
    );
    expect(built.code.split('\n')[1]).toBe('    display: block;');
  });

  it('formats line ranges as "5-10", "7" and a comma list', () => {
    expect(
      formatLineRanges([
        [5, 10],
        [7, 7],
      ])
    ).toBe('5-10, 7');
  });

  it('takes the path without a leading "./"', () => {
    expect(buildQuote(STYLE, quote({ path: './css/style.css' }) as never).source.path).toBe(
      'css/style.css'
    );
  });
});

describe('buildQuote: the anchor', () => {
  it('matches after trimming and collapsing whitespace', () => {
    expect(() =>
      buildQuote(STYLE, quote({ ranges: [[7, 8]], anchor: '   .nav    a  {  ' }) as never)
    ).not.toThrow();
    expect(() =>
      buildQuote(
        STYLE,
        quote({ ranges: [[13, 13]], anchor: 'grid-template-columns:\trepeat(2, 1fr);' }) as never
      )
    ).not.toThrow();
  });

  it('forgives the "N| " prefix of that same line, and only that line', () => {
    expect(anchorMatches('11| .features {', '.features {', 11)).toBe(true);
    expect(anchorMatches('12| .features {', '.features {', 11)).toBe(false);
  });

  it('matches a line exploration cut for length by the part it showed', () => {
    const long = `const data = ${'x'.repeat(50)};`;
    expect(anchorMatches(`const data = xxxx [… line cut: 40 more characters]`, long, 1)).toBe(true);
    expect(anchorMatches('const data = xxxx', long, 1)).toBe(false);
  });

  it('refuses a wrong anchor, saying what the line is and where to look', () => {
    const r = refusal(() => buildQuote(STYLE, quote({ anchor: '.header {' }) as never));
    expect(r.reason).toBe('anchor_mismatch');
    expect(r.message).toBe(
      'Line 11 of css/style.css is `.features {`, not `.header {`. Check the line numbers from your exploration.'
    );
  });

  it('refuses a range that starts on a blank line', () => {
    const r = refusal(() =>
      buildQuote(STYLE, quote({ ranges: [[6, 8]], anchor: '.nav a {' }) as never)
    );
    expect(r.message).toBe(
      'Line 6 of css/style.css is blank. Start the range on a line with code. Check the line numbers from your exploration.'
    );
  });

  it('shortens a long line in the refusal', () => {
    const lines = [`const data = ${'x'.repeat(300)};`];
    const r = refusal(() =>
      buildQuote(lines, { path: 'a.js', ranges: [[1, 1]], anchor: 'const other = 1;' })
    );
    expect(r.message.length).toBeLessThan(260);
    expect(r.message).toContain('…`');
  });
});

describe('buildQuote: refusals', () => {
  it.each([
    [
      'a range past the end',
      { ranges: [[12, 20]] },
      'out_of_range',
      'css/style.css has 15 lines; range 12-20 runs past the end. Check the line numbers from your exploration.',
    ],
    [
      'a range that starts after it ends',
      { ranges: [[13, 11]] },
      'bad_range',
      'Range 13-11 starts after it ends. Give each range as [first line, last line].',
    ],
    [
      'ranges out of order',
      {
        ranges: [
          [11, 15],
          [1, 5],
        ],
      },
      'bad_range',
      'Range 1-5 overlaps or comes before range 11-15. List ranges in ascending order, without overlap.',
    ],
    [
      'overlapping ranges',
      {
        ranges: [
          [11, 13],
          [13, 15],
        ],
      },
      'bad_range',
      'Range 13-15 overlaps or comes before range 11-13. List ranges in ascending order, without overlap.',
    ],
    [
      'an omitted line outside the ranges',
      { omit: [3] },
      'bad_omit',
      'Line 3 in omit is not inside a quoted range.',
    ],
    [
      "an omitted range's first line",
      { omit: [11] },
      'bad_omit',
      'omit cannot leave out line 11, the first or last line of range 11-15. Narrow the range instead.',
    ],
    [
      'an edit of a line not quoted',
      { edit: { line: 2, replace: 'display: block;' } },
      'bad_edit',
      'edit.line 2 is not one of the quoted lines.',
    ],
    [
      'an edit of an omitted line',
      { omit: [13], edit: { line: 13, replace: 'gap: 0;' } },
      'bad_edit',
      'edit.line 13 is not one of the quoted lines.',
    ],
    [
      'an edit over two lines',
      { edit: { line: 13, replace: 'a: 1;\nb: 2;' } },
      'bad_edit',
      'edit.replace must be a single line.',
    ],
    [
      'an edit that changes nothing',
      { edit: { line: 14, replace: 'gap:   1rem;' } },
      'bad_edit',
      'edit.replace is the same as line 14. Change the line, or leave edit out.',
    ],
  ])('refuses %s, with a message that says what to fix', (_label, patch, reason, message) => {
    const r = refusal(() => buildQuote(STYLE, quote(patch) as never));
    expect(r.reason).toBe(reason);
    expect(r.message).toBe(message);
  });

  it('refuses more than 40 shown lines, counting omitted lines out', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1};`);
    const r = refusal(() =>
      buildQuote(lines, { path: 'a.js', ranges: [[1, 45]], anchor: 'line 1;' })
    );
    expect(r.reason).toBe('too_long');
    expect(r.message).toBe(
      'The quote shows 45 lines; show at most 40. Narrow the ranges or leave lines out with omit.'
    );
    expect(() =>
      buildQuote(lines, {
        path: 'a.js',
        ranges: [[1, 45]],
        anchor: 'line 1;',
        omit: [10, 11, 12, 13, 14],
      })
    ).not.toThrow();
  });

  it('refuses an empty file', () => {
    const r = refusal(() => buildQuote([], quote() as never));
    expect(r.message).toBe('css/style.css is empty or is not a file.');
  });
});

describe('languageForPath', () => {
  it('names the language from the extension, and nothing for an unknown one', () => {
    expect(languageForPath('css/style.css')).toBe('css');
    expect(languageForPath('src/App.JSX')).toBe('jsx');
    expect(languageForPath('Makefile')).toBeUndefined();
    expect(languageForPath('notes.xyz')).toBeUndefined();
  });
});

describe('resolveCodeQuote: reading the file', () => {
  const where = {
    attemptId: 'attempt-1',
    owner: 'sample-org',
    repo: 'landing-page',
    gitOrganization: { provider: 'GITHUB', github_installation_id: '1', login: 'sample-org' },
  } as never;
  const signal = () => new AbortController().signal;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const contentsRequests = (requested: string[], path: string) =>
    requested.filter(url => url.endsWith(`/contents/${path}`)).length;

  it('reads the file with a repository token once, then quotes from the cache', async () => {
    const stub = githubStub('landing-page');
    vi.stubGlobal('fetch', stub.fetchImpl);
    const mintRepoToken = vi.fn(async () => 'repo-token');
    const cache = new QuoteFileCache();

    const first = await resolveCodeQuote(
      quote() as never,
      where,
      { mintRepoToken, cache },
      signal()
    );
    const second = await resolveCodeQuote(
      quote({ ranges: [[1, 5]], anchor: '.hero {' }) as never,
      where,
      { mintRepoToken, cache },
      signal()
    );

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.code.split('\n')[0]).toBe('.hero {');
    expect(contentsRequests(stub.requested, 'css/style.css')).toBe(1);
    expect(mintRepoToken).toHaveBeenCalledTimes(1);
    expect(mintRepoToken).toHaveBeenCalledWith(expect.anything(), 'landing-page');
  });

  it('reads the file again when the cache does not have it', async () => {
    const stub = githubStub('landing-page');
    vi.stubGlobal('fetch', stub.fetchImpl);
    const deps = { mintRepoToken: async () => 'repo-token', cache: new QuoteFileCache() };
    await resolveCodeQuote(quote() as never, where, deps, signal());
    deps.cache.clear();
    await resolveCodeQuote(quote() as never, where, deps, signal());
    expect(contentsRequests(stub.requested, 'css/style.css')).toBe(2);
  });

  it('keeps files per attempt', async () => {
    const stub = githubStub('landing-page');
    vi.stubGlobal('fetch', stub.fetchImpl);
    const deps = { mintRepoToken: async () => 'repo-token', cache: new QuoteFileCache() };
    await resolveCodeQuote(quote() as never, where, deps, signal());
    await resolveCodeQuote(
      quote() as never,
      { ...(where as object), attemptId: 'attempt-2' } as never,
      deps,
      signal()
    );
    expect(contentsRequests(stub.requested, 'css/style.css')).toBe(2);
  });

  it('quotes the lines exploration kept, without reading the file', async () => {
    const stub = githubStub('landing-page');
    vi.stubGlobal('fetch', stub.fetchImpl);
    const cache = new QuoteFileCache();
    cache.set(
      QuoteFileCache.key('attempt-1', 'sample-org', 'landing-page', 'css/style.css'),
      '.old {\r\n  color: red;\r\n}\r\n'
    );
    const built = await resolveCodeQuote(
      quote({ ranges: [[1, 3]], anchor: '.old {' }) as never,
      where,
      { mintRepoToken: async () => 'repo-token', cache },
      signal()
    );
    expect(built.code).toBe('.old {\n  color: red;\n}');
    expect(stub.requested).toEqual([]);
  });

  it('refuses a file that is not in the repository', async () => {
    vi.stubGlobal('fetch', githubStub('landing-page').fetchImpl);
    const error = await resolveCodeQuote(
      quote({ path: 'css/stlye.css' }) as never,
      where,
      { mintRepoToken: async () => 'repo-token', cache: new QuoteFileCache() },
      signal()
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(QuoteRefusal);
    expect((error as Error).message).toBe(
      "css/stlye.css is not in the student's repository. Use a path exactly as your exploration results name it."
    );
  });

  it('refuses a path exploration never shows, without reading it', async () => {
    const stub = githubStub('landing-page');
    vi.stubGlobal('fetch', stub.fetchImpl);
    const mintRepoToken = vi.fn(async () => 'repo-token');
    const error = await resolveCodeQuote(
      quote({ path: '.env' }) as never,
      where,
      { mintRepoToken, cache: new QuoteFileCache() },
      signal()
    ).catch((e: unknown) => e);
    expect((error as InstanceType<typeof QuoteRefusal>).reason).toBe('not_quotable');
    expect(mintRepoToken).not.toHaveBeenCalled();
    expect(stub.requested).toEqual([]);
  });

  it('passes any other read error on, for the tool to log', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"message":"Server Error"}', { status: 500 }));
    const error = await resolveCodeQuote(
      quote() as never,
      where,
      { mintRepoToken: async () => 'repo-token', cache: new QuoteFileCache() },
      signal()
    ).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(QuoteRefusal);
    expect((error as Error).message).toMatch(/failed \(500\)/);
  });

  it('stops when the turn has ended', async () => {
    vi.stubGlobal('fetch', githubStub('landing-page').fetchImpl);
    const controller = new AbortController();
    controller.abort();
    const error = await resolveCodeQuote(
      quote() as never,
      where,
      { mintRepoToken: async () => 'repo-token', cache: new QuoteFileCache() },
      controller.signal
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExplorationStoppedError);
  });
});

describe('QuoteFileCache', () => {
  it('drops the least recently used file past its size, and never keeps a very long file', () => {
    const cache = new QuoteFileCache(2, 50);
    cache.set('a', 'a');
    cache.set('b', 'b');
    cache.get('a');
    cache.set('c', 'c');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toEqual(['a']);
    expect(cache.set('long', 'x'.repeat(51))).toEqual(['x'.repeat(51)]);
    expect(cache.get('long')).toBeUndefined();
  });
});
