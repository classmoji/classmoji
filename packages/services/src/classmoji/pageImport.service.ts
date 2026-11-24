/**
 * Page import conversion, run on Trigger.dev.
 *
 * Markdown -> HTML -> page blocks (a web import) and HTML -> page blocks (MCP
 * `page_create`'s `html`) need jsdom, BlockNote's server editor and prettier's
 * Node build, none of which the web app or the MCP server may load (they are
 * moving to Cloudflare Workers). So the text conversion, and only it, runs as
 * the `page-import-convert` task (`packages/tasks/src/workflows/pageImportConvert.ts`),
 * and the callers trigger it and wait for its output with a deadline. Files,
 * commits, the page row and the audit row stay with the caller.
 *
 * Every way a conversion ends without blocks is a `PageImportError` whose
 * message a person can read; nothing is created by then, since callers convert
 * before `page.createPage`.
 *
 * The task is triggered by its string id (this package cannot import
 * `@classmoji/tasks`, which depends on it). The task is pure, so a wait that
 * gives up leaves nothing behind: the run is cancelled (best effort) and
 * carries a short `ttl` in case it was still queued.
 */
import { runs, tasks } from '@trigger.dev/sdk';
import { waitForRunOutcome } from '../helper/runWait.ts';
import { isTriggerConfigured } from '../helper/triggerConfig.ts';
import {
  PAGE_IMPORT_CONVERT_TASK_ID,
  PAGE_IMPORT_HTML_MAX_CHARS,
  PAGE_IMPORT_MAX_IMAGES,
  PAGE_IMPORT_MESSAGES,
  PAGE_IMPORT_PAYLOAD_MAX_BYTES,
  PAGE_IMPORT_TITLE_MAX_CHARS,
  serializedBytes,
  type PageImportFailureCode,
  type PageImportMarkdownOptions,
  type PageImportMatchedImage,
  type PageImportOutput,
  type PageImportPayload,
} from './pageImport.contract.ts';

export {
  PAGE_IMPORT_CONVERT_TASK_ID,
  PAGE_IMPORT_MESSAGES,
  type PageImportMatchedImage,
} from './pageImport.contract.ts';

export const PAGE_IMPORT_ERROR = 'PAGE_IMPORT_ERROR';

/**
 * A conversion that produced no blocks; `message` is the sentence to show.
 * (No parameter properties: the MCP server runs this file with Node's type
 * stripping, which refuses them.)
 */
export class PageImportError extends Error {
  readonly code = PAGE_IMPORT_ERROR;
  readonly reason: PageImportFailureCode;
  readonly runId?: string;
  readonly status: string | null;
  constructor(
    reason: PageImportFailureCode,
    options?: { cause?: unknown; runId?: string; status?: string | null }
  ) {
    super(PAGE_IMPORT_MESSAGES[reason], options?.cause ? { cause: options.cause } : undefined);
    this.name = 'PageImportError';
    this.reason = reason;
    this.runId = options?.runId;
    this.status = options?.status ?? null;
  }
}

export const isPageImportError = (error: unknown): error is PageImportError =>
  error instanceof PageImportError ||
  (error instanceof Error && (error as { code?: unknown }).code === PAGE_IMPORT_ERROR);

/**
 * Whether this process can convert an import: Trigger.dev is configured here.
 * Without it the web app offers Create Blank only and MCP `page_create`
 * refuses `html`.
 */
export const isPageImportAvailable = (): boolean => isTriggerConfigured();

/**
 * How long a caller waits for the run by default (the web imports): wait plus
 * commit stays under the proxy's idle limit. MCP `page_create` passes 30 s.
 */
export const PAGE_IMPORT_WAIT_MS = 35_000;

/**
 * Run statuses that end the wait at once as `unavailable`: `PENDING_VERSION`
 * is a run for a task the deployed worker does not have yet (the web app or
 * the MCP server deployed before the Trigger worker).
 */
const UNAVAILABLE_RUN_STATUSES = ['PENDING_VERSION'] as const;

