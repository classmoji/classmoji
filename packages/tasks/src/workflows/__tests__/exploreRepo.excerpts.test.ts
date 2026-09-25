/**
 * Unit tests for the explore-repo task's excerpt contract.
 *
 * The exploration model no longer writes code into its answer; it names line
 * ranges and the task slices them out of the real files. Everything that turns
 * those pointers into text the quiz agent reads is pinned here: line numbering,
 * clamping and merging, the whole_file size rule, the output cap and its
 * visible note, the fallback when the answer is unusable, the legacy `findings`
 * string an older ai-agent still parses, and publishing the result to run
 * metadata before the task returns. `@trigger.dev/sdk/v3` and the Anthropic SDK
 * are mocked and `fetch` is stubbed, so nothing reaches a network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  warn: vi.fn(),
  set: vi.fn(),
  append: vi.fn(),
  flush: vi.fn(),
  calls: [] as string[],
}));

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), error: vi.fn(), warn: (...a: unknown[]) => mocks.warn(...a) },
  metadata: {
    set: (...a: unknown[]) => {
      mocks.calls.push(`set:${String(a[0])}`);
      return mocks.set(...a);
    },
    append: (...a: unknown[]) => mocks.append(...a),
    flush: (...a: unknown[]) => {
      mocks.calls.push('flush');
      return mocks.flush(...a);
    },
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mocks.create };
  },
}));

vi.spyOn(console, 'log').mockImplementation(() => {});

const {
  splitLines,
  numberLines,
  allocateInputBudget,
  renderFilesForPrompt,
  parseExcerptResponse,
  resolveExcerpts,
  fallbackExcerpts,
  assembleExcerptText,
  buildExploreResult,
  exploreRepoTask,
  WHOLE_FILE_MAX_LINES,
  MAX_EXCERPTS,
  EXCERPT_MAX_CHARS,
  EXCERPT_OUTPUT_MAX_CHARS,
  MAX_LINE_CHARS,
} = await import('../exploreRepo.ts');

type Pointer = Parameters<typeof resolveExcerpts>[0][number];

/** A file of `n` lines whose line k reads `line k`, then `pad` x's. */
const fileOf = (path: string, n: number, pad = 0) => ({
  path,
  content: Array.from({ length: n }, (_, i) => `line ${i + 1}${'x'.repeat(pad)}`).join('\n') + '\n',
});

const pointer = (p: Partial<Pointer> & { path: string }): Pointer => ({
  startLine: null,
  endLine: null,
  wholeFile: false,
  why: '',
  ...p,
});

beforeEach(() => {
  mocks.create.mockReset();
  mocks.warn.mockReset();
  mocks.set.mockReset();
  mocks.append.mockReset();
  mocks.flush.mockReset();
  mocks.calls.length = 0;
});

describe('splitLines / numberLines', () => {
  it('does not count a trailing newline as a line, and handles CRLF', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
  });

  it('numbers lines right-aligned to the width of the last line number', () => {
    const lines = splitLines(fileOf('x', 120).content);
    expect(numberLines(lines, 9, 10)).toBe('  9| line 9\n 10| line 10');
    expect(numberLines(lines, 120, 120)).toBe('120| line 120');
  });
});

describe('input budget', () => {
  it('gives small files all they need and splits the rest evenly', () => {
    expect(allocateInputBudget([100, 50_000, 50_000], 30_100, 24_000)).toEqual([
      100, 15_000, 15_000,
    ]);
    // Each file is still capped on its own.
    expect(allocateInputBudget([50_000], 72_000, 24_000)).toEqual([24_000]);
  });

  it('shows a file cut short with how much of it was shown', () => {
    // 400 lines of ~100 characters is ~42k numbered, over the 24k per-file cap.
    const text = renderFilesForPrompt([fileOf('big.css', 400, 90)]);
    const shown = Number(text.match(/lines 1-(\d+) shown/)?.[1]);
    expect(text).toContain(
      `### FILE: big.css (400 lines; lines 1-${shown} shown, the rest omitted for length)`
    );
    expect(shown).toBeGreaterThan(100);
    expect(shown).toBeLessThan(400);
    expect(text).not.toContain(`line ${shown + 1}x`);
    expect(text.length).toBeLessThanOrEqual(24_000 + 100);
  });

  it(`cuts a line past ${MAX_LINE_CHARS} characters with a marker, so the rest of the file shows`, () => {
    const minified = { path: 'min.js', content: 'z'.repeat(30_000) + '\nafter();\n' };
    expect(renderFilesForPrompt([minified])).toBe(
      `### FILE: min.js (2 lines)\n1| ${'z'.repeat(MAX_LINE_CHARS)} [… line cut: 28000 more characters]\n2| after();`
    );
  });

  it('leaves out files that failed to fetch', () => {
    const text = renderFilesForPrompt([
      { path: 'a.js', content: 'a()' },
      { path: 'b.js', content: '', error: '404' },
    ]);
    expect(text).toBe('### FILE: a.js (1 lines)\n1| a()');
  });
});

