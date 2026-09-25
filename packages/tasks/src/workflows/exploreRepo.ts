// eslint-disable-next-line import/no-unresolved -- trigger.dev v3 resolved at runtime
import { task, logger, metadata } from '@trigger.dev/sdk/v3';
import Anthropic from '@anthropic-ai/sdk';

console.log('[explore-repo] Repository loaded (v3: excerpts, result in metadata)');

/**
 * GitHub API helpers
 * These use the GitHub REST API to read repo contents without cloning.
 */

const GITHUB_API = 'https://api.github.com';

/**
 * Fetch with retry and exponential backoff for GitHub API rate limits.
 * Handles both primary (403) and secondary (429) rate limits.
 *
 * @param {string} url - Full GitHub API URL
 * @param {Object} headers - Request headers
 * @param {string} label - Human-readable label for logging
 * @param {number} maxRetries - Max retry attempts (default 3)
 * @returns {Promise<Response>} Successful fetch response
 */
async function githubFetch(
  url: string,
  headers: Record<string, string>,
  label: string,
  maxRetries: number = 3
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers });

    if (res.ok) return res;

    // Retry on rate limit (429) or abuse detection (403 with rate limit headers)
    const isRateLimit = res.status === 429;
    const isAbuse = res.status === 403 && res.headers.get('retry-after');

    if ((isRateLimit || isAbuse) && attempt < maxRetries) {
      // Use Retry-After header if present, otherwise exponential backoff
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000);
      console.log(
        `[explore-repo] ${label}: ${res.status} rate limited, retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${maxRetries})`
      );
      logger.warn(
        `${label}: rate limited (${res.status}), waiting ${Math.round(waitMs)}ms before retry ${attempt + 1}`
      );
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }

    // Non-retryable error or out of retries
    const body = await res.text();
    throw new Error(`${label} failed (${res.status}): ${body}`);
  }
  throw new Error(`${label} failed: max retries (${maxRetries}) exceeded`);
}

const GITHUB_HEADERS = (token: string): Record<string, string> => ({
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'classmoji-explore',
});

/**
 * Fetch the full gitRepo file tree via the Git Trees API.
 * Returns a flat list of all files with paths, sizes, and types.
 *
 * @param {string} owner - GitHub org/user
 * @param {string} repo - GitRepo name
 * @param {string} token - GitHub installation access token
 * @returns {Promise<Array<{path: string, size: number, type: string}>>}
 */
async function fetchRepoTree(
  owner: string,
  repo: string,
  token: string
): Promise<Array<{ path: string; size: number; type: string }>> {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
  const res = await githubFetch(url, GITHUB_HEADERS(token), `GitHub tree API (${owner}/${repo})`);

  const data = await res.json();
  // Filter to blobs (files) only, exclude tree entries (directories)
  return (data.tree || [])
    .filter((entry: { type: string; path: string; size?: number }) => entry.type === 'blob')
    .map((entry: { type: string; path: string; size?: number }) => ({
      path: entry.path,
      size: entry.size || 0,
      type: entry.type,
    }));
}

/**
 * Fetch a single file's content via the GitHub Contents API.
 * Returns decoded UTF-8 text content.
 *
 * @param {string} owner - GitHub org/user
 * @param {string} repo - GitRepo name
 * @param {string} path - File path within the repo
 * @param {string} token - GitHub installation access token
 * @returns {Promise<string>} File content as text
 */
async function fetchFileContent(
  owner: string,
  repo: string,
  path: string,
  token: string
): Promise<string> {
  const encodedPath = path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;
  const res = await githubFetch(url, GITHUB_HEADERS(token), `GitHub contents (${path})`);

  const data = await res.json();

  if (data.encoding === 'base64' && data.content) {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }

  // Fallback: if content is provided directly (rare)
  return data.content || '';
}

/**
 * Fetch multiple files with a concurrency limit.
 * Uses concurrency of 3 (not 5) to stay under GitHub's abuse detection threshold.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string[]} paths - Array of file paths
 * @param {string} token
 * @param {number} concurrency - Max parallel requests (default 3)
 * @returns {Promise<Array<{path: string, content: string, error?: string}>>}
 */
async function fetchMultipleFiles(
  owner: string,
  repo: string,
  paths: string[],
  token: string,
  concurrency: number = 3
): Promise<Array<{ path: string; content: string; error?: string }>> {
  const results = [];
  // Process in batches for concurrency control
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async path => {
        const content = await fetchFileContent(owner, repo, path, token);
        return { path, content };
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        const failedPath = batch[batchResults.indexOf(result)];
        results.push({ path: failedPath, content: '', error: result.reason?.message });
      }
    }
  }
  return results;
}

/**
 * Build a compact tree listing for Claude to analyze.
 * Filters out common noise (node_modules, .git, etc.) and formats
 * as a simple path listing with file sizes.
 *
 * @param {Array} tree - Raw tree from fetchRepoTree
 * @returns {string} Formatted tree listing
 */
function formatTreeForLLM(tree: Array<{ path: string; size: number; type: string }>): string {
  // Filter out noise
  const ignorePatterns = [
    /^node_modules\//,
    /^\.git\//,
    /^\.next\//,
    /^dist\//,
    /^build\//,
    /^coverage\//,
    /^\.cache\//,
    /^vendor\//,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.min\.(js|css)$/,
    /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|mp4|webm)$/i,
  ];

  const filtered = tree.filter(entry => !ignorePatterns.some(pattern => pattern.test(entry.path)));

  // Cap at 500 files to keep context manageable
  const capped = filtered.slice(0, 500);

  const lines = capped.map(entry => {
    const sizeKB = (entry.size / 1024).toFixed(1);
    return `${entry.path} (${sizeKB}KB)`;
  });

  let result = lines.join('\n');
  if (filtered.length > 500) {
    result += `\n... and ${filtered.length - 500} more files`;
  }

  return result;
}

