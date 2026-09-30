/**
 * `code_quote` on present_question, for code-aware attempts: the model names
 * lines of one file by the numbers its exploration showed, and the server
 * fills the card's code with those exact lines.
 *
 * - The file is read with the same repository-scoped, read-only installation
 *   token exploration uses. Its lines are kept per process, by attempt and
 *   path, in `quoteFileCache`: exploration puts every file it reads there, so
 *   a quote is checked against the very lines the model was shown; a file
 *   that is not there yet is read on first use.
 * - A file the quiz excludes (`excludedPaths`) is refused before it is read
 *   or looked up in the cache (`QUOTE_EXCLUDED_TEXT`).
 * - The quote is checked before anything is written: the path exists, every
 *   range is inside the file, ascending and apart from the others, and the
 *   anchor matches the first quoted line once whitespace is trimmed and
 *   collapsed. A failed check is a `QuoteRefusal`, whose message tells the
 *   model what to fix.
 * - The code is the exact lines, with one "..." line for each gap between
 *   ranges and for each run of omitted lines. An `edit` replaces one quoted
 *   line and marks the quote as changed.
 * - A quote that starts inside a CSS rule or HTML element gets a "..." line
 *   above it, and one that stops inside one, with more than its closing brace
 *   or tag still to come, gets a "..." line below it (`quoteCuts`).
 *
 * Free-typed `code_snippet` stays accepted: the quote is the instructed path,
 * not an enforced one.
 */
import { MAX_QUOTE_LINES, type CodeQuote, type QuoteSource } from '@classmoji/utils/quiz-agent';
import { fetchFileContent, isVisiblePath, splitLines } from '../../../workflows/exploreRepo.ts';
import { providerStatus, untilAborted } from '../../shared/exploration/core.ts';
import { pathExclusion } from '../../shared/exploration/excludedPaths.ts';
import type { GitOrgLike } from '../context.ts';

/** The line that stands for lines left out of a quote. */
export const QUOTE_GAP = '...';

/** The most characters a quote's code may run to. */
export const MAX_QUOTE_CHARS = 8_000;

/** Why a quote was refused: a code for the log line, never the file's content. */
export type QuoteRefusalReason =
  | 'not_quotable'
  | 'excluded'
  | 'missing_file'
  | 'empty_file'
  | 'bad_range'
  | 'out_of_range'
  | 'bad_omit'
  | 'too_long'
  | 'anchor_mismatch'
  | 'bad_edit';

/** A quote that cannot be built. The message is for the model, to fix the call. */
export class QuoteRefusal extends Error {
  readonly reason: QuoteRefusalReason;
  constructor(reason: QuoteRefusalReason, message: string) {
    super(message);
    this.name = 'QuoteRefusal';
    this.reason = reason;
  }
}

/** What a quote puts on the card. */
export type BuiltQuote = {
  code: string;
  source: QuoteSource;
  /** Lines shown, "..." lines not counted. */
  shownLines: number;
};

const CHECK_NUMBERS = 'Check the line numbers from your exploration.';

/** What the model is told when it quotes a file the quiz excludes. */
export const QUOTE_EXCLUDED_TEXT = 'That file is excluded from this quiz; quote from another file.';

