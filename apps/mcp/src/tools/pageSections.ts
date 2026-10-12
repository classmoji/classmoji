/**
 * Page sections over MCP: checkable headings and locked sections.
 *
 *   - `page_sections_status` (OWNER/TEACHER, read): who checked each checkable
 *     heading and who unlocked each locked section on one page.
 *   - `page_section_unlock` (STUDENT, write): open one locked section for the
 *     calling student, the same act as holding the lock on the page.
 *   - `page_section_check` (any accepted member, write): check or uncheck one
 *     checkable heading for the caller, the same act as its checkbox.
 *   Every write audits (PAGES; unlock CREATE on the first unlock, check
 *   CREATE/DELETE on a real change, never coalesced); the status read audits
 *   VIEW per call. Rows carry the caller's ACCEPTED role, and a failed audit
 *   write after a successful act is logged, never turned into a tool error.
 *   - `pageTextForViewer` / `viewerPageText`: the per-viewer page text
 *     `content_get` serves for a page that holds locked sections.
 *
 * ── Who sees a locked body ────────────────────────────────────────────────
 * Decided by the ONE reader rule the pages app also reads
 * (`ClassmojiService.pageSections.sectionViewer`), never from
 * `ctx.classroom.role`: the registry's membership lookup does not filter on
 * `has_accepted_invite`, so a pending invitee passes the registry.
 *   - `revealAll` (OWNER/TEACHER in any invite state — the page editor's rule —
 *     or the accepted teaching team): every body. A draft page is "not found"
 *     to everyone else, on every tool here and in `content_get`.
 *   - an accepted student: the bodies THEY unlocked (`readerState`, scoped
 *     page + user).
 *   - anyone else: no body.
 * `page_sections_status` needs `canSeeActivity` (accepted OWNER/TEACHER): a
 * pending teacher invite passes the registry's role gate and still gets "not
 * found", as on the page.
 * The text is built per call and never stored or cached. The search index
 * never holds a locked body (the extractor stops at a lockedSection's title),
 * so `content_search` and the index text of `content_get` cannot leak one.
 *
 * ── Unlock rules (same as POST /api/page-sections in apps/pages) ──────────
 * `canUnlock` (an accepted student who does not reveal all); a draft is "not
 * found"; the block must be a lockedSection in THIS student's redacted tree,
 * so a locked section nested inside one they have not opened is "not found",
 * exactly like an id that does not exist. The unlock row's classroom is the
 * page row's.
 *
 * ── Classroom status ──────────────────────────────────────────────────────
 * Check and unlock are `readerState` tools: the registry skips its mutation
 * gate for them, so they work in an archived (LOCKED) classroom, and keeps
 * its entry gate, so an UNPUBLISHED classroom refuses non-owners — the same
 * as the page.
 *
 * Impersonation: the MCP has no session to inspect, and needs none. A write
 * tool needs an OAuth token with the `write` scope, and better-auth refuses to
 * issue one while a platform admin is viewing as someone
 * (`packages/auth/src/appConnectionGuard.ts`: /mcp/authorize and
 * /oauth2/consent). Ask Moji's minted tokens are read-only
 * (`ASK_MOJI_SCOPES`), so this tool is never even listed for them.
 */

import { z } from 'zod';
import getPrisma from '@classmoji/database';
import { ClassmojiService } from '@classmoji/services';
import {
  checkableHeadingIds,
  findBlock,
  headingText,
  isCheckableHeading,
  isLockedSection,
  lockedSectionIds,
  lockedSectionTitle,
  redactLockedSections,
} from '@classmoji/page-schema/sections';
import type { Role } from '@prisma/client';
import { ToolError } from '../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../mcp/registry.ts';
import { MEMBER } from '../resources/shape.ts';
import {
  OWNER_TEACHER,
  ok,
  requireClassroomCtx,
  scopedNotFound,
  writeAudit,
  type AuditEntry,
} from './shared.ts';

// ─── Loading a page's blocks ────────────────────────────────────────────────

