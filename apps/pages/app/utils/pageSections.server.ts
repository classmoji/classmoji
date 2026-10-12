/**
 * Page sections on the pages app: who sees which locked bodies, what a reader
 * may do, and the `/api/page-sections` handlers.
 *
 * Pure on purpose: nothing here imports Prisma, `~/utils/db.server.ts` or
 * `@classmoji/services`. The route modules wire the real lookups in as
 * `PageSectionsDeps`, and the unit suite drives every status path with fakes.
 *
 * The rules (plan R2, R4, R8, R9, R10) come from ONE shared reader rule,
 * `ClassmojiService.pageSections.sectionViewer` (the MCP tools read the same
 * one), handed in here as a `SectionViewerAccess`:
 *   - `revealAll` (OWNER/TEACHER in any invite state — the editor's rule — or
 *     the accepted teaching team) sees every locked body and never records an
 *     unlock.
 *   - `canViewDrafts` (OWNER/TEACHER/ASSISTANT in any invite state) may open a
 *     draft page; it is "not found" for everyone else. Locked bodies still
 *     follow `revealAll`.
 *   - Anyone else gets each locked section's body removed unless THEY unlocked
 *     it, before anything is derived from the document (asset maps, download
 *     maps, the loader payload).
 *   - Check/uncheck: any accepted member, not while impersonated.
 *   - Unlock: `canUnlock` (an accepted student who does not reveal all), not
 *     impersonated.
 *   - Reader-state writes follow the classroom ENTRY rule, not the mutation
 *     rule: allowed in a LOCKED (archived) classroom, refused for non-owners in
 *     an UNPUBLISHED one (the MCP registry's `readerState` tools do the same).
 *   - A write names a block that must exist in the writer's OWN redacted tree,
 *     so a body this user cannot see cannot be probed for its block ids.
 *   - Staff unlock list: `canSeeActivity` (accepted OWNER/TEACHER of the
 *     page's classroom).
 */
import {
  findBlock,
  isCheckableHeading,
  isLockedSection,
  redactLockedSections,
} from '@classmoji/page-schema/sections';

import { canEnterClassroom } from '@classmoji/auth/predicates';
import type { ClassroomStatus, Role } from '@prisma/client';

import { checkOrigin, readCappedBody } from './originCheck.server.ts';

// ── Shared shapes ──────────────────────────────────────────────────────────

/**
 * Headers on every response that carries a reader's section state: the page
 * route and `/api/page-sections`. The page is the same URL for every member of
 * the course, and its payload now differs per reader (which bodies are
 * present, what they checked), so no cache may keep it or hand it to someone
 * else.
 */
export const SECTION_NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});

/**
 * What `ClassmojiService.pageSections.sectionViewer` answers: the one reader
 * rule (see that function for each field).
 */
export interface SectionViewerAccess {
  /** Highest role in any invite state (the classroom status gates read it). */
  role: string | null;
  acceptedRole: string | null;
  teachingTeam: boolean;
  student: boolean;
  canEditAnyState: boolean;
  revealAll: boolean;
  canUnlock: boolean;
  canSeeActivity: boolean;
  /** OWNER/TEACHER/ASSISTANT in any invite state: may open draft pages (locked bodies still follow revealAll). */
  canViewDrafts: boolean;
}

export const NO_SECTION_VIEWER: Readonly<SectionViewerAccess> = Object.freeze({
  role: null,
  acceptedRole: null,
  teachingTeam: false,
  student: false,
  canEditAnyState: false,
  revealAll: false,
  canUnlock: false,
  canSeeActivity: false,
  canViewDrafts: false,
});

/** One reader's own state on one page. */
export interface SectionReaderState {
  checked: string[];
  /** Locked-section id → ISO time this reader unlocked it. */
  unlocked: Record<string, string>;
}

/** `readerSections` in the page loader's payload (the API contract). */
export interface ReaderSections {
  /** Reveal-all reader: bodies present, no lock UI, nothing recorded. */
  staff: boolean;
  /** There is a session user (member or not). */
  signedIn: boolean;
  /** Signed in, accepted member, not impersonated, classroom open to them. */
  canCheck: boolean;
  /** canCheck, an accepted student, and not a reveal-all reader. */
  canUnlock: boolean;
  checked: string[];
  unlocked: Record<string, string>;
}

export type SectionIntent = 'check' | 'uncheck' | 'unlock';