/**
 * Return the answer text from a Messages API response, or null if there is none.
 *
 * A model that thinks (Sonnet 5 and Opus 5.5 decide for themselves) puts a
 * `thinking` block first, so the answer is the first `text` block, not
 * `content[0]`. An answer cut short (max_tokens, refusal) or missing is logged,
 * so an exploration that found nothing shows up in the Trigger logs instead of
 * passing silently.
 *
 * @param {Anthropic.Message} response - Messages API response
 * @param {string} label - Which call this was, for the log line
 * @returns {string|null} Text of the first text block, or null
 */
function responseText(response: Anthropic.Message, label: string): string | null {
  // These calls use no tools or stop sequences, so anything but end_turn means
  // the answer was cut short.
  if (response.stop_reason !== 'end_turn') {
    logger.warn(
      `${label}: ${response.model} stopped with ${response.stop_reason} (${response.usage?.output_tokens} output tokens), answer may be incomplete`
    );
  }
  const textBlock = response.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  if (!textBlock) {
    const blockTypes = response.content.map(block => block.type).join(', ') || 'none';
    logger.warn(
      `${label}: ${response.model} returned no text block (blocks: ${blockTypes}, stop_reason: ${response.stop_reason})`
    );
    return null;
  }
  return textBlock.text;
}

/**
 * Use the exploration model to pick the most relevant files to read.
 *
 * @param {Anthropic} client - Anthropic SDK client
 * @param {string} model - Model ID
 * @param {string} treeListing - Formatted tree listing
 * @param {string} focusArea - What to explore
 * @param {string} depth - shallow/focused/deep
 * @param {string[]} previousFindings - Topics already covered
 * @param {string|null} specificQuestion - Specific student question
 * @returns {Promise<string[]>} Array of file paths to read
 */
