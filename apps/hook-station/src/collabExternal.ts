/**
 * Outside pushes to a live-editing classroom's content repo.
 *
 * A classroom's pages and decks that are open for live editing live in the
 * collab service (a `collab_docs` row each) and reach git through the
 * checkpoint worker. Anything else that writes the repo (a GitHub web edit, an
 * agent committing directly, an old save path) is an OUTSIDE push, and collab
 * has to hear about it or the next checkpoint silently overwrites it. For
 * every page/deck file such a push changed, this triggers the Trigger.dev task
 * `collab-external` (packages/tasks/src/workflows/collabExternal.ts, by id),
 * which POSTs `/internal/:kind/:id/external { sha, before }` with retries;
 * `sha` is the push's head commit, which collab reads the file at.
 *
 * Who is notified:
 *  - a `collab_enabled` classroom: every changed page/deck;
 *  - a classroom with the flag off but `collab_docs` rows (live state left
 *    over, e.g. the flag was just turned off): the changed docs that have a
 *    row. No rows and no flag: nothing, after one indexed read.
 *
 * Our own pushes are recognised two ways:
 *  1. a commit carrying the `Classmoji-Collab: <run id>` trailer in its final
 *     paragraph, in a push whose sender is a Bot (the worker pushes as the
 *     GitHub App), contributes no paths. A person typing the trailer into a
 *     web edit is a User sender and is not trusted;
 *  2. a doc whose `collab_docs.pushed_commit` equals the push's head commit is
 *     skipped — except on a force-push, which can re-point the branch at a
 *     commit we pushed earlier while the live doc has moved on.
 *
 * Pushes whose commit list is not the whole story — truncated (GitHub's
 * payload holds at most 2048 commits) or forced — get their changed files from
 * GitHub's compare API (installation token). A force-push compares both ways
 * from the merge base, so a file the rewrite dropped back to an older version
 * counts too. When compare is unavailable (no installation, branch created,
 * 300+ files, API error) every `collab_docs` row of the classroom is notified,
 * at most 4 triggers at a time. That is safe because `/external` is harmless
 * on an unchanged file: a live or dirty doc 3-way merges to no change, an idle
 * clean doc is reseeded from git.
 *
 * Everything here is fire-and-forget: errors are logged, never thrown, and the
 * content-asset sync is triggered independently.
 */

/**
 * The checkpoint worker's commit trailer. `COLLAB_COMMIT_TRAILER` in
 * `@classmoji/collab`, repeated here so hook-station doesn't load that
 * package's root (yjs, the deck converter); a test pins the two together.
 */
export const COLLAB_TRAILER = 'Classmoji-Collab';

/** The Trigger.dev task id (packages/tasks/src/workflows/collabExternal.ts). */
export const COLLAB_EXTERNAL_TASK = 'collab-external';

/** GitHub's compare API lists at most this many files. */
const COMPARE_FILE_LIMIT = 300;

/** Triggers in flight at once when every row is notified. */
const FALLBACK_CONCURRENCY = 4;

const ZERO_SHA = /^0+$/;

export type CollabKind = 'page' | 'deck';

export interface CollabPushCommit {
  id?: string;
  message?: string;
  added?: string[];
  modified?: string[];
  removed?: string[];
}

export interface CollabPushInput {
  classroomId: string;
  collabEnabled: boolean;
  /** The push's head commit: what the collab side reads the files at. */
  after: string;
  /** The commit the branch pointed at before the push. */
  before: string | null;
  commits: CollabPushCommit[];
  /** False when GitHub truncated `commits[]`. */
  complete: boolean;
  forced: boolean;
  sender?: { login?: string; type?: string };
}

/** The payload of the `collab-external` task. */
export interface CollabExternalPayload {
  classroomId: string;
  kind: CollabKind;
  docId: string;
  sha: string;
  before: string | null;
}

/** One file of a GitHub compare. */
export interface CompareFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