const INTENTS: ReadonlySet<string> = new Set(['check', 'uncheck', 'unlock']);

/** A BlockNote block id, the same shape the service accepts (uuid in practice). */
const BLOCK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ROW_ID_MAX_LENGTH = 255;

export const isSectionBlockId = (value: unknown): value is string =>
  typeof value === 'string' && BLOCK_ID_PATTERN.test(value);

const isRowId = (value: unknown): value is string =>
  typeof value === 'string' && value !== '' && value.length <= ROW_ID_MAX_LENGTH;

const hasOwn = (record: Record<string, unknown>, key: string) =>
  Object.prototype.hasOwnProperty.call(record, key);

// ── Rules ──────────────────────────────────────────────────────────────────

const impersonatedByField = (authData: unknown): unknown => {
  const outer = (authData as { session?: unknown } | null | undefined)?.session;
  const inner = (outer as { session?: unknown } | null | undefined)?.session;
  return (inner as { impersonatedBy?: unknown } | null | undefined)?.impersonatedBy;
};

/**
 * Is this session a platform admin viewing as someone else (better-auth's
 * admin plugin sets `session.impersonatedBy`)? Reads both shapes
 * `getAuthSession` returns: `{ session: { session: {...} } }` from better-auth
 * and the dev test-login fallback's Prisma row, which carries the same field.
 */
export function isImpersonatedSession(authData: unknown): boolean {
  const by = impersonatedByField(authData);
  return typeof by === 'string' ? by !== '' : Boolean(by);
}

/** The impersonating admin's user id, or null (for audit rows). */
export function impersonatorOf(authData: unknown): string | null {
  const by = impersonatedByField(authData);
  return typeof by === 'string' && by !== '' ? by : null;
}

/**
 * May this viewer keep reader state in a classroom with this status? The
 * ENTRY rule (UNPUBLISHED admits only its owner; LOCKED admits everyone), read
 * on the viewer's highest role in any invite state, the role the MCP
 * registry's entry gate reads.
 */
export function classroomOpenFor({
  status,
  viewer,
}: {
  status: ClassroomStatus | string | null | undefined;
  viewer: Pick<SectionViewerAccess, 'role'>;
}): boolean {
  if (!status) return false;
  return canEnterClassroom({
    status: status as ClassroomStatus,
    role: (viewer.role ?? 'STUDENT') as Role,
  });
}

/**
 * The document this reader may receive: unchanged for a reveal-all reader,
 * otherwise every locked section's body removed unless this reader unlocked
 * it. Never mutates `blocks` (callers' content caches are shared).
 */
export function documentForReader<T>(
  blocks: T,
  { revealAll, unlocked }: { revealAll: boolean; unlocked: Record<string, string> }
): T {
  if (revealAll || !Array.isArray(blocks)) return blocks;
  return redactLockedSections(blocks, id => hasOwn(unlocked, id)) as T;
}

/**
 * The class site's document: every locked body removed, for every viewer.
 * Viewer-independent, so a shared cache may keep the render.
 */
export function documentForSite<T>(blocks: T): T {
  if (!Array.isArray(blocks)) return blocks;
  return redactLockedSections(blocks, () => false) as T;
}

/** The loader's `readerSections` (anonymous → all false and empty). */
export function readerSectionsFor({
  signedIn,
  viewer,
  impersonated,
  classroomOpen,
  state,
}: {
  signedIn: boolean;
  viewer: SectionViewerAccess;
  impersonated: boolean;
  /** `classroomOpenFor`: the POST refuses reader state where this is false. */
  classroomOpen: boolean;
  state: SectionReaderState | null;
}): ReaderSections {
  const member = signedIn && viewer.acceptedRole !== null;
  const canCheck = member && !impersonated && classroomOpen;
  return {
    staff: viewer.revealAll,
    signedIn,
    canCheck,
    canUnlock: canCheck && viewer.canUnlock,
    checked: member && state ? [...state.checked] : [],
    unlocked: member && state ? { ...state.unlocked } : {},
  };
}

/**
 * Where a signed-out reader of a public page goes to sign in: the webapp's
 * sign-in page with `?redirect=` naming this page, the same URL the root
 * loader sends a signed-out reader of a members-only page to.
 *
 * The webapp honours `redirect` for relative paths only, so a reader coming
 * from this app's host lands on their dashboard after signing in, not back on
 * the page (true of the root loader's redirect too).
 */