export async function pickRelevantFiles(
  client: Anthropic,
  model: string,
  treeListing: string,
  focusArea: string,
  depth: string,
  previousFindings: string[],
  specificQuestion: string | null,
  previouslyReadFiles: string[] = []
): Promise<string[]> {
  const maxFiles = depth === 'shallow' ? 2 : depth === 'focused' ? 4 : 6;

  const previousContext =
    previousFindings.length > 0
      ? `\nPreviously explored topics (avoid these): ${previousFindings.join(', ')}`
      : '';

  const questionContext = specificQuestion ? `\nStudent asked: "${specificQuestion}"` : '';

  // Earlier reads are context, not a blocklist. The quiz agent often comes back
  // for a DIFFERENT part of a file it has already seen (another rule in
  // style.css, another handler in App.jsx), and steering the picker away from
  // those files handed it unrelated code instead.
  const previousFilesContext =
    previouslyReadFiles.length > 0
      ? `\nFiles read in earlier explorations: ${previouslyReadFiles.join(', ')}. Pick one of these again if the focus area needs code in it; otherwise prefer files not read yet.`
      : '';

  // No `thinking` param: owners can pick any model here, and no single value
  // works for all of them (Opus 5.5 rejects `disabled`; it and Sonnet 5 think
  // adaptively when the param is omitted). Thinking tokens count against
  // max_tokens, so it is a roomy ceiling, not the expected spend.
  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are a code exploration assistant. Given a gitRepo file tree and a focus area, pick the ${maxFiles} most relevant files to read.

FOCUS AREA: ${focusArea === 'initial' ? 'Get an overview of the project: framework, structure, main components, key patterns' : focusArea}
${previousContext}${previousFilesContext}${questionContext}

FILE TREE:
${treeListing}

RULES:
- Pick at most ${maxFiles} files
- Prioritize source code over config files (unless focus is on config)
- For "initial" focus: pick the main entry point + 3-5 key source files
- For specific topics: pick files most related to that topic
- Prefer smaller files that are more focused
- Skip test files unless the focus is testing
- Skip lock files, build artifacts, and binary files

Respond with ONLY a JSON array of file paths, nothing else. Example:
["src/App.jsx", "src/utils.js", "src/hooks/useAuth.js"]`,
      },
    ],
  });

  const text = responseText(response, 'File picker') ?? '[]';
  let picked: unknown;
  try {
    // Extract JSON array from response (may include markdown)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    picked = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    logger.warn('Failed to parse file picker response, falling back to defaults');
    return ['package.json'];
  }

  // Paths only, each once, and no more than asked for: anything else in the
  // array would crash the legacy summary (`p.split`) on the initial call, and a
  // repeat would be fetched and shown to the excerpt model twice. "./" goes for
  // the same reason parseExcerptResponse drops it: the tree has "src/App.jsx".
  const paths = (Array.isArray(picked) ? picked : [])
    .filter((p): p is string => typeof p === 'string')
    .map(p => p.trim().replace(/^\.?\/+/, ''))
    .filter(Boolean);
  return [...new Set(paths)].slice(0, maxFiles);
}

/**
 * Excerpt selection: the exploration model POINTS at code, the task copies it.
 *
 * The synthesis call this replaced asked the model to write a JSON summary with
 * code snippets in it. That was ~3,000 output tokens (~25 s on Sonnet 5) of the
 * ~36 s an exploration took, and the snippets it wrote were paraphrased and cut
 * with "...", so the quiz agent came back asking for the exact text. Now the
 * model returns only path + line range pointers (a few hundred tokens) and the
 * task slices the real lines, numbered, so what the quiz agent quotes is what
 * the student wrote.
 *
 * Input is cheap and output is slow, so the caps below are generous on the way
 * in and tight on the way out.
 */

type RepoFile = { path: string; content: string; error?: string };

/**
 * Most characters of one file's numbered text shown to the model. A pointer can
 * only reach lines the model saw, so this is set to cover a whole file in the
 * common case: ~24k chars is ~600 lines of typical student code, ~6k tokens.
 * The old synthesis cap (8,000) cut style.css files off before the rules the
 * quiz agent was asking about.
 */
export const EXCERPT_INPUT_FILE_CHARS = 24_000;

/**
 * Most characters of numbered text across all files (~18-20k tokens). Prefill
 * of that is ~1-2 s, against ~25 s the old output cost. "deep" picks up to 6
 * files, and 6 x 24k would be 144k, so this total is what actually binds there;
 * see allocateInputBudget for how it is shared.
 */
export const EXCERPT_INPUT_TOTAL_CHARS = 72_000;

/** Most excerpts taken from the model's answer, in its order. */
export const MAX_EXCERPTS = 6;

/**
 * Largest file `whole_file` returns whole. Past this, `whole_file` means the
 * first WHOLE_FILE_MAX_LINES lines (fewer if EXCERPT_MAX_CHARS binds first)
 * with a note saying where the file ends, rather than nothing: the model asked
 * for the file because it matters, and the top of a file (imports, the first
 * rules, the component signature) is the part most often wanted.
 */
export const WHOLE_FILE_MAX_LINES = 300;

/**
 * Most characters of numbered text in any one excerpt: a whole_file, a range,
 * ranges merged together, or a fallback block. Line counts alone would let one
 * excerpt take the whole output cap (a live probe hit reveal.js: 8 lines, 181k
 * chars; a 250-line file of long JSX lines is ~30k). Half the output cap, so
 * the first excerpt always fits and leaves room for at least one more. An
 * excerpt over it stops at the last line that fits, with a note saying where it
 * would have run to. A file is "small" (handed over whole) only when all of it
 * fits here unaltered.
 */
export const EXCERPT_MAX_CHARS = 15_000;

/**
 * Longest line shown as is, to the excerpt model and the quiz agent alike.
 * Past it the line is cut with a visible marker, so one minified line cannot
 * eat a file's input budget or an excerpt's output budget on its own.
 */
export const MAX_LINE_CHARS = 2_000;

/**
 * Most characters of assembled excerpt text handed to the quiz agent (~7-8k
 * tokens). Excerpts are taken in the model's relevance order, so what is cut is
 * the least relevant: one that crosses the cap is cut at a line boundary with a
 * visible note when enough of it fits, and skipped (and named as omitted)
 * otherwise, and the ones after it still go in if they fit.
 */
export const EXCERPT_OUTPUT_MAX_CHARS = 30_000;

/**
 * The OLD ai-agent's ExplorationSummarySchema allows at most 5 relevant_files
 * (`.max(5)`). One more and its Zod parse fails and the whole exploration comes
 * back empty, so the legacy `findings` stops at 5 files.
 */
const LEGACY_MAX_RELEVANT_FILES = 5;

/**
 * Largest serialized result published to run metadata. Trigger.dev caps the
 * WHOLE metadata object (steps + currentStep + result) at 256 KB, rejects an
 * update over it server side, and the SDK's flush() only logs that rejection.
 * A result near the cap is skipped (the ai-agent then waits for the run output,
 * which carries the same object) instead of being lost. Normal results are
 * ~65-70 KB at most: ~30 KB of excerptText plus the same code again inside the
 * JSON-escaped `findings` string.
 */
const METADATA_RESULT_MAX_BYTES = 200_000;

/** A pointer as the model gave it, after type coercion but before validation. */
export type ExcerptPointer = {
  path: string;
  startLine: number | null;
  endLine: number | null;
  wholeFile: boolean;
  why: string;
};

/** A validated excerpt: lines are 1-based, inclusive, and inside the file. */
export type Excerpt = {
  path: string;
  startLine: number;
  endLine: number;
  wholeFile: boolean;
  why: string;
};

/**
 * An excerpt on its way to assembly. `uncutEndLine` is set only when the
 * excerpt was cut for length (EXCERPT_MAX_CHARS or WHOLE_FILE_MAX_LINES): the
 * line it would have run to, for the note under it. It never reaches the
 * published result, which has no optional fields (see ExploreResult).
 */
export type ResolvedExcerpt = Excerpt & { uncutEndLine?: number };

/** The model's answer, parsed. `overview` is kept only on the initial call. */
export type ExcerptResponse = {
  overview: string | null;
  pointers: ExcerptPointer[];
};

/**
 * What the task returns AND publishes to run metadata. A type alias, not an
 * interface, so it is assignable to the SDK's DeserializedJson (which is why
 * `overview` is `null`, never `undefined`).
 *
 * `findings` is the pre-excerpt contract, kept for deploy skew: an ai-agent that
 * predates `format` parses it with ExplorationSummarySchema and keeps working.
 */
export type ExploreResult = {
  format: 'excerpts-v1';
  excerptText: string;
  excerpts: Excerpt[];
  overview: string | null;
  findings: string;
  filesRead: string[];
  focusArea: string;
  fileCount: number;
};

/**
 * Split file content into lines. A trailing newline does not make an extra
 * empty last line, so line counts match what an editor shows.
 */
export function splitLines(content: string): string[] {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** A line as shown: whole up to MAX_LINE_CHARS, cut with a marker past it. */
function displayLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  // Do not split a surrogate pair (an emoji, say) in half.
  const code = line.charCodeAt(MAX_LINE_CHARS - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? MAX_LINE_CHARS - 1 : MAX_LINE_CHARS;
  return `${line.slice(0, cut)} [… line cut: ${line.length - cut} more characters]`;
}

/**
 * Lines `start`..`end` (1-based, inclusive) prefixed with their line numbers,
 * right-aligned to the width of the file's last line number: `  40| .header {`.
 * The same format goes to the excerpt model and to the quiz agent, so a line
 * number either of them reads is the line number in the student's file.
 */
export function numberLines(lines: string[], start: number, end: number): string {
  const width = String(lines.length).length;
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    out.push(`${String(n).padStart(width)}| ${displayLine(lines[n - 1])}`);
  }
  return out.join('\n');
}

/**
 * How far from `start` (up to `end`) the numbered lines can run and stay within
 * `budget` characters, measured as numberLines would print them. Returns the
 * last line that fits, or `start - 1` when not even the first one does.
 */
function lastLineThatFits(lines: string[], start: number, end: number, budget: number): number {
  const width = String(lines.length).length;
  let size = -1; // No newline before the first line.
  let last = start - 1;
  while (last < end) {
    const next = size + 1 + width + 2 + displayLine(lines[last]).length;
    if (next > budget) break;
    size = next;
    last++;
  }
  return last;
}

/**
 * Files that were fetched and have something in them, with their lines and
 * whether they are small enough to hand over whole: at most
 * WHOLE_FILE_MAX_LINES lines, no line cut, and all of it within one excerpt.
 */
function readableFiles(
  files: RepoFile[]
): Array<{ path: string; lines: string[]; small: boolean }> {
  return files
    .filter(f => !f.error)
    .map(f => {
      const lines = splitLines(f.content);
      const small =
        lines.length <= WHOLE_FILE_MAX_LINES &&
        lines.every(line => line.length <= MAX_LINE_CHARS) &&
        lastLineThatFits(lines, 1, lines.length, EXCERPT_MAX_CHARS) === lines.length;
      return { path: f.path, lines, small };
    })
    .filter(f => f.lines.length > 0);
}

/**
 * Share the total input budget across files: small files get all they need, and
 * whatever is left is split evenly among the larger ones (each still capped at
 * EXCERPT_INPUT_FILE_CHARS). Taking files first-come would let the first two
 * large picks crowd out the rest entirely.
 *
 * @returns Character budget per file, in the order given
 */
export function allocateInputBudget(
  sizes: number[],
  total: number = EXCERPT_INPUT_TOTAL_CHARS,
  perFile: number = EXCERPT_INPUT_FILE_CHARS
): number[] {
  const budgets = new Array<number>(sizes.length).fill(0);
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => a.size - b.size);
  let remaining = total;
  order.forEach(({ size, i }, k) => {
    const fairShare = Math.floor(remaining / (order.length - k));
    budgets[i] = Math.min(size, perFile, fairShare);
    remaining -= budgets[i];
  });
  return budgets;
}

/**
 * The files as the excerpt model sees them: a header per file with its line
 * count, then its numbered lines up to that file's share of the input budget.
 * A file cut short says so, so the model knows the rest exists.
 */
export function renderFilesForPrompt(files: RepoFile[]): string {
  const readable = readableFiles(files);
  const numbered = readable.map(f => numberLines(f.lines, 1, f.lines.length));
  const budgets = allocateInputBudget(numbered.map(text => text.length));

  return readable
    .map((f, i) => {
      const total = f.lines.length;
      if (numbered[i].length <= budgets[i]) {
        return `### FILE: ${f.path} (${total} lines)\n${numbered[i]}`;
      }
      // Cut at a line boundary inside this file's budget.
      const shown = lastLineThatFits(f.lines, 1, total, budgets[i]);
      if (shown === 0) {
        return `### FILE: ${f.path} (${total} lines; not shown, input budget used up)`;
      }
      return `### FILE: ${f.path} (${total} lines; lines 1-${shown} shown, the rest omitted for length)\n${numberLines(f.lines, 1, shown)}`;
    })
    .join('\n\n');
}