/** How long a run may sit in the queue before Trigger.dev drops it. */
const RUN_TTL = '2m';

type WaitOptions = { timeoutMs?: number };

async function runConversion(
  payload: PageImportPayload,
  { timeoutMs = PAGE_IMPORT_WAIT_MS }: WaitOptions
): Promise<{ output: Extract<PageImportOutput, { ok: true }>; runId: string }> {
  if (!isPageImportAvailable()) throw new PageImportError('unavailable');
  if (serializedBytes(payload) > PAGE_IMPORT_PAYLOAD_MAX_BYTES) {
    throw new PageImportError('too_large');
  }

  let runId: string;
  try {
    const handle = await tasks.trigger(PAGE_IMPORT_CONVERT_TASK_ID, payload, { ttl: RUN_TTL });
    runId = handle.id;
  } catch (error) {
    console.error('[pageImport] could not start the conversion:', error);
    throw new PageImportError('failed', { cause: error });
  }

  const waited = await waitForRunOutcome(runId, {
    timeoutMs,
    pollMs: 500,
    maxPollMs: 3_000,
    callTimeoutMs: 10_000,
    failFastStatuses: UNAVAILABLE_RUN_STATUSES,
  });

  // Pure, so nothing to undo; cancelled so it does not run for nobody.
  const cancel = () =>
    void Promise.resolve()
      .then(() => runs.cancel(runId))
      .catch(() => {});

  if (waited.outcome === 'failed' && waited.status === 'PENDING_VERSION') {
    cancel();
    console.warn(`[pageImport] run ${runId} is waiting for a worker that has the task`);
    throw new PageImportError('unavailable', { runId, status: waited.status });
  }
  if (waited.outcome === 'timeout') {
    cancel();
    console.warn(`[pageImport] run ${runId} did not finish in time (last status ${waited.status})`);
    throw new PageImportError('timeout', { runId, status: waited.status });
  }
  if (waited.outcome === 'failed') {
    console.error(`[pageImport] run ${runId} ended ${waited.status}`);
    throw new PageImportError('failed', { runId, status: waited.status });
  }

  const output = waited.output as PageImportOutput | undefined;
  if (output && typeof output === 'object' && output.ok === false) {
    throw new PageImportError(output.code === 'too_large' ? 'too_large' : 'failed', { runId });
  }
  if (!output || output.ok !== true || !Array.isArray(output.blocks)) {
    console.error(`[pageImport] run ${runId} completed without blocks`);
    throw new PageImportError('failed', { runId, status: 'COMPLETED' });
  }
  return { output, runId };
}

/** A title the conversion would refuse, refused here with a sentence instead. */
export function assertImportTitle(title: string | undefined): void {
  if (title && title.length > PAGE_IMPORT_TITLE_MAX_CHARS) {
    throw new PageImportError('title_too_long');
  }
}

/** HTML (MCP `page_create`'s `html`) -> the page's blocks. */
export async function convertHtml(
  { html, title }: { html: string; title?: string },
  options: WaitOptions = {}
): Promise<unknown[]> {
  assertImportTitle(title);
  if (html.length > PAGE_IMPORT_HTML_MAX_CHARS) throw new PageImportError('too_large');
  const { output } = await runConversion(
    { kind: 'html', html, ...(title ? { title } : {}) },
    options
  );
  return output.blocks;
}

export interface MarkdownConversion {
  blocks: unknown[];
  /** Each reference matched to an upload, in the importer's order. */
  images: PageImportMatchedImage[];
  /** Positions (in `images` as passed) of the uploads no reference matched. */
  unmatched: number[];
  missing: string[];
}

/**
 * A markdown import -> its blocks, plus where each uploaded image goes. The
 * task does `processMarkdownImport` (images by name only), wraps the HTML in
 * the import's document (`wrapHtmlContent`, width 2) and converts it.
 */
