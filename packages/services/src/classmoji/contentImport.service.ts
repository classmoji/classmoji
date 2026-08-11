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
import { classroomContentRepoName, titleToIdentifier } from '@classmoji/utils';
import { ContentService } from '../content/ContentService.ts';
import { getGitProvider } from '../git/index.ts';
import * as contentManifestService from './contentManifest.service.ts';
import { ensureContentRepo } from './page.service.ts';
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
}

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
 * Load a classroom's content-repo coordinates. Returns null when the classroom
 * (or its git org / content namespace) is not configured — the caller turns
 * that into a zeros+warning result for the SOURCE side, or a throw for TARGET.
 */
async function loadRepoContext(classroomId: string): Promise<RepoContext | null> {
  const classroom = await getPrisma().classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });
  const gitOrganization = classroom?.git_organization as GitOrgRecord | null | undefined;
  if (!classroom || !gitOrganization?.login || !classroom.content_namespace) {
    return null;
  }
  return {
    classroomId,
    gitOrganization,
    login: gitOrganization.login,
    repo: classroomContentRepoName({
      login: gitOrganization.login,
      namespace: classroom.content_namespace,
    }),
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
  files: BatchFile[];
  targetTitle: string;
  targetSlug: string;
  targetContentPath: string;
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
 *  - per-item read/DB failures and a per-type commit failure → warning + skip.
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
      });
      summary.pages = created;
      if (created > 0) createdAny = true;
    } catch (error: unknown) {
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
}: {
  source: RepoContext;
  target: RepoContext;
  createdByUserId: string;
  commitMessage: string;
  warn: WarnFn;
  idMap: Record<string, string>;
}): Promise<number> {
  const sourcePages = await getPrisma().page.findMany({
    where: { classroom_id: source.classroomId },
    orderBy: { created_at: 'asc' },
  });
  if (sourcePages.length === 0) return 0;

  // Seed collision sets from existing TARGET rows.
  const targetPages = await getPrisma().page.findMany({
    where: { classroom_id: target.classroomId },
    select: { title: true, content_path: true },
  });
  const takenTitles = new Set(targetPages.map(p => p.title));
  const takenSlugs = new Set(targetPages.map(p => p.content_path.replace(/^pages\//, '')));

  const staged: StagedItem<SourcePage>[] = [];

  for (const page of sourcePages) {
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
    staged.push({ source: page, files, targetTitle, targetSlug, targetContentPath });
  }

  if (staged.length === 0) return 0;

  // ONE commit for all page files.
  try {
    await ContentService.uploadBatch({
      gitOrganization: target.gitOrganization,
      repo: target.repo,
      files: staged.flatMap(s => s.files),
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
      const row = await getPrisma().page.create({
        data: {
          classroom_id: target.classroomId,
          title: item.targetTitle,
          slug: titleToIdentifier(item.targetTitle),
          content_path: item.targetContentPath,
          created_by: createdByUserId,
          is_draft: true,
          is_public: false,
          width: item.source.width,
          show_in_student_menu: item.source.show_in_student_menu,
          menu_order: item.source.menu_order,
          header_image_url: item.source.header_image_url,
          header_image_position: item.source.header_image_position,
        } satisfies Prisma.PageUncheckedCreateInput,
      });
      idMap[item.source.id] = row.id;
      created++;
    } catch (error: unknown) {
      warn('pages', `DB row failed for "${item.targetTitle}": ${errText(error)}`);
    }
  }
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
}: {
  source: RepoContext;
  target: RepoContext;
  createdByUserId: string;
  commitMessage: string;
  warn: WarnFn;
  idMap: Record<string, string>;
}): Promise<number> {
  const sourceSlides = await getPrisma().slide.findMany({
    where: { classroom_id: source.classroomId },
    orderBy: { created_at: 'asc' },
  });
  if (sourceSlides.length === 0) return 0;

  // Slides carry a [classroom_id, slug] unique constraint — slug drives both the
  // constraint and the content path, so one dedupe set covers both.
  const targetSlides = await getPrisma().slide.findMany({
    where: { classroom_id: target.classroomId },
    select: { slug: true },
  });
  const takenSlugs = new Set(targetSlides.map(s => s.slug));

  const staged: StagedItem<SourceSlide>[] = [];

  for (const slide of sourceSlides) {
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
    staged.push({
      source: slide,
      files,
      targetTitle: slide.title,
      targetSlug,
      targetContentPath,
    });
  }

  if (staged.length === 0) return 0;

  // ONE commit for all slide files (deck.json + generated index.html copied
  // verbatim — never regenerated).
  try {
    await ContentService.uploadBatch({
      gitOrganization: target.gitOrganization,
      repo: target.repo,
      files: staged.flatMap(s => s.files),
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
  return created;
}
