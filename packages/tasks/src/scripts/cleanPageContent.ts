/**
 * Clean stored page content to BlockNote's stock style rules: inline code that
 * is also bold/italic/underlined/struck/coloured keeps only the code, code
 * inside a link keeps only the link, a link stored as a text style (`href`)
 * becomes a real link, unknown text styles go (`cleanPageBlocks`,
 * `@classmoji/page-schema`). An operator tool, run once before the page
 * schemas drop the relaxed `code` mark.
 *
 * Which copy of each page is read and how it is written back (the live
 * service for live classrooms, so open editors and git stay in step; git
 * under its sha otherwise) is in `helpers/pageContentCleanup.ts`.
 *
 * DRY RUN by default: reads only (database, git, the collab snapshot, which
 * stores nothing), and prints every page that is not already clean. `--apply`
 * writes, and records a PlatformAuditLog row `page_content.clean` per page
 * written.
 *
 * Output: one tab-separated line per page that is not already clean
 * (classroom, page id, title, status, source, changes, note), then a count
 * per status on stderr. Exit code 1 when a page failed.
 *
 * Usage (on a webapp machine, which carries packages/ and the app's env:
 * DATABASE_URL, the GitHub App / Gitlab settings, COLLAB_URL and
 * COLLAB_INTERNAL_SECRET):
 *   node --experimental-strip-types --no-warnings \
 *     packages/tasks/src/scripts/cleanPageContent.ts <slug> [<slug> …] | --all [--apply]
 */

import type { PrismaClient } from '@classmoji/database/client';
import {
  LiveWriteConflict,
  parseArgs,
  runPageCleanup,
  type CleanupDeps,
  type CleanupPage,
  type LiveRead,
} from '../helpers/pageContentCleanup.ts';

const TAG = '[clean-pages]';
const AUDIT_TOOL = 'script:clean-page-content';
/** Who the live edits are made as (peers see `Classmoji (agent)` while it runs). */
const ACTOR = { userId: AUDIT_TOOL, name: 'Classmoji' };

/** The page row the content services read (as convertLegacyPages selects it). */
const PAGE_SELECT = {
  id: true,
  title: true,
  content_path: true,
  is_draft: true,
  is_public: true,
  header_image_url: true,
  header_image_position: true,
  classroom_id: true,
  classroom: {
    select: {
      id: true,
      slug: true,
      status: true,
      is_archived: true,
      collab_enabled: true,
      content_repo: true,
      content_key_version: true,
      content_delivery_enabled: true,
      git_namespace: true,
      git_organization: true,
    },
  },
} as const;

