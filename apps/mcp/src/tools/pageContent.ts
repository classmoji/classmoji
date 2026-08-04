/**
 * Page CONTENT tools (content-tools plan Phase 2, §7):
 * page_content_outline / page_content_get / page_content_apply +
 * page_preview_accept / page_preview_discard.
 *
 * Token-efficient granular editing of BlockNote page content stored in the
 * per-classroom content repo (`pages/<slug>/content.json`): outline → get(ids)
 * → apply(ops) — never whole-document round-trips. Every apply is optimistic-
 * locked on the sha the caller last read (`expected_sha`); a mismatch returns
 * the machine-readable CONTENT_CONFLICT code so clients re-read and retry.
 *
 * Preview branches (§3b): applies to a published page default to the page's
 * singleton `preview/<content_path>` branch (drafts commit direct — nobody
 * sees them). Accept = GitHub merge into main + branch delete; a genuine
 * same-block conflict returns a structured per-unit report instead of raw
 * conflict markers. Discard = branch delete, main untouched.
 *
 * Tier: OWNER_TEACHER — true parity with web page editing (['OWNER','TEACHER']).
 * S1: every tool loads the page WITH its classroom chain and compares
 * classroom_id before touching GitHub (loadPageWithRepoInClassroom).
 */

import { ClassmojiService } from '@classmoji/services';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import {
  loadPageWithRepoInClassroom,
  mapSemanticMergeError,
  ok,
  OWNER_TEACHER,
  writeAudit,
  type PageWithRepoRecord,
} from './shared.ts';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const LEGACY_GUIDANCE =
  'This page still stores legacy HTML (index.html), so granular block ops are unavailable. ' +
  'Either open the page once in the web editor to migrate it to BlockNote, or overwrite it ' +
  'with a single replace_all op carrying fresh BlockNote blocks.';

/**
 * CONTENT_CONFLICT naming the ref that was compared: when a preview exists,
 * applies stack onto it and the sha must come from a preview read — a stale
 * main sha is the most common mistake, so the message says which re-read fixes it.
 */
function contentConflict(at: 'main' | 'preview' = 'main'): ToolError {
  return new ToolError(
    'invalid_params',
    at === 'preview'
      ? 'Content changed since you read it — a preview exists and applies stack onto it, so ' +
          "re-read with page_content_get at: 'preview' for a fresh sha"
      : 'Content changed since you read it — call page_content_get again for a fresh sha',
    'CONTENT_CONFLICT'
  );
}

/** A BlockNote block as the tools see it (opaque beyond id/type/children). */
interface BlockNode {
  id?: string;
  type?: string;
  content?: unknown;
  children?: BlockNode[];
  [key: string]: unknown;
}

/** Collect every `text` string reachable through `content` (NOT `children`). */
function collectText(node: unknown, out: string[]): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.text === 'string') out.push(record.text);
  // Inline containers: styled text/links (content), tables (rows → cells).
  for (const key of ['content', 'rows', 'cells']) {
    if (record[key]) collectText(record[key], out);
  }
}

/** Flattened plain-text preview of a block, truncated to ≤80 chars. */
function blockPreview(block: BlockNode): string {
  const parts: string[] = [];
  collectText(block.content, parts);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

interface OutlineEntry {
  id: string;
  type: string;
  preview: string;
  depth: number;
  children_count: number;
}

/** Depth-first outline: nested children become entries with depth + 1. */
function flattenOutline(blocks: BlockNode[], depth = 0, out: OutlineEntry[] = []): OutlineEntry[] {
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    out.push({
      id: String(block.id ?? ''),
      type: String(block.type ?? 'unknown'),
      preview: blockPreview(block),
      depth,
      children_count: Array.isArray(block.children) ? block.children.length : 0,
    });
    if (Array.isArray(block.children) && block.children.length > 0) {
      flattenOutline(block.children, depth + 1, out);
    }
  }
  return out;
}

/** Total block count, nested children included. */
function countBlocks(blocks: BlockNode[]): number {
  let count = 0;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    count += 1;
    if (Array.isArray(block.children)) count += countBlocks(block.children);
  }
  return count;
}

