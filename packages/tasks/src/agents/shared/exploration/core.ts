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
 *
 * The steps themselves are `workflows/exploreRepo.ts`, reused as is, so the
 * legacy task and the in-process path read, pick and excerpt the same way.
 * Log lines carry counts only: the focus area names the question the quiz is
 * about to ask.
 */
import type Anthropic from '@anthropic-ai/sdk';
// eslint-disable-next-line import/no-unresolved -- trigger.dev v3 resolved at runtime
import { logger } from '@trigger.dev/sdk/v3';
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
} from '../../../workflows/exploreRepo.ts';

export type { ExploreResult, Excerpt } from '../../../workflows/exploreRepo.ts';

export type ExploreDepth = 'shallow' | 'focused' | 'deep';

export type ExploreRepositoryInput = {
  owner: string;
  repo: string;
  token: string;
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
  client: Anthropic;
  signal: AbortSignal;
  /** One call per file read, with the path only; `error` when the read failed. */
  onFileRead: (path: string, o?: { error: true }) => void;
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
 * The client as the exploration steps see it: every `messages.create` carries
 * the turn's signal, so an abort cancels the request in flight. The steps call
 * nothing else on the client.
 */
function clientWithSignal(client: Anthropic, signal: AbortSignal): Anthropic {
  const messages = {
    create: (body: Anthropic.MessageCreateParamsNonStreaming, options?: Record<string, unknown>) =>
      client.messages.create(body, { ...(options ?? {}), signal }),
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
  const client = clientWithSignal(i.client, signal);

  throwIfStopped(signal);
  const tree = (await untilAborted(fetchRepoTree(owner, repo, token), signal)).filter(
    isExplorableEntry
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
    tree
  );

  throwIfStopped(signal);
  const files = await untilAborted(fetchMultipleFiles(owner, repo, filePaths, token), signal);
  throwIfStopped(signal);
  for (const file of files) {
    if (file.error) i.onFileRead(file.path, { error: true });
    else i.onFileRead(file.path);
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
      '. Explore a different focus area.'
    );
  }
  const header = [
    `Exploration for focus area "${focusArea}".`,
    `Exact code from the student's repository; each line starts with its line number ("N| "), which is not part of the code.`,
    paths.length ? `Excerpted files: ${paths.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `${header}\n\n${result.excerptText}`;
}

/** GitHub refused the token: 401 expired or revoked, 403/404 no access. */
const GITHUB_ACCESS_ERROR = /failed \((?:401|403|404)\)/;

/** The longest error text passed to the quiz model. */
const MAX_MODEL_ERROR_CHARS = 400;

/**
 * An error message made safe for the quiz model, which may relay it: tokens,
 * credential-carrying URLs and URLs with query strings are cut, the rest is
 * capped.
 */
export function sanitizeExplorationError(message: unknown): string {
  const text = String(message || 'unknown error')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+/g, '[redacted token]')
    .replace(/x-access-token:[^@\s]+/g, 'x-access-token:[redacted]')
    .replace(/https?:\/\/\S+\?\S*/g, '[redacted url]')
    .trim();
  return text.length > MAX_MODEL_ERROR_CHARS ? `${text.slice(0, MAX_MODEL_ERROR_CHARS)}…` : text;
}

/** What the quiz model is told when an exploration fails. */
export function explorationFailureText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const message = sanitizeExplorationError(raw);
  if (GITHUB_ACCESS_ERROR.test(raw)) {
    return (
      `Exploration failed: GitHub refused the repository access token (${message}). ` +
      'The next explore_codebase call gets a fresh one, so retry once before telling the student anything.'
    );
  }
  return `Exploration failed: ${message}. The code explorer could not finish this request; you may retry once.`;
}