/** A line number from the model: an integer, or a string holding one. */
function toLineNumber(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

/** Collapse whitespace so a `why` or overview cannot break the block layout. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * The balanced `{...}` that opens at `start`, or null if it never closes.
 * Braces inside JSON strings (a `why` that mentions `{x}`) do not count.
 */
function balancedObject(text: string, start: number): string | null {
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}' && --depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse the excerpt model's answer. Returns null for anything that is neither
 * an object with an `excerpts` array nor a bare array of excerpt objects, which
 * sends the caller to the fallback.
 *
 * Readings tried in order: the whole answer (or what is inside an anchored
 * ```json fence), then the balanced object that opens at the first `{`, which
 * reads the object out of prose before or after it even when that prose has
 * braces of its own.
 */
export function parseExcerptResponse(text: string | null): ExcerptResponse | null {
  if (!text) return null;
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidates = [fenced ? fenced[1] : trimmed];
  const object = balancedObject(trimmed, trimmed.indexOf('{'));
  if (object) candidates.push(object);

  let overview: unknown = null;
  let excerpts: unknown[] | null = null;
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(parsed)) {
      // A bare list is the excerpts on their own, if that is what is in it.
      if (parsed.every(item => item && typeof item === 'object' && !Array.isArray(item))) {
        excerpts = parsed;
        break;
      }
    } else if (parsed && typeof parsed === 'object') {
      const answer = parsed as { overview?: unknown; excerpts?: unknown };
      if (Array.isArray(answer.excerpts)) {
        overview = answer.overview;
        excerpts = answer.excerpts;
        break;
      }
    }
  }
  if (!excerpts) return null;

  const pointers: ExcerptPointer[] = [];
  for (const item of excerpts) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.path !== 'string' || !raw.path.trim()) continue;
    pointers.push({
      // Models sometimes write "./src/App.jsx"; the tree has "src/App.jsx".
      path: raw.path.trim().replace(/^\.?\/+/, ''),
      startLine: toLineNumber(raw.start_line),
      endLine: toLineNumber(raw.end_line),
      wholeFile: raw.whole_file === true,
      why: typeof raw.why === 'string' ? oneLine(raw.why, 160) : '',
    });
  }

  return {
    overview: typeof overview === 'string' && overview.trim() ? oneLine(overview, 800) : null,
    pointers,
  };
}

/**
 * Where an excerpt from `start` wanting to run to `end` has to stop to stay
 * within EXCERPT_MAX_CHARS. Never before `start`: a line as shown is at most
 * MAX_LINE_CHARS plus its marker, so the first line always fits anyway.
 */
function boundedEnd(lines: string[], start: number, end: number): number {
  return Math.max(start, lastLineThatFits(lines, start, end, EXCERPT_MAX_CHARS));
}

/**
 * Turn the model's pointers into excerpts that are safe to slice.
 *
 * - The path must be one of the files that were read; anything else is dropped.
 * - `whole_file` on a small file (see readableFiles) is the file; on a larger
 *   one it is the first WHOLE_FILE_MAX_LINES lines.
 * - A range is clamped to the file, a reversed one is swapped, and a lone start
 *   or end line is a one-line range.
 * - A range that is unusable (no integers, or entirely past the end of the file)
 *   becomes the whole file when the file is small, and is dropped otherwise.
 * - A whole-file pointer (either kind above) on a file that a higher-ranked
 *   pointer already named lines in is dropped: the model chose those lines, and
 *   merging the whole file into them would carry the file to the top of the
 *   order under the better rank.
 * - Every excerpt stops at the last line that fits EXCERPT_MAX_CHARS, keeping
 *   the line it would have run to in `uncutEndLine` for the note.
 * - Only the first MAX_EXCERPTS usable pointers are kept, then ranges in the
 *   same file that overlap, touch, or have one line between them are merged
 *   when the result still fits EXCERPT_MAX_CHARS. A merged excerpt keeps the
 *   rank of its highest-ranked part, and the result is in rank order.
 */
export function resolveExcerpts(pointers: ExcerptPointer[], files: RepoFile[]): ResolvedExcerpt[] {
  const readable = new Map(readableFiles(files).map(f => [f.path, f]));

  // `uncutEndLine` is always set here (equal to endLine when nothing was cut)
  // and left off the output when it adds nothing.
  type Ranked = Excerpt & { rank: number; whys: string[]; uncutEndLine: number };
  const usable: Ranked[] = [];
  const pathsWithRanges = new Set<string>();

  for (const pointer of pointers) {
    if (usable.length >= MAX_EXCERPTS) break;
    const file = readable.get(pointer.path);
    if (!file) continue;
    const total = file.lines.length;
    const small = file.small;

    let start: number;
    let end: number;
    let uncutEnd: number;
    const a = pointer.startLine ?? pointer.endLine;
    const b = pointer.endLine ?? pointer.startLine;
    const low = a !== null && b !== null ? Math.min(a, b) : null;
    const high = a !== null && b !== null ? Math.max(a, b) : null;
    const hasRange = low !== null && high !== null && low <= total && high >= 1;
    // Anything but a usable range stands for the whole file.
    if ((pointer.wholeFile || !hasRange) && pathsWithRanges.has(pointer.path)) continue;

    if (pointer.wholeFile) {
      start = 1;
      end = small ? total : Math.min(total, WHOLE_FILE_MAX_LINES);
      uncutEnd = total;
    } else if (hasRange) {
      start = Math.max(1, low);
      end = Math.min(total, high);
      uncutEnd = end;
      pathsWithRanges.add(pointer.path);
    } else if (small) {
      start = 1;
      end = total;
      uncutEnd = total;
    } else {
      continue;
    }
    end = boundedEnd(file.lines, start, end);

    usable.push({
      path: pointer.path,
      startLine: start,
      endLine: end,
      wholeFile: start === 1 && end === total,
      why: pointer.why,
      rank: usable.length,
      whys: pointer.why ? [pointer.why] : [],
      uncutEndLine: uncutEnd,
    });
  }

  // Merge per file: sort by start, and fold each range into the one before it
  // when they overlap, touch, or have one line between them (usually the blank
  // line between two rules or functions) and the result still fits.
  const merged: Ranked[] = [];
  const byPath = new Map<string, Ranked[]>();
  for (const excerpt of usable) {
    byPath.set(excerpt.path, [...(byPath.get(excerpt.path) ?? []), excerpt]);
  }
  for (const [path, ranges] of byPath) {
    const lines = readable.get(path)?.lines ?? [];
    const total = lines.length;
    const sorted = [...ranges].sort((a, b) => a.startLine - b.startLine);
    let current = { ...sorted[0], whys: [...sorted[0].whys] };
    for (const part of sorted.slice(1)) {
      const next = { ...part, whys: [...part.whys] };
      const end = Math.max(current.endLine, next.endLine);
      if (
        next.startLine <= current.endLine + 2 &&
        boundedEnd(lines, current.startLine, end) === end
      ) {
        current.endLine = end;
        current.uncutEndLine = Math.max(current.uncutEndLine, next.uncutEndLine);
        // Reasons read best in the model's order, not line order.
        current.whys =
          next.rank < current.rank
            ? [...next.whys, ...current.whys]
            : [...current.whys, ...next.whys];
        current.rank = Math.min(current.rank, next.rank);
        continue;
      }
      if (next.startLine <= current.endLine) {
        // They overlap but are too big together. Each fits on its own, so the
        // overlap is partial (current starts first, next ends last): give the
        // shared lines to the higher-ranked one and cut them from the other.
        if (next.rank < current.rank) {
          current.endLine = next.startLine - 1;
          if (current.uncutEndLine <= next.endLine) current.uncutEndLine = current.endLine;
        } else {
          next.startLine = current.endLine + 1;
        }
      }
      merged.push(current);
      current = next;
    }
    merged.push(current);
    for (const excerpt of merged.filter(e => e.path === path)) {
      excerpt.wholeFile = excerpt.startLine === 1 && excerpt.endLine === total;
    }
  }

  return merged
    .sort((a, b) => a.rank - b.rank)
    .map(({ path, startLine, endLine, wholeFile, whys, uncutEndLine }) => ({
      path,
      startLine,
      endLine,
      wholeFile,
      why: [...new Set(whys)].join('; '),
      ...(uncutEndLine > endLine ? { uncutEndLine } : {}),
    }));
}

/**
 * What the quiz agent gets when the model's answer is unusable: every file that
 * was read, small ones whole (in pick order) and then the top of the large
 * ones, each within EXCERPT_MAX_CHARS and all under the same output cap. Code
 * it did not choose beats no code.
 */
export function fallbackExcerpts(files: RepoFile[]): ResolvedExcerpt[] {
  const readable = readableFiles(files);
  const small = readable.filter(f => f.small);
  const large = readable.filter(f => !f.small);
  return [...small, ...large].map(f => {
    const total = f.lines.length;
    const end = boundedEnd(f.lines, 1, Math.min(total, WHOLE_FILE_MAX_LINES));
    return {
      path: f.path,
      startLine: 1,
      endLine: end,
      wholeFile: end === total,
      why: '',
      ...(end < total ? { uncutEndLine: total } : {}),
    };
  });
}

/** The header line of one excerpt block. */
function excerptHeader(excerpt: Excerpt, totalLines: number): string {
  const where = excerpt.wholeFile
    ? `(whole file, ${totalLines} lines)`
    : `lines ${excerpt.startLine}–${excerpt.endLine} of ${totalLines}`;
  return `=== ${excerpt.path} ${where}${excerpt.why ? ` — ${excerpt.why}` : ''} ===`;
}

/**
 * Assemble the text the quiz agent reads: the overview (initial call only),
 * then one block per excerpt, in order, each a header and the exact numbered
 * lines, and a note under any excerpt that was cut for length. Stays under
 * `maxChars` (the notes aside): an excerpt that crosses it is cut at a line
 * boundary with a note saying so when at least 5 of its lines fit, and skipped
 * otherwise; either way the ones after it still go in if they fit, and every
 * skipped one is listed as omitted at the end so the agent can ask for it.
 *
 * @returns The text, and each excerpt that made it in with its block body (the
 *   numbered lines), with `endLine` pulled in when it was cut
 */
export function assembleExcerptText(
  excerpts: ResolvedExcerpt[],
  files: RepoFile[],
  overview: string | null,
  maxChars: number = EXCERPT_OUTPUT_MAX_CHARS
): { excerptText: string; included: Array<{ excerpt: Excerpt; body: string }> } {
  const linesByPath = new Map(readableFiles(files).map(f => [f.path, f.lines]));
  const parts: string[] = [];
  const included: Array<{ excerpt: Excerpt; body: string }> = [];
  const omitted: Excerpt[] = [];
  let used = 0;
  const add = (block: string) => {
    parts.push(block);
    used += block.length + 2; // With the blank line that separates blocks.
  };

  if (overview) add(`Overview: ${overview}`);

  for (const { uncutEndLine, ...excerpt } of excerpts) {
    const lines = linesByPath.get(excerpt.path);
    if (!lines) continue;
    const runsTo = uncutEndLine ?? excerpt.endLine;
    const header = excerptHeader(excerpt, lines.length);
    const body = numberLines(lines, excerpt.startLine, excerpt.endLine);

    if (used + header.length + 1 + body.length <= maxChars) {
      const note =
        runsTo > excerpt.endLine
          ? `\n[… cut at line ${excerpt.endLine} for length; this excerpt runs to line ${runsTo}.]`
          : '';
      add(`${header}\n${body}${note}`);
      included.push({ excerpt, body });
      continue;
    }

    // This one crosses the cap: keep the lines that fit, if enough do to be
    // worth reading. Otherwise skip it; a smaller one after it may still fit.
    const room = maxChars - used - header.length - 1;
    const end = lastLineThatFits(lines, excerpt.startLine, excerpt.endLine, room);
    if (end - excerpt.startLine + 1 >= 5) {
      const cut: Excerpt = { ...excerpt, endLine: end, wholeFile: false };
      const cutBody = numberLines(lines, cut.startLine, cut.endLine);
      add(
        `${excerptHeader(cut, lines.length)}\n${cutBody}\n[… cut at line ${end}; this excerpt runs to line ${runsTo}. Output size cap reached.]`
      );
      included.push({ excerpt: cut, body: cutBody });
    } else {
      omitted.push(excerpt);
    }
  }

  if (omitted.length > 0) {
    const names = omitted.map(e => `${e.path} lines ${e.startLine}–${e.endLine}`).join(', ');
    parts.push(`[Omitted to stay under the output size cap: ${names}]`);
  }

  return { excerptText: parts.join('\n\n'), included };
}

/**
 * The pre-excerpt `findings` string, for an ai-agent that does not know
 * `format`. It matches that agent's ExplorationSummarySchema: one relevant_file
 * per path (at most LEGACY_MAX_RELEVANT_FILES), its code_snippet the exact
 * numbered lines of that file's excerpts, its summary the reasons. There is
 * nothing to put in key_patterns or suggested_topics any more, and
 * project_structure (initial only, all three arrays required) is read off the
 * picked paths.
 */
export function buildLegacyFindings(
  included: Array<{ excerpt: Excerpt; body: string }>,
  filePaths: string[],
  focusArea: string
): string {
  const byPath = new Map<string, Array<{ excerpt: Excerpt; body: string }>>();
  for (const item of included) {
    byPath.set(item.excerpt.path, [...(byPath.get(item.excerpt.path) ?? []), item]);
  }

  const relevantFiles = [...byPath.entries()]
    .slice(0, LEGACY_MAX_RELEVANT_FILES)
    .map(([path, items]) => ({
      path,
      summary:
        items
          .map(({ excerpt }) => excerpt.why)
          .filter(Boolean)
          .join('; ') ||
        items.map(({ excerpt }) => `lines ${excerpt.startLine}–${excerpt.endLine}`).join(', '),
      code_snippet: items.map(({ body }) => body).join('\n…\n'),
      concepts: [] as string[],
    }));

  const summary: Record<string, unknown> = { focus_area: focusArea };
  if (focusArea === 'initial') {
    const dirs = filePaths.map(p => p.split('/').slice(0, -1).join('/')).filter(Boolean);
    summary.project_structure = {
      entry_points: filePaths.filter(p => /(^|\/)(index|main|app)\.[a-z]+$/i.test(p)),
      key_directories: [...new Set(dirs)],
      config_files: filePaths.filter(p =>
        /(^|\/)(package\.json|tsconfig[^/]*\.json|[^/]+\.config\.[a-z]+|\.env\.example|requirements\.txt|pyproject\.toml)$/i.test(
          p
        )
      ),
    };
  }
  summary.relevant_files = relevantFiles;
  summary.key_patterns = [];
  summary.suggested_topics = [];
  return JSON.stringify(summary);
}

/**
 * Ask the exploration model which lines matter, and parse its answer.
 *
 * @returns The parsed pointers (and overview on the initial call), or null when
 *   the answer is missing or unparseable
 */
export async function requestExcerptPointers(
  client: Anthropic,
  model: string,
  files: RepoFile[],
  focusArea: string,
  previousFindings: string[],
  specificQuestion: string | null,
  treeListing: string
): Promise<ExcerptResponse | null> {
  const isInitial = focusArea === 'initial';

  const previousContext =
    previousFindings.length > 0
      ? `\nTopics already covered (prefer code not already used for them): ${previousFindings.join(', ')}`
      : '';
  const questionContext = specificQuestion ? `\nSPECIFIC QUESTION: ${specificQuestion}` : '';
  // The tree only helps the overview, which only the initial call writes.
  const treeContext = isInitial
    ? `\n\nPROJECT TREE (first 100 entries):\n${treeListing.split('\n').slice(0, 100).join('\n')}`
    : '';

  const overviewField = isInitial
    ? `\n  "overview": "<=60 words: what the project is, its framework, how it is organized",`
    : '';

  // No `thinking` param and a roomy max_tokens, for the same reasons as the
  // file picker above. The answer itself is a few hundred tokens, but thinking
  // counts against max_tokens and this call has up to ~20k tokens of code to
  // think about, so it gets twice the picker's room.
  const response = await client.messages.create({
    model,
    max_tokens: 8192,
    messages: [
      {
        role: 'user',
        content: `You pick code for a quiz agent that will ask a student about their own repository. Do NOT quote or summarize code: name the lines, and they will be copied verbatim (with line numbers) from the files below.

FOCUS AREA: ${isInitial ? 'Initial project overview: entry point, main components, key patterns' : focusArea}${questionContext}${previousContext}${treeContext}

FILES (every line starts with its line number):
${renderFilesForPrompt(files)}

Respond with ONLY this JSON object:
{${overviewField}
  "excerpts": [
    {"path": "src/App.jsx", "start_line": 12, "end_line": 40, "why": "<=15 words: what these lines show"},
    {"path": "index.html", "whole_file": true, "why": "<=15 words"}
  ]
}

RULES:
- At most ${MAX_EXCERPTS} excerpts, most relevant first.
- path exactly as in a FILE header.
- Each range covers a complete unit (the whole function, CSS rule, or component) plus a line or two of context; usually 5-60 lines.
- whole_file only for a short file (<= ${WHOLE_FILE_MAX_LINES} lines) that matters as a whole.
- Fewer excerpts are fine: leave out code unrelated to the focus area.
- If there is a specific question, the first excerpt answers it.
- No text outside the JSON.`,
      },
    ],
  });

  return parseExcerptResponse(responseText(response, 'Excerpt selector'));
}

/**
 * Build the task result from the model's parsed answer (or null) and the files.
 * Pure apart from logging, so the fallback and the contract are testable
 * without a model.
 */
export function buildExploreResult({
  response,
  files,
  filePaths,
  focusArea,
  fileCount,
}: {
  response: ExcerptResponse | null;
  files: RepoFile[];
  filePaths: string[];
  focusArea: string;
  fileCount: number;
}): ExploreResult {
  const hasCode = readableFiles(files).length > 0;
  const overview = focusArea === 'initial' ? (response?.overview ?? null) : null;
  const excerpts = response ? resolveExcerpts(response.pointers, files) : [];
  let { excerptText, included } = assembleExcerptText(excerpts, files, overview);

  // Decided on what made it into the text, not on what resolved, so the quiz
  // agent never gets text with no code in it while there is code to show. (A
  // resolved excerpt fits EXCERPT_MAX_CHARS, so the first one always goes in
  // today; this holds even if the caps drift.)
  if (hasCode && included.length === 0) {
    logger.warn(
      !response
        ? 'Excerpt selector: answer missing or not parseable; falling back to whole files'
        : response.pointers.length === 0
          ? 'Excerpt selector: the answer named no excerpts; falling back to whole files'
          : `Excerpt selector: none of ${response.pointers.length} excerpts pointed at lines in the files read; falling back to whole files`
    );
    ({ excerptText, included } = assembleExcerptText(fallbackExcerpts(files), files, overview));
  }

  return {
    format: 'excerpts-v1',
    excerptText,
    excerpts: included.map(({ excerpt }) => excerpt),
    overview,
    findings: buildLegacyFindings(included, filePaths, focusArea),
    filesRead: filePaths,
    focusArea,
    fileCount,
  };
}

/**
 * Put the result in run metadata so the ai-agent can take it on its next poll,
 * without waiting the ~7 s Trigger takes to finalize a run after it returns.
 *
 * Best effort by design. In SDK 4.6.3, flush() returns at once, sending
 * nothing, when another flush is already in flight; the task returns right
 * after this, so the still-queued `result` goes out with the run's completion
 * packet, no sooner than the run output: the early copy is lost, not delayed.
 * flush() also only logs a rejected update. Either way the same object is the
 * run output, which the ai-agent falls back to.
 *
 * Run metadata now holds the focus area and the overview (and the excerpted
 * code), and the focus area names the question the quiz agent is about to ask.
 * The ai-agent reads it server side. Explore runs must never be subscribed to
 * from a student-facing realtime hook (useRealtimeRun, or a tag that
 * useRealtimeRunsWithTag watches), or the student sees the question coming.
 */
async function publishResult(result: ExploreResult): Promise<void> {
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > METADATA_RESULT_MAX_BYTES) {
    logger.warn(
      `Result is ${bytes} bytes, over the ${METADATA_RESULT_MAX_BYTES}-byte metadata budget; not publishing it early`
    );
    return;
  }
  try {
    metadata.set('result', result);
    await metadata.flush();
  } catch (error) {
    logger.warn(`Could not publish the result to run metadata: ${(error as Error).message}`);
  }
}

/**
 * Trigger.dev task: Explore a GitHub gitRepo using the REST API + the exploration model.
 *
 * This is the core of the "trigger" exploration mode. Instead of cloning repos into
 * VMs (slow, expensive), it reads files directly via GitHub's API and makes two
 * direct Messages API calls on the exploration model (chosen per classroom): one
 * picks the files, one points at the lines in them. The result is exact,
 * numbered excerpts (see "Excerpt selection" above), published to run metadata
 * and returned.
 *
 * Cost: two exploration-model calls + Trigger.dev compute.
 */
export const exploreRepoTask = task({
  id: 'explore-repo',
  machine: 'small-2x',
  maxDuration: 120,
  queue: { concurrencyLimit: 50 },

  run: async (payload: {
    owner: string;
    repo: string;
    accessToken: string;
    focusArea?: string;
    depth?: string;
    previousFindings?: string[];
    previouslyReadFiles?: string[];
    specificQuestion?: string | null;
    explorationModel?: string;
  }) => {
    const {
      owner,
      repo,
      accessToken,
      focusArea = 'initial',
      depth = 'focused',
      previousFindings = [],
      previouslyReadFiles = [],
      specificQuestion = null,
      explorationModel,
    } = payload;

    const model = explorationModel || 'claude-sonnet-5';
    console.log(
      `[explore-repo] Starting: ${owner}/${repo} — focus: ${focusArea}, depth: ${depth}, model: ${model}`
    );
    logger.info(
      `Exploring ${owner}/${repo} — focus: ${focusArea}, depth: ${depth}, model: ${model}`
    );

    // Initialize Anthropic client using env var (set in Trigger.dev config, NOT passed in payload)
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY env var not set in Trigger.dev environment');
    }
    const client = new Anthropic({ apiKey: anthropicApiKey });

    // Step 1: Fetch gitRepo tree (~200ms)
    console.log(`[explore-repo] Step 1: Fetching repo tree...`);
    logger.info('Fetching gitRepo structure...');
    metadata.set('currentStep', 'Fetching gitRepo structure');
    metadata.set('steps', [
      { action: 'Fetching gitRepo structure', toolName: 'github_tree', timestamp: Date.now() },
    ]);
    await metadata.flush();

    const tree = await fetchRepoTree(owner, repo, accessToken);
    console.log(`[explore-repo] Step 1 done: ${tree.length} files in tree`);
    logger.info(`GitRepo has ${tree.length} files`);

    const treeListing = formatTreeForLLM(tree);

    // Step 2: Claude picks relevant files (~2-5s)
    console.log(`[explore-repo] Step 2: Asking the exploration model to pick relevant files...`);
    logger.info('Analyzing gitRepo structure...');
    metadata.set('currentStep', 'Analyzing gitRepo structure');
    metadata.append('steps', {
      action: `Analyzing ${tree.length} files`,
      toolName: 'analyze_structure',
      timestamp: Date.now(),
    });
    await metadata.flush();

    const filePaths = await pickRelevantFiles(
      client,
      model,
      treeListing,
      focusArea,
      depth,
      previousFindings,
      specificQuestion,
      previouslyReadFiles
    );
    console.log(
      `[explore-repo] Step 2 done: picked ${filePaths.length} files: ${filePaths.join(', ')}`
    );
    logger.info(`Selected ${filePaths.length} files to read: ${filePaths.join(', ')}`);

    // Step 3: Fetch file contents in parallel (~100ms each)
    // Emit a step for each file being read
    console.log(`[explore-repo] Step 3: Fetching file contents...`);
    logger.info('Reading selected files...');
    for (const filePath of filePaths) {
      metadata.append('steps', {
        action: `Reading: ./${filePath}`,
        toolName: 'github_read',
        toolInput: { path: filePath },
        timestamp: Date.now(),
      });
    }
    metadata.set('currentStep', `Reading ${filePaths.length} files`);
    await metadata.flush();

    const files = await fetchMultipleFiles(owner, repo, filePaths, accessToken);

    const successCount = files.filter(f => !f.error).length;
    console.log(`[explore-repo] Step 3 done: read ${successCount}/${filePaths.length} files`);
    logger.info(`Successfully read ${successCount}/${filePaths.length} files`);

    // Step 4: the exploration model points at the lines that matter (a few
    // hundred output tokens) and the task slices them out of the files.
    console.log(`[explore-repo] Step 4: Selecting excerpts with the exploration model...`);
    logger.info('Selecting relevant code...');
    metadata.set('currentStep', 'Selecting relevant code');
    // No toolInput: steps stream to the student and are saved with the
    // conversation, and the focus area names the question about to be asked.
    // `synthesize` stays as the toolName because the quiz UI keys its icon on it.
    metadata.append('steps', {
      action: 'Selecting relevant code',
      toolName: 'synthesize',
      timestamp: Date.now(),
    });
    await metadata.flush();

    // Nothing readable means nothing to point at; skip the call.
    const response = files.some(f => !f.error && f.content)
      ? await requestExcerptPointers(
          client,
          model,
          files,
          focusArea,
          previousFindings,
          specificQuestion,
          treeListing
        )
      : null;

    const result = buildExploreResult({
      response,
      files,
      filePaths,
      focusArea,
      fileCount: tree.length,
    });

    console.log(
      `[explore-repo] Done! ${result.excerpts.length} excerpts, ${result.excerptText.length} chars`
    );
    logger.info(
      `Exploration complete: ${result.excerpts.length} excerpts, ${result.excerptText.length} chars`
    );
    metadata.set('currentStep', 'complete');

    // Publish before returning: the ai-agent takes it from metadata on its next
    // poll instead of waiting for Trigger to finalize the run. The return value
    // is the same object, for when the early copy is missed.
    await publishResult(result);
    return result;
  },
});