/** Trimmed, with every run of whitespace as one space. */
export const normalizeLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A line as the model is shown it in an error: normalized, and short. */
function shown(text: string): string {
  const line = normalizeLine(text);
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

/** The cut marker exploration puts on a line longer than it shows. */
const CUT_MARKER = /\s*\[(?:…|\.\.\.) line cut: \d+ more characters\]\s*$/;

/**
 * Whether the anchor names line `n`, whose text is `actual`. Two slips are
 * forgiven: the "N| " prefix exploration shows (when N is that line), and a
 * line exploration cut for length, matched by the part that was shown.
 */
export function anchorMatches(anchor: string, actual: string, n: number): boolean {
  let text = anchor.replace(new RegExp(`^\\s*${n}\\|\\s?`), '');
  const cut = CUT_MARKER.test(text);
  if (cut) text = text.replace(CUT_MARKER, '');
  const want = normalizeLine(text);
  const have = normalizeLine(actual);
  if (want === '') return false;
  return cut ? have.startsWith(want) : have === want;
}

/** "5-10", "7", or "5-10, 20-24". */
export function formatLineRanges(ranges: ReadonlyArray<readonly [number, number]>): string {
  return ranges.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/** A path as the repository names it: no leading "./" or "/". */
export function normalizeQuotePath(path: string): string {
  return path.trim().replace(/^(\.\/|\/)+/, '');
}

const LANGUAGES: Record<string, string> = {
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  py: 'python',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin',
  sh: 'bash',
  sql: 'sql',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
};

/** A highlighting language for the file, from its extension; undefined when unknown. */
export function languageForPath(path: string): string | undefined {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? LANGUAGES[match[1].toLowerCase()] : undefined;
}

// ─── Where a quote cuts into a rule or element ──────────────────────────────

const BRACE_LANGUAGES = new Set(['css', 'scss', 'less']);
/** Languages with `//` line comments among the brace ones. */
const LINE_COMMENT_LANGUAGES = new Set(['scss', 'less']);

/**
 * The brace depth before each line: entry `n - 1` for line `n`, plus one
 * entry for the depth after the last line. Braces in comments and strings do
 * not count. Null when the braces do not balance (a closing brace with none
 * open, or a block left open at the end): nothing is marked then.
 */
export function braceDepths(
  lines: readonly string[],
  { lineComments = false }: { lineComments?: boolean } = {}
): number[] | null {
  const depths: number[] = [];
  let depth = 0;
  let inComment = false;
  for (const line of lines) {
    depths.push(depth);
    let quote: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      const next = line[i + 1];
      if (inComment) {
        if (ch === '*' && next === '/') {
          inComment = false;
          i++;
        }
      } else if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
      } else if (ch === '/' && next === '*') {
        inComment = true;
        i++;
      } else if (lineComments && ch === '/' && next === '/') {
        break;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth < 0) return null;
      }
    }
  }
  depths.push(depth);
  return depth === 0 && !inComment ? depths : null;
}

/** The index (0-based) of the first non-blank line from `from`, going by `step`, or null. */
function nonBlankFrom(lines: readonly string[], from: number, step: 1 | -1): number | null {
  for (let i = from; i >= 0 && i < lines.length; i += step) {
    if (lines[i].trim() !== '') return i;
  }
  return null;
}

const leadingSpace = (line: string): string => /^[ \t]*/.exec(line)?.[0] ?? '';

/**
 * Whether a quote cuts into a rule or element at its edges: `before` when its
 * first line is inside one, `after` when its last line is inside one and more
 * than the closing brace or tag follows. Gaps between ranges already show
 * "...", so only the first range's start and the last range's end count.
 *
 * Kept simple and conservative, by the file's extension:
 * - CSS, SCSS, Less: by brace depth. It starts inside a rule when the depth
 *   before its first line is above zero; it stops inside one when the depth
 *   after its last line is above zero and the next non-blank line does not
 *   start with the closing brace.
 * - HTML: by indentation, against the least indented line the quote shows.
 *   It starts inside an element when the non-blank line before it is indented
 *   deeper than that, and stops inside one when the non-blank line after it
 *   is (a closing tag at the quote's own level is not deeper).
 * - Anything else, braces that do not balance, or indentation that mixes tabs
 *   and spaces: no cut is marked.
 */
export function quoteCuts(
  lines: readonly string[],
  ranges: ReadonlyArray<readonly [number, number]>,
  path: string,
  omit: ReadonlySet<number> = new Set()
): { before: boolean; after: boolean } {
  const none = { before: false, after: false };
  if (ranges.length === 0) return none;
  const first = ranges[0][0];
  const last = ranges[ranges.length - 1][1];
  const language = languageForPath(path) ?? '';

  if (BRACE_LANGUAGES.has(language)) {
    const depths = braceDepths(lines, { lineComments: LINE_COMMENT_LANGUAGES.has(language) });
    if (!depths) return none;
    let after = false;
    if (depths[last] > 0) {
      const next = nonBlankFrom(lines, last, 1);
      after = next !== null && !lines[next].trim().startsWith('}');
    }
    return { before: depths[first - 1] > 0, after };
  }

  if (language === 'html') {
    const shown: string[] = [];
    for (const [a, b] of ranges) {
      for (let n = a; n <= b; n++) {
        if (!omit.has(n) && lines[n - 1].trim() !== '') shown.push(lines[n - 1]);
      }
    }
    const prev = nonBlankFrom(lines, first - 2, -1);
    const next = nonBlankFrom(lines, last, 1);
    const considered = [
      ...shown,
      prev === null ? '' : lines[prev],
      next === null ? '' : lines[next],
    ];
    const indents = considered.map(leadingSpace);
    const tabs = indents.some(i => i.includes('\t'));
    const spaces = indents.some(i => i.includes(' '));
    if ((tabs && spaces) || shown.length === 0) return none;
    const level = Math.min(...shown.map(line => leadingSpace(line).length));
    return {
      before: prev !== null && leadingSpace(lines[prev]).length > level,
      after: next !== null && leadingSpace(lines[next]).length > level,
    };
  }

  return none;
}

