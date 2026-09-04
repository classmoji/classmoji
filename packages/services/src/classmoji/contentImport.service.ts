/**
 * contentImport.service.ts — copy a source classroom's page + slide-deck
 * content into a target classroom, as DRAFTS (full-featured classroom import).
 *
 * Composes existing machinery rather than hand-rolling GitHub/DB plumbing:
 *  - target content repo is provisioned by page.service.ensureContentRepo
 *    (the same lazy repo-ensure the page/slide create flows use);
 *  - files are read verbatim from the source repo's MAIN branch and re-committed
 *    with ContentService.uploadBatch (ONE commit per content type);
 *  - the target manifest is refreshed the same way create/delete flows do
 *    (contentManifest.saveManifest, which rebuilds it wholesale from the DB).
 *
 * Verbatim copy: every source file is read as raw base64 and written back as
 * base64, so text (deck.json / index.html / content.json) and binary assets are
 * byte-perfect. In particular the deck's generated index.html is copied as-is —
 * never regenerated — so the deck.json/index.html pair stays consistent.
 *
 * Preview branches (`preview/<content_path>`) are never read, written, or
 * cleaned: reads target MAIN only.
 */

import getPrisma from '@classmoji/database';
import { ContentService } from '../content/ContentService.ts';
import { contentProxyBase, isCommitRef, pagesContentBase, splitRawRef } from './contentRefs.ts';
import { lookupContentAssetsBySha } from './contentAssets.service.ts';
import { getGitProvider } from '../git/index.ts';
import * as contentManifestService from './contentManifest.service.ts';
import { createWithUniquePageSlug, ensureContentRepo, isPageSlugConflict } from './page.service.ts';
import type { Prisma } from '@prisma/client';

// GitHub Contents API caps single-file reads at 1MB; larger files return no
// usable content, so they are skipped with a warning (task requirement).
const ONE_MB = 1024 * 1024;

/** Cap on retained warnings and on per-warning detail length (bounded output). */
const MAX_WARNINGS = 50;
const WARNING_DETAIL_MAX = 200;

export interface ContentImportOptions {
  pages?: boolean;
  slides?: boolean;
  /**
   * Optional per-item progress. Invoked as each page/deck folder finishes
   * READING (the slow, network-bound part) and once more after the DB rows
   * land. Never awaited for correctness: the caller fires-and-forgets, so a
   * progress failure can never fail an import.
   */
  onProgress?: (update: {
    kind: 'pages' | 'slides';
    done: number;
    total: number;
  }) => void | Promise<void>;
}

/** Named once so both per-type passes can take the same callback. */
type ContentProgressFn = NonNullable<ContentImportOptions['onProgress']>;

export interface ContentImportSummary {
  pages: number;
  slides: number;
  /** source Page id → new Page id */
  page_id_map: Record<string, string>;
  /** source Slide id → new Slide id */
  slide_id_map: Record<string, string>;
  /** per-item failures, capped detail */
  warnings: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (unit-tested — no DB/GitHub)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Route-slug for a title: lowercase, every run of non-alphanumerics → '-',
 * leading/trailing '-' trimmed. This is the IDENTICAL computation page.service
 * (`pageContentPath`) and slide.service (`slideSlug`) use for the content-path
 * segment; duplicated locally so this file never imports the slides subtree
 * (which pulls cheerio through the root barrel).
 */
export function routeSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * First of `base`, then `suffix(base, 2)`, `suffix(base, 3)`, … that is not in
 * `taken`. Pure: does not mutate `taken` (the caller adds the winner).
 */
export function dedupe(
  base: string,
  taken: ReadonlySet<string>,
  suffix: (base: string, n: number) => string
): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(suffix(base, n))) n++;
  return suffix(base, n);
}

/** Slug collision suffix: `lab-1` → `lab-1-2`. */
export const slugSuffix = (base: string, n: number): string => `${base}-${n}`;

/** Title collision suffix: `Lab 1` → `Lab 1 (2)`. */
export const titleSuffix = (base: string, n: number): string => `${base} (${n})`;

/**
 * Rewrite a source file path (which lives under `sourcePrefix`) to sit under
 * `targetPrefix`, preserving any nested sub-path (e.g. `assets/x.png`).
 */