/** `base...head` files, or null when GitHub can't give the whole list. */
export type CompareFn = (base: string, head: string) => Promise<CompareFile[] | null>;

/** The slice of Prisma this module reads. */
export interface CollabPrisma {
  page: {
    findMany(args: {
      where: { classroom_id: string; content_path: { in: string[] } };
      select: { id: true; content_path: true };
    }): Promise<{ id: string; content_path: string }[]>;
  };
  slide: {
    findMany(args: {
      where: { classroom_id: string; kind: 'DECK'; content_path: { in: string[] } };
      select: { id: true; content_path: true };
    }): Promise<{ id: string; content_path: string }[]>;
  };
  collabDoc: {
    findMany(args: {
      where: { classroom_id: string };
      select: { kind: true; doc_id: true; pushed_commit: true };
    }): Promise<{ kind: string; doc_id: string; pushed_commit: string | null }[]>;
  };
}

export interface CollabNotifyDeps {
  prisma: CollabPrisma;
  /** Trigger the `collab-external` task for one doc. */
  trigger: (payload: CollabExternalPayload) => Promise<void>;
  /** GitHub compare for this repo; absent = never available. */
  compare?: CompareFn;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

const PAGE_FILE = '/content.json';
const DECK_FILE = '/deck.json';
const TRAILER_LINE = new RegExp(`^${COLLAB_TRAILER}:[ \\t]*\\S`);

/**
 * Whether a commit is the checkpoint worker's own: a Bot-sent push and the
 * trailer in the message's final paragraph (where git trailers live).
 */
export function isCollabCommit(
  commit: CollabPushCommit,
  sender: CollabPushInput['sender']
): boolean {
  if (sender?.type !== 'Bot') return false;
  const paragraphs = (commit.message ?? '').trim().split(/\r?\n[ \t]*\r?\n/);
  const last = paragraphs[paragraphs.length - 1] ?? '';
  return last.split(/\r?\n/).some(line => TRAILER_LINE.test(line.trim()));
}

type PathStatus = 'changed' | 'removed';

/**
 * Net status per path from the push's commits that are not ours. Later
 * commits win per path (oldest-first order), so a file written and then
 * deleted in one push counts as removed.
 */
export function pathsFromCommits(
  commits: CollabPushCommit[],
  sender: CollabPushInput['sender']
): Map<string, PathStatus> {
  const status = new Map<string, PathStatus>();
  for (const commit of commits) {
    if (isCollabCommit(commit, sender)) continue;
    for (const path of commit.added ?? []) status.set(path, 'changed');
    for (const path of commit.modified ?? []) status.set(path, 'changed');
    for (const path of commit.removed ?? []) status.set(path, 'removed');
  }
  return status;
}

/** Status at `head` of each file a `base...head` compare lists. */
function headSide(files: CompareFile[]): Map<string, PathStatus> {
  const out = new Map<string, PathStatus>();
  for (const f of files) {
    if (f.status === 'removed') out.set(f.filename, 'removed');
    else {
      if (f.status === 'renamed' && f.previous_filename) out.set(f.previous_filename, 'removed');
      out.set(f.filename, 'changed');
    }
  }
  return out;
}

/**
 * Status at the merge base (= at `after` when `after` didn't touch it) of
 * each file the dropped side of a force-push (`after...before`) lists.
 */
function baseSide(files: CompareFile[]): Map<string, PathStatus> {
  const out = new Map<string, PathStatus>();
  for (const f of files) {
    if (f.status === 'added' || f.status === 'copied') out.set(f.filename, 'removed');
    else if (f.status === 'renamed') {
      out.set(f.filename, 'removed');
      if (f.previous_filename) out.set(f.previous_filename, 'changed');
    } else out.set(f.filename, 'changed');
  }
  return out;
}

/** Paths a push changed per GitHub's compare API, or null when unavailable. */
async function pathsFromCompare(
  input: CollabPushInput,
  compare: CompareFn | undefined
): Promise<Map<string, PathStatus> | null> {
  const { before, after } = input;
  if (!compare || !before || ZERO_SHA.test(before)) return null;
  const forward = await compare(before, after);
  if (!forward) return null;
  if (!input.forced) return headSide(forward);
  // A force-push: files differing between before and after are those either
  // side changed since their merge base.
  const dropped = await compare(after, before);
  if (!dropped) return null;
  const out = baseSide(dropped);
  for (const [path, status] of headSide(forward)) out.set(path, status);
  return out;
}

/** Page and deck directories among the paths, and the doc files removed. */
export function docDirs(paths: Map<string, PathStatus>): {
  pageDirs: string[];
  deckDirs: string[];
  removed: string[];
} {
  const pageDirs = new Set<string>();
  const deckDirs = new Set<string>();
  const removed: string[] = [];
  for (const [path, s] of paths) {
    const isPage = path.endsWith(PAGE_FILE);
    const isDeck = path.endsWith(DECK_FILE);
    if (!isPage && !isDeck) continue;
    if (s === 'removed') {
      removed.push(path);
      continue;
    }
    if (isPage) pageDirs.add(path.slice(0, -PAGE_FILE.length));
    else deckDirs.add(path.slice(0, -DECK_FILE.length));
  }
  return { pageDirs: [...pageDirs], deckDirs: [...deckDirs], removed };
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++] as T);
  });
  await Promise.all(workers);
}