/** Find a block by id anywhere in the tree (incl. nested children). */
function findBlockById(blocks: BlockNode[], id: string): BlockNode | null {
  for (const block of blocks) {
    if (block?.id === id) return block;
    if (Array.isArray(block?.children)) {
      const found = findBlockById(block.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Humanize the preview's age from its oldest commit date (e.g. '3h', '2d'). */
function humanizeAge(oldestCommitAt: string | undefined): string | undefined {
  if (!oldestCommitAt) return undefined;
  const ms = Date.now() - new Date(oldestCommitAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Outline/tool payload for the preview state. */
function previewPayload(status: {
  exists: boolean;
  commits_ahead?: number;
  oldest_commit_at?: string;
}) {
  if (!status.exists) return { exists: false };
  const age = humanizeAge(status.oldest_commit_at);
  return {
    exists: true,
    commits_ahead: status.commits_ahead ?? 0,
    ...(age ? { age } : {}),
    ...(status.oldest_commit_at ? { oldest_commit_at: status.oldest_commit_at } : {}),
  };
}

/**
 * Resolve the ref to read for an `at` argument. `at: 'preview'` requires the
 * preview branch to exist; reads then target it (API-path only — the CDN and
 * students always see main).
 */
async function resolveReadRef(
  page: PageWithRepoRecord,
  at: 'main' | 'preview'
): Promise<string | undefined> {
  if (at !== 'preview') return undefined;
  const status = await ClassmojiService.pageContent.getPreviewStatus(page);
  if (!status.exists) {
    throw new ToolError(
      'invalid_params',
      "No preview branch exists for this page — at: 'preview' requires a pending preview " +
        "(create one with page_content_apply commit: 'preview')"
    );
  }
  return ClassmojiService.pageContent.previewBranchName(page.content_path);
}

// ─── page_content_outline ────────────────────────────────────────────────────

interface PageContentOutlineArgs {
  classroom: string;
  page_id: string;
  at?: 'main' | 'preview';
}

export const pageContentOutlineTool: ToolDefinition<PageContentOutlineArgs> = {
  name: 'page_content_outline',
  title: 'Outline page content',
  description:
    "Returns a compact outline of a page's BlockNote content: one entry per block " +
    '(id, type, ≤80-char text preview, depth, children_count) plus the content sha and ' +
    'pending-preview status. Start here, then fetch only the blocks you need with ' +
    'page_content_get (block_ids) and edit them with page_content_apply — never round-trip ' +
    "whole documents. Pass at: 'preview' to outline the pending preview instead of main.",
  scope: 'read',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: z.string().uuid().describe('Page id'),
    at: z
      .enum(['main', 'preview'])
      .optional()
      .describe("Read target: 'main' (default) or the pending preview branch"),
  },
  handler: async (args, ctx) => {
    const page = await loadPageWithRepoInClassroom(args.page_id, ctx);
    const status = await ClassmojiService.pageContent.getPreviewStatus(page);
    const at = args.at ?? 'main';
    if (at === 'preview' && !status.exists) {
      throw new ToolError(
        'invalid_params',
        "No preview branch exists for this page — at: 'preview' requires a pending preview " +
          "(create one with page_content_apply commit: 'preview')"
      );
    }
    const ref =
      at === 'preview'
        ? ClassmojiService.pageContent.previewBranchName(page.content_path)
        : undefined;

    const content = await ClassmojiService.pageContent.loadPageContent(page, {
      skipCache: true,
      ...(ref ? { ref } : {}),
    });

    if (content.format !== 'json') {
      return ok({
        page_id: page.id,
        title: page.title,
        format: content.format === 'html' ? 'html' : 'none',
        sha: content.sha,
        ...(content.format === 'html' ? { sha_source: 'legacy_html' } : {}),
        block_count: 0,
        has_cover_image: false,
        preview: previewPayload(status),
        blocks: [],
        message:
          content.format === 'html'
            ? LEGACY_GUIDANCE
            : 'This page has no content file yet — create one with a page_content_apply replace_all op.',
      });
    }

    const blocks = ClassmojiService.pageContent.ensureBlockIds(
      content.blocks as BlockNode[]
    ) as BlockNode[];
    const outline = flattenOutline(blocks);

    return ok({
      page_id: page.id,
      title: page.title,
      format: 'json',
      sha: content.sha,
      sha_source: 'content_json',
      block_count: outline.length,
      has_cover_image: Boolean(content.coverImage),
      preview: previewPayload(status),
      blocks: outline,
    });
  },
};

// ─── page_content_get ────────────────────────────────────────────────────────

interface PageContentGetArgs {
  classroom: string;
  page_id: string;
  block_ids?: string[];
  at?: 'main' | 'preview';
}

export const pageContentGetTool: ToolDefinition<PageContentGetArgs> = {
  name: 'page_content_get',
  title: 'Get page content blocks',
  description:
    'Returns full BlockNote JSON blocks for a page, with stable block ids. Pass block_ids ' +
    '(from page_content_outline) to fetch only specific blocks — preferred on large pages. ' +
    'Omitting block_ids returns the whole document. The returned sha is the expected_sha for ' +
    "a subsequent page_content_apply. Pass at: 'preview' to read the pending preview branch.",
  scope: 'read',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: z.string().uuid().describe('Page id'),
    block_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .optional()
      .describe(
        'Specific block ids to fetch (≤50, from page_content_outline); omit for the whole document'
      ),
    at: z
      .enum(['main', 'preview'])
      .optional()
      .describe("Read target: 'main' (default) or the pending preview branch"),
  },
  handler: async (args, ctx) => {
    const page = await loadPageWithRepoInClassroom(args.page_id, ctx);
    const ref = await resolveReadRef(page, args.at ?? 'main');

    const content = await ClassmojiService.pageContent.loadPageContent(page, {
      skipCache: true,
      ...(ref ? { ref } : {}),
    });

    if (content.format !== 'json') {
      return ok({
        page_id: page.id,
        format: content.format === 'html' ? 'html' : 'none',
        sha: content.sha,
        ...(content.format === 'html' ? { sha_source: 'legacy_html', html: content.blocks } : {}),
        message:
          content.format === 'html'
            ? LEGACY_GUIDANCE
            : 'This page has no content file yet — create one with a page_content_apply replace_all op.',
      });
    }

    const blocks = ClassmojiService.pageContent.ensureBlockIds(
      content.blocks as BlockNode[]
    ) as BlockNode[];
    const totalCount = countBlocks(blocks);

    if (args.block_ids?.length) {
      const selected: BlockNode[] = [];
      for (const id of args.block_ids) {
        const block = findBlockById(blocks, id);
        if (!block) {
          throw new ToolError(
            'invalid_params',
            `Unknown block id '${id}' — call page_content_outline for current ids`
          );
        }
        selected.push(block);
      }
      return ok({
        page_id: page.id,
        format: 'json',
        sha: content.sha,
        sha_source: 'content_json',
        block_count: totalCount,
        blocks: selected,
      });
    }

    return ok({
      page_id: page.id,
      format: 'json',
      sha: content.sha,
      sha_source: 'content_json',
      block_count: totalCount,
      blocks,
      ...(totalCount >= 100
        ? {
            warning: `This document has ${totalCount} blocks — prefer page_content_outline + block_ids to keep responses small`,
          }
        : {}),
    });
  },
};

// ─── page_content_apply ──────────────────────────────────────────────────────

const blockSchema = z.record(z.unknown());

const positionSchema = z.union([
  z.object({ after: z.string().min(1) }).strict(),
  z.object({ at: z.enum(['start', 'end']) }).strict(),
]);

const opSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update'),
    id: z.string().min(1),
    block: blockSchema.describe('Full replacement block (its id is preserved)'),
  }),
  z.object({
    op: z.literal('insert'),
    blocks: z.array(blockSchema).min(1).max(20),
    position: positionSchema,
  }),
  z.object({
    op: z.literal('move'),
    id: z.string().min(1),
    position: positionSchema,
  }),
  z.object({
    op: z.literal('delete'),
    id: z.string().min(1),
  }),
  z.object({
    op: z.literal('replace_all'),
    blocks: z.array(blockSchema),
  }),
]);

