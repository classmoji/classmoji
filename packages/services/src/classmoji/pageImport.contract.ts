/**
 * pageImport.contract.ts — what the `page-import-convert` Trigger task and its
 * callers (`pageImport.service.ts`: the web app's page imports, MCP
 * `page_create`) must agree on: the task id, the payload and its strict
 * parser, the output, the size limits and the sentences a person reads.
 *
 * In one place because the two halves cannot import each other: the task lives
 * in `@classmoji/tasks`, which depends on this package. Pure: no imports, so
 * both the task and the caller load it without the converter.
 *
 * The task does text conversion only (markdown -> HTML -> page blocks, or HTML
 * -> page blocks). It never sees file bytes: an import's images travel as their
 * names, and the caller commits the files itself.
 */

export const PAGE_IMPORT_CONVERT_TASK_ID = 'page-import-convert';

/**
 * Markdown has no character cap of its own: the serialized-payload guard
 * below is its limit. A Google Docs markdown export embeds its screenshots as
 * `data:` URIs, so a real page can run to megabytes. The parser's bound is
 * that guard in characters, the most that could ever fit in it.
 *
 * Measured (2026-11-23, local, bundled task): 280,000 characters of dense
 * markdown convert in about 3.5 s at a peak of about 470 MB, 840,000 in about
 * 10 s at 1.25 GB with a 7.3 MB output.
 */

/** The longest title a conversion takes (the payload parser's bound). */
export const PAGE_IMPORT_TITLE_MAX_CHARS = 1_000;

/** The most HTML one create may convert: MCP `page_create`'s `html` cap. */
export const PAGE_IMPORT_HTML_MAX_CHARS = 500_000;

/** Images named in one markdown import (names only, never bytes). */
export const PAGE_IMPORT_MAX_IMAGES = 2_000;

/**
 * The serialized payload's ceiling, in bytes. Trigger.dev refuses a trigger
 * payload over 3 MB; characters are not bytes (an emoji is four, an escaped
 * control character six), so the caller measures the JSON it sends and refuses
 * here, with a sentence, rather than letting the trigger fail.
 */
export const PAGE_IMPORT_PAYLOAD_MAX_BYTES = 2_500_000;

/**
 * The serialized output's ceiling, in bytes. Trigger.dev refuses a task output
 * over 10 MB, and blocks can be several times their markdown; the task measures
 * its result and answers `too_large` instead of failing the run.
 */
export const PAGE_IMPORT_OUTPUT_MAX_BYTES = 8_000_000;

/** What a person reads for each way a conversion can end without blocks. */
export const PAGE_IMPORT_MESSAGES = {
  unavailable: 'Importing pages is not available right now.',
  too_large: 'This page is too large to import. Split it into smaller pages and try again.',
  failed: 'This page could not be converted. Check the file and try again.',
  timeout: 'Converting this page took too long. Please try again.',
  title_too_long: `The page title is longer than 1,000 characters. Shorten it and try again.`,
} as const;

export type PageImportFailureCode = keyof typeof PAGE_IMPORT_MESSAGES;

/** `processMarkdownImport`'s options, as the caller knows them. */
export interface PageImportMarkdownOptions {
  org: string;
  repo: string;
  contentPath: string;
  assetsFolder: string;
  provider: string | null;
  /**
   * The slides app's origin, for a Gitlab classroom's image URLs. Passed
   * rather than read in the task, so the worker's environment cannot change
   * the URLs a create writes.
   */
  slidesUrl: string;
}

export type PageImportPayload =
  | { kind: 'html'; html: string; title?: string }
  | {
      kind: 'markdown';
      markdown: string;
      title?: string;
      /** The uploaded images' names, in upload order (the index is the position). */
      images: string[];
      options: PageImportMarkdownOptions;
    };