export function signInUrlFor(pageUrl: string): string {
  const webappUrl = process.env.WEBAPP_URL || 'http://localhost:3000';
  return `${webappUrl}?redirect=${encodeURIComponent(pageUrl)}`;
}

/**
 * Does `blockId` name a block this intent may target, in THIS reader's tree?
 * check/uncheck: a heading with `checkable: true`; unlock: a `lockedSection`.
 */
export function sectionTargetValid(tree: unknown, blockId: string, intent: SectionIntent): boolean {
  const block = findBlock(tree, blockId);
  if (!block) return false;
  return intent === 'unlock' ? isLockedSection(block) : isCheckableHeading(block);
}

/** The POST body, or null when it is not `{ pageId, blockId, intent }`. */
export function parseSectionRequest(
  raw: unknown
): { pageId: string; blockId: string; intent: SectionIntent } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { pageId, blockId, intent } = raw as Record<string, unknown>;
  if (!isRowId(pageId) || !isSectionBlockId(blockId)) return null;
  if (typeof intent !== 'string' || !INTENTS.has(intent)) return null;
  return { pageId, blockId, intent: intent as SectionIntent };
}

// ── /api/page-sections ─────────────────────────────────────────────────────

/** The page row fields the handlers read. */
export interface SectionsPage {
  id: string;
  classroom_id: string;
  is_draft: boolean;
  classroom: { status: ClassroomStatus | string };
}

/** The signed-in user (and, when an admin is viewing as them, who). */
export interface SectionsSession {
  userId: string;
  impersonated: boolean;
  impersonatedBy: string | null;
}

export interface PageSectionsDeps<P extends SectionsPage = SectionsPage> {
  /** The signed-in user, or null when there is no session. Throws on a real failure. */
  getSession(request: Request): Promise<SectionsSession | null>;
  /** The page by id (with its classroom's status), or null. */
  findPage(pageId: string): Promise<P | null>;
  /** The one reader rule (`ClassmojiService.pageSections.sectionViewer`). */
  sectionViewer(args: { userId: string; classroomId: string }): Promise<SectionViewerAccess>;
  readerState(args: { pageId: string; userId: string }): Promise<SectionReaderState>;
  /** The page's stored blocks, read the way the loader reads them for a reader. */
  loadReaderBlocks(page: P): Promise<unknown[]>;
  setChecked(args: {
    pageId: string;
    userId: string;
    blockId: string;
    checked: boolean;
  }): Promise<{ checked: boolean; changed: boolean }>;
  recordUnlock(args: {
    page: { id: string; classroom_id: string };
    userId: string;
    blockId: string;
  }): Promise<{ unlockedAt: Date; created: boolean }>;
  /** Unlocks only, for the page row this handler already loaded and authorized. */
  sectionActivity(args: {
    page: { id: string; classroom_id: string };
    blockId: string;
    only: 'unlocks';
  }): Promise<{
    students: number;
    unlocks: Array<{
      userId: string;
      name: string | null;
      login: string | null;
      avatarUrl: string | null;
      at: Date;
    }>;
  } | null>;
  /** One audit row (`resource_type: 'PAGES'`, `resource_id: page.id`). */
  audit(entry: SectionAuditEntry): Promise<unknown>;
  /** A write the service refused as malformed (→ 400). */
  isValidationError(error: unknown): boolean;
}

/**
 * An audit row for this surface. Every write and every staff read is logged,
 * in the same shape as the MCP tools' rows (`via: 'mcp'` there):
 *   - unlock (first time only) → CREATE
 *     `{ tool: 'page_section_unlock', via: 'web', page_id, block_id }`;
 *   - check → CREATE, uncheck → DELETE
 *     `{ tool: 'page_section_check', via: 'web', page_id, block_id, checked }`
 *     (only when the state actually changed, and with `dedupe: false`: each
 *     row is a distinct event, so check → uncheck → check in 5 s is 3 rows);
 *   - the staff list → VIEW
 *     `{ tool: 'page_section_unlocks', via: 'web', page_id, block_id }`, plus
 *     `impersonated_by` when an admin is viewing as the staff member.
 * `role` is the actor's highest ACCEPTED role (the audit service skips rows
 * without a valid one).
 */