export async function convertMarkdown(
  {
    markdown,
    title,
    imageNames,
    options: importOptions,
  }: {
    markdown: string;
    title?: string;
    /** The uploads' names, in upload order. */
    imageNames: string[];
    options: Omit<PageImportMarkdownOptions, 'slidesUrl' | 'provider'> & {
      provider?: string | null;
      slidesUrl?: string;
    };
  },
  options: WaitOptions = {}
): Promise<MarkdownConversion> {
  assertImportTitle(title);
  // Markdown has no character cap: the serialized-payload guard in
  // runConversion is its limit (a Google Docs export embeds `data:` images).
  if (imageNames.length > PAGE_IMPORT_MAX_IMAGES) throw new PageImportError('too_large');
  const { output, runId } = await runConversion(
    {
      kind: 'markdown',
      markdown,
      images: imageNames,
      options: {
        org: importOptions.org,
        repo: importOptions.repo,
        contentPath: importOptions.contentPath,
        assetsFolder: importOptions.assetsFolder,
        provider: importOptions.provider ?? null,
        slidesUrl: importOptions.slidesUrl ?? process.env.SLIDES_URL ?? '',
      },
      ...(title ? { title } : {}),
    },
    options
  );
  return readMarkdownAnswer(output as unknown as Record<string, unknown> & { blocks: unknown[] }, {
    uploads: imageNames.length,
    assetsFolder: importOptions.assetsFolder,
    runId,
  });
}

/**
 * The file name the importer gives a matched upload (`name-<timestamp>.ext`,
 * lower-cased, dash-safe): one path segment, no `..`. A leading `-` is what
 * the importer writes for a name that starts with a symbol (`_x.png`).
 */
const SAFE_ASSET_FILENAME = /^[a-z0-9-][a-z0-9.-]*$/;

/**
 * The task's answer, read as data: every field type-checked, every upload
 * position one the caller has, every file name one path segment. Each
 * matched upload's `newPath` is REBUILT from the caller's own assets folder;
 * the path in the answer is never used. Anything else is a failed conversion,
 * and the caller creates nothing.
 */
function readMarkdownAnswer(
  output: Record<string, unknown> & { blocks: unknown[] },
  { uploads, assetsFolder, runId }: { uploads: number; assetsFolder: string; runId?: string }
): MarkdownConversion {
  const broken = (why: string): never => {
    console.error(`[pageImport] run ${runId ?? '?'} answered a broken markdown result: ${why}`);
    throw new PageImportError('failed', { runId });
  };
  const known = (index: unknown): index is number =>
    Number.isInteger(index) && (index as number) >= 0 && (index as number) < uploads;
  const asArray = (value: unknown, name: string): unknown[] =>
    value === undefined ? [] : Array.isArray(value) ? value : broken(`${name} is not an array`);

  const images = asArray(output.images, 'images').map((raw, i): PageImportMatchedImage => {
    if (!raw || typeof raw !== 'object') return broken(`images[${i}] is not an object`);
    const image = raw as Record<string, unknown>;
    const { originalPath, index, newFilename, githubUrl } = image;
    if (!known(index)) return broken(`images[${i}].index`);
    if (typeof originalPath !== 'string' || typeof githubUrl !== 'string') {
      return broken(`images[${i}] fields`);
    }
    if (
      typeof newFilename !== 'string' ||
      !SAFE_ASSET_FILENAME.test(newFilename) ||
      newFilename.includes('..')
    ) {
      return broken(`images[${i}].newFilename`);
    }
    return {
      originalPath,
      index,
      newFilename,
      newPath: `${assetsFolder}/${newFilename}`,
      githubUrl,
    };
  });
  const unmatched = asArray(output.unmatched, 'unmatched').map((index, i) =>
    known(index) ? index : broken(`unmatched[${i}]`)
  );
  const missing = asArray(output.missing, 'missing').map((name, i) =>
    typeof name === 'string' ? name : broken(`missing[${i}]`)
  );
  return { blocks: output.blocks, images, unmatched, missing };
}