async function main(): Promise<void> {
  const { selector, apply } = parseArgs(process.argv.slice(2));

  const [{ ClassmojiService }, { default: getPrisma }, schemaServer, collab, collabEnv, hash] =
    await Promise.all([
      import('@classmoji/services'),
      import('@classmoji/database'),
      import('@classmoji/page-schema/server'),
      import('@classmoji/collab'),
      import('@classmoji/collab/env'),
      import('@classmoji/collab/hash'),
    ]);
  const db = getPrisma() as PrismaClient;
  const pageContent = ClassmojiService.pageContent;
  type ServicePage = Parameters<typeof pageContent.loadPageContent>[0];
  const asServicePage = (page: CleanupPage) => page as unknown as ServicePage;

  // Only an explicit COLLAB_URL: the dev fallback (localhost) is never what
  // an operator run means.
  const env = process.env.COLLAB_URL?.trim() ? collabEnv.resolveCollabEnv(process.env) : null;
  if (!env) console.error(`${TAG} COLLAB_URL / COLLAB_INTERNAL_SECRET not set: live pages fail`);
  const collabFetch = async (pageId: string, action: 'snapshot' | 'ops', body?: unknown) => {
    const response = await fetch(
      `${env!.httpUrl}${collab.COLLAB_INTERNAL_PREFIX}/page/${encodeURIComponent(pageId)}/${action}`,
      {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          [collab.COLLAB_SECRET_HEADER]: env!.secret,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      }
    );
    const parsed = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body: parsed };
  };
  const refusal = (status: number, body: Record<string, unknown> | null) =>
    `HTTP ${status}${typeof body?.error === 'string' ? ` ${body.error}` : ''}`;

  const audit = async (page: CleanupPage, data: Record<string, unknown>) => {
    try {
      await db.platformAuditLog.create({
        data: {
          action: 'page_content.clean',
          target_type: 'page',
          target_id: page.id,
          classroom_id: page.classroom.id,
          data: { tool: AUDIT_TOOL, ...data } as never,
        },
      });
    } catch (error) {
      console.error(`${TAG} ${page.id}: cleaned, but the audit row was not written:`, error);
    }
  };

  const deps: CleanupDeps = {
    async findPages(sel) {
      const rows = await db.page.findMany({
        where: sel.kind === 'slugs' ? { classroom: { slug: { in: sel.slugs } } } : {},
        select: PAGE_SELECT,
        orderBy: [{ classroom_id: 'asc' }, { title: 'asc' }],
      });
      if (sel.kind === 'slugs') {
        const found = new Set(rows.map(row => row.classroom.slug));
        const missing = sel.slugs.filter(slug => !found.has(slug));
        if (missing.length > 0) console.error(`${TAG} no pages for: ${missing.join(', ')}`);
      }
      return rows as unknown as CleanupPage[];
    },
    readLive: env
      ? async (pageId): Promise<LiveRead> => {
          const { status, body } = await collabFetch(pageId, 'snapshot');
          if (status === 200) {
            const content = body?.content as { blocks?: unknown } | undefined;
            if (!Array.isArray(content?.blocks)) throw new Error('snapshot without blocks');
            return { kind: 'live', blocks: content.blocks };
          }
          if (status === 422 && body?.error === 'invalid-block') {
            return { kind: 'unloadable', detail: String(body.message ?? 'invalid-block') };
          }
          if (status >= 500 || status === 0)
            throw new Error(`live service ${refusal(status, body)}`);
          return { kind: 'refused', detail: refusal(status, body) };
        }
      : null,
    async hasUnpushedLiveEdits(pageId) {
      const row = await db.collabDoc.findUnique({
        where: { kind_doc_id: { kind: 'page', doc_id: pageId } },
        select: { version: true, pushed_version: true },
      });
      return Boolean(row && row.version !== row.pushed_version);
    },
    async readGit(page) {
      const loaded = await pageContent.loadPageContent(asServicePage(page), { skipCache: true });
      if (loaded.format === 'html') return { kind: 'legacy' };
      if (loaded.format !== 'json' || !loaded.sha) return { kind: 'none' };
      return { kind: 'json', blocks: loaded.blocks as unknown[], sha: loaded.sha };
    },
    hash: hash.itemHash,
    remainingProblems: blocks =>
      schemaServer.validatePageBlocks(blocks).map(p => `${p.blockId ?? 'a block'}: ${p.problem}`),
    writeLive: apply
      ? async (page, ops, expect) => {
          const { status, body } = await collabFetch(page.id, 'ops', { ops, actor: ACTOR, expect });
          if (status === 409 && body?.error === 'block-changed') {
            const ids = Array.isArray(body.changedIds) ? body.changedIds.map(String) : [];
            throw new LiveWriteConflict(ids);
          }
          if (status !== 200) throw new Error(`live write refused: ${refusal(status, body)}`);
          await audit(page, { committed_to: 'live', blocks: ops.map(op => op.id) });
        }
      : null,
    writeGit: apply
      ? async (page, blocks, sha) => {
          const servicePage = asServicePage(page);
          const prepared = await pageContent.preparePageContent(servicePage, blocks);
          const written = await pageContent.writePageContent(servicePage, prepared, {
            expectedSha: sha,
            message: `Clean page content: ${page.title}`,
          });
          // The save's own tail, awaited: this process exits when it is done.
          await pageContent.recordPageFile(
            servicePage,
            prepared.path,
            written.sha,
            prepared.content,
            {
              awaitTail: true,
            }
          );
          await audit(page, { committed_to: 'git', sha: written.sha, commit: written.commit });
        }
      : null,
    log: line => process.stdout.write(`${line}\n`),
  };

  try {
    const summary = await runPageCleanup(deps, selector, { apply });
    const counts = Object.entries(summary.counts)
      .map(([status, n]) => `${status} ${n}`)
      .join(', ');
    console.error(
      `${TAG} ${apply ? 'APPLY' : 'DRY RUN'}: ${summary.pages.length} pages; ${counts}`
    );
    if (summary.counts.failed > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

main().catch(error => {
  console.error(`${TAG} ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
