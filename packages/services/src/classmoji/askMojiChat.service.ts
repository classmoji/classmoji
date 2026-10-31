/**
 * Conversation storage and turn admission for Ask Moji served as a chat agent
 * (the `ask-moji` Trigger task). One `ai_conversations` row of type
 * SYLLABUS_BOT per conversation; its id is the chat id.
 *
 * A conversation on this runtime carries `context.grant` (`AskMojiGrant`),
 * written when the session module creates it. Rows without one are the legacy
 * WebSocket path's: nothing here reuses, admits or reads them. `context` keys
 * are written one at a time (`writeContextKey`): `grant`, `runtime` (the
 * transport's cursors), `summary` (compaction) and `session` (the Trigger
 * session record) never clobber each other.
 *
 * Every id is the server's: the caller passes the session user, the classroom
 * it resolved and the request's scope (who is acting, and under which
 * impersonation), or the chat id the task was started with, and each read
 * re-checks the row's own owner, classroom, type and scope. A missing row and
 * someone else's row get the same answer.
 *
 * SCOPE (R2). A conversation belongs to the request scope that started it:
 * the grant's `actor_user_id` and its impersonation session id. A request
 * under an impersonation never finds, continues, ends or rates a conversation
 * the user started themselves, nor one from another impersonation session,
 * and the reverse.
 *
 * Messages live in `ai_conversation_messages` as UIMessage parts
 * (`format: 'ui_message_v1'`), keyed by `(conversation_id, ui_message_id)`.
 * A user row is written at admission, with server-only metadata (the acting
 * role, the resolved viewing); an assistant row once its reply ends, with its
 * full parts (the model's memory, MCP tool results included) and server-only
 * usage and cites. What the browser gets is always projected
 * (`projectAskMojiTranscript`): text, cite_content and the notice/step data
 * parts, and of the metadata only a user row's `viewing`.
 *
 * SETTLED MARKER (R3). Every turn end writes `metadata.settled {outcome, at}`
 * on the user row it answered: `final` (persistAssistantMessage with a final
 * reply), `failed` or `stopped` (`settleTurn`, or a non-final persist with an
 * outcome). A re-delivery that runs the turn again clears it. `inFlight` (in
 * `state`) is: the latest user row has no marker, no final reply follows it,
 * and the conversation moved within `IN_FLIGHT_STALE_MS`.
 *
 * Nothing here writes audit rows: the callers (the session module, the task)
 * audit the user actions they perform.
 */

import getPrisma from '@classmoji/database';
import {
  canonicalTimeZone,
  resolveEffectiveTimeZone,
  type EffectiveTimeZone,
} from '@classmoji/utils';
import {
  ASK_MOJI_REFUSALS,
  AskMojiMessageMetadataSchema,
  AskMojiUsageSchema,
  AskMojiViewingSchema,
  CONTRACT_VERSION,
  INSTRUCTIONS_MAX_CHARS,
  IN_FLIGHT_STALE_MS,
  MAX_MESSAGE_CHARS,
  ROLE_RANK,
  START_RATE_LIMIT,
  actingRole,
  citesFromParts,
  isAskMojiRole,
  projectAskMojiTranscript,
  stubLookupOutputs,
  withRateable,
  type AskMojiMessageMetadata,
  type AskMojiRefusalCode,
  type AskMojiRole,
  type AskMojiTurnOutcome,
  type AskMojiUIMessage,
  type AskMojiUsage,
  type AskMojiUserRowMetadata,
} from '@classmoji/utils/ask-moji';
import { containsReservedText } from '@classmoji/utils/quiz-agent';
import type { Prisma } from '@prisma/client';
import {
  resolve as resolveViewing,
  viewingRef,
  type ResolvedViewing,
} from './askMojiViewing.service.ts';
import { canUseSyllabusBot } from './entitlement.service.ts';
import {
  ASK_MOJI_REDELIVERY,
  CLIENT_MESSAGE_ID_PATTERN,
  MIN_TURN_INTERVAL_MS,
  classroomAllowsTurn,
  findStoredMessage,
  grantHolds,
  isObject,
  nextCreatedAt,
  replyStateAfter,
  toUIMessage,
  writeContextKey,
  type ChatGrant,
  type Tx,
} from './chatShared.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

const TYPE = 'SYLLABUS_BOT' as const;

/** The roles that may use Ask Moji at all (the webapp route's BOT_ROLES). */
export const BOT_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'] as const;

/** Same bounds as the quiz's locked transactions. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/** The longest compaction summary stored, in characters. */
export const SUMMARY_MAX_CHARS = 40_000;

/**
 * `ai_conversations.context.grant` for an Ask Moji conversation: the quiz's
 * chat grant plus what the conversation was started as.
 * - `role`: the user's highest role at start (re-derived by `findOrCreate`).
 * - `view_as`: the role the widget was opened as (tone and suggestions),
 *   clamped to at most `role`.
 * - `role_ceiling`: `view_as` when the user held it at start, else null (no
 *   ceiling). The MCP is asked to act at or below it; admission picks the
 *   acting role under it.
 * - `browser_timezone`: the browser's zone at start, canonical or null.
 * - `contract_version`: the stored message contract the conversation runs on.
 */
export interface AskMojiGrant extends ChatGrant {
  view_as: AskMojiRole;
  role_ceiling: AskMojiRole | null;
  browser_timezone: string | null;
  contract_version: number;
}

/** `ai_conversations.context.runtime`: the transport's cursors and opaque state. */
export type AskMojiRuntimeState = { cursors: unknown; state: unknown };

/** `ai_conversations.context.summary`: what compaction wrote. */
export type AskMojiSummary = {
  text: string;
  /** The last message the summary covers; history reads rows after it. */
  through_message_id: string;
  created_at: string;
  model: string | null;
};

export type AskMojiRefusal = { ok: false; code: AskMojiRefusalCode; permanent: boolean };

const refusal = (code: AskMojiRefusalCode): AskMojiRefusal => ({
  ok: false,
  code,
  permanent: ASK_MOJI_REFUSALS[code] === 'permanent',
});

/**
 * The request a call is made for: the effective user, who is acting, and the
 * impersonation behind it (`assertAskMojiAccess`'s result fits as it is).
 * Omitted fields mean the user acting as themselves, not impersonated.
 */
export type AskMojiScope = {
  userId: string;
  actorUserId?: string;
  impersonation?: { sessionId: string | null } | null;
};