type PageContentOp = z.infer<typeof opSchema>;

interface PageContentApplyArgs {
  classroom: string;
  page_id: string;
  expected_sha: string;
  ops: PageContentOp[];
  commit?: 'preview' | 'direct';
}

/** Compact per-op summary for the result payload and the audit row. */
function summarizeOps(ops: PageContentOp[]): Array<Record<string, unknown>> {
  return ops.map(op => {
    switch (op.op) {
      case 'insert':
        return { op: 'insert', count: op.blocks.length };
      case 'replace_all':
        return { op: 'replace_all', count: op.blocks.length };
      default:
        return { op: op.op, id: op.id };
    }
  });
}

export const pageContentApplyTool: ToolDefinition<PageContentApplyArgs> = {
  name: 'page_content_apply',
  annotations: { destructive: true, openWorld: true },
  title: 'Apply page content edits',
  description:
    'Applies granular block operations (update / insert / move / delete / replace_all) to a ' +
    "page's BlockNote content in one commit. Requires expected_sha from page_content_get or " +
    'page_content_outline; a CONTENT_CONFLICT error means the content changed — re-read for a ' +
    "fresh sha. Published pages default to commit: 'preview' (a preview branch students never " +
    "see — review then page_preview_accept); drafts default to commit: 'direct'. Pass commit " +
    'explicitly to override either way. When a preview already exists, applies STACK onto it ' +
    "and expected_sha must come from a read at: 'preview' (main's sha will conflict).",
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: z.string().uuid().describe('Page id'),
    expected_sha: z
      .string()
      .min(1)
      .describe('Content sha from the last page_content_get/outline read (optimistic lock)'),
    ops: z
      .array(opSchema)
      .min(1)
      .max(25)
      .describe('Block operations, applied sequentially (later ops see earlier effects)'),
    commit: z
      .enum(['preview', 'direct'])
      .optional()
      .describe(
        "Where to commit: 'preview' (singleton preview branch) or 'direct' (main). " +
          'Default: preview for published pages, direct for drafts'
      ),
  },
  handler: async (args, ctx) => {
    const page = await loadPageWithRepoInClassroom(args.page_id, ctx);

    // §3b default routing: published pages preview, drafts direct.
    const committedTo: 'main' | 'preview' =
      (args.commit ?? (page.is_draft === false ? 'preview' : 'direct')) === 'preview'
        ? 'preview'
        : 'main';

    // Stacking: when a preview already exists and we're committing to it,
    // load FROM it so this apply builds on the pending changes.
    let loadRef: string | undefined;
    if (committedTo === 'preview') {
      const status = await ClassmojiService.pageContent.getPreviewStatus(page);
      if (status.exists) {
        loadRef = ClassmojiService.pageContent.previewBranchName(page.content_path);
      }
    }

    const content = await ClassmojiService.pageContent.loadPageContent(page, {
      skipCache: true,
      ...(loadRef ? { ref: loadRef } : {}),
    });

    // Legacy HTML (or missing) content: granular ops are meaningless — only a
    // fresh replace_all is allowed (it writes a brand-new content.json).
    if (content.format !== 'json' && args.ops.some(op => op.op !== 'replace_all')) {
      throw new ToolError('invalid_params', LEGACY_GUIDANCE);
    }

    // Which ref the sha was compared against — names the right re-read in
    // CONTENT_CONFLICT messages (stacking reads target the preview branch).
    const conflictAt: 'main' | 'preview' = loadRef ? 'preview' : 'main';

    // Optimistic lock (tool-level, works for BOTH sha sources): the sha the
    // caller read must still be the sha of the file we loaded.
    if (content.sha !== null && content.sha !== args.expected_sha) {
      throw contentConflict(conflictAt);
    }

    const priorBlocks =
      content.format === 'json'
        ? (ClassmojiService.pageContent.ensureBlockIds(
            content.blocks as BlockNode[]
          ) as BlockNode[])
        : [];
    const priorCount = countBlocks(priorBlocks);

    // Client-supplied ids that collide with existing ids (or each other) are
    // re-minted deterministically inside applyBlockOps — collected here so the
    // result/audit report the re-mints.
    const idRemints: Array<{ op_index: number; from: string; to: string }> = [];

    let newBlocks: unknown[];
    try {
      newBlocks = ClassmojiService.pageContent.applyBlockOps(
        priorBlocks,
        args.ops as Parameters<typeof ClassmojiService.pageContent.applyBlockOps>[1],
        { onIdRemint: remint => idRemints.push(remint) }
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'BlockOpError') {
        throw new ToolError('invalid_params', error.message);
      }
      throw error;
    }

    // Client-supplied blocks (insert/replace_all payloads) may lack ids —
    // fill them deterministically so this apply PERSISTS stable ids.
    newBlocks = ClassmojiService.pageContent.ensureBlockIds(newBlocks as BlockNode[]);

    let createdPreviewBranch = false;
    if (committedTo === 'preview') {
      // Create the branch from main's current HEAD when absent (no-op when
      // stacking on an existing preview).
      const ensured = await ClassmojiService.pageContent.ensurePreviewBranch(page);
      createdPreviewBranch = ensured.created;
    }

    // On a create (no content file yet), there is no sha to lock on — passing
    // one would 409 every first write (put treats expectedSha + missing file
    // as deleted-since-read). GitHub's sha-less create still rejects an
    // existence race with a 422, mapped to CONTENT_CONFLICT below.
    const isCreate = content.sha === null;

    let saved: { sha: string; commit: string };
    try {
      saved = await ClassmojiService.pageContent.savePageContent(page, newBlocks, {
        // Also enforced GitHub-side at write time: catches a racing writer
        // between our read and this commit (and a content.json materialized
        // out-of-band under a legacy page).
        ...(isCreate ? {} : { expectedSha: args.expected_sha }),
        ...(committedTo === 'preview'
          ? { branch: ClassmojiService.pageContent.previewBranchName(page.content_path) }
          : {}),
        message: `page_content_apply: ${page.title}`,
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      // 409 = optimistic-lock loss; 422 on a create = a concurrent creator won
      // the sha-less create race — both mean "re-read for a fresh sha".
      if (status === 409 || (isCreate && status === 422)) {
        // The branch was created by THIS apply and the save failed — delete
        // the fresh (empty) branch so it doesn't strand the page in preview
        // mode with no pending edits. Best-effort.
        if (createdPreviewBranch) {
          try {
            await ClassmojiService.pageContent.discardPreview(page);
          } catch (cleanupError: unknown) {
            console.warn(
              '[page_content_apply] Failed to clean up the freshly created preview branch:',
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            );
          }
        }
        throw contentConflict(conflictAt);
      }
      throw error;
    }

    const applied = summarizeOps(args.ops);
    for (const remint of idRemints) {
      const entry = applied[remint.op_index];
      if (entry) {
        const reminted =
          (entry.reminted_ids as Array<{ from: string; to: string }> | undefined) ?? [];
        reminted.push({ from: remint.from, to: remint.to });
        entry.reminted_ids = reminted;
      }
    }
    const hasDestructiveOps = args.ops.some(op => op.op === 'replace_all' || op.op === 'delete');

    await writeAudit(ctx, {
      resource_type: 'PAGES',
      resource_id: page.id,
      action: 'UPDATE',
      data: {
        tool: 'page_content_apply',
        ops: applied,
        expected_sha: args.expected_sha,
        new_sha: saved.sha,
        commit_sha: saved.commit,
        committed_to: committedTo,
        ...(hasDestructiveOps ? { prior_block_count: priorCount } : {}),
      } as Prisma.InputJsonValue,
    });

    return ok({
      success: true,
      new_sha: saved.sha,
      block_count: countBlocks(newBlocks as BlockNode[]),
      committed_to: committedTo,
      applied,
    });
  },
};

// ─── page_preview_accept ─────────────────────────────────────────────────────

interface PagePreviewArgs {
  classroom: string;
  page_id: string;
}

interface PagePreviewAcceptArgs extends PagePreviewArgs {
  resolutions?: Array<{ id: string; choose: 'ours' | 'theirs' }>;
  expected_ours_sha?: string;
  expected_theirs_sha?: string;
}

export const pagePreviewAcceptTool: ToolDefinition<PagePreviewAcceptArgs> = {
  name: 'page_preview_accept',
  annotations: { destructive: false, openWorld: true },
  title: 'Accept a page preview',
  description:
    "Publishes a page's pending preview: merges the preview branch into main and deletes the " +
    'branch. Non-overlapping edits merge automatically (git first, then a per-block semantic ' +
    '3-way merge — the result reports semantic: true with the auto_merged count when that ' +
    'layer kicked in). Only genuine same-block collisions stop the accept: you get a report of ' +
    'just those blocks (ours = main, theirs = preview, base) plus auto_merged. A block-order ' +
    "conflict appears as a units entry with id '__order__' (unlike deck_preview_accept, which " +
    'reports top-level order separately as order_conflict). To finish, ' +
    'either call this tool again with resolutions — one {id, choose: ours|theirs} per reported ' +
    "conflict id (ours = keep the live main version, theirs = keep the preview's), passing the " +
    "report's ours_sha/theirs_sha as expected_ours_sha/expected_theirs_sha to pin your choices " +
    'to the state you reviewed — or re-read ' +
    'fresh main with page_content_get, re-apply merged blocks with page_content_apply and ' +
    'accept again, or page_preview_discard.',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: z.string().uuid().describe('Page id'),
    resolutions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            choose: z.enum(['ours', 'theirs']),
          })
          .strict()
      )
      .min(1)
      .max(100)
      .optional()
      .describe(
        "Per-conflict choices from a prior conflict report: ours = keep main's (live) version, " +
          "theirs = keep the preview's. Must cover EVERY reported conflict id — block ids plus " +
          "the '__order__' sentinel when a block-order conflict was reported. Omit to attempt " +
          'a plain accept.'
      ),
    expected_ours_sha: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Pass the ours_sha from the conflict report your resolutions answer. If main's " +
          'content changed since that report, the accept fails with CONTENT_CONFLICT instead ' +
          'of applying reviewed choices to unseen content. Only meaningful with resolutions.'
      ),
    expected_theirs_sha: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Pass the theirs_sha from the conflict report your resolutions answer (same staleness ' +
          'pin for the preview side). Only meaningful with resolutions.'
      ),
  },
  handler: async (args, ctx) => {
    const page = await loadPageWithRepoInClassroom(args.page_id, ctx);

    const status = await ClassmojiService.pageContent.getPreviewStatus(page);
    if (!status.exists) {
      throw new ToolError('invalid_params', 'No pending preview for this page — nothing to accept');
    }

    // ── Resolutions path: apply chooser decisions to the conflicted merge ──
    if (args.resolutions?.length) {
      let result;
      try {
        result = await ClassmojiService.pageContent.resolvePreviewConflicts(page, {
          resolutions: args.resolutions,
          ...(args.expected_ours_sha ? { expectedOursSha: args.expected_ours_sha } : {}),
          ...(args.expected_theirs_sha ? { expectedTheirsSha: args.expected_theirs_sha } : {}),
        });
      } catch (error: unknown) {
        throw mapSemanticMergeError(error, 'page_preview_accept');
      }

      await writeAudit(ctx, {
        resource_type: 'PAGES',
        resource_id: page.id,
        action: 'UPDATE',
        data: {
          tool: 'page_preview_accept',
          outcome: 'merged',
          semantic: true,
          resolutions: args.resolutions.map(({ id, choose }) => ({ id, choose })),
          auto_merged: result.auto_merged,
          new_sha: result.sha,
          ...(result.preview_kept ? { preview_kept: true, reason: result.reason } : {}),
        } as unknown as Prisma.InputJsonValue,
      });
      return ok({
        success: true,
        merged: true,
        semantic: true,
        resolved: args.resolutions,
        auto_merged: result.auto_merged,
        new_sha: result.sha,
        ...(result.preview_kept ? { preview_kept: true, reason: result.reason } : {}),
      });
    }

    let result;
    try {
      result = await ClassmojiService.pageContent.acceptPreview(page);
    } catch (error: unknown) {
      throw mapSemanticMergeError(error, 'page_preview_accept');
    }

    if (result.merged) {
      await writeAudit(ctx, {
        resource_type: 'PAGES',
        resource_id: page.id,
        action: 'UPDATE',
        data: {
          tool: 'page_preview_accept',
          outcome: 'merged',
          new_sha: result.sha,
          ...(result.semantic ? { semantic: true, auto_merged: result.auto_merged } : {}),
          ...(result.preview_kept ? { preview_kept: true, reason: result.reason } : {}),
        } as Prisma.InputJsonValue,
      });
      return ok({
        success: true,
        merged: true,
        new_sha: result.sha,
        ...(result.semantic ? { semantic: true, auto_merged: result.auto_merged } : {}),
        ...(result.preview_kept
          ? {
              preview_kept: true,
              message:
                'New changes arrived during accept — the preview branch was retained with the ' +
                `newer edits (${result.reason ?? 'concurrent apply'}). Review and accept again, ` +
                'or discard.',
            }
          : {}),
      });
    }

    await writeAudit(ctx, {
      resource_type: 'PAGES',
      resource_id: page.id,
      action: 'UPDATE',
      data: {
        tool: 'page_preview_accept',
        outcome: 'conflict',
        conflict_unit_ids: result.units.map(unit => unit.id),
        auto_merged: result.auto_merged,
        ours_sha: result.ours_sha,
        theirs_sha: result.theirs_sha,
      } as Prisma.InputJsonValue,
    });

    return ok({
      conflict: true,
      units: result.units,
      auto_merged: result.auto_merged,
      ours_sha: result.ours_sha,
      theirs_sha: result.theirs_sha,
      message:
        `${result.auto_merged} change(s) auto-merge cleanly; ${result.units.length} conflict(s) ` +
        'need a decision. Resolve by calling page_preview_accept again with resolutions ' +
        "(one {id, choose: 'ours'|'theirs'} per conflict id — '__order__' addresses a " +
        "block-order conflict; ours = main, theirs = preview), passing this report's " +
        'ours_sha/theirs_sha as expected_ours_sha/expected_theirs_sha — or re-read fresh main with ' +
        'page_content_get, re-apply merged blocks with page_content_apply and accept again, ' +
        'or page_preview_discard to drop the preview.',
    });
  },
};

// ─── page_preview_discard ────────────────────────────────────────────────────

export const pagePreviewDiscardTool: ToolDefinition<PagePreviewArgs> = {
  name: 'page_preview_discard',
  annotations: { destructive: true, openWorld: true },
  title: 'Discard a page preview',
  description:
    "Deletes a page's pending preview branch, permanently dropping its uncommitted edits. " +
    'Main is untouched. Safe to call when no preview exists (reports it was already gone).',
  scope: 'write',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: z.string().uuid().describe('Page id'),
  },
  handler: async (args, ctx) => {
    const page = await loadPageWithRepoInClassroom(args.page_id, ctx);

    const result = await ClassmojiService.pageContent.discardPreview(page);

    await writeAudit(ctx, {
      resource_type: 'PAGES',
      resource_id: page.id,
      action: 'DELETE',
      data: {
        tool: 'page_preview_discard',
        existed: result.existed,
      } as Prisma.InputJsonValue,
    });

    return ok({
      success: true,
      discarded: true,
      ...(result.existed ? {} : { note: 'Preview branch was already gone' }),
    });
  },
};