/** One image reference the markdown matched to an upload. */
export interface PageImportMatchedImage {
  /** The reference as written in the markdown (decoded). */
  originalPath: string;
  /** Position of the upload in the payload's `images`. */
  index: number;
  /** Repo path to commit the upload at (`<assetsFolder>/<newFilename>`). */
  newPath: string;
  newFilename: string;
  /** The URL the page's HTML now points at. */
  githubUrl: string;
}

export type PageImportOutput =
  | {
      ok: true;
      blocks: unknown[];
      /** Markdown only: in `processMarkdownImport`'s image-map order. */
      images?: PageImportMatchedImage[];
      /** Markdown only: positions of the uploads no reference matched. */
      unmatched?: number[];
      /** Markdown only: referenced file names no upload matched. */
      missing?: string[];
    }
  | { ok: false; code: 'too_large' };

const reject = (message: string): never => {
  throw new Error(`[${PAGE_IMPORT_CONVERT_TASK_ID}] ${message}`);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], what: string) {
  const extra = Object.keys(record).filter(key => !allowed.includes(key));
  if (extra.length > 0) reject(`unknown ${what} key(s): ${extra.join(', ')}`);
}

function boundedString(value: unknown, name: string, max: number, { min = 0 } = {}): string {
  if (typeof value !== 'string') return reject(`${name} must be a string`);
  if (value.length < min) return reject(`${name} must not be empty`);
  if (value.length > max) return reject(`${name} is longer than ${max} characters`);
  return value;
}

/**
 * The strict payload guard `schemaTask` runs before `run`: exactly the keys
 * above, every string bounded. Throws on anything else.
 */
export function parsePageImportPayload(input: unknown): PageImportPayload {
  if (!isRecord(input)) return reject('payload must be an object');
  const title =
    input.title === undefined
      ? undefined
      : boundedString(input.title, 'title', PAGE_IMPORT_TITLE_MAX_CHARS);

  if (input.kind === 'html') {
    onlyKeys(input, ['kind', 'html', 'title'], 'payload');
    const html = boundedString(input.html, 'html', PAGE_IMPORT_HTML_MAX_CHARS);
    return { kind: 'html', html, ...(title !== undefined ? { title } : {}) };
  }

  if (input.kind === 'markdown') {
    onlyKeys(input, ['kind', 'markdown', 'title', 'images', 'options'], 'payload');
    const markdown = boundedString(input.markdown, 'markdown', PAGE_IMPORT_PAYLOAD_MAX_BYTES);
    if (!Array.isArray(input.images)) return reject('images must be an array');
    if (input.images.length > PAGE_IMPORT_MAX_IMAGES) {
      return reject(`images holds more than ${PAGE_IMPORT_MAX_IMAGES} names`);
    }
    const images = input.images.map((name, i) => boundedString(name, `images[${i}]`, 1_024));
    if (!isRecord(input.options)) return reject('options must be an object');
    const raw = input.options;
    onlyKeys(
      raw,
      ['org', 'repo', 'contentPath', 'assetsFolder', 'provider', 'slidesUrl'],
      'options'
    );
    if (raw.provider !== null && raw.provider !== 'GITHUB' && raw.provider !== 'GITLAB') {
      return reject('options.provider must be GITHUB, GITLAB or null');
    }
    const options: PageImportMarkdownOptions = {
      org: boundedString(raw.org, 'options.org', 255, { min: 1 }),
      repo: boundedString(raw.repo, 'options.repo', 255, { min: 1 }),
      contentPath: boundedString(raw.contentPath, 'options.contentPath', 1_024, { min: 1 }),
      assetsFolder: boundedString(raw.assetsFolder, 'options.assetsFolder', 1_024, { min: 1 }),
      provider: raw.provider as string | null,
      slidesUrl: boundedString(raw.slidesUrl, 'options.slidesUrl', 2_048),
    };
    return {
      kind: 'markdown',
      markdown,
      images,
      options,
      ...(title !== undefined ? { title } : {}),
    };
  }

  return reject('kind must be "html" or "markdown"');
}

/** The payload's size as Trigger.dev receives it (its JSON, in UTF-8 bytes). */
export function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