type DocKey = `${CollabKind}:${string}`;

/** Notify the collab service of an outside push. Never throws. */
export async function notifyCollabOfPush(
  input: CollabPushInput,
  deps: CollabNotifyDeps
): Promise<void> {
  const log = deps.log ?? console;
  const { classroomId, after } = input;
  try {
    const unseen = !input.complete || input.forced;
    const visible = unseen ? null : docDirs(pathsFromCommits(input.commits, input.sender));
    // The common case: a push of assets only, or only our own checkpoint.
    if (visible && !visible.pageDirs.length && !visible.deckDirs.length) return;

    const rows = await deps.prisma.collabDoc.findMany({
      where: { classroom_id: classroomId },
      select: { kind: true, doc_id: true, pushed_commit: true },
    });
    if (!input.collabEnabled && !rows.length) return;

    let changed = visible;
    let everyRow = false;
    if (!changed) {
      const paths = await pathsFromCompare(input, deps.compare).catch(err => {
        log.warn(`[collab:external] ${classroomId}: compare failed, notifying every live doc`, err);
        return null;
      });
      if (paths) changed = docDirs(paths);
      else everyRow = true;
    }

    if (changed?.removed.length) {
      log.info(
        `[collab:external] ${classroomId}: content files removed by the push, not merged: ${changed.removed.join(', ')}`
      );
    }

    const [pages, decks] = await Promise.all([
      changed?.pageDirs.length
        ? deps.prisma.page.findMany({
            where: { classroom_id: classroomId, content_path: { in: changed.pageDirs } },
            select: { id: true, content_path: true },
          })
        : [],
      changed?.deckDirs.length
        ? deps.prisma.slide.findMany({
            where: {
              classroom_id: classroomId,
              kind: 'DECK',
              content_path: { in: changed.deckDirs },
            },
            select: { id: true, content_path: true },
          })
        : [],
    ]);

    const pushedCommit = new Map<DocKey, string | null>();
    for (const r of rows) {
      if (r.kind === 'page' || r.kind === 'deck')
        pushedCommit.set(`${r.kind}:${r.doc_id}`, r.pushed_commit);
    }

    const targets = new Set<DocKey>();
    if (everyRow) for (const key of pushedCommit.keys()) targets.add(key);
    for (const p of pages) targets.add(`page:${p.id}`);
    for (const d of decks) targets.add(`deck:${d.id}`);

    const toNotify = [...targets].filter(key => {
      // Flag off: only docs with live state left.
      if (!input.collabEnabled && !pushedCommit.has(key)) return false;
      // Our own checkpoint — unless forced, which can re-point to an old one.
      if (!input.forced && pushedCommit.get(key) === after) return false;
      return true;
    });

    await eachLimited(toNotify, FALLBACK_CONCURRENCY, async key => {
      const [kind, docId] = key.split(':') as [CollabKind, string];
      try {
        await deps.trigger({ classroomId, kind, docId, sha: after, before: input.before });
        log.info(`[collab:external] ${kind}/${docId} @ ${after}: queued`);
      } catch (err) {
        log.error(`[collab:external] ${kind}/${docId} @ ${after}: trigger failed`, err);
      }
    });
  } catch (err) {
    log.error(`[collab:external] ${classroomId}: notify failed`, err);
  }
}