/** A conversation the caller may continue: its id, grant, last activity and Trigger session. */
export type OwnedConversation = {
  conversationId: string;
  grant: AskMojiGrant;
  lastActivity: Date;
  /** The Trigger session recorded for it (`recordTriggerSession`), or null when none was started. */
  triggerSessionId: string | null;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const isString = (v: unknown): v is string => typeof v === 'string' && v !== '';
const nullableString = (v: unknown) => v === null || typeof v === 'string';

/** A conversation id as a caller may hand it in: a bounded string, else nothing matches. */
const validId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= 128;

/** A stored message id (assistant ids contain `:`): a bounded string. */
export const validMessageId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= 200;

/** The Ask Moji grant in a `context` value, or null when it has none (legacy) or a malformed one. */
export const readGrant = (context: unknown): AskMojiGrant | null => {
  const grant = isObject(context) ? context.grant : undefined;
  if (!isObject(grant)) return null;
  if (!isString(grant.actor_user_id) || !isString(grant.effective_user_id)) return null;
  if (!isString(grant.classroom_id) || !isString(grant.role)) return null;
  if (!isAskMojiRole(grant.view_as)) return null;
  if (grant.role_ceiling !== null && !isAskMojiRole(grant.role_ceiling)) return null;
  if (!nullableString(grant.browser_timezone) || !nullableString(grant.web_session_id)) return null;
  if (typeof grant.contract_version !== 'number') return null;
  if (grant.impersonation !== null && !isObject(grant.impersonation)) return null;
  return grant as unknown as AskMojiGrant;
};

const readTriggerSessionId = (context: unknown): string | null => {
  const session = isObject(context) ? context.session : undefined;
  return isObject(session) && isString(session.id) ? session.id : null;
};

const holds = (
  grant: AskMojiGrant,
  row: { user_id: string; classroom_id: string },
  now: number
): boolean => grantHolds(grant, { userId: row.user_id, classroomId: row.classroom_id }, now);

type NormalizedScope = {
  userId: string;
  actorUserId: string;
  sessionId: string | null;
  impersonated: boolean;
};

const normalizeScope = (s: AskMojiScope): NormalizedScope => ({
  userId: s.userId,
  actorUserId: s.actorUserId ?? s.userId,
  impersonated: Boolean(s.impersonation),
  sessionId: s.impersonation?.sessionId ?? null,
});

/** Whether a grant was issued to this request scope (R2). */
export const scopeMatches = (grant: AskMojiGrant, scope: AskMojiScope): boolean => {
  const s = normalizeScope(scope);
  if (grant.effective_user_id !== s.userId || grant.actor_user_id !== s.actorUserId) return false;
  if (!grant.impersonation) return !s.impersonated;
  return s.impersonated && (grant.impersonation.session_id ?? null) === s.sessionId;
};

const lockConversation = async (tx: Tx, conversationId: string): Promise<boolean> => {
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM ai_conversations WHERE id = ${conversationId} FOR UPDATE`;
  return locked.length > 0;
};

const lockUser = (tx: Tx, userId: string) =>
  tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${`ask-moji:${userId}`}))) AS l`;

const textOf = (parts: readonly unknown[]): string =>
  parts
    .filter(
      (p): p is { type: 'text'; text: string } =>
        isObject(p) && p.type === 'text' && typeof p.text === 'string'
    )
    .map(p => p.text)
    .join('\n\n');

const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/** The latest admitted user row of a conversation. */
const latestUserRow = (db: Pick<Tx, 'aIConversationMessage'>, conversationId: string) =>
  db.aIConversationMessage.findFirst({
    where: { conversation_id: conversationId, role: 'USER', format: 'ui_message_v1' },
    orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
    select: { ui_message_id: true, created_at: true, metadata: true },
  });

/** Write (or with null, clear) the settled marker on a user row. */
const writeSettled = async (
  db: Pick<Tx, '$executeRaw'>,
  conversationId: string,
  uiMessageId: string,
  outcome: AskMojiTurnOutcome | null
): Promise<number> => {
  if (outcome === null) {
    return db.$executeRaw`
      UPDATE ai_conversation_messages SET metadata = metadata - 'settled'
      WHERE conversation_id = ${conversationId} AND ui_message_id = ${uiMessageId}
        AND role = 'USER' AND metadata ? 'settled'`;
  }
  const json = JSON.stringify({ outcome, at: new Date().toISOString() });
  return db.$executeRaw`
    UPDATE ai_conversation_messages
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{settled}', ${json}::jsonb, true)
    WHERE conversation_id = ${conversationId} AND ui_message_id = ${uiMessageId} AND role = 'USER'`;
};

// ─── Session start ──────────────────────────────────────────────────────────

const OWNED_SELECT = {
  id: true,
  user_id: true,
  classroom_id: true,
  context: true,
  last_activity: true,
} as const;

/**
 * The conversation the widget opens on: the user's one ACTIVE Ask Moji
 * conversation in this classroom for this `viewAs` and this request scope,
 * carrying a grant (legacy rows never match) that still holds. It has no
 * expiry: it lasts until the user starts a new one. Null when there is none.
 */
export const findActive = async (
  i: AskMojiScope & { classroomId: string; viewAs: string; now?: Date }
): Promise<OwnedConversation | null> =>
  findActiveIn(getPrisma(), i, (i.now ?? new Date()).getTime());

const findActiveIn = async (
  db: Pick<Tx, 'aIConversation'>,
  i: AskMojiScope & { classroomId: string; viewAs: string },
  now: number
): Promise<OwnedConversation | null> => {
  if (!isAskMojiRole(i.viewAs)) return null;
  const rows = await db.aIConversation.findMany({
    where: { user_id: i.userId, classroom_id: i.classroomId, type: TYPE, status: 'ACTIVE' },
    orderBy: [{ last_activity: 'desc' }, { started_at: 'desc' }],
    select: OWNED_SELECT,
  });
  for (const row of rows) {
    const grant = readGrant(row.context);
    if (!grant || grant.view_as !== i.viewAs || !holds(grant, row, now)) continue;
    if (!scopeMatches(grant, i)) continue;
    return {
      conversationId: row.id,
      grant,
      lastActivity: row.last_activity,
      triggerSessionId: readTriggerSessionId(row.context),
    };
  }
  return null;
};

export type FindOrCreateResult =
  | {
      ok: true;
      conversationId: string;
      grant: AskMojiGrant;
      /** Whether a conversation was created by this call (else an existing one is reused). */
      created: boolean;
      /**
       * Conversations this call ended: the replaced ones, and the user's
       * unusable ones in this classroom (`closeUnusable`). Without a create,
       * only unusable ones.
       */
      closedConversationIds: string[];
      /** Those of them with a recorded Trigger session: the caller closes these (`sessions.close`). */
      closedWithSession: string[];
      triggerSessionId: string | null;
    }
  | FindOrCreateRefusal;

/**
 * A refused start. The unusable conversations closed before the refusal stay
 * closed (`closeUnusable`); they are listed here, when there were any, so the
 * caller can close their Trigger sessions.
 */
export type FindOrCreateRefusal = AskMojiRefusal & {
  closedConversationIds?: string[];
  closedWithSession?: string[];
};

/** Kept for callers of the first version; `findOrCreate` with a create. */
export type CreateResult =
  | { ok: true; conversationId: string; closedConversationIds: string[] }
  | AskMojiRefusal;

/**
 * The grant as stored: `role` (highest held), `view_as` (clamped to at most
 * it) and `role_ceiling` (`view_as` when held, else null) re-derived from the
 * user's current memberships, whatever the caller sent; the browser zone kept
 * only when it is a real zone; stamped with `CONTRACT_VERSION`.
 */
const deriveGrant = (
  requested: Omit<AskMojiGrant, 'contract_version'>,
  held: readonly AskMojiRole[]
): AskMojiGrant => {
  const highest = held.reduce<AskMojiRole>(
    (best, r) => (ROLE_RANK[r] > ROLE_RANK[best] ? r : best),
    held[0]
  );
  const viewAs =
    isAskMojiRole(requested.view_as) && ROLE_RANK[requested.view_as] <= ROLE_RANK[highest]
      ? requested.view_as
      : highest;
  return {
    ...requested,
    role: highest,
    view_as: viewAs,
    role_ceiling: held.includes(viewAs) ? viewAs : null,
    browser_timezone: canonicalTimeZone(requested.browser_timezone),
    contract_version: CONTRACT_VERSION,
  };
};

class Refused extends Error {
  readonly code: AskMojiRefusalCode;
  constructor(code: AskMojiRefusalCode) {
    super(`ask moji refused: ${code}`);
    this.code = code;
  }
}

/**
 * The conversation the widget should be on, for the grant's user, classroom,
 * view and request scope, under a per-user lock (so two tabs or devices
 * converge). First, under the same lock, the user's unusable conversations in
 * this classroom are ended, whatever their view or scope: every ACTIVE one
 * carrying a grant that no longer holds (an impersonation behind it expired),
 * or all of them once the user holds no bot role there. They are closed as a
 * replace closes (COMPLETED, tool outputs stubbed) and listed in
 * `closedConversationIds` / `closedWithSession`, on a refusal too. Then:
 * - without `replace`: the ACTIVE one if there is one (`created: false`),
 *   else a new one;
 * - with `replace` (New conversation, naming the conversation the caller is
 *   on): when another conversation is already the active one (another device
 *   replaced it first) that one is returned (`created: false`); otherwise the
 *   active ones for this view and scope (`replace` among them) are ended
 *   (COMPLETED, their stored tool outputs stubbed) and a new one created.
 *
 * Creating is refused (and nothing changes) when the user is not a member
 * (`NOT_A_MEMBER`), holds no role under the derived ceiling (`NOT_ALLOWED`),
 * the classroom's status refuses that acting role (`CLASSROOM_LOCKED` /
 * `CLASSROOM_UNPUBLISHED`, the mutation rule), or the user started
 * `START_RATE_LIMIT.max` conversations within its window (`RATE_LIMITED`).
 * Reusing an existing conversation is never refused here; admission refuses
 * its turns. See `deriveGrant` for what is re-derived; the caller builds the
 * rest of the grant from ids it derived itself.
 */
export const findOrCreate = async (i: {
  grant: Omit<AskMojiGrant, 'contract_version'>;
  replace?: string;
  now?: Date;
}): Promise<FindOrCreateResult> =>
  start(i.grant, i.replace === undefined ? 'reuse' : { replace: i.replace }, i.now);

/**
 * Always create a conversation (ending the active ones for this view and
 * scope), under the same lock and refusals as `findOrCreate`.
 */
export const create = async (i: {
  grant: Omit<AskMojiGrant, 'contract_version'>;
  now?: Date;
}): Promise<CreateResult> => {
  const result = await start(i.grant, 'always', i.now);
  if (!result.ok) return result;
  return {
    ok: true,
    conversationId: result.conversationId,
    closedConversationIds: result.closedConversationIds,
  };
};

const start = async (
  requested: Omit<AskMojiGrant, 'contract_version'>,
  mode: 'reuse' | 'always' | { replace: string },
  at?: Date
): Promise<FindOrCreateResult> => {
  const now = at ?? new Date();
  if (!readGrant({ grant: { ...requested, contract_version: CONTRACT_VERSION } })) {
    throw new Error('askMojiChat: malformed grant');
  }
  const userId = requested.effective_user_id;
  const classroomId = requested.classroom_id;
  const scope: AskMojiScope = {
    userId,
    actorUserId: requested.actor_user_id,
    impersonation: requested.impersonation
      ? { sessionId: requested.impersonation.session_id ?? null }
      : null,
  };

  const result = await getPrisma().$transaction(async (tx): Promise<FindOrCreateResult> => {
    // Serializes one user's starts, so the reuse, the count and the closing
    // below see every earlier start.
    await lockUser(tx, userId);

    const memberships = await tx.classroomMembership.findMany({
      where: { classroom_id: classroomId, user_id: userId, role: { in: [...BOT_ROLES] } },
      select: { role: true },
    });
    const held = memberships.map(m => m.role).filter(isAskMojiRole);
    // Committed whatever follows: a refusal below returns (never throws) so
    // the transaction keeps these closes.
    const unusable = await closeUnusable(tx, { userId, classroomId, held, now });

    try {
      if (held.length === 0) throw new Refused('NOT_A_MEMBER');
      const grant = deriveGrant(requested, held);

      const active = await findActiveIn(
        tx,
        { ...scope, classroomId, viewAs: grant.view_as },
        now.getTime()
      );
      if (
        active &&
        (mode === 'reuse' || (typeof mode === 'object' && active.conversationId !== mode.replace))
      ) {
        return {
          ok: true,
          ...active,
          created: false,
          closedConversationIds: unusable.ids,
          closedWithSession: unusable.withSession,
        };
      }

      const role = actingRole(held, grant.role_ceiling);
      if (!role) throw new Refused('NOT_ALLOWED');
      const classroom = await tx.classroom.findUnique({
        where: { id: classroomId },
        select: { status: true },
      });
      if (!classroom) throw new Refused('NOT_A_MEMBER');
      if (!classroomAllowsTurn({ status: classroom.status, role })) {
        throw new Refused(
          classroom.status === 'LOCKED' ? 'CLASSROOM_LOCKED' : 'CLASSROOM_UNPUBLISHED'
        );
      }

      const recent = await tx.aIConversation.findMany({
        where: {
          user_id: userId,
          type: TYPE,
          started_at: { gt: new Date(now.getTime() - START_RATE_LIMIT.windowMs) },
        },
        select: { context: true },
      });
      if (recent.filter(r => readGrant(r.context)).length >= START_RATE_LIMIT.max) {
        throw new Refused('RATE_LIMITED');
      }

      // One open conversation per (user, classroom, view, scope). Other
      // scopes' conversations, and legacy rows, are left alone.
      const open = await tx.aIConversation.findMany({
        where: { user_id: userId, classroom_id: classroomId, type: TYPE, status: 'ACTIVE' },
        select: { id: true, context: true },
      });
      const closedRows = open.filter(r => {
        const g = readGrant(r.context);
        return g !== null && g.view_as === grant.view_as && scopeMatches(g, scope);
      });
      const closed = closedRows.map(r => r.id);
      if (closed.length > 0) {
        await tx.aIConversation.updateMany({
          where: { id: { in: closed }, status: 'ACTIVE' },
          data: { status: 'COMPLETED', ended_at: now },
        });
      }

      const conversation = await tx.aIConversation.create({
        data: {
          type: TYPE,
          user_id: userId,
          classroom_id: classroomId,
          context: { grant } as unknown as Prisma.InputJsonObject,
          started_at: now,
          last_activity: now,
        },
        select: { id: true },
      });
      return {
        ok: true,
        conversationId: conversation.id,
        grant,
        created: true,
        closedConversationIds: [...unusable.ids, ...closed],
        closedWithSession: [
          ...unusable.withSession,
          ...closedRows.filter(r => readTriggerSessionId(r.context) !== null).map(r => r.id),
        ],
        triggerSessionId: null,
      };
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      return {
        ...refusal(error.code),
        ...(unusable.ids.length > 0
          ? { closedConversationIds: unusable.ids, closedWithSession: unusable.withSession }
          : {}),
      };
    }
  }, TX_OPTIONS);
  // Retention (R7): an ended conversation's lookups can no longer reach the model.
  for (const id of result.closedConversationIds ?? []) await stripToolOutputs(id);
  return result;
};

/**
 * End the user's unusable Ask Moji conversations in a classroom (inside
 * `start`'s transaction, under the user lock): every ACTIVE one with a grant
 * that no longer holds (`grantHolds`: an impersonation behind it expired), and
 * every one once the user holds no bot role there (`held` empty). Any view
 * and any request scope: none of them can take a turn again. Legacy rows (no
 * grant) are left alone. Returns the ids ended, and those with a Trigger
 * session.
 */
const closeUnusable = async (
  tx: Tx,
  i: { userId: string; classroomId: string; held: readonly AskMojiRole[]; now: Date }
): Promise<{ ids: string[]; withSession: string[] }> => {
  const rows = await tx.aIConversation.findMany({
    where: { user_id: i.userId, classroom_id: i.classroomId, type: TYPE, status: 'ACTIVE' },
    select: { id: true, user_id: true, classroom_id: true, context: true },
  });
  const dead = rows.filter(row => {
    const grant = readGrant(row.context);
    if (!grant) return false;
    return i.held.length === 0 || !holds(grant, row, i.now.getTime());
  });
  if (dead.length === 0) return { ids: [], withSession: [] };
  const { count } = await tx.aIConversation.updateMany({
    where: { id: { in: dead.map(r => r.id) }, status: 'ACTIVE' },
    data: { status: 'COMPLETED', ended_at: i.now },
  });
  if (count === 0) return { ids: [], withSession: [] };
  return {
    ids: dead.map(r => r.id),
    withSession: dead.filter(r => readTriggerSessionId(r.context) !== null).map(r => r.id),
  };
};

/**
 * The conversation if it is this user's Ask Moji conversation in this
 * classroom, started under this request scope, with a grant that still holds,
 * and (by default) ACTIVE; else null (one answer for missing, not yours,
 * another scope, another type, legacy, ended). For the token, state and
 * feedback paths.
 */
export const findOwned = async (
  i: AskMojiScope & {
    conversationId: string;
    classroomId: string;
    now?: Date;
    /** Also an ended one (read paths). */
    anyStatus?: boolean;
  }
): Promise<(OwnedConversation & { status: string }) | null> => {
  if (!validId(i.conversationId)) return null;
  const row = await getPrisma().aIConversation.findFirst({
    where: {
      id: i.conversationId,
      user_id: i.userId,
      classroom_id: i.classroomId,
      type: TYPE,
      ...(i.anyStatus ? {} : { status: 'ACTIVE' as const }),
    },
    select: { ...OWNED_SELECT, status: true },
  });
  const grant = row ? readGrant(row.context) : null;
  if (!row || !grant || !scopeMatches(grant, i)) return null;
  if (!holds(grant, row, (i.now ?? new Date()).getTime())) return null;
  return {
    conversationId: row.id,
    grant,
    lastActivity: row.last_activity,
    triggerSessionId: readTriggerSessionId(row.context),
    status: row.status,
  };
};

/**
 * End the user's conversation (the widget's end): marks it COMPLETED and
 * stubs its stored tool outputs (R7). `owned` is false for a conversation
 * that is not this user's Ask Moji conversation in this classroom under this
 * scope (one answer for missing and not yours); `changed` is whether it was
 * ACTIVE until now.
 */
export const end = async (
  i: AskMojiScope & { conversationId: string; classroomId: string }
): Promise<{ owned: boolean; changed: boolean; hadSession?: boolean }> => {
  if (!validId(i.conversationId)) return { owned: false, changed: false };
  const where = {
    id: i.conversationId,
    user_id: i.userId,
    classroom_id: i.classroomId,
    type: TYPE,
  };
  const row = await getPrisma().aIConversation.findFirst({
    where,
    select: { id: true, context: true },
  });
  const grant = row ? readGrant(row.context) : null;
  if (!row || !grant || !scopeMatches(grant, i)) return { owned: false, changed: false };
  const { count } = await getPrisma().aIConversation.updateMany({
    where: { ...where, status: 'ACTIVE' },
    data: { status: 'COMPLETED', ended_at: new Date() },
  });
  if (count > 0) await stripToolOutputs(row.id);
  return {
    owned: true,
    changed: count > 0,
    hadSession: readTriggerSessionId(row.context) !== null,
  };
};

/**
 * Record the Trigger session started for a conversation
 * (`context.session {id, created_at}`). False, writing nothing, for anything
 * but an Ask Moji conversation with a grant.
 */
export const recordTriggerSession = async (
  conversationId: string,
  sessionId: string
): Promise<boolean> => {
  if (!validId(conversationId) || !isString(sessionId)) return false;
  return getPrisma().$transaction(async tx => {
    if (!(await lockConversation(tx, conversationId))) return false;
    const row = await tx.aIConversation.findUnique({
      where: { id: conversationId },
      select: { type: true, context: true },
    });
    if (!row || row.type !== TYPE || !readGrant(row.context)) return false;
    await writeContextKey(tx, conversationId, 'session', {
      id: sessionId,
      created_at: new Date().toISOString(),
    });
    return true;
  }, TX_OPTIONS);
};

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * Whether a turn is in flight (the UI's flag only; admission never refuses on
 * it): the latest user row carries no settled marker, no final reply follows
 * it, and the conversation moved (admission or re-delivery) within
 * `IN_FLIGHT_STALE_MS`, so a run that crashed before settling stops counting.
 */
const inFlightIn = async (
  db: Pick<Tx, 'aIConversationMessage'>,
  conversationId: string,
  lastActivity: Date,
  now: number
): Promise<boolean> => {
  const latest = await latestUserRow(db, conversationId);
  if (!latest) return false;
  if (isObject(latest.metadata) && isObject(latest.metadata.settled)) return false;
  if (now - lastActivity.getTime() > IN_FLIGHT_STALE_MS) return false;
  const reply = await db.aIConversationMessage.findFirst({
    where: {
      conversation_id: conversationId,
      role: 'ASSISTANT',
      final: true,
      created_at: { gt: latest.created_at },
    },
    select: { id: true },
  });
  return reply === null;
};

/** Where the reply stream resumes: `context.runtime.cursors.lastOutEventId`, digits only. */
const resumeCursorOf = (context: unknown): string | null => {
  const runtime = isObject(context) ? context.runtime : undefined;
  const cursors = isObject(runtime) ? runtime.cursors : undefined;
  const cursor = isObject(cursors) ? cursors.lastOutEventId : undefined;
  return typeof cursor === 'string' && /^\d+$/.test(cursor) ? cursor : null;
};

export type ConversationState = {
  /** The requested conversation's status. COMPLETED: the widget moves on (`start`). */
  status: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  /**
   * The conversation this view is on now: the requested one while ACTIVE,
   * else the newest ACTIVE one for the same view and scope (another device's
   * New conversation), else null.
   */
  conversationId: string | null;
  /** The id of the conversation's latest message (any role), null when it has none. */
  lastMessageId: string | null;
  inFlight: boolean;
  resumeCursor: string | null;
  /** The projected transcript, only when `knownLastMessageId` is not `lastMessageId`. */
  transcript?: AskMojiUIMessage[];
};

/**
 * The widget's poll (R4): the conversation's state for its owner under this
 * scope, or null when it is not theirs (any status). Never starts anything.
 */
export const state = async (
  i: AskMojiScope & {
    conversationId: string;
    classroomId: string;
    knownLastMessageId?: string | null;
    now?: Date;
  }
): Promise<ConversationState | null> => {
  const owned = await findOwned({ ...i, anyStatus: true });
  if (!owned) return null;
  const status = owned.status as ConversationState['status'];
  const prisma = getPrisma();
  if (status !== 'ACTIVE') {
    const next = await findActive({
      ...i,
      viewAs: owned.grant.view_as,
      now: i.now,
    });
    return {
      status,
      conversationId: next?.conversationId ?? null,
      lastMessageId: null,
      inFlight: false,
      resumeCursor: null,
    };
  }
  const [last, row] = await Promise.all([
    prisma.aIConversationMessage.findFirst({
      where: {
        conversation_id: owned.conversationId,
        format: 'ui_message_v1',
        ui_message_id: { not: null },
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      select: { ui_message_id: true },
    }),
    prisma.aIConversation.findUnique({
      where: { id: owned.conversationId },
      select: { context: true },
    }),
  ]);
  const lastMessageId = last?.ui_message_id ?? null;
  const inFlight = await inFlightIn(
    prisma,
    owned.conversationId,
    owned.lastActivity,
    (i.now ?? new Date()).getTime()
  );
  const out: ConversationState = {
    status,
    conversationId: owned.conversationId,
    lastMessageId,
    inFlight,
    resumeCursor: resumeCursorOf(row?.context),
  };
  if ((i.knownLastMessageId ?? null) !== lastMessageId) {
    out.transcript = (await loadTranscriptForViewer(i)) ?? [];
  }
  return out;
};

// ─── Admission ──────────────────────────────────────────────────────────────

/**
 * An admitted message:
 *   admitted          a new user row was written; this turn runs
 *   redelivered       the same id and text as the latest admitted message,
 *                     whose reply never finished: this turn runs again, no
 *                     new row, no turn counted, its settled marker cleared
 *   already_answered  the same id and text as a message whose turn finished
 *                     (or an older one): run nothing, show nothing
 * `role` is the acting role (the strongest held at or below the ceiling);
 * `turnsUsed` the admitted messages so far; `metadata` the message's client
 * metadata as stored (`viewing` at most); `viewing` what that viewing
 * resolved to now (`askMojiViewing.resolve`, null when it was dropped or
 * there was none; never for `already_answered`).
 */
export type AdmitResult =
  | {
      ok: true;
      status: 'admitted' | 'redelivered' | 'already_answered';
      messageId: string;
      role: AskMojiRole;
      turnsUsed: number;
      metadata: AskMojiMessageMetadata;
      viewing: ResolvedViewing | null;
    }
  | AskMojiRefusal;

type CheckedMessage = { id: string; text: string; metadata: AskMojiMessageMetadata };

/**
 * The one user text message admission takes, or null: a well-formed id,
 * exactly one text part, not blank, within `MAX_MESSAGE_CHARS`, no text
 * reserved for the server's notices (`containsReservedText`, the quiz's
 * rule), and metadata that is absent or exactly `AskMojiMessageMetadataSchema`
 * (at most `viewing`; any other key refuses the message).
 */
const checkedMessage = (message: unknown): CheckedMessage | null => {
  if (!isObject(message) || message.role !== 'user') return null;
  const { id, parts } = message;
  if (typeof id !== 'string' || !CLIENT_MESSAGE_ID_PATTERN.test(id)) return null;
  if (!Array.isArray(parts) || parts.length !== 1) return null;
  const [part] = parts;
  if (!isObject(part) || part.type !== 'text' || typeof part.text !== 'string') return null;
  if (part.text.trim() === '' || part.text.length > MAX_MESSAGE_CHARS) return null;
  if (containsReservedText(part.text)) return null;
  const parsed = AskMojiMessageMetadataSchema.safeParse(message.metadata ?? {});
  if (!parsed.success) return null;
  return { id, text: part.text, metadata: parsed.data };
};

/** The client part of stored user metadata: a `viewing` that still parses, else none. */
const storedClientMetadata = (value: unknown): AskMojiMessageMetadata => {
  if (!isObject(value)) return {};
  const viewing = AskMojiViewingSchema.safeParse(value.viewing);
  return viewing.success ? { viewing: viewing.data } : {};
};

/**
 * Admit one user message, in one transaction under the conversation's row
 * lock (`SELECT … FOR UPDATE`). Checks, in order (permanent ones first):
 * - an Ask Moji conversation with a grant (`NOT_FOUND`), ACTIVE
 *   (`CONVERSATION_ENDED`), whose grant still holds: it names the row's owner
 *   and classroom, and an impersonation behind it has not expired
 *   (`SESSION_ENDED`);
 * - the owner is still a member of the conversation's classroom
 *   (`NOT_A_MEMBER`) and holds a role at or below the grant's ceiling, the
 *   strongest of which is the acting role (`NOT_ALLOWED`);
 * - the classroom lets that role act, the mutation rule
 *   (`CLASSROOM_LOCKED` / `CLASSROOM_UNPUBLISHED`, transient);
 * - Pro, through `canUseSyllabusBot` (read before the lock on its own
 *   connection; a failed lookup is `UNAVAILABLE` too), and
 *   `syllabus_bot_enabled` (`NOT_ENABLED`), both transient;
 * - one user message (`checkedMessage`), else `INVALID_MESSAGE`;
 * - an id already stored: with other text or on another role,
 *   `INVALID_MESSAGE`; else re-delivery (`ASK_MOJI_REDELIVERY`): the latest
 *   user row whose reply never finished runs again (its settled marker
 *   cleared), anything else is `already_answered`. Neither is paced nor
 *   counted;
 * - a new message within `MIN_TURN_INTERVAL_MS` of the previous one: `PACE`
 *   (a rate limit; there is no busy refusal: a message sent mid-turn is
 *   queued by the transport for the next turn);
 * - then the viewing is resolved and the user row written
 *   (`[{ type: 'text', text }]`; metadata: the client `viewing` when sent,
 *   plus the server-only `acting_role` and `resolved_viewing {kind,id}|null`;
 *   provenance `user`; the grant's contract version) and `last_activity`
 *   moves.
 * There is no turn limit: the task compacts long histories.
 */
export const admitUserMessage = async (i: {
  conversationId: string;
  message: unknown;
}): Promise<AdmitResult> => {
  if (!validId(i.conversationId)) return refusal('NOT_FOUND');
  const prisma = getPrisma();
  const pre = await prisma.aIConversation.findUnique({
    where: { id: i.conversationId },
    select: { classroom_id: true },
  });
  if (!pre) return refusal('NOT_FOUND');
  let pro: boolean;
  try {
    pro = (await canUseSyllabusBot(pre.classroom_id)).allowed;
  } catch {
    // A failed lookup is not a verdict; the next message tries again.
    pro = false;
  }

  try {
    return await prisma.$transaction(async (tx): Promise<AdmitResult> => {
      if (!(await lockConversation(tx, i.conversationId))) throw new Refused('NOT_FOUND');
      const row = await tx.aIConversation.findUnique({
        where: { id: i.conversationId },
        select: {
          id: true,
          type: true,
          status: true,
          user_id: true,
          classroom_id: true,
          context: true,
          classroom: {
            select: { status: true, settings: { select: { syllabus_bot_enabled: true } } },
          },
        },
      });
      const grant = row && row.type === TYPE ? readGrant(row.context) : null;
      if (!row || !grant) throw new Refused('NOT_FOUND');
      if (row.status !== 'ACTIVE') throw new Refused('CONVERSATION_ENDED');
      const now = new Date();
      if (!holds(grant, row, now.getTime())) throw new Refused('SESSION_ENDED');

      const memberships = await tx.classroomMembership.findMany({
        where: {
          classroom_id: row.classroom_id,
          user_id: row.user_id,
          role: { in: [...BOT_ROLES] },
        },
        select: { role: true },
      });
      if (memberships.length === 0) throw new Refused('NOT_A_MEMBER');
      const role = actingRole(
        memberships.map(m => m.role),
        grant.role_ceiling
      );
      if (!role) throw new Refused('NOT_ALLOWED');

      const status = row.classroom.status;
      if (!classroomAllowsTurn({ status, role })) {
        throw new Refused(status === 'LOCKED' ? 'CLASSROOM_LOCKED' : 'CLASSROOM_UNPUBLISHED');
      }
      if (!pro) throw new Refused('UNAVAILABLE');
      if (!row.classroom.settings?.syllabus_bot_enabled) throw new Refused('NOT_ENABLED');

      const message = checkedMessage(i.message);
      if (!message) throw new Refused('INVALID_MESSAGE');

      const resolveFor = (viewing: unknown) =>
        resolveViewing({
          classroomId: row.classroom_id,
          userId: row.user_id,
          actingRole: role,
          viewing,
        });

      const turns = await countTurns(tx, row.id);
      const stored = await findStoredMessage(tx, row.id, message.id);
      if (stored) {
        const parts = Array.isArray(stored.parts) ? stored.parts : [];
        const same =
          stored.role === 'USER' &&
          parts.length === 1 &&
          isObject(parts[0]) &&
          parts[0].type === 'text' &&
          parts[0].text === message.text;
        if (!same) throw new Refused('INVALID_MESSAGE');
        const latest = await latestUserRow(tx, row.id);
        const action =
          latest?.ui_message_id === message.id
            ? ASK_MOJI_REDELIVERY[await replyStateAfter(tx, row.id, stored.created_at)]
            : 'skip';
        const first = await tx.aIConversationMessage.findUnique({
          where: {
            conversation_id_ui_message_id: { conversation_id: row.id, ui_message_id: message.id },
          },
          select: { metadata: true },
        });
        const metadata = storedClientMetadata(first?.metadata);
        if (action === 'rerun') {
          await tx.aIConversation.update({ where: { id: row.id }, data: { last_activity: now } });
          await writeSettled(tx, row.id, message.id, null);
        }
        return {
          ok: true,
          status: action === 'rerun' ? 'redelivered' : 'already_answered',
          messageId: message.id,
          role,
          turnsUsed: turns,
          metadata,
          viewing: action === 'rerun' ? await resolveFor(metadata.viewing) : null,
        };
      }

      const previous = await latestUserRow(tx, row.id);
      if (previous && now.getTime() - previous.created_at.getTime() < MIN_TURN_INTERVAL_MS) {
        throw new Refused('PACE');
      }

      const viewing = await resolveFor(message.metadata.viewing);
      const metadata: AskMojiUserRowMetadata = {
        ...(message.metadata.viewing ? { viewing: message.metadata.viewing } : {}),
        acting_role: role,
        resolved_viewing: viewingRef(viewing),
      };
      await tx.aIConversationMessage.create({
        data: {
          conversation_id: row.id,
          role: 'USER',
          content: message.text,
          parts: [{ type: 'text', text: message.text }],
          metadata: toJson(metadata) as Prisma.InputJsonObject,
          format: 'ui_message_v1',
          ui_message_id: message.id,
          final: true,
          provenance: 'user',
          contract_version: grant.contract_version,
          created_at: await nextCreatedAt(tx, row.id),
        },
      });
      await tx.aIConversation.update({ where: { id: row.id }, data: { last_activity: now } });
      return {
        ok: true,
        status: 'admitted',
        messageId: message.id,
        role,
        turnsUsed: turns + 1,
        metadata: message.metadata,
        viewing,
      };
    }, TX_OPTIONS);
  } catch (error) {
    if (error instanceof Refused) return refusal(error.code);
    throw error;
  }
};

/** User messages a conversation has admitted (one row each; a re-delivery adds none). */
const countTurns = (db: Pick<Tx, 'aIConversationMessage'>, conversationId: string) =>
  db.aIConversationMessage.count({
    where: { conversation_id: conversationId, role: 'USER', format: 'ui_message_v1' },
  });

/**
 * Mark the turn answering `messageId` as over (R3): `failed` or `stopped`
 * (a final reply settles itself through `persistAssistantMessage`). Any
 * status: a turn of a conversation ended meanwhile still ends. False for
 * anything but a user row of an Ask Moji conversation with a grant.
 */
export const settleTurn = async (i: {
  conversationId: string;
  messageId: string;
  outcome: AskMojiTurnOutcome;
}): Promise<boolean> => {
  if (!validId(i.conversationId) || !validMessageId(i.messageId)) return false;
  const row = await getPrisma().aIConversation.findUnique({
    where: { id: i.conversationId },
    select: { type: true, context: true },
  });
  if (!row || row.type !== TYPE || !readGrant(row.context)) return false;
  return (await writeSettled(getPrisma(), i.conversationId, i.messageId, i.outcome)) > 0;
};

// ─── Model history ──────────────────────────────────────────────────────────

/**
 * The conversation as the model reads it, oldest first, for an Ask Moji
 * conversation with a grant (anything else: `[]`, R16). Rows up to and
 * including the compaction summary's `through_message_id` are left out (the
 * task reads the summary itself, `readSummary`). Of the rest: every user
 * message whose turn got a final reply, with every final reply in full
 * (text, MCP tool calls and results, cite_content calls, reasoning, data
 * parts: the task converts what it needs), plus the one being answered now:
 * `answeringMessageId`, or without it the latest user message when nothing
 * final follows it. A user message whose turn never got a final reply is
 * dropped with its partial replies; partial rows never reach the model.
 */
export const loadModelHistory = async (
  conversationId: string,
  o: { answeringMessageId?: string } = {}
): Promise<AskMojiUIMessage[]> => {
  if (!validId(conversationId)) return [];
  const prisma = getPrisma();
  const conversation = await prisma.aIConversation.findUnique({
    where: { id: conversationId },
    select: { type: true, context: true },
  });
  if (!conversation || conversation.type !== TYPE || !readGrant(conversation.context)) return [];

  const summary = readSummaryFrom(conversation.context);
  const cutoff = summary
    ? await prisma.aIConversationMessage.findUnique({
        where: {
          conversation_id_ui_message_id: {
            conversation_id: conversationId,
            ui_message_id: summary.through_message_id,
          },
        },
        select: { created_at: true },
      })
    : null;

  const rows = await prisma.aIConversationMessage.findMany({
    where: {
      conversation_id: conversationId,
      format: 'ui_message_v1',
      ui_message_id: { not: null },
      ...(cutoff ? { created_at: { gt: cutoff.created_at } } : {}),
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { ui_message_id: true, role: true, parts: true, metadata: true, final: true },
  });

  // One segment per user message: it and the assistant rows after it.
  type Row = (typeof rows)[number];
  const segments: { user: Row; replies: Row[] }[] = [];
  for (const row of rows) {
    if (row.role === 'USER') segments.push({ user: row, replies: [] });
    else if (row.role === 'ASSISTANT' && segments.length > 0) {
      segments[segments.length - 1].replies.push(row);
    }
  }

  const messages: AskMojiUIMessage[] = [];
  segments.forEach((segment, idx) => {
    const finals = segment.replies.filter(r => r.final);
    const answering =
      o.answeringMessageId !== undefined
        ? segment.user.ui_message_id === o.answeringMessageId
        : idx === segments.length - 1;
    if (finals.length === 0 && !answering) return;
    messages.push(toUIMessage<AskMojiUIMessage>(segment.user));
    for (const reply of finals) messages.push(toUIMessage<AskMojiUIMessage>(reply));
  });
  return messages;
};

// ─── Assistant messages ─────────────────────────────────────────────────────

/**
 * Store an assistant message by `(conversation_id, ui_message_id)` with its
 * full parts (MCP tool calls and results included: the model's memory of the
 * conversation; the browser's projection never shows them), `format:
 * 'ui_message_v1'`, the grant's contract version, and move `last_activity`.
 * Under the conversation's row lock.
 *
 * Metadata is server-only and built here, never taken from the message:
 * `usage` (one turn's sum, `AskMojiUsageSchema`; an invalid one is dropped),
 * `model` (the usage's), and `cites` (the ok `cite_content` results in the
 * parts, `citesFromParts`).
 *
 * Settles the turn (R3): a final reply settles `answeringMessageId` (default:
 * the latest user row) as `final`; a non-final one settles it with `outcome`
 * when one is given (`failed` / `stopped`), else leaves it in flight (a
 * checkpoint of a reply still running).
 *
 * Not stored (`stored: false`) once the conversation is no longer an ACTIVE
 * Ask Moji conversation with a grant, or when a partial save would overwrite
 * a final one. An id that belongs to a user row throws.
 */
export const persistAssistantMessage = async (i: {
  conversationId: string;
  message: AskMojiUIMessage;
  provenance?: 'model' | 'server';
  final?: boolean;
  usage?: AskMojiUsage;
  answeringMessageId?: string;
  outcome?: 'failed' | 'stopped';
}): Promise<{ stored: boolean }> => {
  const m = i.message;
  if (!m || m.role !== 'assistant' || !validMessageId(m.id)) {
    throw new Error('persistAssistantMessage: expected an assistant message with an id');
  }
  if (!validId(i.conversationId)) return { stored: false };
  const final = i.final ?? true;
  const usage = i.usage === undefined ? undefined : AskMojiUsageSchema.safeParse(i.usage);
  if (usage && !usage.success) console.warn('[askMojiChat] usage dropped: not the usage shape');
  return getPrisma().$transaction(async tx => {
    if (!(await lockConversation(tx, i.conversationId))) return { stored: false };
    const row = await tx.aIConversation.findUnique({
      where: { id: i.conversationId },
      select: { id: true, type: true, status: true, context: true },
    });
    const grant = row && row.type === TYPE ? readGrant(row.context) : null;
    if (!row || !grant || row.status !== 'ACTIVE') return { stored: false };

    const partsList: unknown[] = Array.isArray(m.parts) ? m.parts : [];
    const parts = toJson(partsList);
    const content = textOf(partsList);
    const cites = citesFromParts(partsList);
    const metadata: Record<string, unknown> = {
      ...(usage?.success
        ? { usage: usage.data, ...(usage.data.model ? { model: usage.data.model } : {}) }
        : {}),
      ...(cites.length > 0 ? { cites } : {}),
    };
    const metadataJson =
      Object.keys(metadata).length > 0 ? (toJson(metadata) as Prisma.InputJsonObject) : undefined;
    const where = {
      conversation_id_ui_message_id: { conversation_id: row.id, ui_message_id: m.id },
    };
    const existing = await tx.aIConversationMessage.findUnique({
      where,
      select: { role: true, final: true },
    });
    if (existing) {
      if (existing.role !== 'ASSISTANT') {
        throw new Error('persistAssistantMessage: message id belongs to another message');
      }
      if (existing.final && !final) return { stored: false };
      await tx.aIConversationMessage.update({
        where,
        data: { parts, content, final, ...(metadataJson ? { metadata: metadataJson } : {}) },
      });
    } else {
      await tx.aIConversationMessage.create({
        data: {
          conversation_id: row.id,
          role: 'ASSISTANT',
          content,
          parts,
          ...(metadataJson ? { metadata: metadataJson } : {}),
          format: 'ui_message_v1',
          ui_message_id: m.id,
          final,
          provenance: i.provenance ?? 'model',
          contract_version: grant.contract_version,
          created_at: await nextCreatedAt(tx, row.id),
        },
      });
    }

    const outcome: AskMojiTurnOutcome | null = final ? 'final' : (i.outcome ?? null);
    if (outcome) {
      const answering =
        i.answeringMessageId !== undefined && validMessageId(i.answeringMessageId)
          ? i.answeringMessageId
          : (await latestUserRow(tx, row.id))?.ui_message_id;
      if (answering) await writeSettled(tx, row.id, answering, outcome);
    }
    await tx.aIConversation.update({ where: { id: row.id }, data: { last_activity: new Date() } });
    return { stored: true };
  }, TX_OPTIONS);
};

/**
 * Add usage to a stored assistant row's `metadata.usage` (summing every
 * count; `model` kept unless the row had none): the summarizer's usage, which
 * R6 records with the turn it ran after. Any status. False for anything but
 * an ASSISTANT row of an Ask Moji conversation with a grant, or a usage that
 * is not the usage shape.
 */
export const addUsage = async (
  conversationId: string,
  messageId: string,
  extra: AskMojiUsage
): Promise<boolean> => {
  if (!validId(conversationId) || !validMessageId(messageId)) return false;
  const parsed = AskMojiUsageSchema.safeParse(extra);
  if (!parsed.success) return false;
  return getPrisma().$transaction(async tx => {
    if (!(await lockConversation(tx, conversationId))) return false;
    const conversation = await tx.aIConversation.findUnique({
      where: { id: conversationId },
      select: { type: true, context: true },
    });
    if (!conversation || conversation.type !== TYPE || !readGrant(conversation.context)) {
      return false;
    }
    const where = {
      conversation_id_ui_message_id: { conversation_id: conversationId, ui_message_id: messageId },
    };
    const row = await tx.aIConversationMessage.findUnique({
      where,
      select: { role: true, metadata: true },
    });
    if (!row || row.role !== 'ASSISTANT') return false;
    const metadata = isObject(row.metadata) ? row.metadata : {};
    const before = AskMojiUsageSchema.safeParse(metadata.usage);
    const a = parsed.data;
    const usage: AskMojiUsage = before.success
      ? {
          input: before.data.input + a.input,
          output: before.data.output + a.output,
          cacheRead: before.data.cacheRead + a.cacheRead,
          cacheWrite: before.data.cacheWrite + a.cacheWrite,
          reasoning: before.data.reasoning + a.reasoning,
          calls: before.data.calls + a.calls,
          model: before.data.model ?? a.model,
        }
      : a;
    await tx.aIConversationMessage.update({
      where,
      data: { metadata: toJson({ ...metadata, usage }) as Prisma.InputJsonObject },
    });
    return true;
  }, TX_OPTIONS);
};

// ─── Retention and compaction ───────────────────────────────────────────────

/**
 * Retention (R7): rewrite the stored outputs of every course lookup (MCP
 * tool part) on the conversation's assistant rows to `TOOL_OUTPUT_STUB`,
 * keeping inputs, text, `cite_content` parts and `data-*` parts. With
 * `through` (a message id), only rows up to and including that message's
 * time; an unknown id strips nothing. Ask Moji conversations with a grant
 * only. Returns how many rows changed.
 */
export const stripToolOutputs = async (
  conversationId: string,
  o: { through?: string } = {}
): Promise<{ rows: number }> => {
  if (!validId(conversationId)) return { rows: 0 };
  return getPrisma().$transaction(async tx => {
    if (!(await lockConversation(tx, conversationId))) return { rows: 0 };
    const conversation = await tx.aIConversation.findUnique({
      where: { id: conversationId },
      select: { type: true, context: true },
    });
    if (!conversation || conversation.type !== TYPE || !readGrant(conversation.context)) {
      return { rows: 0 };
    }
    let upTo: Date | undefined;
    if (o.through !== undefined) {
      if (!validMessageId(o.through)) return { rows: 0 };
      const mark = await tx.aIConversationMessage.findUnique({
        where: {
          conversation_id_ui_message_id: {
            conversation_id: conversationId,
            ui_message_id: o.through,
          },
        },
        select: { created_at: true },
      });
      if (!mark) return { rows: 0 };
      upTo = mark.created_at;
    }
    const rows = await tx.aIConversationMessage.findMany({
      where: {
        conversation_id: conversationId,
        role: 'ASSISTANT',
        format: 'ui_message_v1',
        ...(upTo ? { created_at: { lte: upTo } } : {}),
      },
      select: { id: true, parts: true },
    });
    let changed = 0;
    for (const row of rows) {
      if (!Array.isArray(row.parts)) continue;
      const stubbed = stubLookupOutputs(row.parts);
      if (!stubbed.changed) continue;
      await tx.aIConversationMessage.update({
        where: { id: row.id },
        data: { parts: toJson(stubbed.parts) },
      });
      changed += 1;
    }
    return { rows: changed };
  }, TX_OPTIONS);
};

const readSummaryFrom = (context: unknown): AskMojiSummary | null => {
  const summary = isObject(context) ? context.summary : undefined;
  if (!isObject(summary)) return null;
  if (typeof summary.text !== 'string' || !isString(summary.through_message_id)) return null;
  return {
    text: summary.text,
    through_message_id: summary.through_message_id,
    created_at: typeof summary.created_at === 'string' ? summary.created_at : '',
    model: typeof summary.model === 'string' ? summary.model : null,
  };
};

/** `context.summary` of an Ask Moji conversation with a grant, or null. */
export const readSummary = async (conversationId: string): Promise<AskMojiSummary | null> => {
  if (!validId(conversationId)) return null;
  const row = await getPrisma().aIConversation.findUnique({
    where: { id: conversationId },
    select: { type: true, context: true },
  });
  if (!row || row.type !== TYPE || !readGrant(row.context)) return null;
  return readSummaryFrom(row.context);
};

/**
 * Store a compaction summary (`context.summary {text, through_message_id,
 * created_at, model}`, written by key; the previous summary is replaced), then
 * stub the tool outputs of every row it covers (R7): from now on the model
 * reads the summary and the rows after `throughMessageId` only. False, writing
 * nothing, for anything but an Ask Moji conversation with a grant, a blank or
 * over-long text (`SUMMARY_MAX_CHARS`), or a message id not in the
 * conversation. Any status.
 */
export const saveSummary = async (
  conversationId: string,
  s: { text: string; throughMessageId: string; model?: string | null }
): Promise<boolean> => {
  if (!validId(conversationId) || !validMessageId(s.throughMessageId)) return false;
  if (typeof s.text !== 'string' || s.text.trim() === '' || s.text.length > SUMMARY_MAX_CHARS) {
    return false;
  }
  const saved = await getPrisma().$transaction(async tx => {
    if (!(await lockConversation(tx, conversationId))) return false;
    const row = await tx.aIConversation.findUnique({
      where: { id: conversationId },
      select: { type: true, context: true },
    });
    if (!row || row.type !== TYPE || !readGrant(row.context)) return false;
    const mark = await tx.aIConversationMessage.findUnique({
      where: {
        conversation_id_ui_message_id: {
          conversation_id: conversationId,
          ui_message_id: s.throughMessageId,
        },
      },
      select: { id: true },
    });
    if (!mark) return false;
    const summary: AskMojiSummary = {
      text: s.text,
      through_message_id: s.throughMessageId,
      created_at: new Date().toISOString(),
      model: s.model ?? null,
    };
    await writeContextKey(tx, conversationId, 'summary', summary);
    return true;
  }, TX_OPTIONS);
  if (saved) await stripToolOutputs(conversationId, { through: s.throughMessageId });
  return saved;
};

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * The transcript the conversation's owner sees under this scope, projected
 * (`projectAskMojiTranscript`: text, cite_content, notice and step parts; of
 * the metadata a user row's `viewing` and, on every assistant row, `rateable`:
 * true when the row is final and written by the model, the rows
 * `askMojiFeedback.set` accepts; `withRateable`). A partial assistant row whose
 * turn later got a final reply is left out (R16). Null when the conversation
 * is not this user's Ask Moji conversation (with a grant) in this classroom
 * under this scope. Ended conversations are still readable by their owner.
 */
export const loadTranscriptForViewer = async (
  i: AskMojiScope & { conversationId: string; classroomId: string }
): Promise<AskMojiUIMessage[] | null> => {
  if (!validId(i.conversationId)) return null;
  const prisma = getPrisma();
  const conversation = await prisma.aIConversation.findFirst({
    where: { id: i.conversationId, user_id: i.userId, classroom_id: i.classroomId, type: TYPE },
    select: { id: true, context: true },
  });
  const grant = conversation ? readGrant(conversation.context) : null;
  if (!conversation || !grant || !scopeMatches(grant, i)) return null;
  const rows = await prisma.aIConversationMessage.findMany({
    where: {
      conversation_id: conversation.id,
      format: 'ui_message_v1',
      ui_message_id: { not: null },
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: {
      ui_message_id: true,
      role: true,
      parts: true,
      metadata: true,
      final: true,
      provenance: true,
    },
  });
  return projectAskMojiTranscript(
    withoutSupersededPartials(rows).map(row => toUIMessage<AskMojiUIMessage>(withRateable(row)))
  );
};

/** Rows minus each turn's non-final assistant rows when that turn has a final one. */
export const withoutSupersededPartials = <R extends { role: string; final: boolean }>(
  rows: readonly R[]
): R[] => {
  const out: R[] = [];
  let segment: R[] = [];
  const flush = () => {
    const hasFinal = segment.some(r => r.role === 'ASSISTANT' && r.final);
    for (const r of segment) if (!(hasFinal && r.role === 'ASSISTANT' && !r.final)) out.push(r);
    segment = [];
  };
  for (const row of rows) {
    if (row.role === 'USER') flush();
    segment.push(row);
  }
  flush();
  return out;
};

/** `context.runtime` of an Ask Moji conversation with a grant, or null (none saved, or not one). */
export const readRuntimeState = async (
  conversationId: string
): Promise<AskMojiRuntimeState | null> => {
  if (!validId(conversationId)) return null;
  const row = await getPrisma().aIConversation.findUnique({
    where: { id: conversationId },
    select: { type: true, context: true },
  });
  if (!row || row.type !== TYPE || !readGrant(row.context)) return null;
  const runtime = isObject(row.context) ? row.context.runtime : undefined;
  return isObject(runtime) ? (runtime as AskMojiRuntimeState) : null;
};

/**
 * Replace `context.runtime`, keeping every other key (`grant` above all).
 * Returns false, writing nothing, for anything but an Ask Moji conversation
 * with a grant. Any status: the cursors of an ended conversation still move.
 */
export const writeRuntimeState = async (
  conversationId: string,
  v: AskMojiRuntimeState
): Promise<boolean> => {
  if (!validId(conversationId)) return false;
  return getPrisma().$transaction(async tx => {
    if (!(await lockConversation(tx, conversationId))) return false;
    const row = await tx.aIConversation.findUnique({
      where: { id: conversationId },
      select: { type: true, context: true },
    });
    if (!row || row.type !== TYPE || !readGrant(row.context)) return false;
    await writeContextKey(tx, conversationId, 'runtime', v);
    return true;
  }, TX_OPTIONS);
};

/** The classroom settings a turn reads (server only: carries the classroom's key). */
export type AskMojiSettingsRow = {
  anthropic_api_key: string | null;
  syllabus_bot_model: string | null;
  syllabus_bot_effort: string | null;
};

export type TurnContext = {
  conversationId: string;
  userId: string;
  classroomId: string;
  classroomName: string;
  classroomSlug: string;
  /** `org/slug` as the MCP takes it (the git organization's login + the slug), null if either is missing. */
  classroomRef: string | null;
  /** The zone dates are stated in: the classroom's, else the grant's browser zone, else UTC. */
  timeZone: EffectiveTimeZone;
  /** The browser's zone at start, for `X-Classmoji-Timezone`. */
  browserTimeZone: string | null;
  viewAs: AskMojiRole;
  roleCeiling: AskMojiRole | null;
  /**
   * The strongest role the user holds now at or below the ceiling (null: no
   * longer a member, or none under it); the MCP acts as the same role under
   * the ceiling header. Admission computes the same.
   */
  actingRole: AskMojiRole | null;
  settings: AskMojiSettingsRow;
  /** The classroom has its own Anthropic key (a blank one is none). */
  hasClassroomKey: boolean;
  /**
   * The owner's instructions (`syllabus_bot_instructions`, blank = none,
   * capped at `INSTRUCTIONS_MAX_CHARS`). Server only, for the model's
   * context; never sent to a browser.
   */
  instructions: string | null;
  actorUserId: string;
  impersonation: ChatGrant['impersonation'];
  contractVersion: number;
};

/**
 * What the task needs for a turn, re-derived from the conversation's own
 * classroom every time (org logins and settings can change): null for
 * anything but an Ask Moji conversation with a grant. Reads nothing from the
 * browser.
 */
export const contextForTurn = async (conversationId: string): Promise<TurnContext | null> => {
  if (!validId(conversationId)) return null;
  const prisma = getPrisma();
  const row = await prisma.aIConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      type: true,
      user_id: true,
      classroom_id: true,
      context: true,
      classroom: {
        select: {
          name: true,
          slug: true,
          git_organization: { select: { login: true } },
          settings: {
            select: {
              timezone: true,
              anthropic_api_key: true,
              syllabus_bot_model: true,
              syllabus_bot_effort: true,
              syllabus_bot_instructions: true,
            },
          },
        },
      },
    },
  });
  const grant = row && row.type === TYPE ? readGrant(row.context) : null;
  if (!row || !grant) return null;
  const memberships = await prisma.classroomMembership.findMany({
    where: { classroom_id: row.classroom_id, user_id: row.user_id, role: { in: [...BOT_ROLES] } },
    select: { role: true },
  });
  const { classroom } = row;
  const login = classroom.git_organization?.login;
  const settings = classroom.settings;
  const key = settings?.anthropic_api_key?.trim() || null;
  const instructions =
    settings?.syllabus_bot_instructions?.trim().slice(0, INSTRUCTIONS_MAX_CHARS) || null;
  return {
    conversationId: row.id,
    userId: row.user_id,
    classroomId: row.classroom_id,
    classroomName: classroom.name,
    classroomSlug: classroom.slug,
    classroomRef: login && classroom.slug ? `${login}/${classroom.slug}` : null,
    timeZone: resolveEffectiveTimeZone(settings?.timezone, grant.browser_timezone),
    browserTimeZone: canonicalTimeZone(grant.browser_timezone),
    viewAs: grant.view_as,
    roleCeiling: grant.role_ceiling,
    actingRole: actingRole(
      memberships.map(m => m.role),
      grant.role_ceiling
    ),
    settings: {
      anthropic_api_key: key,
      syllabus_bot_model: settings?.syllabus_bot_model ?? null,
      syllabus_bot_effort: settings?.syllabus_bot_effort ?? null,
    },
    hasClassroomKey: key !== null,
    instructions,
    actorUserId: grant.actor_user_id,
    impersonation: grant.impersonation,
    contractVersion: grant.contract_version,
  };
};
