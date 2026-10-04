/**
 * Outside pushes to a live-editing classroom's content repo.
 *
 * When a classroom has `collab_enabled`, its pages and decks live in the
 * collab service and reach git through the checkpoint worker. Anything else
 * that writes the repo (a GitHub web edit, an agent committing directly, an
 * old save path) is an OUTSIDE push, and the collab service has to hear about
 * it or the next checkpoint silently overwrites it. For every page/deck file
 * the push changed, this POSTs `${COLLAB_URL}/internal/:kind/:id/external`
 * `{ sha }`, where `sha` is the push's head commit (`after`): the collab side
 * reads the file at that commit and 3-way merges it into the live doc, or
 * reseeds an idle one.
 *
 * Our own pushes are recognised two ways:
 *  1. a commit whose message carries the `Classmoji-Collab: <run id>` trailer
 *     is the checkpoint worker's and contributes no paths (primary guard —
 *     the webhook can arrive before the worker records `pushed_commit`);
 *  2. a doc whose `collab_docs.pushed_commit` equals the push's head commit
 *     is skipped (second guard).
 *
 * A push GitHub truncated (its `commits[]` caps at 20) or a force-push does
 * not tell us every file it changed. Then EVERY `collab_docs` row of the
 * classroom is notified as possibly changed, plus whatever the visible commits
 * name. That is safe because `/external` is harmless on an unchanged file: a
 * live or dirty doc 3-way merges with theirs == base (a no-op), an idle clean
 * doc is reseeded from git (exactly right after an unseen change). Docs with
 * no row are not live anywhere; their next open seeds from git anyway.
 *
 * Everything here is fire-and-forget: errors are logged, never thrown, and
 * the content-asset sync is triggered independently of it.
 */
import { COLLAB_COMMIT_TRAILER, COLLAB_SECRET_HEADER, type CollabKind } from '@classmoji/collab';
import { resolveCollabEnv } from '@classmoji/collab/env';

export interface CollabPushCommit {
  id?: string;
  message?: string;
  added?: string[];
  modified?: string[];
  removed?: string[];
}

export interface CollabPushInput {
  classroomId: string;
  /** The push's head commit: what the collab side reads the files at. */
  after: string;
  commits: CollabPushCommit[];
  /** False when GitHub truncated `commits[]`. */
  complete: boolean;
  forced: boolean;
}

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
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
  timeoutMs?: number;
}

const PAGE_FILE = '/content.json';
const DECK_FILE = '/deck.json';
const TRAILER_LINE = new RegExp(`^${COLLAB_COMMIT_TRAILER}:`, 'm');

/** Whether a commit is the checkpoint worker's own (carries the trailer). */
export function isCollabCommit(commit: CollabPushCommit): boolean {
  return TRAILER_LINE.test(commit.message ?? '');
}

/**
 * Page / deck directories the push changed and left in place, from commits
 * that are not ours. Later commits win per path (oldest-first order), so a
 * file written and then deleted in one push counts as removed.
 */
export function changedDocDirs(commits: CollabPushCommit[]): {
  pageDirs: string[];
  deckDirs: string[];
  removed: string[];
} {
  const status = new Map<string, 'changed' | 'removed'>();
  for (const commit of commits) {
    if (isCollabCommit(commit)) continue;
    for (const path of commit.added ?? []) status.set(path, 'changed');
    for (const path of commit.modified ?? []) status.set(path, 'changed');
    for (const path of commit.removed ?? []) status.set(path, 'removed');
  }

  const pageDirs = new Set<string>();
  const deckDirs = new Set<string>();
  const removed: string[] = [];
  for (const [path, s] of status) {
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

type DocKey = `${CollabKind}:${string}`;

/** Notify the collab service of an outside push. Never throws. */
export async function notifyCollabOfPush(
  input: CollabPushInput,
  deps: CollabNotifyDeps
): Promise<void> {
  const log = deps.log ?? console;
  try {
    const collab = resolveCollabEnv(deps.env ?? process.env);
    if (!collab) {
      log.warn('[collab:external] COLLAB_URL / COLLAB_INTERNAL_SECRET unset; not notifying');
      return;
    }

    const { classroomId, after } = input;
    const { pageDirs, deckDirs, removed } = changedDocDirs(input.commits);
    if (removed.length) {
      log.info(
        `[collab:external] ${classroomId}: content files removed by the push, not merged: ${removed.join(', ')}`
      );
    }
    const unseen = !input.complete || input.forced;
    // The common case: a push of assets only, or only our own checkpoint.
    if (!unseen && !pageDirs.length && !deckDirs.length) return;

    const [pages, decks, rows] = await Promise.all([
      pageDirs.length
        ? deps.prisma.page.findMany({
            where: { classroom_id: classroomId, content_path: { in: pageDirs } },
            select: { id: true, content_path: true },
          })
        : [],
      deckDirs.length
        ? deps.prisma.slide.findMany({
            where: { classroom_id: classroomId, kind: 'DECK', content_path: { in: deckDirs } },
            select: { id: true, content_path: true },
          })
        : [],
      deps.prisma.collabDoc.findMany({
        where: { classroom_id: classroomId },
        select: { kind: true, doc_id: true, pushed_commit: true },
      }),
    ]);

    const pushedCommit = new Map<DocKey, string | null>(
      rows.map(r => [`${r.kind as CollabKind}:${r.doc_id}`, r.pushed_commit])
    );

    const targets = new Set<DocKey>();
    for (const p of pages) targets.add(`page:${p.id}`);
    for (const d of decks) targets.add(`deck:${d.id}`);
    if (unseen) {
      for (const r of rows) {
        if (r.kind === 'page' || r.kind === 'deck') targets.add(`${r.kind}:${r.doc_id}`);
      }
    }

    const doFetch = deps.fetch ?? globalThis.fetch;
    await Promise.all(
      [...targets].map(async key => {
        if (pushedCommit.get(key) === after) return; // our own checkpoint
        const [kind, id] = key.split(':') as [CollabKind, string];
        try {
          const response = await doFetch(
            `${collab.httpUrl}/internal/${kind}/${encodeURIComponent(id)}/external`,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                [COLLAB_SECRET_HEADER]: collab.secret,
              },
              body: JSON.stringify({ sha: after }),
              signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
            }
          );
          const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
          if (!response.ok) {
            log.error(
              `[collab:external] ${kind}/${id} @ ${after}: HTTP ${response.status} ${JSON.stringify(body)}`
            );
            return;
          }
          const conflicts = Array.isArray(body?.conflicts)
            ? ` conflicts=${body.conflicts.length}`
            : '';
          log.info(
            `[collab:external] ${kind}/${id} @ ${after}: ${String(body?.action ?? 'ok')}${conflicts}`
          );
        } catch (err) {
          log.error(`[collab:external] ${kind}/${id} @ ${after}: collab unreachable`, err);
        }
      })
    );
  } catch (err) {
    log.error(`[collab:external] ${input.classroomId}: notify failed`, err);
  }
}