export function remapFilePath(
  filePath: string,
  sourcePrefix: string,
  targetPrefix: string
): string {
  if (!filePath.startsWith(sourcePrefix)) {
    // Defensive: a path outside the folder keeps only its basename.
    const name = filePath.split('/').pop() ?? filePath;
    return `${targetPrefix}/${name}`;
  }
  const rest = filePath.slice(sourcePrefix.length).replace(/^\//, '');
  return rest ? `${targetPrefix}/${rest}` : targetPrefix;
}

/** Format one warning with truncated detail: `scope: detail…`. */
export function formatWarning(scope: string, detail: string): string {
  const trimmed =
    detail.length > WARNING_DETAIL_MAX ? `${detail.slice(0, WARNING_DETAIL_MAX)}…` : detail;
  return `${scope}: ${trimmed}`;
}

/** File extensions whose contents get source→target URL rewriting. */
const TEXT_EXTENSIONS = /\.(json|html?|md|css|js|txt|svg)$/i;

/** true when the path names a text file safe to URL-rewrite (never binaries). */
export function isTextContentPath(path: string): boolean {
  return TEXT_EXTENSIONS.test(path);
}

export interface UrlRewriteContext {
  sourceLogin: string;
  sourceRepo: string;
  /** This item's folder in the source repo (e.g. `pages/lab-1`). */
  sourcePath: string;
  targetLogin: string;
  targetRepo: string;
  /** This item's folder in the target repo (may carry a dedupe suffix). */
  targetPath: string;
  /**
   * Signed-blob sha → the SOURCE repo path holding it, from the source
   * classroom's asset map. The only way back from `/c/{id}/blob/{sha}.{ext}`,
   * which names content and not location. Absent shas are left verbatim and
   * warned about — see `rewriteSignedUrls`.
   */
  shaPaths?: ReadonlyMap<string, string>;
  /** Where an unresolvable signed URL is reported. Defaults to console.warn. */
  onWarn?: (detail: string) => void;
}

const RAW_HOST = 'https://raw.githubusercontent.com';

/** `.slidesthemes/{theme}` — where a signed theme URL's bytes actually live. */
const THEMES_FOLDER = '.slidesthemes';

/**
 * Every reference shape the app has ever stored, and what a copy must do to it.
 *
 * Content is authored across years and surfaces, so one page's `content.json`
 * can hold all of these at once:
 *
 *   1. `raw.githubusercontent.com/{login}/{repo}/{branch}/{path}` — on ANY
 *      branch, not just `main`; a repo whose default is `master`, or content
 *      hand-authored against a working branch, writes something else.
 *   2. `{login}.github.io/{repo}/{path}` — the Pages CDN.
 *   3. `/content/{login}/{repo}/{path}` — the slides app's same-origin proxy.
 *   4. A BARE repo path (`pages/lab-1/assets/d.png`) — what pages store now
 *      that the delivery layer signs at render time, so it is the shape most
 *      new content is in.
 *   5. One of OUR signed URLs — `/c/{classroomId}/blob/…`, `/theme/…`,
 *      `/missing/…`.
 *
 * The first four are the same thing with different prefixes: swap the source
 * repo's prefix for the target's. The fifth cannot be copied at all. A signed
 * URL is bound to the SOURCE classroom's id and key version, and the imported
 * copy renders under a different classroom — so copying one verbatim produces a
 * link that is not stale, it is permanently unauthorized, and the image is gone
 * the moment anyone loads the page. They are turned back into repo paths
 * instead, and the target classroom signs them itself on its next render.
 *
 * Order matters. Signed URLs resolve to bare SOURCE paths first, so the
 * item-specific folder rewrite below then carries them onto the target's
 * (possibly dedupe-suffixed) folder like any other bare path. Within each
 * shape the item-specific rewrite runs before the repo-general one, which
 * catches cross-item references — those keep their original folder, correct
 * whenever that item was imported un-renamed; a renamed cross-referenced item
 * is a documented residual.
 *
 * RESIDUALS this does not fix, and cannot from here:
 *
 *   - A recovered `/theme/` reference becomes `.slidesthemes/{name}`, which is
 *     outside any item's `sourcePath` and so is carried across unchanged. It
 *     resolves only if the TARGET repo already has a theme by that name —
 *     shared themes are per-repo and an import copies pages and decks, not the
 *     `.slidesthemes/` folder. A deck importing onto a repo without that theme
 *     falls back to its own CSS, which is visible and fixable; inventing a
 *     theme copy here would not be.
 *   - A cross-item bare path (`pages/lab-9/…`) keeps its folder, for the same
 *     reason and with the same caveat as the URL shapes above.
 */
export function rewriteContentUrls(text: string, ctx: UrlRewriteContext): string {
  const rawSourcePrefix = `${RAW_HOST}/${ctx.sourceLogin}/${ctx.sourceRepo}/`;
  const rawTargetPrefix = `${RAW_HOST}/${ctx.targetLogin}/${ctx.targetRepo}/`;

  const withPaths = rewriteSignedUrls(text, ctx);

  // Branch-agnostic: the branch segment is consumed positionally and carried
  // across unchanged. Normalizing it would mean guessing the TARGET repo's
  // default branch, which nothing here knows, and `main` is exactly the guess
  // that broke this in the first place.
  const prefixed = rewriteRawUrls(withPaths, rawSourcePrefix, rawTargetPrefix, ctx);

  const bases: [string, string][] = [
    [
      pagesContentBase(ctx.sourceLogin, ctx.sourceRepo),
      pagesContentBase(ctx.targetLogin, ctx.targetRepo),
    ],
    [
      contentProxyBase(ctx.sourceLogin, ctx.sourceRepo),
      contentProxyBase(ctx.targetLogin, ctx.targetRepo),
    ],
  ];

  const rewritten = bases.reduce(
    (acc, [sourceBase, targetBase]) =>
      acc
        .replaceAll(`${sourceBase}/${ctx.sourcePath}/`, `${targetBase}/${ctx.targetPath}/`)
        .replaceAll(`${sourceBase}/`, `${targetBase}/`),
    prefixed
  );

  return rewriteBarePaths(rewritten, ctx);
}

/**
 * The raw shape, on whatever ref the reference happens to name.
 *
 * The ref is whatever `splitRawRef` says it is — including the fully-qualified
 * `refs/heads/main` that GitHub's own Raw button emits, which is why this does
 * not just take the first segment. Getting that wrong is not cosmetic: `refs`
 * would be read as the branch, the item folder would never be recognized, and
 * the copied page would point at `…/{target}/heads/main/pages/lab-1/…` — a path
 * that exists in no repo at all.
 *
 * A COMMIT-pinned URL is left entirely alone, repo swap included. It asks for
 * one exact historical revision, and that commit exists only in the SOURCE
 * repo — a fresh import's target has none of its history. Pointing it at the
 * target guarantees a 404, where leaving it at least resolves for as long as
 * the source repo is around.
 */
function rewriteRawUrls(
  text: string,
  sourcePrefix: string,
  targetPrefix: string,
  ctx: UrlRewriteContext
): string {
  // Everything after the repo, up to the first delimiter, so surrounding markup
  // or JSON is never swallowed; `splitRawRef` then separates ref from path.
  const pattern = new RegExp(`${escapeRegExp(sourcePrefix)}([^\\s"'()<>]*)`, 'g');
  const itemPrefix = ctx.sourcePath ? `${ctx.sourcePath}/` : '';

  return text.replace(pattern, (match, rest: string) => {
    const split = splitRawRef(rest);
    if (!split || isCommitRef(split.ref)) return match;

    const mapped =
      itemPrefix && split.path.startsWith(itemPrefix)
        ? `${ctx.targetPath}/${split.path.slice(itemPrefix.length)}`
        : split.path;
    return `${targetPrefix}${split.ref}/${mapped}`;
  });
}

/**
 * A bare repo path under THIS item's folder → the same path under the target's.
 *
 * Anchored on a value boundary — a quote, a bracket, whitespace, start of text
 * — and never mid-string. A blanket replace would reach inside an unrelated
 * org's absolute URL that happens to contain the same folder name and corrupt
 * it, and the absolute shapes above have already handled every occurrence that
 * legitimately belongs to this repo.
 *
 * Skipped when the item's folder does not move: a whole-repo clone copies every
 * path unchanged and passes an empty `sourcePath`, where a prefix rewrite is
 * meaningless.
 */
function rewriteBarePaths(text: string, ctx: UrlRewriteContext): string {
  if (!ctx.sourcePath || ctx.sourcePath === ctx.targetPath) return text;

  // `=` and `,` are deliberately NOT boundaries: a foreign URL's query string
  // (`?src=pages/lab-1/a.png`) would otherwise be rewritten inside a link this
  // import has no business touching.
  const pattern = new RegExp(`(^|["'(\\s>])${escapeRegExp(ctx.sourcePath)}/`, 'g');
  return text.replace(pattern, (_match, lead: string) => `${lead}${ctx.targetPath}/`);
}

/**
 * `/c/{classroomId}/{blob|theme|missing}/…` — the shapes OUR delivery layer
 * emits, matched by path rather than by host because the origin is deployment
 * configuration and staging, production and local all differ.
 *
 * The classroom-id class assumes a UUID (hex and dashes). `Classroom.id` is
 * `@default(uuid())` and has been since the model existed; if that ever changes
 * to a slug or a cuid, this stops matching and signed URLs start being copied
 * verbatim again — silently, since a non-match is indistinguishable from
 * ordinary text.
 */
const SIGNED_URL_PATTERN =
  /(?:https?:\/\/[^\s"'()<>]+)?\/c\/[0-9a-fA-F-]{8,36}\/(blob|theme|missing)\/([^\s"'()<>]*)/g;

/** The signed-blob shas a piece of text references, for a map lookup. */
export function collectSignedBlobShas(text: string): string[] {
  const shas = new Set<string>();
  for (const [, kind, tail] of text.matchAll(SIGNED_URL_PATTERN)) {
    if (kind !== 'blob') continue;
    const sha = blobShaOf(tail);
    if (sha) shas.add(sha);
  }
  return [...shas];
}

/**
 * Turn our own signed URLs back into bare SOURCE repo paths.
 *
 * Each kind knows a different amount about where its bytes live:
 *
 *   `missing` carries the original reference verbatim in its path — it is the
 *   resolver saying "I could not find this", so the ref it could not find is
 *   right there and needs only decoding.
 *
 *   `theme` names the theme, and a theme always lives at `.slidesthemes/{name}`
 *   — derivable with no lookup at all.
 *
 *   `blob` names CONTENT, not location: a sha and an extension, deliberately,
 *   because that is what lets the edge cache it forever. Only the source
 *   classroom's asset map can say which path held it, so an unresolvable sha is
 *   left exactly as it was and warned about. Leaving it is the lesser harm:
 *   the URL is already broken in the copy, and inventing a path would put a
 *   confidently wrong reference into content nobody will think to check.
 */
function rewriteSignedUrls(text: string, ctx: UrlRewriteContext): string {
  const warn = ctx.onWarn ?? ((detail: string) => console.warn(`[contentImport] ${detail}`));

  return text.replace(SIGNED_URL_PATTERN, (match, kind: string, tail: string) => {
    if (kind === 'missing') {
      return decodePathOnce(stripQuery(tail)) || match;
    }

    if (kind === 'theme') {
      // `{theme}/{treeSha}/{policy}/{rest}` — the first segment is the theme,
      // the next two are addressing and authorization, and anything after them
      // is the path inside the folder.
      const [theme, , , ...rest] = stripQuery(tail).split('/');
      if (!theme) return match;
      const inside = rest.filter(Boolean).join('/');
      return inside ? `${THEMES_FOLDER}/${theme}/${inside}` : `${THEMES_FOLDER}/${theme}`;
    }

    const sha = blobShaOf(tail);
    const path = sha ? ctx.shaPaths?.get(sha) : undefined;
    if (path) return path;

    warn(
      `left a signed URL unrewritten — the source classroom's asset map has no path for ` +
        `${sha ?? 'an unreadable sha'}; the imported copy will not load it`
    );
    return match;
  });
}

/** `{sha}.{ext}` (plus any query) → the sha, or null if it is not one. */
function blobShaOf(tail: string): string | null {
  const name = stripQuery(tail).split('/')[0] ?? '';
  const sha = name.slice(0, name.indexOf('.') === -1 ? name.length : name.indexOf('.'));
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
}

function stripQuery(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

function decodePathOnce(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A staged write alongside its decoded text, so the utf8 round trip happens
 * once.
 *
 * The import needs to READ every text file before it rewrites any of them — the
 * signed-blob shas across the whole batch are resolved in a single query — and
 * decoding in both passes meant base64-decoding a course's entire content
 * twice. `text` is null for binaries, which are never decoded at all: their
 * bytes are not valid utf8 and a round trip would replace them with U+FFFD.
 */
export interface DecodedFile {
  file: BatchFile;
  text: string | null;
}

/** Decode the text files of a staged batch; binaries carry a null text. */
export function decodeStagedFiles(files: BatchFile[]): DecodedFile[] {
  return files.map(file => ({
    file,
    text: isTextContentPath(file.path)
      ? Buffer.from(file.content, 'base64').toString('utf8')
      : null,
  }));
}

/** Rewrite already-decoded staged files; binaries pass through untouched. */
export function rewriteDecodedFiles(decoded: DecodedFile[], ctx: UrlRewriteContext): BatchFile[] {
  return decoded.map(({ file, text }) => {
    if (text === null) return file;
    const rewritten = rewriteContentUrls(text, ctx);
    if (rewritten === text) return file;
    return { ...file, content: Buffer.from(rewritten, 'utf8').toString('base64') };
  });
}

/**
 * Apply `rewriteContentUrls` to the text files in a staged item's writes
 * (base64-decoded, rewritten, re-encoded); binaries pass through untouched.
 */
export function rewriteStagedFiles(files: BatchFile[], ctx: UrlRewriteContext): BatchFile[] {
  return rewriteDecodedFiles(decodeStagedFiles(files), ctx);
}

// ─────────────────────────────────────────────────────────────────────────────
// Impl helpers (touch DB/GitHub — not unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

// Structural git-org shape ContentService + the git provider accept.
interface GitOrgRecord {
  id: string;
  provider: string;
  login: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  gitlab_group_id?: string | null;
}

interface RepoContext {
  classroomId: string;
  gitOrganization: GitOrgRecord;
  login: string;
  repo: string;
  slug: string;
}

type WarnFn = (scope: string, detail: string) => void;

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Fire-and-forget progress. Progress reporting must never fail (or slow) an
 * import, so the result is deliberately not awaited and every error is
 * swallowed — including a synchronous throw from a bad callback.
 */
function emitProgress<T>(
  onProgress: ((update: T) => void | Promise<void>) | undefined,
  update: T
): void {
  if (!onProgress) return;
  try {
    void Promise.resolve(onProgress(update)).catch(() => {});
  } catch {
    // ignore
  }
}

/**
 * Load a classroom's content-repo coordinates. Returns null when the classroom
 * (or its git org / content repo) is not configured — the caller turns that
 * into a zeros+warning result for the SOURCE side, or a throw for TARGET.
 */
async function loadRepoContext(classroomId: string): Promise<RepoContext | null> {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });
  const gitOrganization = classroom?.git_organization as GitOrgRecord | null | undefined;
  if (!classroom || !gitOrganization?.login || !classroom.content_repo) {
    return null;
  }
  return {
    classroomId,
    gitOrganization,
    login: gitOrganization.login,
    repo: classroom.content_repo,
    slug: classroom.slug,
  };
}

type BatchFile = { path: string; content: string; encoding: 'base64' };

/**
 * Recursively read every file under `sourcePath` on the source repo's MAIN
 * branch, remapping each path to sit under `targetPath`. Files >1MB are skipped
 * with a warning. Returns the base64 file writes for a later batch commit.
 * Reads are ref-pinned to 'main' (also bypasses the per-process response cache).
 */
async function collectFolderFiles({
  source,
  sourcePath,
  targetPath,
  scope,
  warn,
}: {
  source: RepoContext;
  sourcePath: string;
  targetPath: string;
  scope: string;
  warn: WarnFn;
}): Promise<BatchFile[]> {
  const collected: BatchFile[] = [];

  const walk = async (dirPath: string): Promise<void> => {
    const entries = await ContentService.listFolder({
      gitOrganization: source.gitOrganization,
      repo: source.repo,
      path: dirPath,
      ref: 'main',
    });
    for (const entry of entries) {
      if (entry.type === 'dir') {
        await walk(entry.path);
        continue;
      }
      const meta = await ContentService.getMeta({
        gitOrganization: source.gitOrganization,
        repo: source.repo,
        path: entry.path,
        ref: 'main',
      });
      if (meta && meta.size > ONE_MB) {
        warn(scope, `skipped ${entry.path} (>1MB, ${meta.size} bytes)`);
        continue;
      }
      const file = await ContentService.getContent({
        gitOrganization: source.gitOrganization,
        repo: source.repo,
        path: entry.path,
        ref: 'main',
        raw: true,
      });
      if (!file) {
        warn(scope, `could not read ${entry.path}`);
        continue;
      }
      collected.push({
        path: remapFilePath(entry.path, sourcePath, targetPath),
        content: file.content,
        encoding: 'base64',
      });
    }
  };

  await walk(sourcePath);
  return collected;
}

/** A source content row staged for import after its files were read. */
interface StagedItem<Source> {
  source: Source;
  files: DecodedFile[];
  targetTitle: string;
  targetSlug: string;
  targetContentPath: string;
}

/**
 * Resolve every signed-blob sha an import references back to SOURCE repo paths,
 * in one query for the whole run.
 *
 * A signed URL names content (a sha), not location, so the only way to recover
 * a path is the source classroom's own asset map. Resolved here, in the import,
 * because the rewriter itself is pure — it is called from a Trigger task and
 * from a local clone helper, neither of which should acquire a database.
 *
 * ONE query, for the whole batch, once. Per-sha lookups inside the staging loop
 * made this a round trip per image per page, on the code path whose entire job
 * is copying a course's worth of images.
 *
 * Best effort throughout: a sha the map has never heard of simply stays out of
 * the map, and the rewriter leaves that URL alone and warns. An import must not
 * fail over a reference it could not tidy up.
 */
export async function resolveShaPaths(
  classroomId: string,
  texts: string[]
): Promise<ReadonlyMap<string, string>> {
  const shas = [...new Set(texts.flatMap(text => collectSignedBlobShas(text)))];
  if (shas.length === 0) return new Map();

  try {
    return await lookupContentAssetsBySha(classroomId, shas);
  } catch {
    return new Map();
  }
}

/** Every decoded text a staged item carries, for the sha sweep. */
function stagedTexts<Source>(items: StagedItem<Source>[]): string[] {
  return items.flatMap(item =>
    item.files.map(file => file.text).filter((text): text is string => text !== null)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Copy all pages and/or all slide decks from `sourceClassroomId` into
 * `targetClassroomId` as drafts, byte-perfect, returning id maps for
 * module-item remapping.
 *
 * Resilience:
 *  - a source with no configured content repo → zeros + a warning;
 *  - a target that cannot be provisioned (missing org/namespace, repo-create
 *    failure) THROWS — an unwritable target is a caller error, not per-item;
 *  - per-item read/DB failures and a per-type commit failure → warning + skip;
 *  - EXCEPT a page-slug unique violation, which THROWS all the way out. It
 *    means the slug allocator's premise is broken, and every page after it
 *    would be dropped the same silent way. A caller that sees this must not
 *    treat the import as finished.
 */
export const importClassroomContent = async (
  sourceClassroomId: string,
  targetClassroomId: string,
  createdByUserId: string,
  opts: ContentImportOptions
): Promise<ContentImportSummary> => {
  const warnings: string[] = [];
  const warn: WarnFn = (scope, detail) => {
    if (warnings.length >= MAX_WARNINGS) return;
    warnings.push(formatWarning(scope, detail));
  };

  const summary: ContentImportSummary = {
    pages: 0,
    slides: 0,
    page_id_map: {},
    slide_id_map: {},
    warnings,
  };

  const wantPages = opts.pages === true;
  const wantSlides = opts.slides === true;
  if (!wantPages && !wantSlides) {
    return summary;
  }

  // ── Source side: resolve coordinates and confirm the content repo exists ──
  const source = await loadRepoContext(sourceClassroomId);
  if (!source) {
    warn('source', 'source classroom has no configured content repository');
    return summary;
  }
  let sourceRepoExists = false;
  try {
    const provider = getGitProvider(source.gitOrganization);
    sourceRepoExists = await provider.repositoryExists(source.login, source.repo);
  } catch (error: unknown) {
    warn('source', `could not check source content repo: ${errText(error)}`);
    return summary;
  }
  if (!sourceRepoExists) {
    warn('source', `source content repository ${source.repo} does not exist`);
    return summary;
  }

  // ── Target side: ensure the content repo exists (THROWS if unprovisionable) ──
  const target = await loadRepoContext(targetClassroomId);
  if (!target) {
    // Mirror ensureContentRepo's own error surface for an unconfigured target.
    throw new Error('Target classroom content repository is not configured');
  }
  await ensureContentRepo(targetClassroomId);

  const commitMessage = `Import content from ${source.slug}`;
  let createdAny = false;

  // ── Pages ──
  if (wantPages) {
    try {
      const created = await importPages({
        source,
        target,
        createdByUserId,
        commitMessage,
        warn,
        idMap: summary.page_id_map,
        onProgress: opts.onProgress,
      });
      summary.pages = created;
      if (created > 0) createdAny = true;
    } catch (error: unknown) {
      // The one failure this pass does NOT absorb. importPages rethrows a slug
      // P2002 rather than warning (see the row loop); catching it here would
      // put it straight back where it came from — a warning on a summary the
      // caller still reads as success — only now with every page lost instead
      // of one. It has to leave the orchestrator.
      if (isPageSlugConflict(error)) throw error;
      warn('pages', `page import failed: ${errText(error)}`);
    }
  }

  // ── Slides ──
  if (wantSlides) {
    try {
      const created = await importSlides({
        source,
        target,
        createdByUserId,
        commitMessage,
        warn,
        idMap: summary.slide_id_map,
        onProgress: opts.onProgress,
      });
      summary.slides = created;
      if (created > 0) createdAny = true;
    } catch (error: unknown) {
      warn('slides', `slide import failed: ${errText(error)}`);
    }
  }

  // ── Manifest refresh (once, non-fatal — mirrors create/delete flows) ──
  if (createdAny) {
    try {
      await contentManifestService.saveManifest(targetClassroomId);
    } catch (error: unknown) {
      warn('manifest', `failed to refresh target manifest: ${errText(error)}`);
    }
  }

  return summary;
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-type import passes
// ─────────────────────────────────────────────────────────────────────────────

type SourcePage = Prisma.PageGetPayload<Record<string, never>>;

async function importPages({
  source,
  target,
  createdByUserId,
  commitMessage,
  warn,
  idMap,
  onProgress,
}: {
  source: RepoContext;
  target: RepoContext;
  createdByUserId: string;
  commitMessage: string;
  warn: WarnFn;
  idMap: Record<string, string>;
  onProgress?: ContentProgressFn;
}): Promise<number> {
  const sourcePages = await getPrisma().page.findMany({
    where: { classroom_id: source.classroomId },
    orderBy: { created_at: 'asc' },
  });
  // The real total lands before the empty-set return, so the bar sizes itself
  // the moment the phase starts even when there is nothing to copy.
  const total = sourcePages.length;
  emitProgress(onProgress, { kind: 'pages', done: 0, total });
  if (sourcePages.length === 0) return 0;

  // Seed collision sets from existing TARGET rows.
  const targetPages = await getPrisma().page.findMany({
    where: { classroom_id: target.classroomId },
    select: { title: true, content_path: true },
  });
  const takenTitles = new Set(targetPages.map(p => p.title));
  const takenSlugs = new Set(targetPages.map(p => p.content_path.replace(/^pages\//, '')));

  const staged: StagedItem<SourcePage>[] = [];
  let consumed = 0;

  for (const page of sourcePages) {
    // `finally` owns the count, not the end of the body: every skip below is a
    // `continue`, and `done` tracks source pages CONSUMED, not pages staged.
    try {
      const base = routeSlug(page.title);
      if (!base) {
        warn('pages', `skipped "${page.title}" — title has no slug-able characters`);
        continue;
      }
      const targetSlug = dedupe(base, takenSlugs, slugSuffix);
      takenSlugs.add(targetSlug);
      const targetTitle = dedupe(page.title, takenTitles, titleSuffix);
      takenTitles.add(targetTitle);
      const targetContentPath = `pages/${targetSlug}`;

      let files: BatchFile[];
      try {
        files = await collectFolderFiles({
          source,
          sourcePath: page.content_path,
          targetPath: targetContentPath,
          scope: 'pages',
          warn,
        });
      } catch (error: unknown) {
        warn('pages', `skipped "${page.title}" — read failed: ${errText(error)}`);
        continue;
      }
      if (files.length === 0) {
        warn('pages', `skipped "${page.title}" — no files at ${page.content_path}`);
        continue;
      }
      // Staged DECODED and un-rewritten. The rewrite needs the signed-blob
      // shas of the whole batch resolved first, and that is one query for the
      // run rather than one per page — see resolveShaPaths.
      staged.push({
        source: page,
        files: decodeStagedFiles(files),
        targetTitle,
        targetSlug,
        targetContentPath,
      });
    } finally {
      consumed++;
      emitProgress(onProgress, { kind: 'pages', done: consumed, total });
    }
  }

  if (staged.length === 0) return 0;

  // Repoint source-repo asset references at the copied files — otherwise
  // deleting the source classroom (with GitHub cleanup) 404s every image. The
  // header images go into the same sweep: they are stored on the row rather
  // than in the files, but they are the same repo and the same shapes.
  const shaPaths = await resolveShaPaths(source.classroomId, [
    ...stagedTexts(staged),
    ...staged.map(item => item.source.header_image_url ?? ''),
  ]);

  const written = staged.map(item => ({
    item,
    files: rewriteDecodedFiles(item.files, {
      sourceLogin: source.login,
      sourceRepo: source.repo,
      sourcePath: item.source.content_path,
      targetLogin: target.login,
      targetRepo: target.repo,
      targetPath: item.targetContentPath,
      shaPaths,
    }),
  }));

  // ONE commit for all page files.
  try {
    await ContentService.uploadBatch({
      gitOrganization: target.gitOrganization,
      repo: target.repo,
      files: written.flatMap(w => w.files),
      branch: 'main',
      message: commitMessage,
    });
  } catch (error: unknown) {
    warn('pages', `page content commit failed: ${errText(error)}`);
    return 0;
  }

  // DB rows AFTER the commit (GitHub-first, mirroring createPage).
  let created = 0;
  for (const item of staged) {
    try {
      // Slug allocation goes through the shared walker, not a bare
      // titleToIdentifier: `slug` is unique per classroom now, and two source
      // pages can normalize to one slug ("Lab 1" and "Lab-1"). Writing the
      // derived value straight in would make the second page 23505 and be
      // swallowed by the warn below — an import that silently drops a page.
      // It also returns '' for a title with no usable characters, which the
      // unique index treats as an ordinary, collidable value.
      const row = await createWithUniquePageSlug(item.targetTitle, slug =>
        getPrisma().page.create({
          data: {
            classroom_id: target.classroomId,
            title: item.targetTitle,
            slug,
            content_path: item.targetContentPath,
            created_by: createdByUserId,
            is_draft: true,
            is_public: false,
            width: item.source.width,
            show_in_student_menu: item.source.show_in_student_menu,
            menu_order: item.source.menu_order,
            // Same source→target URL repoint as the file contents get.
            header_image_url: item.source.header_image_url
              ? rewriteContentUrls(item.source.header_image_url, {
                  sourceLogin: source.login,
                  sourceRepo: source.repo,
                  sourcePath: item.source.content_path,
                  targetLogin: target.login,
                  targetRepo: target.repo,
                  targetPath: item.targetContentPath,
                  shaPaths,
                })
              : item.source.header_image_url,
            header_image_position: item.source.header_image_position,
          } satisfies Prisma.PageUncheckedCreateInput,
        })
      );
      idMap[item.source.id] = row.id;
      created++;
    } catch (error: unknown) {
      // A slug collision must never be downgraded to a warning. The walker
      // above already absorbs every 23505 it can act on and exhausts into
      // PAGE_SLUG_UNAVAILABLE, so a raw P2002 on [classroom_id, slug] arriving
      // HERE means the walker's premise is broken — the likeliest cause being
      // code running against a database whose unique index predates it, where
      // `slug` was written straight through. Warning would then drop pages
      // silently, one per collision, and report the import as a success with a
      // line of noise. Fail the import instead: it is retryable, a half-empty
      // classroom is not.
      if (isPageSlugConflict(error)) throw error;
      warn('pages', `DB row failed for "${item.targetTitle}": ${errText(error)}`);
    }
  }
  // The phase is finished once the rows land — say so explicitly rather than
  // leaving the bar on whatever the last staging tick reported.
  emitProgress(onProgress, { kind: 'pages', done: total, total });
  return created;
}

type SourceSlide = Prisma.SlideGetPayload<Record<string, never>>;

async function importSlides({
  source,
  target,
  createdByUserId,
  commitMessage,
  warn,
  idMap,
  onProgress,
}: {
  source: RepoContext;
  target: RepoContext;
  createdByUserId: string;
  commitMessage: string;
  warn: WarnFn;
  idMap: Record<string, string>;
  onProgress?: ContentProgressFn;
}): Promise<number> {
  const sourceSlides = await getPrisma().slide.findMany({
    where: { classroom_id: source.classroomId },
    orderBy: { created_at: 'asc' },
  });
  // Same as pages: the real total before the empty-set return.
  const total = sourceSlides.length;
  emitProgress(onProgress, { kind: 'slides', done: 0, total });
  if (sourceSlides.length === 0) return 0;

  // Slides carry a [classroom_id, slug] unique constraint — slug drives both the
  // constraint and the content path, so one dedupe set covers both.
  const targetSlides = await getPrisma().slide.findMany({
    where: { classroom_id: target.classroomId },
    select: { slug: true },
  });
  const takenSlugs = new Set(targetSlides.map(s => s.slug));

  const staged: StagedItem<SourceSlide>[] = [];
  let consumed = 0;

  for (const slide of sourceSlides) {
    // `finally` owns the count, not the end of the body: every skip below is a
    // `continue`, and `done` tracks source decks CONSUMED, not decks staged.
    try {
      const base = routeSlug(slide.title);
      if (!base) {
        warn('slides', `skipped "${slide.title}" — title has no slug-able characters`);
        continue;
      }
      const targetSlug = dedupe(base, takenSlugs, slugSuffix);
      takenSlugs.add(targetSlug);
      const targetContentPath = `slides/${targetSlug}`;

      let files: BatchFile[];
      try {
        files = await collectFolderFiles({
          source,
          sourcePath: slide.content_path,
          targetPath: targetContentPath,
          scope: 'slides',
          warn,
        });
      } catch (error: unknown) {
        warn('slides', `skipped "${slide.title}" — read failed: ${errText(error)}`);
        continue;
      }
      if (files.length === 0) {
        warn('slides', `skipped "${slide.title}" — no files at ${slide.content_path}`);
        continue;
      }
      // Staged DECODED and un-rewritten — the whole batch's signed-blob shas
      // resolve in one query below, not one per deck.
      staged.push({
        source: slide,
        files: decodeStagedFiles(files),
        targetTitle: slide.title,
        targetSlug,
        targetContentPath,
      });
    } finally {
      consumed++;
      emitProgress(onProgress, { kind: 'slides', done: consumed, total });
    }
  }

  if (staged.length === 0) return 0;

  // Repoint source-repo asset references at the copied files (deck.json +
  // index.html are rewritten in lockstep, keeping the pair consistent).
  const shaPaths = await resolveShaPaths(source.classroomId, stagedTexts(staged));

  const files = staged.flatMap(item =>
    rewriteDecodedFiles(item.files, {
      sourceLogin: source.login,
      sourceRepo: source.repo,
      sourcePath: item.source.content_path,
      targetLogin: target.login,
      targetRepo: target.repo,
      targetPath: item.targetContentPath,
      shaPaths,
    })
  );

  // ONE commit for all slide files (deck.json + generated index.html copied
  // verbatim — never regenerated).
  try {
    await ContentService.uploadBatch({
      gitOrganization: target.gitOrganization,
      repo: target.repo,
      files,
      branch: 'main',
      message: commitMessage,
    });
  } catch (error: unknown) {
    warn('slides', `slide content commit failed: ${errText(error)}`);
    return 0;
  }

  let created = 0;
  for (const item of staged) {
    try {
      const row = await getPrisma().slide.create({
        data: {
          classroom_id: target.classroomId,
          title: item.targetTitle,
          slug: item.targetSlug,
          content_path: item.targetContentPath,
          created_by: createdByUserId,
          is_draft: true,
          is_public: false,
          allow_team_edit: item.source.allow_team_edit,
          show_speaker_notes: item.source.show_speaker_notes,
        } satisfies Prisma.SlideUncheckedCreateInput,
      });
      idMap[item.source.id] = row.id;
      created++;
    } catch (error: unknown) {
      warn('slides', `DB row failed for "${item.targetTitle}": ${errText(error)}`);
    }
  }
  // The phase is finished once the rows land — same closing tick as pages.
  emitProgress(onProgress, { kind: 'slides', done: total, total });
  return created;
}