type TasksTrigger = (
  id: string,
  payload: CollabExternalPayload,
  options: { concurrencyKey: string; idempotencyKey: string; idempotencyKeyTTL: string }
) => Promise<unknown>;

/**
 * The real trigger, by task id through `@trigger.dev/sdk` (loaded lazily, as
 * apps/collab does; the SDK is already in hook-station's process through
 * `@classmoji/tasks`). `concurrencyKey: classroomId` with the task's
 * concurrency-1 queue applies one classroom's notifications in order; the
 * idempotency key makes a redelivered webhook a no-op.
 */
export function createCollabExternalTrigger(
  loadTrigger: () => Promise<TasksTrigger> = async () => {
    const { tasks } = await import('@trigger.dev/sdk');
    return (id, payload, options) => tasks.trigger(id, payload, options);
  }
): CollabNotifyDeps['trigger'] {
  let trigger: Promise<TasksTrigger> | null = null;
  return async payload => {
    trigger ??= loadTrigger();
    await (
      await trigger
    )(COLLAB_EXTERNAL_TASK, payload, {
      concurrencyKey: payload.classroomId,
      idempotencyKey: `collab-external:${payload.kind}:${payload.docId}:${payload.before ?? ''}..${payload.sha}`,
      idempotencyKeyTTL: '1h',
    });
  };
}

export interface CompareOrganization {
  provider: string;
  github_installation_id: string | null;
  login: string | null;
}

/**
 * GitHub's compare API for one repo, with a contents:read installation token
 * from the existing GitHubProvider. Null (never throws) when there is no
 * installation, the call fails, or the file list is truncated.
 */
export function createGithubCompare(
  org: CompareOrganization | null | undefined,
  owner: string,
  repo: string,
  deps: {
    fetch?: typeof fetch;
    getToken?: () => Promise<string>;
    log?: Pick<Console, 'warn'>;
  } = {}
): CompareFn | undefined {
  if (!org || org.provider !== 'GITHUB' || !org.github_installation_id) return undefined;
  const getToken =
    deps.getToken ??
    (async () => {
      const { getGitProvider } = await import('@classmoji/services');
      const provider = getGitProvider(org) as unknown as {
        getInstallationToken(scope?: {
          repositories?: string[];
          permissions?: Record<string, string>;
        }): Promise<{ token: string }>;
      };
      const { token } = await provider.getInstallationToken({
        repositories: [repo],
        permissions: { contents: 'read' },
      });
      return token;
    });
  const log = deps.log ?? console;

  return async (base, head) => {
    try {
      const token = await getToken();
      const response = await (deps.fetch ?? fetch)(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${base}...${head}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(15_000),
        }
      );
      if (!response.ok) {
        log.warn(
          `[collab:external] compare ${owner}/${repo} ${base}...${head}: HTTP ${response.status}`
        );
        return null;
      }
      const body = (await response.json()) as { files?: CompareFile[] };
      const files = body.files ?? [];
      return files.length >= COMPARE_FILE_LIMIT ? null : files;
    } catch (err) {
      log.warn(`[collab:external] compare ${owner}/${repo} ${base}...${head} failed`, err);
      return null;
    }
  };
}
