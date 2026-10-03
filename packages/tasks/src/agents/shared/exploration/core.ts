/**
 * Repository exploration as a function: the `explore-repo` task's pipeline
 * (tree → file pick → fetch → line pointers → excerpts), called in process by
 * a chat agent's tool instead of as a child run.
 *
 * What the caller injects, and why:
 *   - `token`: a repository-scoped, read-only installation token the caller
 *     mints in its own run. It is never put in a payload or logged here.
 *   - `client`: the Anthropic client that pays (the classroom's key when the
 *     classroom has one, otherwise the platform's).
 *   - `signal`: the turn's deadline. Every phase stops on it; the model calls
 *     are cancelled through it.
 *   - `onFileRead`: one call per file read, with the path only. The quiz turns
 *     each into a `data-step` the student sees; the focus area, the specific
 *     question and every other argument stay out of it.
 *   - `callLog`: where one usage line per model call goes (ids, model, token
 *     counts, never content), in the same shape as the quiz loop's line.
 *
 * GitHub rate limits: many students starting at once share one installation's
 * limits. A tree or file read that GitHub answers with a rate limit is tried
 * up to twice more, after a jittered pause (`RATE_LIMIT_BACKOFF_MS`), and the
 * pauses stop on the turn's signal. A Gitlab read (`gitHost`) answered with a 429 is retried the same way.
 *
 * The steps themselves are `workflows/exploreRepo.ts`, reused as is, so the
 * legacy task and the in-process path read, pick and excerpt the same way.
 * Log lines carry counts only: the focus area names the question the quiz is
 * about to ask.
 */
import type Anthropic from '@anthropic-ai/sdk';
// eslint-disable-next-line import/no-unresolved -- trigger.dev v3 resolved at runtime
import { logger } from '@trigger.dev/sdk/v3';
import type { DiagnosticLog } from '../sanitize.ts';
import { pathExclusion } from './excludedPaths.ts';
import {
  buildExploreResult,
  capExcerptEffort,
  fetchMultipleFiles,
  fetchRepoTree,
  formatTreeForLLM,
  isExplorableEntry,
  pickRelevantFiles,
  readablePickedPaths,
  requestExcerptPointers,
  toEffortLevel,
  type Excerpt,
  type ExploreResult,
  type FileReadOptions,
} from '../../../workflows/exploreRepo.ts';

export type { ExploreResult, Excerpt } from '../../../workflows/exploreRepo.ts';

export type ExploreDepth = 'shallow' | 'focused' | 'deep';

/** Where the per-call usage line goes, and the ids it carries. */
export type ExplorationCallLog = {
  log: DiagnosticLog;
  attemptId: string;
  runId: string;
  keySource: string;
};

/**
 * The pause before each GitHub rate-limit retry, as [min, max] milliseconds;
 * the wait is drawn uniformly from the range, so students who were limited
 * together do not all come back together.
 */
export const RATE_LIMIT_BACKOFF_MS: ReadonlyArray<readonly [number, number]> = [
  [1_000, 3_000],
  [3_000, 6_000],
];

export type ExploreRepositoryInput = {
  /** The org on Github; the project's namespace on Gitlab. */
  owner: string;
  repo: string;
  token: string;
  /** A Gitlab instance origin to read from instead of Github; absent on Github. */
  gitHost?: string | null;
  model: string;
  /** Effort for the excerpt call; unknown values send none. */
  effort: string | null;
  focusArea: string;
  depth: ExploreDepth;
  specificQuestion?: string | null;
  /** Short notes on what earlier explorations covered, for the file picker. */
  previousFindings: string[];
  /** Paths earlier explorations showed code from. Context, not a blocklist. */
  previouslyReadFiles: string[];
  /**
   * The quiz's excluded paths (.gitignore-style patterns, `excludedPaths.ts`).
   * Matching files are left out of the tree the model sees, so they are never
   * picked, listed or read. None when absent.
   */
  excludedPaths?: readonly string[];
  client: Anthropic;
  signal: AbortSignal;
  /** One call per file read, with the path only; `error` when the read failed. */
  onFileRead: (path: string, o?: { error: true }) => void;
  /**
   * One call per file read successfully, with its content as read: the lines
   * the excerpts were numbered from. Server side only (the quiz keeps them so
   * a code quote checks the same lines the model was shown).
   */
  onFileContent?: (path: string, content: string) => void;
  /** One usage line per model call; none when absent. */
  callLog?: ExplorationCallLog;
  /** Pauses before the rate-limit retries; defaults to `RATE_LIMIT_BACKOFF_MS`. */
  rateLimitBackoffMs?: ReadonlyArray<readonly [number, number]>;
};

