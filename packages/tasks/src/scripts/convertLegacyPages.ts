/**
 * Convert legacy pages (`index.html`, no `content.json`) to blocks, in place:
 * the page keeps its row, id and links; `content.json` is written beside the
 * `index.html`, which stays in git. An operator tool: the pages app no longer
 * converts on read, so a page left with only `index.html` shows empty (with a
 * notice to its staff) until this has run for it.
 *
 * The rules, and why the blocks must be exactly what collab seeds a legacy
 * page with, are in `helpers/legacyPageConversion.ts`. In short: every page
 * is checked against the deployed collab server's own document for it and
 * against the merge collab will run when the file lands, and is written only
 * when that merge provably changes nothing. Pages with unsaved live edits, or
 * open in an editor, are skipped and reported.
 *
 * DRY RUN by default. It writes nothing anywhere:
 *   - refuses to start without `CLASSMOJI_DRY_RUN_ACK=read-only`;
 *   - reads the database through its OWN one-session client on
 *     `DATABASE_URL_UNPOOLED` (the direct endpoint) whose every session
 *     starts read-only (`openReadOnlySession`), checked again before the
 *     report is printed;
 *   - `@classmoji/services` (the git reads, `preparePageContent`) is loaded
 *     only after `DATABASE_URL` is pointed at that same direct endpoint with
 *     the read-only startup parameter, so the services' own client is
 *     read-only too (Gitlab content reads look the classroom up), and that is
 *     checked before anything else runs;
 *   - git: listings and blob reads only; collab: the snapshot read only.
 *   - the writer is not even built: `deps.write` is null.
 * It saves, per legacy page, the `content.json` it WOULD write
 * (`<pageId>.content.json`) and collab's document for the page
 * (`<pageId>.collab.json`), plus `report.json`, under `--out` (default: a new
 * folder in the OS temp dir, printed at the end).
 *
 * `--write` converts: for each page that passes every check, `content.json`
 * is committed create-only (a file that appeared meanwhile is left alone),
 * recorded the way a save records it (asset map, `updated_at`, delivery
 * warm, search index; awaited), and a PlatformAuditLog row
 * `legacy_page.convert` is written. It needs the collab server (COLLAB_URL,
 * COLLAB_INTERNAL_SECRET) and refuses to run without it.
 *
 * Selector, exactly one: `--page <page id>`, `--classroom <git-org-login>/<slug>`
 * or `--all`.
 *
 * Usage (from the repo root, on the commit that is deployed):
 *   CLASSMOJI_DRY_RUN_ACK=read-only infisical run --env=sta -- \
 *     node --experimental-strip-types --no-warnings \
 *     packages/tasks/src/scripts/convertLegacyPages.ts --all [--out <dir>]
 *   infisical run --env=sta -- node --experimental-strip-types --no-warnings \
 *     packages/tasks/src/scripts/convertLegacyPages.ts --page <id> --write
 *
 * Env, dry run: DATABASE_URL_UNPOOLED, CLASSMOJI_DRY_RUN_ACK=read-only, the
 * GitHub App (GITHUB_APP_ID, GITHUB_PRIVATE_KEY_BASE64) and Gitlab settings
 * the content reads use, and COLLAB_URL + COLLAB_INTERNAL_SECRET (without
 * them the run compares with the stored collab rows only and says so).
 * Write: DATABASE_URL, the same git and collab settings.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { PrismaClient } from '@classmoji/database/client';
import {
  formatReport,
  gitlabTokenFreshForDryRun,
  hasFailures,
  parseArgs,
  runLegacyConversion,
  type CollabSnapshot,
  type LegacyDeps,
  type LegacyPageRow,
  type Selector,
} from '../helpers/legacyPageConversion.ts';
import {
  assertReadOnly,
  assertStartedReadOnly,
  directEndpointUrl,
  openReadOnlySession,
  readOnlyStartupUrl,
  requireReadOnlyAck,
} from '../helpers/readOnlyPrisma.ts';

const TAG = '[legacy-pages]';
const AUDIT_TOOL = 'script:convert-legacy-pages';

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
      collab_enabled: true,
      content_repo: true,
      content_key_version: true,
      content_delivery_enabled: true,
      is_archived: true,
      git_namespace: true,
      git_organization: true,
    },
  },
} as const;

function pageWhere(selector: Selector) {
  if (selector.kind === 'page') return { id: selector.pageId };
  if (selector.kind === 'classroom') {
    return { classroom: { slug: selector.slug, git_organization: { login: selector.login } } };
  }
  return {};
}

async function collabSnapshotFetcher(): Promise<
  ((pageId: string) => Promise<CollabSnapshot>) | null
> {
  // Only an explicit COLLAB_URL: the dev fallback (localhost) is never what
  // an operator run means.
  if (!process.env.COLLAB_URL?.trim()) return null;
  const { resolveCollabEnv } = await import('@classmoji/collab/env');
  const { COLLAB_INTERNAL_PREFIX, COLLAB_SECRET_HEADER } = await import('@classmoji/collab');
  const env = resolveCollabEnv(process.env);
  if (!env) return null;
  return async pageId => {
    // No viewer/session: a plain read (an agent's read would be remembered).
    const response = await fetch(
      `${env.httpUrl}${COLLAB_INTERNAL_PREFIX}/page/${encodeURIComponent(pageId)}/snapshot`,
      { headers: { [COLLAB_SECRET_HEADER]: env.secret }, signal: AbortSignal.timeout(30_000) }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as CollabSnapshot;
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const write = options.write;

  let ownSession: PrismaClient | null = null;
  if (!write) {
    requireReadOnlyAck(process.env);
    const { url, host } = directEndpointUrl(process.env.DATABASE_URL_UNPOOLED);
    // Before @classmoji/services or @classmoji/database is loaded (both read it).
    process.env.DATABASE_URL = readOnlyStartupUrl(url);
    ownSession = await openReadOnlySession(url);
    console.error(`${TAG} DRY RUN, connected read-only to ${host}`);
  } else if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required for --write');
  }

  const collabSnapshot = await collabSnapshotFetcher();
  if (write && !collabSnapshot) {
    throw new Error('--write needs the collab server: set COLLAB_URL and COLLAB_INTERNAL_SECRET');
  }
  if (!collabSnapshot) {
    console.error(`${TAG} COLLAB_URL not set: comparing with stored collab rows only`);
  }

  const [{ ClassmojiService, ContentService }, { default: getPrisma }, schemaHtml] =
    await Promise.all([
      import('@classmoji/services'),
      import('@classmoji/database'),
      import('@classmoji/page-schema/html'),
    ]);
  const servicesDb = getPrisma();
  if (!write) {
    // The services' client must be read-only too, before it is used at all.
    await assertStartedReadOnly(servicesDb);
    await assertReadOnly(servicesDb);
  }
  const db = (ownSession ?? servicesDb) as PrismaClient;
  const pageContent = ClassmojiService.pageContent;

  const outDir =
    options.outDir ??
    path.join(tmpdir(), `classmoji-legacy-pages-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  await mkdir(outDir, { recursive: true });

  type ServicePage = Parameters<typeof pageContent.preparePageContent>[0];
  const asServicePage = (page: LegacyPageRow) => page as unknown as ServicePage;
  const gitOrg = (page: { git_organization: unknown }) => page.git_organization as never;

  const deps: LegacyDeps = {
    async findPages(selector) {
      return (await db.page.findMany({
        where: pageWhere(selector),
        select: PAGE_SELECT,
        orderBy: [{ classroom_id: 'asc' }, { created_at: 'asc' }],
      })) as unknown as LegacyPageRow[];
    },
    async listPageFiles(classroom) {
      const files = await ContentService.listFolderFiles({
        gitOrganization: gitOrg(classroom),
        repo: classroom.content_repo!,
        folder: 'pages',
      });
      return new Map(files.map(file => [file.path, file.sha]));
    },
    async readBlob(classroom, sha) {
      const blob = await ContentService.getBlobContent({
        gitOrganization: gitOrg(classroom),
        repo: classroom.content_repo!,
        sha,
      });
      return blob?.content ?? null;
    },
    async pageIdsInClassroom(classroomId, ids) {
      const rows = await db.page.findMany({
        where: { classroom_id: classroomId, id: { in: ids } },
        select: { id: true },
      });
      return new Set(rows.map(row => row.id));
    },
    async collabRow(pageId) {
      const row = await db.collabDoc.findUnique({
        where: { kind_doc_id: { kind: 'page', doc_id: pageId } },
        select: {
          version: true,
          pushed_version: true,
          source_sha: true,
          schema_version: true,
          state: true,
        },
      });
      return row ? { ...row, state: new Uint8Array(row.state) } : null;
    },
    collabSnapshot,
    legacyPageLinkIds: schemaHtml.legacyPageLinkIds,
    convertLegacy: (html, inputs) =>
      schemaHtml.convertLegacyPageHtml(html, {
        ...inputs,
        ensureBlockIds: pageContent.ensureBlockIds,
      }),
    pageOps: pageContent,
    prepare: (page, blocks, coverImage) =>
      pageContent.preparePageContent(asServicePage(page), blocks, { coverImage }),
    write: write
      ? async (page, prepared) => {
          const servicePage = asServicePage(page);
          const { sha, commit } = await pageContent.writePageContent(servicePage, prepared, {
            createOnly: true,
            message: `Convert legacy page to blocks: ${page.title}`,
          });
          // The save's own tail, awaited: this process exits when it is done.
          await pageContent.recordPageFile(servicePage, prepared.path, sha, prepared.content, {
            awaitTail: true,
          });
          // After the commit: a failure here is reported on a page that WAS
          // converted, never as a failed write.
          try {
            await servicesDb.platformAuditLog.create({
              data: {
                action: 'legacy_page.convert',
                target_type: 'page',
                target_id: page.id,
                classroom_id: page.classroom_id,
                data: {
                  tool: AUDIT_TOOL,
                  content_path: page.content_path,
                  path: prepared.path,
                  sha,
                  commit,
                },
              },
            });
          } catch (error) {
            return {
              commit,
              note: `converted, but the audit row was not written: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
          return { commit };
        }
      : null,
    // Dry run only: never let a Gitlab read refresh (and so spend) a token.
    ...(write
      ? {}
      : {
          async gitlabTokenFresh(classroom: LegacyPageRow['classroom']) {
            const connectionId = classroom.git_organization?.gitlab_connection_id;
            // A static token (no connection) is never refreshed.
            if (typeof connectionId !== 'string' || !connectionId) return true;
            const connection = await db.gitLabConnection.findUnique({
              where: { id: connectionId },
              select: { access_token_expires_at: true },
            });
            // No row: the provider fails without a refresh (nothing to spend).
            if (!connection) return true;
            return gitlabTokenFreshForDryRun(connection.access_token_expires_at);
          },
        }),
    async onProgress(summary) {
      // After every page, so a crash mid-run still leaves what was written.
      await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
    },
    async save(pageId, name, text) {
      await writeFile(path.join(outDir, `${pageId}.${name}.json`), `${text}\n`);
    },
    log: line => console.error(line),
  };

  try {
    const summary = await runLegacyConversion(deps, options.selector);
    if (ownSession) await assertReadOnly(ownSession);
    await writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
    process.stdout.write(`${formatReport(summary)}\n`);
    console.error(`${TAG} ${write ? 'WRITE' : 'DRY RUN'} done; files in ${outDir}`);
    if (hasFailures(summary)) {
      console.error(`${TAG} some pages FAILED (see report.json)`);
      process.exitCode = 1;
    }
  } finally {
    await ownSession?.$disconnect();
    await servicesDb.$disconnect().catch(() => {});
  }
}

main().catch(error => {
  console.error(`${TAG} ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