describe('parseExcerptResponse', () => {
  it('coerces line numbers, normalizes ./ paths, and flattens why', () => {
    const parsed = parseExcerptResponse(
      JSON.stringify({
        overview: '  A  React\napp. ',
        excerpts: [
          { path: './src/App.jsx', start_line: '12', end_line: 40, why: 'the\nApp' },
          { path: 'a.css', start_line: 1.5, end_line: 'x' },
          { path: 'index.html', whole_file: true },
          { nope: true },
        ],
      })
    );
    expect(parsed).toEqual({
      overview: 'A React app.',
      pointers: [
        { path: 'src/App.jsx', startLine: 12, endLine: 40, wholeFile: false, why: 'the App' },
        { path: 'a.css', startLine: null, endLine: null, wholeFile: false, why: '' },
        { path: 'index.html', startLine: null, endLine: null, wholeFile: true, why: '' },
      ],
    });
  });

  it('returns null for anything without an excerpts array', () => {
    expect(parseExcerptResponse(null)).toBeNull();
    expect(parseExcerptResponse('not json')).toBeNull();
    expect(parseExcerptResponse('{"overview": "x"}')).toBeNull();
    expect(parseExcerptResponse('[1, 2]')).toBeNull();
  });

  it('takes a bare array of excerpts as the excerpts list, fenced or not', () => {
    const expected = {
      overview: null,
      pointers: [{ path: 'src/App.jsx', startLine: 1, endLine: 5, wholeFile: false, why: 'x' }],
    };
    const array = '[{"path": "src/App.jsx", "start_line": 1, "end_line": 5, "why": "x"}]';
    expect(parseExcerptResponse(array)).toEqual(expected);
    expect(parseExcerptResponse('```json\n' + array + '\n```')).toEqual(expected);
    expect(parseExcerptResponse('[]')).toEqual({ overview: null, pointers: [] });
  });

  it('reads the object out of prose that has braces of its own, and braces inside strings', () => {
    const object =
      '{"excerpts": [{"path": "a.css", "start_line": 1, "end_line": 5, "why": "the {x} rule"}]}';
    const expected = {
      overview: null,
      pointers: [
        { path: 'a.css', startLine: 1, endLine: 5, wholeFile: false, why: 'the {x} rule' },
      ],
    };
    expect(parseExcerptResponse(`${object}\nNote: I skipped the .b { } rule.`)).toEqual(expected);
    expect(parseExcerptResponse(`Here you go:\n${object}\nThe {y} block is unrelated.`)).toEqual(
      expected
    );
  });
});