/** The page row with the content-repo chain a delivery read needs. */
const PAGE_WITH_REPO = {
  include: { classroom: { include: { git_organization: true } } },
} as const;

export interface SectionPageRecord {
  id: string;
  classroom_id: string;
  title: string;
  content_path: string;
  is_draft: boolean;
  is_public: boolean;
  classroom: {
    id: string;
    git_organization?: { login?: string | null } | null;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

/**
 * A page of the bound classroom, by a query that names the classroom (S1):
 * another classroom's page id finds nothing.
 */
async function findPageInClassroom(
  pageId: string,
  ctx: ToolContext
): Promise<SectionPageRecord | null> {
  const { classroomId } = requireClassroomCtx(ctx);
  return (await getPrisma().page.findFirst({
    where: { id: pageId, classroom_id: classroomId },
    ...PAGE_WITH_REPO,
  })) as SectionPageRecord | null;
}

/**
 * The block list of a stored `content.json`: the `{ blocks }` wrapper or a bare
 * array, as a string or already parsed. Null when it is neither.
 */
export function parsePageBlocks(json: unknown): unknown[] | null {
  let parsed = json;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const blocks = (parsed as { blocks?: unknown }).blocks;
    if (Array.isArray(blocks)) return blocks;
  }
  return null;
}

/**
 * The page's `content.json` blocks, read the way `content_get`'s live fallback
 * reads it (the delivery layer, never throws). Null when there is none or it
 * cannot be read: a legacy HTML page has no sections.
 */
async function loadPageBlocks(page: SectionPageRecord, label: string): Promise<unknown[] | null> {
  if (!page.classroom?.git_organization?.login) return null;
  const body = await ClassmojiService.contentDelivery.fetchContentText(
    { classroom: page.classroom as never },
    `${page.content_path}/content.json`,
    { label }
  );
  return body ? parsePageBlocks(body.text) : null;
}

// ─── The viewer ─────────────────────────────────────────────────────────────

export interface SectionViewer {
  /** Teaching team: every locked body. */
  revealAll: boolean;
  /** A student: the sections they unlocked on this page. */
  unlocked: ReadonlySet<string>;
  /** An accepted student (not staff), who may unlock. */
  canUnlock: boolean;
  /** Any accepted member, who may check headings (their own progress). */
  canCheck: boolean;
  /** This user's own checked heading ids on this page. */
  checked: ReadonlySet<string>;
  /** The caller's token has `write`: page_section_unlock / _check are listed. */
  hasWriteTools: boolean;
}

/** What the shared reader rule answers (`ClassmojiService.pageSections.sectionViewer`). */
export type SectionReaderRule = Awaited<
  ReturnType<typeof ClassmojiService.pageSections.sectionViewer>
>;

/** The caller's reader rule in the bound classroom (one membership read). */
async function readerRuleFor(ctx: ToolContext): Promise<SectionReaderRule> {
  const { classroomId } = requireClassroomCtx(ctx);
  return ClassmojiService.pageSections.sectionViewer({ userId: ctx.viewer.userId, classroomId });
}

/**
 * What the calling user is on this page (the shared reader rule), with THEIR
 * OWN reader state (page + user scoped) when they are an accepted member.
 * Nobody else's rows are read.
 */
async function sectionViewerFor(
  pageId: string,
  ctx: ToolContext,
  rule?: SectionReaderRule
): Promise<SectionViewer> {
  const access = rule ?? (await readerRuleFor(ctx));
  const member = access.acceptedRole !== null;
  const state = member
    ? await ClassmojiService.pageSections.readerState({ pageId, userId: ctx.viewer.userId })
    : { checked: [], unlocked: {} };
  return {
    revealAll: access.revealAll,
    // A reveal-all reader never unlocks; their reveal is `revealAll`.
    unlocked: access.revealAll ? new Set() : new Set(Object.keys(state.unlocked)),
    canUnlock: access.canUnlock,
    canCheck: member,
    checked: new Set(state.checked),
    hasWriteTools: ctx.viewer.scopes.has('write'),
  };
}

/** A draft page exists only for the teaching team in any invite state (as on the page). */
export function pageHiddenFrom(
  page: { is_draft: boolean },
  rule: Pick<SectionReaderRule, 'canViewDrafts'>
): boolean {
  return page.is_draft && !rule.canViewDrafts;
}

/**
 * `content_get`'s draft rule for one page of the bound classroom: true when
 * the page is a draft this caller does not reveal all on. Reads the caller's
 * rule only for a draft.
 */
export async function draftHiddenFromCaller(
  page: { is_draft: boolean },
  ctx: ToolContext
): Promise<boolean> {
  if (!page.is_draft) return false;
  return pageHiddenFrom(page, await readerRuleFor(ctx));
}

/** As `draftHiddenFromCaller`, by page id (a page of another classroom is not hidden here: it is not found elsewhere). */
export async function pageDraftHiddenFromCaller(
  pageId: string,
  ctx: ToolContext
): Promise<boolean> {
  const page = await findPageInClassroom(pageId, ctx);
  return page ? draftHiddenFromCaller(page, ctx) : false;
}

/**
 * The audit row for an act that already happened, as the caller's ACCEPTED
 * role. A failed write is logged and the tool's answer stands (the HTTP
 * surface does the same).
 */
async function auditQuietly(
  ctx: ToolContext,
  role: Role,
  entry: Omit<AuditEntry, 'role'>
): Promise<void> {
  try {
    await writeAudit(ctx, { ...entry, role });
  } catch (error) {
    const tool = (entry.data as { tool?: unknown } | undefined)?.tool;
    console.warn(`[mcp] page sections audit (${String(tool)}) failed:`, error);
  }
}

/** The tree this viewer may see: staff everything, others with closed sections emptied. */
function visibleBlocks(blocks: unknown[], viewer: SectionViewer): unknown[] {
  // Staff skip redaction: it fails closed on a section without an id.
  if (viewer.revealAll) return blocks;
  return redactLockedSections(blocks, id => viewer.unlocked.has(id));
}

// ─── Per-viewer text ────────────────────────────────────────────────────────

/** The line a closed locked section becomes. */
export function lockedSectionMarker(
  title: string,
  id: string | null,
  viewer: Pick<SectionViewer, 'canUnlock' | 'hasWriteTools'>
): string {
  if (viewer.canUnlock && id && viewer.hasWriteTools) {
    return `[Locked section "${title}" (id ${id}) — use page_section_unlock to open it]`;
  }
  if (viewer.canUnlock)
    return `[Locked section "${title}" — the student can unlock it on the page]`;
  return `[Locked section "${title}"]`;
}

/** What a checkable heading's line ends with, for a viewer who can check. */
export function checkableHeadingSuffix(id: string, checked: boolean): string {
  return checked ? ` [done] (id ${id})` : ` [not done] (id ${id})`;
}

const markerBlock = (text: string) => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

export interface ViewerSection {
  /** Present for staff and for a student who may unlock. */
  id?: string;
  title: string;
  open: boolean;
}

export interface ViewerHeading {
  id: string;
  title: string;
  /** This viewer's own state. */
  checked: boolean;
}

/**
 * The page's blocks as this viewer may read them, with every locked section
 * turned into marker paragraphs the extractor prints: a closed one becomes its
 * marker line; an open one becomes an opening line, its (still redacted) body,
 * and a closing line. A viewer who can check sees their own state at the end
 * of every checkable heading they can reach. Also lists the locked sections
 * and checkable headings the viewer can see, in document order (anything
 * inside a closed section is not listed: it is not there for them).
 */
export function viewerPageBlocks(
  blocks: unknown[],
  viewer: SectionViewer
): { blocks: unknown[]; sections: ViewerSection[]; headings: ViewerHeading[] } {
  const reveal = (id: string) => viewer.revealAll || viewer.unlocked.has(id);
  const visible = visibleBlocks(blocks, viewer);
  const showIds = viewer.revealAll || viewer.canUnlock;
  const sections: ViewerSection[] = [];
  const headings: ViewerHeading[] = [];

  const mapList = (list: unknown[]): unknown[] => {
    const out: unknown[] = [];
    for (const block of list) {
      if (isLockedSection(block)) {
        const id = typeof block.id === 'string' && block.id ? block.id : null;
        const title = lockedSectionTitle(block) || 'Untitled';
        const open = viewer.revealAll || (id !== null && reveal(id));
        sections.push({ ...(showIds && id ? { id } : {}), title, open });
        if (!open) {
          out.push(markerBlock(lockedSectionMarker(title, id, viewer)));
          continue;
        }
        const label = id ? ` (id ${id})` : '';
        out.push(
          markerBlock(
            viewer.revealAll
              ? `[Locked section "${title}"${label}: students see this only after unlocking it]`
              : `[Locked section "${title}"${label}, unlocked]`
          )
        );
        if (Array.isArray(block.children)) out.push(...mapList(block.children));
        out.push(markerBlock(`[End of locked section "${title}"]`));
        continue;
      }
      let next = block;
      if (
        viewer.canCheck &&
        isCheckableHeading(block) &&
        typeof block.id === 'string' &&
        block.id
      ) {
        const checked = viewer.checked.has(block.id);
        headings.push({ id: block.id, title: headingText(block), checked });
        const content = Array.isArray(block.content) ? block.content : [];
        next = {
          ...block,
          content: [...content, { type: 'text', text: checkableHeadingSuffix(block.id, checked) }],
        };
      }
      const children = (next as { children?: unknown } | null)?.children;
      if (Array.isArray(children) && children.length > 0) {
        out.push({ ...(next as object), children: mapList(children) });
      } else {
        out.push(next);
      }
    }
    return out;
  };

  return { blocks: mapList(Array.isArray(visible) ? visible : []), sections, headings };
}

/** Blocks → plain text through the indexer's own extractor. */
async function extractBlocksText(blocks: unknown[], title?: string): Promise<string | null> {
  const { extractText } = await import('@classmoji/services/content/extract');
  const extracted = extractText(
    { kind: 'blocknote', json: blocks },
    title !== undefined ? { title } : {}
  );
  return extracted.ok ? extracted.text : null;
}

export interface ViewerPageText {
  text: string;
  /** Present when the page holds locked sections. */
  locked_sections?: ViewerSection[];
  /** Present when the viewer can check and the page has checkable headings. */
  checkable_headings?: ViewerHeading[];
}

/**
 * This viewer's text of a page's `content.json` body, or null when nothing in
 * it depends on who reads it (no locked section, and no checkable heading the
 * viewer can check): the shared text is then already right.
 */
export async function viewerPageText(
  page: Pick<SectionPageRecord, 'id' | 'title'>,
  json: unknown,
  ctx: ToolContext
): Promise<ViewerPageText | null> {
  const blocks = parsePageBlocks(json);
  if (!blocks) return null;
  // Any lockedSection counts, with or without an id.
  const hasLocked = containsLockedSection(blocks);
  const hasCheckable = checkableHeadingIds(blocks).length > 0;
  if (!hasLocked && !hasCheckable) return null;
  const viewer = await sectionViewerFor(page.id, ctx);
  if (!hasLocked && !viewer.canCheck) return null;
  const view = viewerPageBlocks(blocks, viewer);
  const text = await extractBlocksText(view.blocks, page.title);
  if (text === null) return null;
  return {
    text,
    ...(hasLocked ? { locked_sections: view.sections } : {}),
    ...(viewer.canCheck && view.headings.length ? { checkable_headings: view.headings } : {}),
  };
}

/** A lockedSection at any depth. */
function containsLockedSection(blocks: unknown): boolean {
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    block =>
      isLockedSection(block) ||
      containsLockedSection((block as { children?: unknown } | null)?.children)
  );
}

