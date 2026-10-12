/**
 * Page sections on the pages app: who sees which locked bodies, what a reader
 * may do, and the `/api/page-sections` handlers.
 *
 * Pure on purpose: nothing here imports Prisma, `~/utils/db.server.ts` or
 * `@classmoji/services`. The route modules wire the real lookups in as
 * `PageSectionsDeps`, and the unit suite drives every status path with fakes.
 *
 * The rules (plan R2, R4, R8, R9, R10):
 *   - A reader who may edit the page (`canEdit`: OWNER/TEACHER, the editor's
 *     own lookup) or whose highest ACCEPTED role is on the teaching team sees
 *     every locked body and never records an unlock ("reveal all").
 *   - Anyone else gets each locked section's body removed unless THEY unlocked
 *     it, before anything is derived from the document (asset maps, download
 *     maps, the loader payload).
 *   - Check/uncheck: any accepted member, not while impersonated.
 *   - Unlock: an accepted student who does not reveal all, not impersonated.
 *   - A write names a block that must exist in the writer's OWN redacted tree,
 *     so a body this user cannot see cannot be probed for its block ids.
 *   - Staff unlock list: accepted OWNER/TEACHER of the page's classroom.
 */
import {
  findBlock,
  isCheckableHeading,
  isLockedSection,
  redactLockedSections,
} from '@classmoji/page-schema/sections';

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

/** What `ClassmojiService.pageSections.readerAccess` answers (accepted-only). */
export interface SectionReaderAccess {
  acceptedRole: string | null;
  teachingTeam: boolean;
  student: boolean;
}

export const NO_READER_ACCESS: SectionReaderAccess = Object.freeze({
  acceptedRole: null,
  teachingTeam: false,
  student: false,
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
  /** Signed in, accepted member, not impersonated. */
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

/**
 * Is this session a platform admin viewing as someone else (better-auth's
 * admin plugin sets `session.impersonatedBy`)? Reads both shapes
 * `getAuthSession` returns: `{ session: { session: {...} } }` from better-auth
 * and the dev test-login fallback's Prisma row, which carries the same field.
 */
export function isImpersonatedSession(authData: unknown): boolean {
  const outer = (authData as { session?: unknown } | null | undefined)?.session;
  const inner = (outer as { session?: unknown } | null | undefined)?.session;
  const by = (inner as { impersonatedBy?: unknown } | null | undefined)?.impersonatedBy;
  return typeof by === 'string' ? by !== '' : Boolean(by);
}

/** R2: who gets every locked body. */
export function revealsAllSections({
  canEdit,
  access,
}: {
  canEdit: boolean;
  access: SectionReaderAccess;
}): boolean {
  return canEdit || access.teachingTeam;
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
  access,
  impersonated,
  revealAll,
  state,
}: {
  signedIn: boolean;
  access: SectionReaderAccess;
  impersonated: boolean;
  revealAll: boolean;
  state: SectionReaderState | null;
}): ReaderSections {
  const member = signedIn && access.acceptedRole !== null;
  const canCheck = member && !impersonated;
  return {
    staff: revealAll,
    canCheck,
    canUnlock: canCheck && access.student && !revealAll,
    checked: member && state ? [...state.checked] : [],
    unlocked: member && state ? { ...state.unlocked } : {},
  };
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
}

export interface PageSectionsDeps<P extends SectionsPage = SectionsPage> {
  /** The signed-in user, or null. */
  getSession(request: Request): Promise<{ userId: string; impersonated: boolean } | null>;
  /** The page by id, or null. */
  findPage(pageId: string): Promise<P | null>;
  /** Accepted-only access to a classroom. */
  readerAccess(args: { userId: string; classroomId: string }): Promise<SectionReaderAccess>;
  /** The editor's own rule (OWNER/TEACHER, any invite state): the loader's `canEdit`. */
  canEdit(args: { userId: string; classroomId: string }): Promise<boolean>;
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
  sectionActivity(args: { pageId: string; classroomId: string; blockId: string }): Promise<{
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
 * An audit row for this surface. Every write and every staff read is logged:
 *   - unlock (first time only) → CREATE `{ tool: 'page_section_unlock', block_id }`
 *     (the same shape as the MCP unlock tool's row);
 *   - check → CREATE, uncheck → DELETE `{ tool: 'page_section_check', block_id, checked }`
 *     (only when the state actually changed, like the MCP tool);
 *   - the staff list → VIEW `{ tool: 'page_section_unlocks', page_id, block_id }`.
 * `role` is the actor's highest ACCEPTED role (the audit service skips rows
 * without a valid one).
 */
export interface SectionAuditEntry {
  userId: string;
  classroomId: string;
  role: string;
  pageId: string;
  action: 'CREATE' | 'DELETE' | 'VIEW';
  data: { tool: string; block_id: string; [key: string]: string | boolean };
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

const STAFF_LIST_ROLES: ReadonlySet<string> = new Set(['OWNER', 'TEACHER']);

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...SECTION_NO_STORE_HEADERS } });
}