describe('resolveExcerpts', () => {
  const small = fileOf('small.js', 50);
  const large = fileOf('large.css', 400);

  it('clamps a range to the file and swaps a reversed one', () => {
    expect(
      resolveExcerpts(
        [
          pointer({ path: 'small.js', startLine: 45, endLine: 80 }),
          pointer({ path: 'large.css', startLine: 30, endLine: -3 }),
        ],
        [small, large]
      )
    ).toEqual([
      { path: 'small.js', startLine: 45, endLine: 50, wholeFile: false, why: '' },
      { path: 'large.css', startLine: 1, endLine: 30, wholeFile: false, why: '' },
    ]);
  });

  it('reads a lone start or end line as a one-line range', () => {
    expect(
      resolveExcerpts(
        [pointer({ path: 'large.css', startLine: 7 }), pointer({ path: 'large.css', endLine: 20 })],
        [large]
      ).map(e => [e.startLine, e.endLine])
    ).toEqual([
      [7, 7],
      [20, 20],
    ]);
  });

  it('drops paths that were not read', () => {
    expect(
      resolveExcerpts([pointer({ path: 'nope.js', startLine: 1, endLine: 2 })], [small])
    ).toEqual([]);
  });

  it('turns an unusable range into the whole file when small, and drops it when large', () => {
    const resolved = resolveExcerpts(
      [
        pointer({ path: 'small.js' }),
        pointer({ path: 'large.css' }),
        pointer({ path: 'large.css', startLine: 900, endLine: 950 }),
      ],
      [small, large]
    );
    expect(resolved).toEqual([
      { path: 'small.js', startLine: 1, endLine: 50, wholeFile: true, why: '' },
    ]);
  });

  it('gives whole_file whole for a small file and the first lines of a large one', () => {
    const resolved = resolveExcerpts(
      [
        pointer({ path: 'small.js', wholeFile: true }),
        pointer({ path: 'large.css', wholeFile: true }),
      ],
      [small, large]
    );
    expect(resolved).toEqual([
      { path: 'small.js', startLine: 1, endLine: 50, wholeFile: true, why: '' },
      {
        path: 'large.css',
        startLine: 1,
        endLine: WHOLE_FILE_MAX_LINES,
        wholeFile: false,
        why: '',
        uncutEndLine: 400,
      },
    ]);
  });

  describe(`bounds every excerpt by characters (${EXCERPT_MAX_CHARS})`, () => {
    // 250 lines of ~123 numbered characters: ~31k, over the per-excerpt budget
    // at half the line cap. A live probe gave a file like this as whole_file.
    const wide = fileOf('src/Big.jsx', 250, 110);
    const lines = splitLines(wide.content);

    it('stops whole_file, a range, and the fallback at the last line that fits', () => {
      const [whole] = resolveExcerpts([pointer({ path: 'src/Big.jsx', wholeFile: true })], [wide]);
      const [range] = resolveExcerpts(
        [pointer({ path: 'src/Big.jsx', startLine: 1, endLine: 250 })],
        [wide]
      );
      const [fallback] = fallbackExcerpts([wide]);
      for (const excerpt of [whole, range, fallback]) {
        expect(excerpt).toMatchObject({ startLine: 1, wholeFile: false, uncutEndLine: 250 });
        expect(excerpt.endLine).toBeGreaterThan(100);
        const body = numberLines(lines, 1, excerpt.endLine);
        expect(body.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
        // The next line would not have fit.
        expect(numberLines(lines, 1, excerpt.endLine + 1).length).toBeGreaterThan(
          EXCERPT_MAX_CHARS
        );
      }
    });

    it('says where a cut excerpt would have run to, and leaves room for the next one', () => {
      const excerpts = resolveExcerpts(
        [
          pointer({ path: 'src/Big.jsx', wholeFile: true, why: 'the component' }),
          pointer({ path: 'small.js', startLine: 1, endLine: 20, why: 'the answer' }),
        ],
        [wide, small]
      );
      const { excerptText, included } = assembleExcerptText(excerpts, [wide, small], null);
      const cutAt = excerpts[0].endLine;
      expect(excerptText).toContain(`=== src/Big.jsx lines 1–${cutAt} of 250 — the component ===`);
      expect(excerptText).toContain(
        `[… cut at line ${cutAt} for length; this excerpt runs to line 250.]`
      );
      expect(excerptText).toContain('=== small.js lines 1–20 of 50 — the answer ===');
      // Nothing extra leaks into the published excerpts.
      expect(included.map(i => Object.keys(i.excerpt).sort())).toEqual([
        ['endLine', 'path', 'startLine', 'wholeFile', 'why'],
        ['endLine', 'path', 'startLine', 'wholeFile', 'why'],
      ]);
    });

    it('does not merge ranges too big together, and keeps shared lines in the higher-ranked one', () => {
      const wider = fileOf('src/Wide.jsx', 400, 110);
      // Each fits alone (118 and 11 lines); together (123 lines) they do not.
      const answer = pointer({ path: 'src/Wide.jsx', startLine: 200, endLine: 210, why: 'answer' });
      const context = pointer({
        path: 'src/Wide.jsx',
        startLine: 88,
        endLine: 205,
        why: 'context',
      });
      expect(
        resolveExcerpts([answer, context], [wider]).map(e => [e.why, e.startLine, e.endLine])
      ).toEqual([
        ['answer', 200, 210],
        ['context', 88, 199],
      ]);
      expect(
        resolveExcerpts([context, answer], [wider]).map(e => [e.why, e.startLine, e.endLine])
      ).toEqual([
        ['context', 88, 205],
        ['answer', 206, 210],
      ]);
    });
  });

  describe('a whole-file pointer on a file the model already named lines in', () => {
    const big = fileOf('src/Big.jsx', 250, 110);
    const app = fileOf('src/App.jsx', 40);

    it('is dropped when it ranks lower, so it cannot carry the file to the top', () => {
      // From a probe: the whole_file ranked last merged into the top-ranked
      // range and pushed every other excerpt out.
      const resolved = resolveExcerpts(
        [
          pointer({ path: 'src/Big.jsx', startLine: 10, endLine: 20, why: 'answer' }),
          pointer({ path: 'src/App.jsx', startLine: 1, endLine: 10, why: 'second' }),
          pointer({ path: 'src/Big.jsx', wholeFile: true, why: 'context' }),
          pointer({ path: 'small.js', why: 'no lines named' }),
          pointer({ path: 'src/App.jsx', why: 'no lines named either' }),
        ],
        [big, app, small]
      );
      expect(resolved.map(e => [e.path, e.startLine, e.endLine, e.why])).toEqual([
        ['src/Big.jsx', 10, 20, 'answer'],
        ['src/App.jsx', 1, 10, 'second'],
        ['small.js', 1, 50, 'no lines named'],
      ]);
    });

    it('is kept when it ranks higher, and takes in the ranges inside it', () => {
      const resolved = resolveExcerpts(
        [
          pointer({ path: 'src/App.jsx', wholeFile: true, why: 'the app' }),
          pointer({ path: 'src/App.jsx', startLine: 3, endLine: 8, why: 'state' }),
        ],
        [app]
      );
      expect(resolved).toEqual([
        { path: 'src/App.jsx', startLine: 1, endLine: 40, wholeFile: true, why: 'the app; state' },
      ]);
    });
  });

  it('does not count a minified file as small, whatever its line count', () => {
    // A live probe hit this: reveal.js is 8 lines and 181k characters.
    const bundle = { path: 'bundle.js', content: 'x'.repeat(40_000) + '\ny()\n' };
    expect(resolveExcerpts([pointer({ path: 'bundle.js' })], [bundle])).toEqual([]);
    expect(fallbackExcerpts([bundle, small]).map(e => e.path)).toEqual(['small.js', 'bundle.js']);
  });

  it('merges overlapping, adjacent, and one-line-apart ranges in a file, keeping the best rank', () => {
    const resolved = resolveExcerpts(
      [
        pointer({ path: 'large.css', startLine: 100, endLine: 120, why: 'nav rules' }),
        pointer({ path: 'small.js', startLine: 1, endLine: 5, why: 'imports' }),
        pointer({ path: 'large.css', startLine: 40, endLine: 60, why: 'header rule' }),
        pointer({ path: 'large.css', startLine: 61, endLine: 70, why: 'header media query' }),
        pointer({ path: 'large.css', startLine: 110, endLine: 130, why: 'nav hover' }),
        pointer({ path: 'large.css', startLine: 72, endLine: 80, why: 'gap of one line' }),
      ],
      [small, large]
    );
    expect(resolved).toEqual([
      {
        path: 'large.css',
        startLine: 100,
        endLine: 130,
        wholeFile: false,
        why: 'nav rules; nav hover',
      },
      { path: 'small.js', startLine: 1, endLine: 5, wholeFile: false, why: 'imports' },
      {
        path: 'large.css',
        startLine: 40,
        endLine: 80,
        wholeFile: false,
        why: 'header rule; header media query; gap of one line',
      },
    ]);
  });

  it('merges rules one blank line apart, but not two lines apart', () => {
    // From a live probe: 7–51, 53–79 and 81–109 came back as three excerpts.
    expect(
      resolveExcerpts(
        [
          pointer({ path: 'large.css', startLine: 7, endLine: 51 }),
          pointer({ path: 'large.css', startLine: 53, endLine: 79 }),
          pointer({ path: 'large.css', startLine: 81, endLine: 109 }),
          pointer({ path: 'large.css', startLine: 112, endLine: 120 }),
        ],
        [large]
      ).map(e => [e.startLine, e.endLine])
    ).toEqual([
      [7, 109],
      [112, 120],
    ]);
  });

  it('marks a range that covers the whole file as whole_file', () => {
    expect(
      resolveExcerpts(
        [
          pointer({ path: 'small.js', startLine: 1, endLine: 30 }),
          pointer({ path: 'small.js', startLine: 31, endLine: 50 }),
        ],
        [small]
      )
    ).toEqual([{ path: 'small.js', startLine: 1, endLine: 50, wholeFile: true, why: '' }]);
  });

  it(`keeps only the first ${MAX_EXCERPTS} usable pointers`, () => {
    const pointers = Array.from({ length: 10 }, (_, i) =>
      pointer({ path: 'large.css', startLine: i * 20 + 1, endLine: i * 20 + 5 })
    );
    expect(resolveExcerpts(pointers, [large])).toHaveLength(MAX_EXCERPTS);
  });
});

describe('assembleExcerptText', () => {
  it('writes the overview, then a header and the exact numbered lines per excerpt', () => {
    const files = [
      { path: 'style.css', content: '.a {}\n.header {\n  display: flex;\n}\n.b {}\n' },
      { path: 'index.html', content: '<h1>Hi</h1>\n' },
    ];
    const { excerptText, included } = assembleExcerptText(
      [
        { path: 'style.css', startLine: 2, endLine: 4, wholeFile: false, why: 'header flex rule' },
        { path: 'index.html', startLine: 1, endLine: 1, wholeFile: true, why: '' },
      ],
      files,
      'A static site.'
    );
    expect(excerptText).toBe(
      [
        'Overview: A static site.',
        '=== style.css lines 2–4 of 5 — header flex rule ===\n2| .header {\n3|   display: flex;\n4| }',
        '=== index.html (whole file, 1 lines) ===\n1| <h1>Hi</h1>',
      ].join('\n\n')
    );
    expect(included.map(i => i.body)).toEqual([
      '2| .header {\n3|   display: flex;\n4| }',
      '1| <h1>Hi</h1>',
    ]);
  });

  it('stops at the cap: cuts the excerpt that crosses it and lists the rest as omitted', () => {
    const files = [fileOf('a.js', 1000), fileOf('b.js', 1000)];
    const { excerptText, included } = assembleExcerptText(
      [
        { path: 'a.js', startLine: 1, endLine: 100, wholeFile: false, why: 'first' },
        { path: 'a.js', startLine: 201, endLine: 900, wholeFile: false, why: 'second' },
        { path: 'b.js', startLine: 1, endLine: 10, wholeFile: false, why: 'third' },
      ],
      files,
      null,
      3000
    );

    // The two notes may run past the cap; the code itself does not (give or
    // take the separators around the notes).
    const notes = excerptText.split('\n').filter(l => l.startsWith('['));
    expect(excerptText.length - notes.join('\n').length).toBeLessThanOrEqual(3000 + 3);
    expect(included).toHaveLength(2);
    expect(included[0].excerpt.endLine).toBe(100);
    const cut = included[1].excerpt;
    expect(cut.startLine).toBe(201);
    expect(cut.endLine).toBeLessThan(900);
    expect(excerptText).toContain(`=== a.js lines 201–${cut.endLine} of 1000 — second ===`);
    expect(excerptText).toContain(
      `[… cut at line ${cut.endLine}; this excerpt runs to line 900. Output size cap reached.]`
    );
    expect(excerptText).toContain('[Omitted to stay under the output size cap: b.js lines 1–10]');
    expect(excerptText).not.toContain('— third');
  });

  it('skips an excerpt that cannot fit 5 lines and still takes the ones after it', () => {
    // Lines of ~150 characters: the second excerpt has room for 3 of them.
    const files = [fileOf('a.js', 1000, 140), fileOf('b.js', 2)];
    const { excerptText, included } = assembleExcerptText(
      [
        { path: 'a.js', startLine: 1, endLine: 16, wholeFile: false, why: 'first' },
        { path: 'a.js', startLine: 400, endLine: 700, wholeFile: false, why: 'second' },
        { path: 'b.js', startLine: 1, endLine: 2, wholeFile: true, why: 'tiny' },
      ],
      files,
      null,
      3000
    );
    expect(included.map(i => [i.excerpt.path, i.excerpt.startLine, i.excerpt.endLine])).toEqual([
      ['a.js', 1, 16],
      ['b.js', 1, 2],
    ]);
    expect(excerptText).toContain(
      '=== b.js (whole file, 2 lines) — tiny ===\n1| line 1\n2| line 2'
    );
    expect(
      excerptText.endsWith('[Omitted to stay under the output size cap: a.js lines 400–700]')
    ).toBe(true);
  });

  it('does not let an oversized first excerpt push out the rest', () => {
    const files = [fileOf('wide.js', 10, 500), fileOf('b.js', 3)];
    const { excerptText, included } = assembleExcerptText(
      [
        { path: 'wide.js', startLine: 1, endLine: 10, wholeFile: true, why: 'too wide' },
        { path: 'b.js', startLine: 1, endLine: 3, wholeFile: true, why: 'fits' },
      ],
      files,
      null,
      1000
    );
    expect(included.map(i => i.excerpt.path)).toEqual(['b.js']);
    expect(excerptText).toBe(
      '=== b.js (whole file, 3 lines) — fits ===\n1| line 1\n2| line 2\n3| line 3\n\n' +
        '[Omitted to stay under the output size cap: wide.js lines 1–10]'
    );
  });

  it(`cuts a single line past ${MAX_LINE_CHARS} characters instead of spending the cap on it`, () => {
    const files = [
      { path: 'min.js', content: `${'z'.repeat(50_000)}\n` },
      { path: 'app.js', content: 'run();\n' },
    ];
    const { excerptText, included } = assembleExcerptText(
      [
        { path: 'min.js', startLine: 1, endLine: 1, wholeFile: true, why: '' },
        { path: 'app.js', startLine: 1, endLine: 1, wholeFile: true, why: '' },
      ],
      files,
      null
    );
    expect(included).toHaveLength(2);
    expect(excerptText).toBe(
      `=== min.js (whole file, 1 lines) ===\n1| ${'z'.repeat(MAX_LINE_CHARS)} [… line cut: 48000 more characters]\n\n` +
        '=== app.js (whole file, 1 lines) ===\n1| run();'
    );
  });

  it('holds real output under the default ~30 KB cap', () => {
    const files = [fileOf('a.js', 5000)];
    const { excerptText } = assembleExcerptText(
      [{ path: 'a.js', startLine: 1, endLine: 5000, wholeFile: false, why: '' }],
      files,
      null
    );
    expect(excerptText.length).toBeLessThanOrEqual(EXCERPT_OUTPUT_MAX_CHARS + 200);
    expect(excerptText.length).toBeGreaterThan(EXCERPT_OUTPUT_MAX_CHARS - 200);
  });
});

/**
 * A copy of the OLD ai-agent's ExplorationSummarySchema
 * (apps/ai-agent/src/llm/schemas/explorationSummary.js). An ai-agent that
 * predates `format` parses `findings` with exactly this during a deploy where
 * the Trigger task lands first; failing it empties the exploration.
 */
const LegacySummarySchema = z.object({
  focus_area: z.string(),
  project_structure: z
    .object({
      entry_points: z.array(z.string()),
      key_directories: z.array(z.string()),
      config_files: z.array(z.string()),
    })
    .optional(),
  relevant_files: z
    .array(
      z.object({
        path: z.string(),
        summary: z.string(),
        code_snippet: z.string().optional(),
        concepts: z.array(z.string()),
      })
    )
    .max(5),
  key_patterns: z.array(z.object({ pattern: z.string(), evidence: z.string() })).max(3),
  suggested_topics: z.array(z.string()).max(5),
});

describe('buildExploreResult', () => {
  const files = [
    fileOf('src/App.jsx', 40),
    fileOf('src/big.css', 900),
    fileOf('index.html', 10),
    { path: 'gone.js', content: '', error: '404' },
  ];
  const filePaths = files.map(f => f.path);

  it('builds the excerpts-v1 contract with the legacy findings alongside', () => {
    const result = buildExploreResult({
      response: {
        overview: 'A React app.',
        pointers: [
          pointer({ path: 'src/big.css', startLine: 40, endLine: 44, why: 'header rule' }),
          pointer({ path: 'src/App.jsx', startLine: 3, endLine: 4, why: 'state' }),
          pointer({ path: 'src/big.css', startLine: 100, endLine: 101, why: 'nav rule' }),
        ],
      },
      files,
      filePaths,
      focusArea: 'initial',
      fileCount: 12,
    });

    expect(result).toMatchObject({
      format: 'excerpts-v1',
      overview: 'A React app.',
      filesRead: filePaths,
      focusArea: 'initial',
      fileCount: 12,
      excerpts: [
        { path: 'src/big.css', startLine: 40, endLine: 44, wholeFile: false, why: 'header rule' },
        { path: 'src/App.jsx', startLine: 3, endLine: 4, wholeFile: false, why: 'state' },
        { path: 'src/big.css', startLine: 100, endLine: 101, wholeFile: false, why: 'nav rule' },
      ],
    });
    expect(
      result.excerptText.startsWith('Overview: A React app.\n\n=== src/big.css lines 40–44')
    ).toBe(true);

    const legacy = LegacySummarySchema.parse(JSON.parse(result.findings));
    expect(legacy.relevant_files).toEqual([
      {
        path: 'src/big.css',
        summary: 'header rule; nav rule',
        code_snippet:
          ' 40| line 40\n 41| line 41\n 42| line 42\n 43| line 43\n 44| line 44\n…\n100| line 100\n101| line 101',
        concepts: [],
      },
      {
        path: 'src/App.jsx',
        summary: 'state',
        code_snippet: ' 3| line 3\n 4| line 4',
        concepts: [],
      },
    ]);
    expect(legacy.project_structure).toEqual({
      entry_points: ['src/App.jsx', 'index.html'],
      key_directories: ['src'],
      config_files: [],
    });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('keeps the overview and project_structure to the initial call', () => {
    const result = buildExploreResult({
      response: {
        overview: 'ignored',
        pointers: [pointer({ path: 'index.html', wholeFile: true })],
      },
      files,
      filePaths,
      focusArea: 'the header CSS rule',
      fileCount: 12,
    });
    expect(result.overview).toBeNull();
    expect(result.excerptText.startsWith('=== index.html (whole file, 10 lines) ===')).toBe(true);
    const legacy = LegacySummarySchema.parse(JSON.parse(result.findings));
    expect(legacy.project_structure).toBeUndefined();
    expect(legacy.focus_area).toBe('the header CSS rule');
  });

  it('caps the legacy relevant_files at 5 so the old schema still parses', () => {
    const six = Array.from({ length: 6 }, (_, i) => fileOf(`f${i}.js`, 5));
    const result = buildExploreResult({
      response: {
        overview: null,
        pointers: six.map(f => pointer({ path: f.path, wholeFile: true })),
      },
      files: six,
      filePaths: six.map(f => f.path),
      focusArea: 'api',
      fileCount: 6,
    });
    expect(result.excerpts).toHaveLength(6);
    expect(LegacySummarySchema.parse(JSON.parse(result.findings)).relevant_files).toHaveLength(5);
  });

  it('falls back to whole small files, then the top of large ones, on an unusable answer', () => {
    const result = buildExploreResult({
      response: null,
      files,
      filePaths,
      focusArea: 'api',
      fileCount: 12,
    });
    expect(result.excerpts.map(e => [e.path, e.startLine, e.endLine, e.wholeFile])).toEqual([
      ['src/App.jsx', 1, 40, true],
      ['index.html', 1, 10, true],
      ['src/big.css', 1, WHOLE_FILE_MAX_LINES, false],
    ]);
    expect(result.excerptText).toContain('=== src/App.jsx (whole file, 40 lines) ===\n 1| line 1');
    expect(result.excerptText).toContain(
      `[… cut at line ${WHOLE_FILE_MAX_LINES} for length; this excerpt runs to line 900.]`
    );
    expect(String(mocks.warn.mock.calls[0][0])).toContain('answer missing or not parseable');
    LegacySummarySchema.parse(JSON.parse(result.findings));
  });

  it('falls back too when the answer parses but points at nothing usable', () => {
    const result = buildExploreResult({
      response: { overview: null, pointers: [pointer({ path: 'nope.js', wholeFile: true })] },
      files,
      filePaths,
      focusArea: 'api',
      fileCount: 12,
    });
    // The published excerpts carry only the five contract fields.
    expect(result.excerpts).toEqual(
      fallbackExcerpts(files).map(({ path, startLine, endLine, wholeFile, why }) => ({
        path,
        startLine,
        endLine,
        wholeFile,
        why,
      }))
    );
    expect(String(mocks.warn.mock.calls[0][0])).toContain('none of 1 excerpts pointed at lines');
  });

  it('falls back, and says the answer was empty, when the model names no excerpts', () => {
    const result = buildExploreResult({
      response: { overview: null, pointers: [] },
      files,
      filePaths,
      focusArea: 'testing',
      fileCount: 12,
    });
    expect(result.excerpts.map(e => e.path)).toEqual(['src/App.jsx', 'index.html', 'src/big.css']);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(String(mocks.warn.mock.calls[0][0])).toBe(
      'Excerpt selector: the answer named no excerpts; falling back to whole files'
    );
  });

  it('falls back on what made it into the text, not on what resolved', () => {
    // Only reachable with an overview far past the 800 characters the parser
    // keeps, but it pins the rule: an excerpt resolved and then left out of
    // the text must not leave the quiz agent with no code.
    const wide = fileOf('src/wide.js', 400, 110);
    const tiny = fileOf('tiny.js', 3);
    const result = buildExploreResult({
      response: {
        overview: 'o'.repeat(EXCERPT_OUTPUT_MAX_CHARS - 600),
        pointers: [pointer({ path: 'src/wide.js', startLine: 1, endLine: 100, why: 'wide' })],
      },
      files: [wide, tiny],
      filePaths: ['src/wide.js', 'tiny.js'],
      focusArea: 'initial',
      fileCount: 2,
    });
    expect(result.excerpts.map(e => e.path)).toEqual(['tiny.js']);
    expect(result.excerptText).toContain('=== tiny.js (whole file, 3 lines) ===');
    expect(String(mocks.warn.mock.calls[0][0])).toContain('none of 1 excerpts pointed at lines');
  });

  it('returns empty text, and a parseable empty summary, when nothing could be read', () => {
    const result = buildExploreResult({
      response: null,
      files: [{ path: 'gone.js', content: '', error: '404' }],
      filePaths: ['gone.js'],
      focusArea: 'api',
      fileCount: 3,
    });
    expect(result.excerptText).toBe('');
    expect(result.excerpts).toEqual([]);
    expect(LegacySummarySchema.parse(JSON.parse(result.findings)).relevant_files).toEqual([]);
  });
});

describe('explore-repo task run', () => {
  const REPO_FILES: Record<string, string> = {
    'src/App.jsx':
      'import React from "react";\nexport default function App() {\n  return <h1>Hi</h1>;\n}\n',
    'style.css': '.header {\n  display: flex;\n}\n',
  };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('/git/trees/')
          ? {
              tree: Object.keys(REPO_FILES).map(path => ({ path, type: 'blob', size: 100 })),
            }
          : {
              encoding: 'base64',
              content: Buffer.from(
                REPO_FILES[decodeURIComponent(url.split('/contents/')[1])]
              ).toString('base64'),
            };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
    const text = (t: string) => ({
      content: [{ type: 'text', text: t }],
      stop_reason: 'end_turn',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    mocks.create
      .mockResolvedValueOnce(text('["style.css", "src/App.jsx"]'))
      .mockResolvedValueOnce(
        text(
          '{"excerpts": [{"path": "style.css", "start_line": 1, "end_line": 3, "why": "header flex"}]}'
        )
      );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const run = () =>
    (
      exploreRepoTask as unknown as {
        run: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }
    ).run({
      owner: 'org',
      repo: 'repo',
      accessToken: 'ghs_x',
      focusArea: 'the header CSS rule',
    });

  it('publishes the result to metadata, flushes, and returns the same object', async () => {
    const result = await run();

    expect(result.format).toBe('excerpts-v1');
    expect(result.excerptText).toBe(
      '=== style.css (whole file, 3 lines) — header flex ===\n1| .header {\n2|   display: flex;\n3| }'
    );
    const published = mocks.set.mock.calls.find(call => call[0] === 'result');
    expect(published?.[1]).toBe(result);
    // The result is set, then flushed, before the task returns.
    expect(mocks.calls.slice(-2)).toEqual(['set:result', 'flush']);
  });

  it('never puts the focus area in a step the student sees', async () => {
    await run();

    const steps = [
      ...mocks.append.mock.calls.map(call => call[1]),
      ...mocks.set.mock.calls.filter(call => call[0] === 'steps').flatMap(call => call[1]),
    ];
    expect(steps.length).toBeGreaterThan(0);
    expect(JSON.stringify(steps)).not.toContain('header CSS');
  });
});
