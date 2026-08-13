/**
 * slideContent.service.ts — deck load/save choke point (content-tools plan §3).
 *
 * Single write path for the editor action, new-slide creation, the importer,
 * and MCP deck_apply. deck.json is the source of truth once it exists;
 * index.html is a build artifact regenerated on every save. Preview branches
 * carry SOURCE FILES ONLY (deck.json — never index.html, plan §3b).
 */

import getPrisma from '@classmoji/database';
import { ContentService } from '../content/ContentService.ts';
import {
  DeckParseError,
  generateDeckHtml,
  parseDeckHtml,
  type DeckThemeUrls,
  type ParseOptions,
} from './deckHtml.ts';
import type { DeckJson } from './deckTypes.ts';

// Structural type compatible with ContentService's (unexported) git org record.
interface GitOrgRecord {
  provider: string;
  login: string;
  github_installation_id?: string | null;
  access_token?: string | null;
  base_url?: string | null;
  gitlab_group_id?: string | null;
}

/**
 * The slice of a Slide row (with classroom + git_organization included) that
 * the content service needs. `id` is optional so createSlide can save the
 * starter deck before the DB row exists.
 */
export interface SlideContentTarget {
  id?: string;
  title: string;
  content_path: string;
  classroom?: {
    /** Stored content repo name — never re-derived from org + namespace. */
    content_repo: string | null;
    git_organization: GitOrgRecord | null;
  } | null;
}

export type DeckShaSource = 'deck' | 'legacy_html';

/** 409 — the deck (or legacy html) changed since the caller read it. */
export class DeckConflictError extends Error {
  status = 409 as const;
  code = 'CONTENT_CONFLICT' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DeckConflictError';
  }
}

export const PREVIEW_BRANCH_PREFIX = 'preview/';

/** Singleton preview branch per resource: `preview/<content_path>` (plan §3b). */
export function previewBranchName(contentPath: string): string {
  return `${PREVIEW_BRANCH_PREFIX}${contentPath}`;
}

/**
 * Resolve the content repo (org + repo name) a slide's files live in.
 * Shared with deckPreview.service — the preview lifecycle operates on the
 * same repo the save choke point writes to.
 */
export function resolveSlideRepoContext(slide: SlideContentTarget): {
  gitOrganization: GitOrgRecord;
  repo: string;
} {
  const gitOrganization = slide.classroom?.git_organization;
  if (!gitOrganization?.login) {
    throw new Error('Git organization not configured');
  }
  const repo = slide.classroom?.content_repo;
  if (!repo) {
    throw new Error('Classroom content repo not configured');
  }
  return { gitOrganization, repo };
}

// ─────────────────────────────────────────────────────────────────────────────
// loadDeck
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadDeckResult {
  deck: DeckJson;
  /** deck.json's sha when sha_source='deck', index.html's sha when 'legacy_html'. */
  sha: string;
  sha_source: DeckShaSource;
  /** Parser warnings (legacy_html reads only). */
  warnings?: string[];
}

/**
 * Load a slide's deck: deck.json first (API read, JSON parse), else parse the
 * legacy index.html. Sha-bearing reads must pass skipCache — the 60s response
 * cache is per-process and cross-instance invalidation does not exist.
 *
 * @throws {DeckParseError} deck.json malformed, or index.html unparseable.
 */