/**
 * The per-viewer text of a page `content_get` already served from the index,
 * when the page holds locked sections; null otherwise (or when its
 * `content.json` cannot be read: the index text never holds a locked body, so
 * it stays a safe answer).
 */
export async function pageTextForViewer(
  pageId: string,
  ctx: ToolContext
): Promise<ViewerPageText | null> {
  const page = await findPageInClassroom(pageId, ctx);
  if (!page) return null;
  const blocks = await loadPageBlocks(page, 'content_get');
  if (!blocks) return null;
  return viewerPageText(page, blocks, ctx);
}

// ─── page_sections_status ───────────────────────────────────────────────────

const pageIdArg = z.string().uuid().describe('Page id (from list_pages or content_list)');

/** A BlockNote block id (the service's own shape: letters, digits, - and _, ≤ 64). */
const blockIdArg = (description: string) =>
  z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'Must be a block id')
    .describe(description);

interface StatusArgs {
  classroom: string;
  page_id: string;
}

interface ActivityRow {
  blockId: string;
  name: string | null;
  login: string | null;
  at: Date;
}

const presentStudent = (row: ActivityRow) => ({
  name: row.name,
  login: row.login,
  at: row.at.toISOString(),
});

export const pageSectionsStatusTool: ToolDefinition<StatusArgs> = {
  name: 'page_sections_status',
  title: 'Page sections: checks and unlocks',
  description:
    "Shows students' progress on one page: for every checkable heading, how many current " +
    'students checked it, and who and when; for every locked section, how many unlocked it, and ' +
    'who and when. `students` is the number of current students in the class. Counts only ' +
    'current students of this classroom (removed students and staff are left out).',
  scope: 'read',
  roles: OWNER_TEACHER,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: pageIdArg,
  },
  handler: async (args, ctx) => {
    const [page, rule] = await Promise.all([
      findPageInClassroom(args.page_id, ctx),
      readerRuleFor(ctx),
    ]);
    // Accepted OWNER/TEACHER only, as the page's unlock list: a pending
    // teacher invite passes the registry and still finds nothing here.
    const actingRole = rule.acceptedRole;
    if (!page || !rule.canSeeActivity || !actingRole) throw scopedNotFound('Page');

    // The page row was just found by a query naming the bound classroom.
    const activity = await ClassmojiService.pageSections.sectionActivity({
      page: { id: page.id, classroom_id: page.classroom_id },
    });
    if (!activity) throw scopedNotFound('Page');

    const blocks = await loadPageBlocks(page, 'page_sections_status');

    const byBlock = (rows: ActivityRow[]) => {
      const map = new Map<string, ActivityRow[]>();
      for (const row of rows) map.set(row.blockId, [...(map.get(row.blockId) ?? []), row]);
      return map;
    };
    const checks = byBlock(activity.checks);
    const unlocks = byBlock(activity.unlocks);
    const headingTitle = (id: string) => (blocks ? headingText(findBlock(blocks, id)) : '');
    const lockTitle = (id: string) => (blocks ? lockedSectionTitle(findBlock(blocks, id)) : '');

    const headingIds = blocks ? checkableHeadingIds(blocks) : [];
    const lockedIds = blocks ? lockedSectionIds(blocks) : [];

    const checkable_headings = headingIds.map(id => {
      const rows = checks.get(id) ?? [];
      return {
        id,
        title: headingTitle(id),
        checked: rows.length,
        students: rows.map(presentStudent),
      };
    });
    const locked_sections = lockedIds.map(id => {
      const rows = unlocks.get(id) ?? [];
      return {
        id,
        title: lockTitle(id) || 'Untitled',
        unlocked: rows.length,
        students: rows.map(presentStudent),
      };
    });

    // Rows on blocks the current content no longer has (deleted or retyped),
    // or every row when the content could not be read.
    const known = new Set([...headingIds, ...lockedIds]);
    const orphaned = [
      ...[...checks]
        .filter(([id]) => !known.has(id))
        .map(([id, rows]) => ({
          id,
          kind: 'check' as const,
          count: rows.length,
        })),
      ...[...unlocks]
        .filter(([id]) => !known.has(id))
        .map(([id, rows]) => ({
          id,
          kind: 'unlock' as const,
          count: rows.length,
        })),
    ];

    await auditQuietly(ctx, actingRole, {
      resource_type: 'PAGES',
      resource_id: page.id,
      action: 'VIEW',
      data: { tool: 'page_sections_status', via: 'mcp', page_id: page.id },
    });

    return ok({
      page_id: page.id,
      title: page.title,
      students: activity.students,
      checkable_headings,
      locked_sections,
      ...(orphaned.length ? { not_in_current_content: orphaned } : {}),
      ...(blocks
        ? {}
        : { content_unavailable: true, note: "The page's content could not be read." }),
    });
  },
};