export interface SectionAuditEntry {
  userId: string;
  classroomId: string;
  role: string;
  pageId: string;
  action: 'CREATE' | 'DELETE' | 'VIEW';
  data: {
    tool: string;
    via: 'web';
    page_id: string;
    block_id: string;
    [key: string]: string | boolean;
  };
  /** false: skip the audit service's 5-second dedup window. */
  dedupe?: boolean;
}

/**
 * Write an audit row without letting a logging failure undo or fail what the
 * user just did (the write has already happened; the list is theirs to see).
 */
async function auditQuietly(
  deps: Pick<PageSectionsDeps, 'audit'>,
  entry: SectionAuditEntry
): Promise<void> {
  try {
    await deps.audit(entry);
  } catch (error) {
    console.warn(`[page-sections] audit (${entry.data.tool}) failed:`, error);
  }
}

/** The biggest POST this route reads. The real body is ~150 bytes. */
export const SECTION_REQUEST_MAX_BYTES = 4 * 1024;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...SECTION_NO_STORE_HEADERS } });
}

const fail = (status: number, error: string) => json({ error }, status);

/** One answer for "no such page" and "not yours to see", so ids can't be probed. */
const notFound = () => fail(404, 'Not found');

/** A member of a classroom that is not open to them (UNPUBLISHED, not its owner). */
const classroomClosed = () =>
  json({ error: 'This classroom is not open yet', code: 'CLASSROOM_UNPUBLISHED' }, 403);

/**
 * Run a handler so an unexpected failure (the session store, the database) is
 * a 500 that still carries the no-store headers, never a sign-in prompt or a
 * cacheable framework error page.
 */
async function guarded(label: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    console.error(`[page-sections] ${label} failed:`, error);
    return fail(500, 'Something went wrong');
  }
}

/**
 * POST `{ pageId, blockId, intent }`: check, uncheck or unlock one section for
 * the signed-in reader.
 *
 * NOT gated by `pageMutationBlocked`: these are the reader's own state, not an
 * edit to the page, so an archived (LOCKED) classroom keeps them working the
 * same way it keeps the page readable (R8). An UNPUBLISHED classroom refuses
 * them for everyone but its owner (the entry rule).
 */
export function handleSectionsPost<P extends SectionsPage>(
  request: Request,
  deps: PageSectionsDeps<P>
): Promise<Response> {
  return guarded('POST', () => sectionsPost(request, deps));
}

async function sectionsPost<P extends SectionsPage>(
  request: Request,
  deps: PageSectionsDeps<P>
): Promise<Response> {
  if (request.method !== 'POST') return fail(405, 'Method not allowed');

  const origin = checkOrigin(request);
  if (!origin.ok) {
    console.warn('[page-sections] refused cross-site request:', origin.reason, origin.origin);
    return fail(403, 'Forbidden');
  }

  const text = await readCappedBody(request, SECTION_REQUEST_MAX_BYTES);
  if (text === null) return fail(413, 'Request too large');
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    return fail(400, 'Invalid request');
  }
  const body = parseSectionRequest(parsedBody);
  if (!body) return fail(400, 'Invalid request');

  const session = await deps.getSession(request);
  if (!session) return fail(401, 'Sign in to continue');

  const page = await deps.findPage(body.pageId);
  if (!page) return notFound();

  const viewer = await deps.sectionViewer({
    userId: session.userId,
    classroomId: page.classroom_id,
  });
  // Accepted members only: a pending invite or a stranger to the classroom
  // (even on a public page) has no state to keep.
  const actingRole = viewer.acceptedRole;
  if (actingRole === null) return notFound();
  if (page.is_draft && !viewer.canViewDrafts) return notFound();
  if (!classroomOpenFor({ status: page.classroom?.status, viewer })) return classroomClosed();

  // A platform admin viewing as this user must not create their record.
  if (session.impersonated) return fail(403, 'Not available while viewing as another user');

  // Validate against THIS user's tree: the whole document for a reveal-all
  // reader, otherwise the document with every body they have not unlocked
  // removed — a block inside one is "not there" (R4).
  const { revealAll } = viewer;
  const blocks = await deps.loadReaderBlocks(page);
  const unlocked = revealAll
    ? {}
    : (await deps.readerState({ pageId: page.id, userId: session.userId })).unlocked;
  const tree = documentForReader(blocks, { revealAll, unlocked });
  if (!sectionTargetValid(tree, body.blockId, body.intent)) {
    return fail(400, 'No such section on this page');
  }

  try {
    if (body.intent === 'unlock') {
      if (!viewer.canUnlock) {
        return fail(409, 'Staff see locked sections already');
      }
      const { unlockedAt, created } = await deps.recordUnlock({
        page: { id: page.id, classroom_id: page.classroom_id },
        userId: session.userId,
        blockId: body.blockId,
      });
      // Logged once, when the row is made; a repeat unlock changes nothing.
      if (created) {
        await auditQuietly(deps, {
          userId: session.userId,
          classroomId: page.classroom_id,
          role: actingRole,
          pageId: page.id,
          action: 'CREATE',
          data: {
            tool: 'page_section_unlock',
            via: 'web',
            page_id: page.id,
            block_id: body.blockId,
          },
        });
      }
      // The time only. The body reaches the reader through the page loader's
      // revalidation, the one path that serializes documents (R5).
      return json({ ok: true, unlockedAt: unlockedAt.toISOString() });
    }

    const { checked, changed } = await deps.setChecked({
      pageId: page.id,
      userId: session.userId,
      blockId: body.blockId,
      checked: body.intent === 'check',
    });
    // Logged only when the state changed (a repeat click writes nothing), and
    // never coalesced: check → uncheck → check is three events.
    if (changed) {
      await auditQuietly(deps, {
        userId: session.userId,
        classroomId: page.classroom_id,
        role: actingRole,
        pageId: page.id,
        action: checked ? 'CREATE' : 'DELETE',
        data: {
          tool: 'page_section_check',
          via: 'web',
          page_id: page.id,
          block_id: body.blockId,
          checked,
        },
        dedupe: false,
      });
    }
    return json({ ok: true, checked });
  } catch (error) {
    if (deps.isValidationError(error)) return fail(400, 'Invalid request');
    throw error;
  }
}

