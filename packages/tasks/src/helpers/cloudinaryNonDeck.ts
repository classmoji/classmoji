/**
 * REPORT-ONLY sweep for Cloudinary URLs of our cloud OUTSIDE decks — the
 * "every active reference" of plan §10.2, so nothing still pointing at
 * Cloudinary is a surprise when the account is cancelled. Never migrated,
 * never rewritten: the output is a list for a person to act on.
 *
 * Two places:
 *   - pages' content files (`content.json`, legacy `index.html`) in the
 *     content repo, through the same GET-only GitHub reader as the decks;
 *   - database rows of the tables below, by a read-only SELECT per table
 *     whose WHERE is `to_jsonb(t)::text ILIKE '%cloudinary.com%'` — every
 *     column of the row, so a column added later is still covered. The
 *     matching columns are then named from the row itself.
 *
 * Imports nothing that opens a database client (the dry-run CLI loads it).
 */

/**
 * Tables whose rows hold instructor-written text or links: module, assignment
 * and repository descriptions, quiz prompts, form text and fields (draft and
 * published revisions), calendar descriptions and meeting links, page header
 * images, slide source URLs, and the class-site config.
 *
 * Deliberately absent: `classroom_settings` (holds API keys; no URL columns),
 * `git_organizations` (tokens), student-written tables (form answers, quiz
 * attempts, AI conversations), caches (`content_index`, `docs_index`) and logs.
 * Resource links (`page_links`, `slide_links`, module items) hold ids, not URLs.
 */
export const NON_DECK_TABLES = [
  'modules',
  'assignments',
  'repositories',
  'quizzes',
  'forms',
  'form_revisions',
  'calendar_events',
  'calendar_event_overrides',
  'pages',
  'slides',
  'classroom_sites',
] as const;

export type NonDeckTable = (typeof NON_DECK_TABLES)[number];

/** A table name, checked against the allowlist: it is interpolated into SQL. */
export function assertNonDeckTable(table: string): asserts table is NonDeckTable {
  if (!(NON_DECK_TABLES as readonly string[]).includes(table)) {
    throw new Error(`not a swept table: ${table}`);
  }
}

/**
 * The SELECT for one table. Read-only by construction (a SELECT) and run
 * inside the CLI's read-only session. `$1` is the ILIKE pattern.
 */
export function nonDeckQuery(table: NonDeckTable): string {
  assertNonDeckTable(table);
  return `SELECT to_jsonb(t) AS row FROM "${table}" t WHERE to_jsonb(t)::text ILIKE $1`;
}

/** Deliberately broad; our cloud is picked out of the matches in JS. */
export const NON_DECK_ILIKE = '%cloudinary.com%';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every URL of our cloud in `text` — any resource type, any delivery form. */
export function ourCloudUrls(text: string, cloudName: string): string[] {
  const cloud = escapeRegExp(cloudName);
  const pattern = new RegExp(
    `(?:https?:)?//(?:res(?:-\\d+)?\\.cloudinary\\.com/${cloud}|${cloud}-res\\.cloudinary\\.com)/[^\\s"'<>\\\\\`()]+`,
    'gi'
  );
  return [...new Set(text.match(pattern) ?? [])];
}

export interface PageRecord {
  pageId: string;
  classroomId: string;
  title: string;
  contentPath: string;
}

export interface PageRead {
  files: { path: string; text: string }[];
  unscanned: string | null;
}

export type NonDeckReference =
  | {
      source: 'page-file';
      classroomId: string;
      pageId: string;
      title: string;
      path: string;
      urls: string[];
    }
  | {
      source: 'db';
      table: NonDeckTable;
      column: string;
      rowId: string | null;
      classroomId: string | null;
      urls: string[];
    };

export interface NonDeckSweep {
  references: NonDeckReference[];
  /** Pages and tables that could not be read, with why. */
  unscanned: { location: string; reason: string }[];
}

export interface NonDeckDeps {
  cloudName: string;
  readPage(page: PageRecord): Promise<PageRead>;
  /** Rows of `table` matching `NON_DECK_ILIKE`, each as its `to_jsonb` object. */
  queryTable(table: NonDeckTable): Promise<Record<string, unknown>[]>;
  concurrency?: number;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** The sweep. Never throws for one page or one table; those are `unscanned`. */
export async function sweepNonDeck(deps: NonDeckDeps, pages: PageRecord[]): Promise<NonDeckSweep> {
  const references: NonDeckReference[] = [];
  const unscanned: NonDeckSweep['unscanned'] = [];

  const reads = await mapLimited(pages, deps.concurrency ?? 4, async page => {
    try {
      return { page, read: await deps.readPage(page) };
    } catch (error) {
      return { page, read: { files: [], unscanned: `read failed: ${errText(error)}` } };
    }
  });
  for (const { page, read } of reads) {
    if (read.unscanned) {
      unscanned.push({
        location: `page ${page.pageId} (${page.contentPath})`,
        reason: read.unscanned,
      });
      continue;
    }
    for (const file of read.files) {
      const urls = ourCloudUrls(file.text, deps.cloudName);
      if (urls.length === 0) continue;
      references.push({
        source: 'page-file',
        classroomId: page.classroomId,
        pageId: page.pageId,
        title: page.title,
        path: file.path,
        urls,
      });
    }
  }

  for (const table of NON_DECK_TABLES) {
    let rows: Record<string, unknown>[];
    try {
      rows = await deps.queryTable(table);
    } catch (error) {
      unscanned.push({ location: `table ${table}`, reason: errText(error) });
      continue;
    }
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        if (value === null || value === undefined) continue;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        const urls = ourCloudUrls(text, deps.cloudName);
        if (urls.length === 0) continue;
        references.push({
          source: 'db',
          table,
          column,
          rowId: typeof row.id === 'string' ? row.id : null,
          classroomId: typeof row.classroom_id === 'string' ? row.classroom_id : null,
          urls,
        });
      }
    }
  }

  return { references, unscanned };
}