export async function loadDeck(
  slide: SlideContentTarget,
  {
    skipCache = false,
    ref,
    parseOptions,
  }: { skipCache?: boolean; ref?: string; parseOptions?: ParseOptions } = {}
): Promise<LoadDeckResult> {
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const deckPath = `${slide.content_path}/deck.json`;
  const htmlPath = `${slide.content_path}/index.html`;

  const deckFile = await ContentService.getContent({
    gitOrganization,
    repo,
    path: deckPath,
    ref,
    skipCache,
  });
  if (deckFile) {
    let deck: DeckJson;
    try {
      deck = JSON.parse(deckFile.content) as DeckJson;
    } catch (error: unknown) {
      throw new DeckParseError(
        `deck.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    if (deck?.version !== 1 || !Array.isArray(deck.slides)) {
      throw new DeckParseError(
        'deck.json has an unsupported shape (expected version 1 with slides)'
      );
    }
    return { deck, sha: deckFile.sha, sha_source: 'deck' };
  }

  const htmlFile = await ContentService.getContent({
    gitOrganization,
    repo,
    path: htmlPath,
    ref,
    skipCache,
  });
  if (!htmlFile) {
    throw new Error(`Slide content not found: ${htmlPath}`);
  }
  const { deck, warnings } = parseDeckHtml(htmlFile.content, parseOptions);
  return { deck, sha: htmlFile.sha, sha_source: 'legacy_html', warnings };
}

// ─────────────────────────────────────────────────────────────────────────────
// saveDeck
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveDeckArgs {
  slide: SlideContentTarget;
  deck: DeckJson;
  /** Sha from the paired read; omit only for first writes (create/import). */
  expectedSha?: string;
  /** Which file the paired read's sha came from. Default 'deck'. */
  shaSource?: DeckShaSource;
  message: string;
  /**
   * Branch to commit to. When it is a preview branch (`preview/…`), ONLY
   * deck.json is written (source-only rule, plan §3b) and the branch must
   * already exist (callers create it via ContentService.createBranch).
   * Omit for the default branch (main) dual-write.
   */
  branch?: string;
  /** Caller-resolved URLs for shared:/custom: themes (getThemeUrls output). */
  themeUrls?: DeckThemeUrls;
}

export interface SaveDeckResult {
  /** deck.json's new blob sha (identical to the Contents-API file sha). */
  sha: string;
  /** The commit sha. */
  commit: string;
  /** The generated index.html (the editor's savedContent CDN-lag workaround). */
  html: string;
}

/**
 * Save a deck: conflict check (§3 2×2 table) → generateDeckHtml → ONE atomic
 * uploadBatch commit (deck.json + index.html on main; deck.json only on
 * preview branches) → bump slide.updated_at (main writes only).
 *
 * Conflict table (branches on shaSource — the file the paired read's sha came from):
 *
 *   | shaSource     | deck.json state            | index.html check     | result |
 *   |---------------|----------------------------|----------------------|--------|
 *   | 'deck'        | exists, sha matches        | —                    | proceed|
 *   | 'deck'        | exists, sha differs        | —                    | 409    |
 *   | 'deck'        | missing (deleted)          | —                    | 409    |
 *   | 'legacy_html' | now exists (materialized)  | —                    | 409    |
 *   | 'legacy_html' | still absent               | sha matches          | proceed|
 *   | 'legacy_html' | still absent               | sha differs/missing  | 409    |
 *
 * Every check uses getMeta(skipCache: true) — caches are per-process and
 * cross-instance invalidation does not exist, so skipCache is REQUIRED.
 *
 * CAS note: the pre-check above gives fast, readable 409s, but the real
 * guarantee is uploadBatch's `verifyBaseTree` hook — the expected sha is
 * re-verified against EVERY retry attempt's base commit inside the git
 * operation, so a concurrent commit (including one landing during an internal
 * not-a-fast-forward retry) always surfaces as a DeckConflictError instead of
 * being clobbered. Batch writes are a true compare-and-swap.
 *
 * @throws {DeckConflictError} on any conflict row above (status 409).
 */
export async function saveDeck({
  slide,
  deck,
  expectedSha,
  shaSource = 'deck',
  message,
  branch,
  themeUrls,
}: SaveDeckArgs): Promise<SaveDeckResult> {
  const { gitOrganization, repo } = resolveSlideRepoContext(slide);
  const deckPath = `${slide.content_path}/deck.json`;
  const htmlPath = `${slide.content_path}/index.html`;

  const isPreviewBranch = branch != null && branch.startsWith(PREVIEW_BRANCH_PREFIX);
  const targetBranch = branch ?? 'main';
  // Ref for conflict checks: the branch being written (main when absent) —
  // §3b: expected_sha refers to the file on the branch being written.
  const checkRef = branch;

  const html = generateDeckHtml(deck, { title: slide.title, themeUrls, includeNotes: true });
  const deckJson = JSON.stringify(deck, null, 2) + '\n';

  // Conflict check — immediately before the batch call (see CAS note above).
  if (expectedSha) {
    if (shaSource === 'deck') {
      const deckMeta = await ContentService.getMeta({
        gitOrganization,
        repo,
        path: deckPath,
        ref: checkRef,
        skipCache: true,
      });
      if (!deckMeta) {
        // Deleted out-of-band: deleted = changed.
        throw new DeckConflictError('deck.json no longer exists — re-read the deck before saving');
      }
      if (deckMeta.sha !== expectedSha) {
        throw new DeckConflictError('Deck changed since it was read — re-read before saving');
      }
    } else {
      const deckMeta = await ContentService.getMeta({
        gitOrganization,
        repo,
        path: deckPath,
        ref: checkRef,
        skipCache: true,
      });
      if (deckMeta) {
        // deck.json materialized between the legacy read and this save.
        throw new DeckConflictError(
          'deck.json was created since this deck was read — re-read before saving'
        );
      }
      const htmlMeta = await ContentService.getMeta({
        gitOrganization,
        repo,
        path: htmlPath,
        ref: checkRef,
        skipCache: true,
      });
      if (!htmlMeta || htmlMeta.sha !== expectedSha) {
        throw new DeckConflictError('Slide HTML changed since it was read — re-read before saving');
      }
    }
  }

  // ONE atomic commit. Preview branches carry source files only (§3b):
  // index.html is never committed to a preview branch.
  const files = isPreviewBranch
    ? [{ path: deckPath, content: deckJson, encoding: 'utf-8' as const }]
    : [
        { path: deckPath, content: deckJson, encoding: 'utf-8' as const },
        { path: htmlPath, content: html, encoding: 'utf-8' as const },
      ];

  const result = await ContentService.uploadBatch({
    gitOrganization,
    repo,
    files,
    branch: targetBranch,
    message,
    // Main writes prime the response cache so a same-process read right after
    // the save (editor reload, MCP re-read) sees the new content despite
    // GitHub's Contents-API replication lag.
    primeCache: !isPreviewBranch,
    // True CAS: re-verify the expected sha against EVERY retry attempt's base
    // commit, so a ref race can never retry past (and clobber) a concurrent
    // save. Mirrors the pre-check's 2×2 table rows for the sha we hold.
    verifyBaseTree: expectedSha
      ? async ({ getFileSha }) => {
          if (shaSource === 'deck') {
            const current = await getFileSha(deckPath);
            if (current !== expectedSha) {
              throw new DeckConflictError('Deck changed since it was read — re-read before saving');
            }
          } else {
            const [currentDeck, currentHtml] = await Promise.all([
              getFileSha(deckPath),
              getFileSha(htmlPath),
            ]);
            if (currentDeck !== null) {
              throw new DeckConflictError(
                'deck.json was created since this deck was read — re-read before saving'
              );
            }
            if (currentHtml !== expectedSha) {
              throw new DeckConflictError(
                'Slide HTML changed since it was read — re-read before saving'
              );
            }
          }
        }
      : undefined,
  });

  const newDeckSha = result.files.find(f => f.path === deckPath)?.sha;
  if (!newDeckSha) {
    throw new Error('uploadBatch did not return a sha for deck.json');
  }

  // Bump updated_at for main writes (a preview-branch commit changes nothing
  // students or the live viewer can see).
  if (slide.id && !isPreviewBranch) {
    await getPrisma().slide.update({
      where: { id: slide.id },
      data: { updated_at: new Date() },
    });
  }

  return { sha: newDeckSha, commit: result.commit, html };
}