// ─── page_section_unlock ────────────────────────────────────────────────────

interface UnlockArgs {
  classroom: string;
  page_id: string;
  block_id: string;
}

/** The same refusal for a bogus id, a non-lockedSection and a hidden nested one. */
const sectionNotFound = () =>
  new ToolError('invalid_params', 'No locked section with that id on this page');

export const pageSectionUnlockTool: ToolDefinition<UnlockArgs> = {
  name: 'page_section_unlock',
  title: 'Unlock a locked page section',
  // Not reversible, and the teaching staff see who unlocked what and when, so
  // a client should ask the student first.
  annotations: { destructive: true, idempotent: true, openWorld: false },
  description:
    'Opens one locked section of a page for YOU (students only) and returns its text. Unlocking ' +
    'is recorded, cannot be undone, and staff can see who unlocked what and when, so confirm ' +
    'with the student before calling. block_id is the id in a "[Locked section ...]" line of ' +
    'content_get.',
  scope: 'write',
  roles: ['STUDENT'],
  // The caller's own record, not the classroom's content (archived: allowed).
  readerState: true,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: pageIdArg,
    block_id: blockIdArg('The locked section id, from content_get'),
  },
  handler: async (args, ctx) => {
    const userId = ctx.viewer.userId;

    const rule = await readerRuleFor(ctx);
    // Reveal-all readers (the teaching team, and anyone holding an OWNER or
    // TEACHER invite, accepted or not) already see every body: the page
    // answers them 409, this answers the same refusal.
    if (rule.revealAll) {
      throw new ToolError(
        'forbidden',
        'Teaching staff already see every locked section; nothing is recorded for staff',
        'TEACHING_TEAM'
      );
    }
    // Not an accepted student (a pending invite): the page is not theirs to unlock.
    const actingRole = rule.acceptedRole;
    if (!rule.canUnlock || !actingRole) throw scopedNotFound('Page');

    const page = await findPageInClassroom(args.page_id, ctx);
    if (!page || pageHiddenFrom(page, rule)) throw scopedNotFound('Page');

    const blocks = await loadPageBlocks(page, 'page_section_unlock');
    if (!blocks) {
      throw new ToolError(
        'internal',
        "This page's content could not be read from the content repository; try again"
      );
    }

    const state = await ClassmojiService.pageSections.readerState({ pageId: page.id, userId });
    const unlocked = new Set(Object.keys(state.unlocked));
    const visible = redactLockedSections(blocks, id => unlocked.has(id));
    const target = findBlock(visible, args.block_id);
    if (!target || !isLockedSection(target)) throw sectionNotFound();

    const { unlockedAt, created } = await ClassmojiService.pageSections.recordUnlock({
      page: { id: page.id, classroom_id: page.classroom_id },
      userId,
      blockId: args.block_id,
    });

    if (created) {
      await auditQuietly(ctx, actingRole, {
        resource_type: 'PAGES',
        resource_id: page.id,
        action: 'CREATE',
        data: {
          tool: 'page_section_unlock',
          via: 'mcp',
          page_id: page.id,
          block_id: args.block_id,
        },
      });
    }

    // The body only: this section's children, with the sections nested in it
    // still closed unless this student opened them before.
    unlocked.add(args.block_id);
    const opened = findBlock(
      redactLockedSections(blocks, id => unlocked.has(id)),
      args.block_id
    );
    const body = Array.isArray(opened?.children) ? opened.children : [];
    const view = viewerPageBlocks(body, {
      revealAll: false,
      unlocked,
      canUnlock: true,
      canCheck: true,
      checked: new Set(state.checked),
      hasWriteTools: true,
    });
    const text = (await extractBlocksText(view.blocks)) ?? '';

    return ok({
      page_id: page.id,
      block_id: args.block_id,
      title: lockedSectionTitle(target) || 'Untitled',
      unlocked_at: unlockedAt.toISOString(),
      already_unlocked: !created,
      text,
      ...(view.sections.length ? { locked_sections: view.sections } : {}),
      ...(view.headings.length ? { checkable_headings: view.headings } : {}),
    });
  },
};