const fail = (status: number, error: string) => json({ error }, status);

/** One answer for "no such page" and "not yours to see", so ids can't be probed. */
const notFound = () => fail(404, 'Not found');

/**
 * POST `{ pageId, blockId, intent }`: check, uncheck or unlock one section for
 * the signed-in reader.
 *
 * NOT gated by `pageMutationBlocked`: these are the reader's own state, not an
 * edit to the page, so an archived or ended classroom keeps them working the
 * same way it keeps the page readable (R8).
 */
export async function handleSectionsPost<P extends SectionsPage>(
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

  const [access, canEdit] = await Promise.all([
    deps.readerAccess({ userId: session.userId, classroomId: page.classroom_id }),
    deps.canEdit({ userId: session.userId, classroomId: page.classroom_id }),
  ]);
  // Accepted members only: a pending invite or a stranger to the classroom
  // (even on a public page) has no state to keep.
  if (access.acceptedRole === null) return notFound();
  const revealAll = revealsAllSections({ canEdit, access });
  if (page.is_draft && !revealAll) return notFound();

  // A platform admin viewing as this user must not create their record.
  if (session.impersonated) return fail(403, 'Not available while viewing as another user');

  // Validate against THIS user's tree: the whole document for a reveal-all
  // reader, otherwise the document with every body they have not unlocked
  // removed — a block inside one is "not there" (R4).
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
      if (!access.student || revealAll) {
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
          role: access.acceptedRole,
          pageId: page.id,
          action: 'CREATE',
          data: { tool: 'page_section_unlock', block_id: body.blockId },
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
    // Logged only when the state changed (a repeat click writes nothing).
    if (changed) {
      await auditQuietly(deps, {
        userId: session.userId,
        classroomId: page.classroom_id,
        role: access.acceptedRole,
        pageId: page.id,
        action: checked ? 'CREATE' : 'DELETE',
        data: { tool: 'page_section_check', block_id: body.blockId, checked },
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
 * one locked section. Accepted OWNER/TEACHER of the page's classroom only
 * (the people who see the chip); everyone else gets the same 404 as a page
 * that does not exist. Audited as a VIEW.
 */
export async function handleSectionsGet<P extends SectionsPage>(
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

  const access = await deps.readerAccess({
    userId: session.userId,
    classroomId: page.classroom_id,
  });
  if (access.acceptedRole === null || !STAFF_LIST_ROLES.has(access.acceptedRole)) {
    return notFound();
  }
  if (!isSectionBlockId(blockId)) return fail(400, 'Invalid request');

  const activity = await deps.sectionActivity({
    pageId: page.id,
    classroomId: page.classroom_id,
    blockId,
  });
  if (!activity) return notFound();

  // The list is the staff member's to see either way; a failed log line must
  // not take the popover down with it.
  await auditQuietly(deps, {
    userId: session.userId,
    classroomId: page.classroom_id,
    role: access.acceptedRole,
    pageId: page.id,
    action: 'VIEW',
    data: { tool: 'page_section_unlocks', page_id: page.id, block_id: blockId },
  });

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