/**
 * Build the card's code from the file's lines. Pure: throws `QuoteRefusal`
 * with a message for the model when the quote does not fit the file.
 */
export function buildQuote(lines: readonly string[], quote: CodeQuote): BuiltQuote {
  const path = normalizeQuotePath(quote.path);
  const total = lines.length;
  if (total === 0) {
    throw new QuoteRefusal('empty_file', `${path} is empty or is not a file.`);
  }

  // Ranges: each inside the file, ascending, apart. Touching ranges join.
  const ranges: Array<[number, number]> = [];
  for (const [a, b] of quote.ranges.map(r => [r[0], r[1]] as const)) {
    if (a > b) {
      throw new QuoteRefusal(
        'bad_range',
        `Range ${a}-${b} starts after it ends. Give each range as [first line, last line].`
      );
    }
    if (b > total) {
      throw new QuoteRefusal(
        'out_of_range',
        `${path} has ${total} line${total === 1 ? '' : 's'}; range ${a}-${b} runs past the end. ${CHECK_NUMBERS}`
      );
    }
    const prev = ranges.at(-1);
    if (prev && a <= prev[1]) {
      throw new QuoteRefusal(
        'bad_range',
        `Range ${a}-${b} overlaps or comes before range ${prev[0]}-${prev[1]}. List ranges in ascending order, without overlap.`
      );
    }
    if (prev && a === prev[1] + 1) prev[1] = b;
    else ranges.push([a, b]);
  }

  // Omitted lines: inside a range, never its first or last line.
  const omit = new Set(quote.omit ?? []);
  for (const n of omit) {
    const range = ranges.find(([a, b]) => n >= a && n <= b);
    if (!range) {
      throw new QuoteRefusal('bad_omit', `Line ${n} in omit is not inside a quoted range.`);
    }
    if (n === range[0] || n === range[1]) {
      throw new QuoteRefusal(
        'bad_omit',
        `omit cannot leave out line ${n}, the first or last line of range ${range[0]}-${range[1]}. Narrow the range instead.`
      );
    }
  }

  const shownLines = ranges.reduce((sum, [a, b]) => sum + b - a + 1, 0) - omit.size;
  if (shownLines > MAX_QUOTE_LINES) {
    throw new QuoteRefusal(
      'too_long',
      `The quote shows ${shownLines} lines; show at most ${MAX_QUOTE_LINES}. Narrow the ranges or leave lines out with omit.`
    );
  }

  // The anchor: the first quoted line, as the model believes it reads.
  const first = ranges[0][0];
  const firstText = lines[first - 1];
  if (normalizeLine(firstText) === '') {
    throw new QuoteRefusal(
      'anchor_mismatch',
      `Line ${first} of ${path} is blank. Start the range on a line with code. ${CHECK_NUMBERS}`
    );
  }
  if (!anchorMatches(quote.anchor, firstText, first)) {
    throw new QuoteRefusal(
      'anchor_mismatch',
      `Line ${first} of ${path} is \`${shown(firstText)}\`, not \`${shown(quote.anchor)}\`. ${CHECK_NUMBERS}`
    );
  }

  // The one deliberate change, if any.
  let edited: { line: number; text: string } | null = null;
  if (quote.edit) {
    const { line, replace } = quote.edit;
    const inRange = ranges.some(([a, b]) => line >= a && line <= b);
    if (!inRange || omit.has(line)) {
      throw new QuoteRefusal('bad_edit', `edit.line ${line} is not one of the quoted lines.`);
    }
    if (/[\r\n]/.test(replace)) {
      throw new QuoteRefusal('bad_edit', 'edit.replace must be a single line.');
    }
    const original = lines[line - 1];
    if (normalizeLine(replace) === normalizeLine(original)) {
      throw new QuoteRefusal(
        'bad_edit',
        `edit.replace is the same as line ${line}. Change the line, or leave edit out.`
      );
    }
    // A replacement typed without indentation keeps the line's own.
    const indent = /^\s*/.exec(original)?.[0] ?? '';
    const text = /^\s/.test(replace) || replace === '' ? replace : `${indent}${replace}`;
    edited = { line, text };
  }

  const cuts = quoteCuts(lines, ranges, path, omit);
  const out: string[] = [];
  let gapOpen = false;
  const gap = () => {
    if (!gapOpen) out.push(QUOTE_GAP);
    gapOpen = true;
  };
  if (cuts.before) gap();
  ranges.forEach(([a, b], i) => {
    if (i > 0) gap();
    for (let n = a; n <= b; n++) {
      if (omit.has(n)) {
        gap();
        continue;
      }
      out.push(edited && edited.line === n ? edited.text : lines[n - 1]);
      gapOpen = false;
    }
  });
  if (cuts.after) gap();
  const code = out.join('\n');
  if (code.length > MAX_QUOTE_CHARS) {
    throw new QuoteRefusal(
      'too_long',
      `The quoted lines run to ${code.length} characters; show at most ${MAX_QUOTE_CHARS}. Quote fewer lines.`
    );
  }

  return {
    code,
    source: { path, lines: formatLineRanges(ranges), changed: edited !== null },
    shownLines,
  };
}