/**
 * GET `?pageId&blockId`: who among the classroom's current students unlocked
 * one locked section. `canSeeActivity` readers only (accepted OWNER/TEACHER of
 * the page's classroom, the people who see the chip); everyone else gets the
 * same 404 as a page that does not exist. Audited as a VIEW, except for a HEAD
 * request (nothing is shown).
 */
export function handleSectionsGet<P extends SectionsPage>(
  request: Request,
  deps: PageSectionsDeps<P>
): Promise<Response> {
  return guarded('GET', () => sectionsGet(request, deps));
}

async function sectionsGet<P extends SectionsPage>(
  request: Request,
  deps: PageSectionsDeps<P>
): Promise<Response> {
  const url = new URL(request.url);
  const pageId = url.searchParams.get('pageId');
  const blockId = url.searchParams.get('blockId');

  const session = await deps.getSession(request);
  if (!session) return fail(401, 'Sign in to continue');

  if (!isRowId(pageId)) return notFound();
  const page = await deps.findPage(pageId);
  if (!page) return notFound();

  const viewer = await deps.sectionViewer({
    userId: session.userId,
    classroomId: page.classroom_id,
  });
  const actingRole = viewer.acceptedRole;
  if (!viewer.canSeeActivity || actingRole === null) return notFound();
  if (!classroomOpenFor({ status: page.classroom?.status, viewer })) return classroomClosed();
  if (!isSectionBlockId(blockId)) return fail(400, 'Invalid request');

  const activity = await deps.sectionActivity({
    page: { id: page.id, classroom_id: page.classroom_id },
    blockId,
    only: 'unlocks',
  });
  if (!activity) return notFound();

  // A HEAD answers the same status and headers but shows no one anything.
  if (request.method !== 'HEAD') {
    // The list is the staff member's to see either way; a failed log line
    // must not take the popover down with it.
    await auditQuietly(deps, {
      userId: session.userId,
      classroomId: page.classroom_id,
      role: actingRole,
      pageId: page.id,
      action: 'VIEW',
      data: {
        tool: 'page_section_unlocks',
        via: 'web',
        page_id: page.id,
        block_id: blockId,
        ...(session.impersonatedBy ? { impersonated_by: session.impersonatedBy } : {}),
      },
    });
  }

  return json({
    students: activity.students,
    unlocks: activity.unlocks.map(entry => ({
      userId: entry.userId,
      name: entry.name,
      login: entry.login,
      avatarUrl: entry.avatarUrl,
      unlockedAt: entry.at.toISOString(),
    })),
  });
}