/** Thrown when the turn's signal stops an exploration. */
export class ExplorationStoppedError extends Error {
  constructor() {
    super('Exploration stopped');
    this.name = 'ExplorationStoppedError';
  }
}

function throwIfStopped(signal: AbortSignal): void {
  if (signal.aborted) throw new ExplorationStoppedError();
}

/**
 * A promise that settles with `work`, or rejects as soon as `signal` aborts.
 * The GitHub reads take no signal of their own, so this is what stops waiting
 * on them; a late result is dropped.
 */
export function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(new ExplorationStoppedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ExplorationStoppedError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Resolve after `ms`, or reject with `ExplorationStoppedError` as soon as the
 * signal aborts.
 */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new ExplorationStoppedError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ExplorationStoppedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A wait drawn from `[min, max]`. */
export function rateLimitWaitMs(
  range: readonly [number, number],
  random: () => number = Math.random
): number {
  const [min, max] = range;
  return Math.round(min + random() * Math.max(0, max - min));
}

/**
 * Whether a GitHub read failed on a rate limit: a 429, or a 403 whose body
 * names a rate limit (GitHub's primary and secondary limit answers both do).
 * Reads the "failed (NNN): body" text the `exploreRepo.ts` helpers throw (or
 * store as a file's `error`); the response headers do not reach this far, and
 * the helper itself already waits out a `retry-after`.
 */
export function isGithubRateLimited(error: unknown): boolean {
  const message = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  const match = / failed \((\d{3})\): ([\s\S]*)$/.exec(message);
  if (!match) return false;
  if (match[1] === '429') return true;
  return match[1] === '403' && /rate limit/i.test(match[2]);
}

type RetryContext = {
  signal: AbortSignal;
  backoff: ReadonlyArray<readonly [number, number]>;
  callLog?: ExplorationCallLog;
};

/** Pause before rate-limit retry `retry` (0-based), with one counts-only log line. */
async function waitBeforeRetry(
  r: RetryContext,
  retry: number,
  what: 'tree' | 'files',
  count: number
): Promise<void> {
  const waitMs = rateLimitWaitMs(r.backoff[retry]);
  const fields = { retry: retry + 1, of: r.backoff.length, what, count, waitMs };
  if (r.callLog) {
    r.callLog.log('[quiz-agent] exploration rate limited', {
      attemptId: r.callLog.attemptId,
      runId: r.callLog.runId,
      ...fields,
    });
  } else {
    logger.warn(
      `Exploration: GitHub rate limited (${what}, ${count}), retry ${retry + 1} of ${r.backoff.length} in ${waitMs}ms`
    );
  }
  await pause(waitMs, r.signal);
}

type RepoTree = Awaited<ReturnType<typeof fetchRepoTree>>;
type RepoFiles = Awaited<ReturnType<typeof fetchMultipleFiles>>;

/** The repository tree, retried on a rate limit. */
async function fetchTreeWithRetry(
  owner: string,
  repo: string,
  token: string,
  r: RetryContext,
  gitHost?: string | null
): Promise<RepoTree> {
  const fetchTree = () =>
    gitHost ? fetchRepoTree(owner, repo, token, gitHost) : fetchRepoTree(owner, repo, token);
  for (let retry = 0; ; retry++) {
    try {
      return await untilAborted(fetchTree(), r.signal);
    } catch (error) {
      if (error instanceof ExplorationStoppedError) throw error;
      if (retry >= r.backoff.length || !isGithubRateLimited(error)) throw error;
      await waitBeforeRetry(r, retry, 'tree', 1);
    }
  }
}

/**
 * The picked files, in the picked order. Files whose read hit a rate limit are
 * read again (only those), and a file still limited after the last retry keeps
 * its error.
 */
async function fetchFilesWithRetry(
  owner: string,
  repo: string,
  paths: string[],
  token: string,
  r: RetryContext,
  read: FileReadOptions = {}
): Promise<RepoFiles> {
  const fetchFiles = (list: string[]) => fetchMultipleFiles(owner, repo, list, token, 3, read);
  let files = await untilAborted(fetchFiles(paths), r.signal);
  for (let retry = 0; retry < r.backoff.length; retry++) {
    const limited = files.filter(f => f.error && isGithubRateLimited(f.error)).map(f => f.path);
    if (limited.length === 0) break;
    await waitBeforeRetry(r, retry, 'files', limited.length);
    const again = await untilAborted(fetchFiles(limited), r.signal);
    const byPath = new Map(again.map(f => [f.path, f]));
    files = files.map(f => byPath.get(f.path) ?? f);
  }
  return files;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The client as the exploration steps see it: every `messages.create` carries
 * the turn's signal, so an abort cancels the request in flight, and each
 * answered call logs one usage line (ids, model, token counts; never content)
 * when a `callLog` is given. The steps call nothing else on the client.
 */
function clientWithSignal(
  client: Anthropic,
  signal: AbortSignal,
  callLog?: ExplorationCallLog
): Anthropic {
  let calls = 0;
  const messages = {
    create: async (
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: Record<string, unknown>
    ) => {
      const started = Date.now();
      const response = await client.messages.create(body, { ...(options ?? {}), signal });
      calls += 1;
      if (callLog) {
        try {
          // Tolerant of a partial answer: a missing figure logs as 0.
          const u: Partial<Anthropic.Usage> = response?.usage ?? {};
          const noCache = numberOrZero(u.input_tokens);
          const cacheRead = numberOrZero(u.cache_read_input_tokens);
          const cacheWrite = numberOrZero(u.cache_creation_input_tokens);
          const model = response?.model;
          callLog.log('[quiz-agent] exploration call', {
            attemptId: callLog.attemptId,
            runId: callLog.runId,
            call: calls,
            model: typeof model === 'string' && model ? model : body.model,
            keySource: callLog.keySource,
            finish: String(response?.stop_reason ?? ''),
            inputTokens: noCache + cacheRead + cacheWrite,
            noCacheTokens: noCache,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            outputTokens: numberOrZero(u.output_tokens),
            ms: Date.now() - started,
          });
        } catch {
          // A usage line never fails an exploration.
        }
      }
      return response;
    },
  };
  return { messages } as unknown as Anthropic;
}

/**
 * Explore one repository for one focus area and return exact, numbered
 * excerpts (`ExploreResult`, the same object the `explore-repo` task returns).
 * Throws `ExplorationStoppedError` when the signal aborts, and the GitHub or
 * model error otherwise.
 */
export async function exploreRepository(i: ExploreRepositoryInput): Promise<ExploreResult> {
  const { owner, repo, token, model, focusArea, depth, signal } = i;
  const specificQuestion = i.specificQuestion ?? null;
  const effort = capExcerptEffort(toEffortLevel(i.effort));
  const client = clientWithSignal(i.client, signal, i.callLog);
  const retry: RetryContext = {
    signal,
    backoff: i.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS,
    callLog: i.callLog,
  };

  const isExcluded = pathExclusion(i.excludedPaths);

  throwIfStopped(signal);
  const tree = (await fetchTreeWithRetry(owner, repo, token, retry, i.gitHost)).filter(
    entry => isExplorableEntry(entry) && !isExcluded(entry.path)
  );
  const treeListing = formatTreeForLLM(tree);

  throwIfStopped(signal);
  const filePaths = readablePickedPaths(
    await untilAborted(
      pickRelevantFiles(
        client,
        model,
        treeListing,
        focusArea,
        depth,
        i.previousFindings,
        specificQuestion,
        i.previouslyReadFiles
      ),
      signal
    ),
    tree,
    isExcluded
  );

  throwIfStopped(signal);
  // The answer's own path is checked against the excluded paths too.
  const files = await fetchFilesWithRetry(owner, repo, filePaths, token, retry, {
    isExcluded,
    ...(i.gitHost ? { gitHost: i.gitHost } : {}),
  });
  throwIfStopped(signal);
  for (const file of files) {
    if (file.error) i.onFileRead(file.path, { error: true });
    else i.onFileRead(file.path);
  }
  if (i.onFileContent) {
    for (const file of files) {
      if (file.error) continue;
      try {
        i.onFileContent(file.path, file.content);
      } catch {
        // Keeping a copy never fails an exploration.
      }
    }
  }

  const response = files.some(f => !f.error && f.content)
    ? await untilAborted(
        requestExcerptPointers(
          client,
          model,
          files,
          focusArea,
          i.previousFindings,
          specificQuestion,
          treeListing,
          effort
        ),
        signal
      )
    : null;
  throwIfStopped(signal);

  const result = buildExploreResult({
    response,
    files,
    filePaths,
    focusArea,
    fileCount: tree.length,
  });
  logger.info(
    `Exploration: ${tree.length} files in tree, ${filePaths.length} read, ${result.excerpts.length} excerpts, ${result.excerptText.length} chars`
  );
  return result;
}

/**
 * One line per excerpted file: `path: lines a–b: why; ...`. Only files the
 * model was shown code from; a file fetched but not excerpted has not been
 * seen. Used as exploration history (the `exploration_completed` journal row)
 * and, on later explorations, as the picker's notes on what was covered.
 */
export function excerptSummaryLines(excerpts: readonly Excerpt[]): string[] {
  const byPath = new Map<string, string[]>();
  for (const excerpt of excerpts) {
    if (!excerpt?.path) continue;
    const range = excerpt.wholeFile
      ? 'whole file'
      : `lines ${excerpt.startLine}–${excerpt.endLine}`;
    const part = excerpt.why ? `${range}: ${excerpt.why}` : range;
    byPath.set(excerpt.path, [...(byPath.get(excerpt.path) ?? []), part]);
  }
  return [...byPath].map(([path, parts]) => `${path}: ${parts.join('; ')}`);
}

/** The excerpted paths, each once, in excerpt order. */
export function excerptedPaths(excerpts: readonly Excerpt[]): string[] {
  return [...new Set(excerpts.map(e => e.path).filter(Boolean))];
}

/**
 * What an exploration that found no code tells the model to do next: carry on
 * with what it has, not explore again (a model told to try another area can
 * keep exploring for the whole turn).
 */
export const EXPLORATION_EMPTY_NEXT_STEP =
  "Continue with the code you have already seen; if you have seen none, ask about the concepts directly without quoting the student's code.";

/**
 * The tool result text for the quiz model: a short header, then the excerpt
 * text as is, so line numbers and code reach the model exactly as sliced.
 * Never shown to the student.
 */
export function formatExcerptResult(result: ExploreResult, focusArea: string): string {
  const paths = excerptedPaths(result.excerpts);
  const hasCode =
    result.excerptText.trim() !== '' &&
    (result.excerpts.length > 0 || (result.overview ?? '').trim() !== '');
  if (!hasCode) {
    return (
      `Exploration for focus area "${focusArea}" found no code to show` +
      (result.filesRead.length ? ` (files read: ${result.filesRead.join(', ')})` : '') +
      `. ${EXPLORATION_EMPTY_NEXT_STEP}`
    );
  }
  const header = [
    `Exploration for focus area "${focusArea}".`,
    `Exact code from the student's repository; each line starts with its line number in the file ("N| "), which is not part of the code. Cite code by these line numbers.`,
    paths.length ? `Excerpted files: ${paths.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${header}\n\n${result.excerptText}`;
}

/**
 * What the quiz model is told when an exploration fails, whatever the cause.
 * Fixed text: the model may repeat what a tool result says, so no provider
 * message, status or credential wording ever reaches it. The real error is
 * logged privately (ids and error facts only) by the tool.
 */
export const EXPLORATION_FAILED_TEXT =
  "The student's code could not be read right now. Call explore_codebase at most once more; " +
  'if that fails too, follow IF explore_codebase FAILS in your instructions.';

/**
 * The HTTP status a provider error carries, for the private diagnostic line:
 * a numeric `status`/`statusCode`, or the "(NNN)" our GitHub helpers put in
 * their fixed-format messages. Nothing else is read from the message.
 */
export function providerStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { status?: unknown; statusCode?: unknown; message?: unknown };
  const direct = e.status ?? e.statusCode;
  if (typeof direct === 'number' && Number.isInteger(direct)) return direct;
  if (typeof e.message !== 'string') return undefined;
  const match = /\((\d{3})\)/.exec(e.message);
  return match ? Number(match[1]) : undefined;
}