// ─── The file cache ─────────────────────────────────────────────────────────

/** Files kept per process; the least recently used goes first. */
const MAX_CACHED_FILES = 100;
/** A file longer than this is read again each time instead of kept. */
const MAX_CACHED_FILE_CHARS = 200_000;

/**
 * File lines by attempt, repository and path, for the life of this process.
 * Exploration fills it with each file it reads; a quote reads through it.
 */
export class QuoteFileCache {
  private readonly files = new Map<string, string[]>();
  constructor(
    private readonly maxFiles: number = MAX_CACHED_FILES,
    private readonly maxFileChars: number = MAX_CACHED_FILE_CHARS
  ) {}

  static key(attemptId: string, owner: string, repo: string, path: string): string {
    return `${attemptId}\u0000${owner}/${repo}\u0000${normalizeQuotePath(path)}`;
  }

  get(key: string): string[] | undefined {
    const lines = this.files.get(key);
    if (lines) {
      this.files.delete(key);
      this.files.set(key, lines);
    }
    return lines;
  }

  /** Keep the file's content as lines (or drop a stale copy when it is too long to keep). */
  set(key: string, content: string): string[] {
    const lines = splitLines(content);
    this.files.delete(key);
    if (content.length > this.maxFileChars) return lines;
    this.files.set(key, lines);
    while (this.files.size > this.maxFiles) {
      const oldest = this.files.keys().next().value;
      if (oldest === undefined) break;
      this.files.delete(oldest);
    }
    return lines;
  }

  get size(): number {
    return this.files.size;
  }

  clear(): void {
    this.files.clear();
  }
}

/** The process's cache, shared by every turn and attempt it runs. */
export const quoteFileCache = new QuoteFileCache();

// ─── Resolving a quote ──────────────────────────────────────────────────────

export type QuoteRepo = {
  attemptId: string;
  owner: string;
  repo: string;
  gitOrganization: GitOrgLike;
  /** The quiz's excluded paths: a matching file is refused before anything is read. */
  excludedPaths?: readonly string[];
};

export type QuoteDeps = {
  mintRepoToken: (gitOrganization: GitOrgLike, repo: string) => Promise<string>;
  /** Reads one file's text; defaults to the Contents API read exploration uses. */
  readFile?: (owner: string, repo: string, path: string, token: string) => Promise<string>;
  cache?: QuoteFileCache;
};

/**
 * The quote, built from the file's lines: from the cache, or read from the
 * repository (and kept) when the cache does not have them. Throws
 * `QuoteRefusal` for a quote the model can fix, `ExplorationStoppedError`
 * when the signal aborts, and the token or read error otherwise.
 */
export async function resolveCodeQuote(
  quote: CodeQuote,
  where: QuoteRepo,
  deps: QuoteDeps,
  signal: AbortSignal
): Promise<BuiltQuote & { cached: boolean }> {
  const path = normalizeQuotePath(quote.path);
  if (!path || !isVisiblePath(path)) {
    throw new QuoteRefusal(
      'not_quotable',
      `${path || 'That path'} cannot be quoted. Use a path exactly as your exploration results name it.`
    );
  }
  // Before the cache: a copy kept before the setting changed is not quoted either.
  if (pathExclusion(where.excludedPaths)(path)) {
    throw new QuoteRefusal('excluded', QUOTE_EXCLUDED_TEXT);
  }
  const cache = deps.cache ?? quoteFileCache;
  const key = QuoteFileCache.key(where.attemptId, where.owner, where.repo, path);
  let lines = cache.get(key);
  const cached = lines !== undefined;
  if (!lines) {
    const token = await untilAborted(deps.mintRepoToken(where.gitOrganization, where.repo), signal);
    const read = deps.readFile ?? fetchFileContent;
    let content: string;
    try {
      content = await untilAborted(read(where.owner, where.repo, path, token), signal);
    } catch (error) {
      if (providerStatus(error) === 404) {
        throw new QuoteRefusal(
          'missing_file',
          `${path} is not in the student's repository. Use a path exactly as your exploration results name it.`
        );
      }
      throw error;
    }
    lines = cache.set(key, content);
  }
  return { ...buildQuote(lines, { ...quote, path }), cached };
}