// ─── page_section_check ─────────────────────────────────────────────────────

interface CheckArgs {
  classroom: string;
  page_id: string;
  block_id: string;
  checked: boolean;
}

export const pageSectionCheckTool: ToolDefinition<CheckArgs> = {
  name: 'page_section_check',
  title: 'Check or uncheck a page section',
  // The reader's own progress mark, reversible by calling again.
  annotations: { destructive: false, idempotent: true, openWorld: false },
  description:
    'Marks a checkable heading of a page done (checked: true) or not done (checked: false) for ' +
    'YOU, the same as its checkbox on the page. block_id is the id in a "[done]" or ' +
    '"[not done]" heading line of content_get. Staff can see who checked what.',
  scope: 'write',
  roles: MEMBER,
  // The caller's own progress, not the classroom's content (archived: allowed).
  readerState: true,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    page_id: pageIdArg,
    block_id: blockIdArg('The checkable heading id, from content_get'),
    checked: z.boolean().describe('true = done, false = not done'),
  },
  handler: async (args, ctx) => {
    const [page, rule] = await Promise.all([
      findPageInClassroom(args.page_id, ctx),
      readerRuleFor(ctx),
    ]);
    // Accepted members only (a pending invite reads the page but keeps no
    // state); a draft only for readers who see every body.
    const actingRole = rule.acceptedRole;
    if (!page || !actingRole || pageHiddenFrom(page, rule)) throw scopedNotFound('Page');

    const viewer = await sectionViewerFor(page.id, ctx, rule);

    const blocks = await loadPageBlocks(page, 'page_section_check');
    if (!blocks) {
      throw new ToolError(
        'internal',
        "This page's content could not be read from the content repository; try again"
      );
    }

    // In THIS user's tree: a heading inside a locked section they have not
    // opened is not there for them, and answers like an id that does not exist.
    const target = findBlock(visibleBlocks(blocks, viewer), args.block_id);
    if (!target || !isCheckableHeading(target)) {
      throw new ToolError('invalid_params', 'No checkable heading with that id on this page');
    }

    // The service says whether the row actually changed (race-safe), so a
    // repeat call writes no audit row.
    const { changed } = await ClassmojiService.pageSections.setChecked({
      pageId: page.id,
      userId: ctx.viewer.userId,
      blockId: args.block_id,
      checked: args.checked,
    });
    // Never coalesced: check → uncheck → check is three events.
    if (changed) {
      await auditQuietly(ctx, actingRole, {
        dedupe: false,
        resource_type: 'PAGES',
        resource_id: page.id,
        action: args.checked ? 'CREATE' : 'DELETE',
        data: {
          tool: 'page_section_check',
          via: 'mcp',
          page_id: page.id,
          block_id: args.block_id,
          checked: args.checked,
        },
      });
    }

    return ok({
      page_id: page.id,
      block_id: args.block_id,
      title: headingText(target),
      checked: args.checked,
      changed,
    });
  },
};
