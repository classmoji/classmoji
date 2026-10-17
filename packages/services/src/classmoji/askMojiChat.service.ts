/**
 * Conversation storage and turn admission for Ask Moji served as a chat agent
 * (the `ask-moji` Trigger task). One `ai_conversations` row of type
 * SYLLABUS_BOT per conversation; its id is the chat id.
 *
 * A conversation on this runtime carries `context.grant` (`AskMojiGrant`),
 * written when the webapp's session route creates it. Rows without one are
 * the legacy WebSocket path's: nothing here reuses, admits or reads them.
 * `context` keys are written one at a time (`writeContextKey`), so `grant`
 * and `runtime` never clobber each other.
 *
 * Every id is the server's: the caller passes the session user and the
 * classroom it resolved, or the chat id the task was started with, and each
 * read re-checks the row's own owner, classroom and type. A missing row and
 * someone else's row get the same answer.
 *
 * Messages live in `ai_conversation_messages` as UIMessage parts
 * (`format: 'ui_message_v1'`), keyed by `(conversation_id, ui_message_id)`.
 * A user row is written at admission; an assistant row once its reply ends,
 * with its full parts (the model's memory, MCP tool results included). What
 * the browser gets is always projected (`askMojiVisibility`): only text,
 * cite_content and the notice/step data parts.
 *
 * Nothing here writes audit rows: the callers (the session route, the task)
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
  CONTRACT_VERSION,
  MAX_MESSAGE_CHARS,
  START_RATE_LIMIT,
  actingRole,
  askMojiVisibility,
  isAskMojiRole,
  projectTranscript,
  type AskMojiMessageMetadata,
  type AskMojiRefusalCode,
  type AskMojiRole,
  type AskMojiUIMessage,
} from '@classmoji/utils/ask-moji';
import type { Prisma } from '@prisma/client';
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
const BOT_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'] as const;

/** Same bounds as the quiz's locked transactions. */
const TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

/**
 * `ai_conversations.context.grant` for an Ask Moji conversation: the quiz's
 * chat grant plus what the conversation was started as.
 * - `view_as`: the role the widget was opened as (tone and suggestions only).
 * - `role_ceiling`: `view_as` when the user held it at start, else null (no
 *   ceiling). The MCP is asked to act at or below it; admission picks the
 *   acting role under it.
 * - `browser_timezone`: the browser's zone at start, canonical or null.
 * - `contract_version`: the stored message contract the conversation runs on.
 * `role` (from ChatGrant) is the user's highest role at start.
 */
export interface AskMojiGrant extends ChatGrant {
  view_as: AskMojiRole;
  role_ceiling: AskMojiRole | null;
  browser_timezone: string | null;
  contract_version: number;
}

/** `ai_conversations.context.runtime`: the transport's cursors and opaque state. */
export type AskMojiRuntimeState = { cursors: unknown; state: unknown };

export type AskMojiRefusal = { ok: false; code: AskMojiRefusalCode; permanent: boolean };

const refusal = (code: AskMojiRefusalCode): AskMojiRefusal => ({
  ok: false,
  code,
  permanent: ASK_MOJI_REFUSALS[code] === 'permanent',
});

/** A conversation the caller may continue: its id, grant and last activity. */
export type OwnedConversation = {
  conversationId: string;
  grant: AskMojiGrant;
  lastActivity: Date;
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const isString = (v: unknown): v is string => typeof v === 'string' && v !== '';
const nullableString = (v: unknown) => v === null || typeof v === 'string';

/** A conversation id as a caller may hand it in: a bounded string, else nothing matches. */
const validId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= 128;

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

const holds = (
  grant: AskMojiGrant,
  row: { user_id: string; classroom_id: string },
  now: number
): boolean => grantHolds(grant, { userId: row.user_id, classroomId: row.classroom_id }, now);

/** User messages a conversation has admitted (one row each; a re-delivery adds none). */
const countTurns = (db: Pick<Tx, 'aIConversationMessage'>, conversationId: string) =>
  db.aIConversationMessage.count({
    where: { conversation_id: conversationId, role: 'USER', format: 'ui_message_v1' },
  });

const lockConversation = async (tx: Tx, conversationId: string): Promise<boolean> => {
  const locked = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM ai_conversations WHERE id = ${conversationId} FOR UPDATE`;
  return locked.length > 0;
};

const textOf = (parts: readonly unknown[]): string =>
  parts
    .filter(
      (p): p is { type: 'text'; text: string } =>
        isObject(p) && p.type === 'text' && typeof p.text === 'string'
    )
    .map(p => p.text)
    .join('\n\n');

// ─── Session start ──────────────────────────────────────────────────────────

/**
 * The conversation the widget opens on: the user's one ACTIVE Ask Moji
 * conversation in this classroom for this `viewAs`, carrying a grant (legacy
 * rows never match) that still holds. It has no expiry: it lasts until the
 * user starts a new one (`create`). Null when there is none, so the caller
 * creates one.
 */
export const findActive = async (i: {
  userId: string;
  classroomId: string;
  viewAs: string;
  now?: Date;
}): Promise<OwnedConversation | null> => {
  if (!isAskMojiRole(i.viewAs)) return null;
  const now = (i.now ?? new Date()).getTime();
  const rows = await getPrisma().aIConversation.findMany({
    where: { user_id: i.userId, classroom_id: i.classroomId, type: TYPE, status: 'ACTIVE' },
    orderBy: [{ last_activity: 'desc' }, { started_at: 'desc' }],
    select: { id: true, user_id: true, classroom_id: true, context: true, last_activity: true },
  });
  for (const row of rows) {
    const grant = readGrant(row.context);
    if (!grant || grant.view_as !== i.viewAs || !holds(grant, row, now)) continue;
    return { conversationId: row.id, grant, lastActivity: row.last_activity };
  }
  return null;
};

export type CreateResult =
  | { ok: true; conversationId: string; closedConversationIds: string[] }
  | AskMojiRefusal;

/**
 * Start a conversation for the grant's user in the grant's classroom, with
 * `context: { grant }` (stamped with `CONTRACT_VERSION`; the browser zone is
 * kept only when it is a real zone). In the same transaction, under a
 * per-user lock:
 * - `RATE_LIMITED` when the user started `START_RATE_LIMIT.max` grant-bearing
 *   conversations within its window (any classroom), and nothing changes;
 * - otherwise the user's other ACTIVE grant-bearing conversations in this
 *   classroom for the same `view_as` are marked COMPLETED and their ids
 *   returned (the caller closes their Trigger sessions), so one stays open
 *   per (user, classroom, view). Legacy rows are left alone.
 *
 * The caller has already run every gate and builds the grant from ids it
 * derived itself.
 */
export const create = async (i: {
  grant: Omit<AskMojiGrant, 'contract_version'>;
  now?: Date;
}): Promise<CreateResult> => {
  const now = i.now ?? new Date();
  const grant: AskMojiGrant = {
    ...i.grant,
    browser_timezone: canonicalTimeZone(i.grant.browser_timezone),
    contract_version: CONTRACT_VERSION,
  };
  if (!readGrant({ grant })) throw new Error('askMojiChat.create: malformed grant');
  const userId = grant.effective_user_id;
  const classroomId = grant.classroom_id;

  return getPrisma().$transaction(async (tx): Promise<CreateResult> => {
    // Serializes one user's starts, so the count and the closing below see
    // every earlier start.
    await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${`ask-moji:${userId}`}))) AS l`;

    const recent = await tx.aIConversation.findMany({
      where: {
        user_id: userId,
        type: TYPE,
        started_at: { gt: new Date(now.getTime() - START_RATE_LIMIT.windowMs) },
      },
      select: { context: true },
    });
    if (recent.filter(r => readGrant(r.context)).length >= START_RATE_LIMIT.max) {
      return refusal('RATE_LIMITED');
    }

    const open = await tx.aIConversation.findMany({
      where: { user_id: userId, classroom_id: classroomId, type: TYPE, status: 'ACTIVE' },
      select: { id: true, context: true },
    });
    const closed = open.filter(r => readGrant(r.context)?.view_as === grant.view_as).map(r => r.id);
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
      closedConversationIds: closed,
    };
  }, TX_OPTIONS);
};

/**
 * The conversation if it is this user's Ask Moji conversation in this
 * classroom, ACTIVE, with a grant that still holds; else null (one answer for
 * missing, not yours, another type, legacy, ended). For the token and resume
 * paths.
 */
export const findOwned = async (i: {
  conversationId: string;
  userId: string;
  classroomId: string;
  now?: Date;
}): Promise<OwnedConversation | null> => {
  if (!validId(i.conversationId)) return null;
  const row = await getPrisma().aIConversation.findFirst({
    where: {
      id: i.conversationId,
      user_id: i.userId,
      classroom_id: i.classroomId,
      type: TYPE,
      status: 'ACTIVE',
    },
    select: { id: true, user_id: true, classroom_id: true, context: true, last_activity: true },
  });
  const grant = row ? readGrant(row.context) : null;
  if (!row || !grant || !holds(grant, row, (i.now ?? new Date()).getTime())) return null;
  return { conversationId: row.id, grant, lastActivity: row.last_activity };
};

/**
 * End the user's conversation (New conversation, or the widget's end): marks
 * it COMPLETED. `owned` is false for a conversation that is not this user's
 * Ask Moji conversation in this classroom (one answer for missing and not
 * yours); `changed` is whether it was ACTIVE until now.
 */
export const end = async (i: {
  conversationId: string;
  userId: string;
  classroomId: string;
}): Promise<{ owned: boolean; changed: boolean }> => {
  if (!validId(i.conversationId)) return { owned: false, changed: false };
  const where = {
    id: i.conversationId,
    user_id: i.userId,
    classroom_id: i.classroomId,
    type: TYPE,
  };
  const { count } = await getPrisma().aIConversation.updateMany({
    where: { ...where, status: 'ACTIVE' },
    data: { status: 'COMPLETED', ended_at: new Date() },
  });
  if (count > 0) return { owned: true, changed: true };
  const owned = await getPrisma().aIConversation.findFirst({ where, select: { id: true } });
  return { owned: Boolean(owned), changed: false };
};

// ─── Admission ──────────────────────────────────────────────────────────────

/**
 * An admitted message:
 *   admitted          a new user row was written; this turn runs
 *   redelivered       the same id and text as the latest admitted message,
 *                     whose reply never finished: this turn runs again, no
 *                     new row, no turn counted
 *   already_answered  the same id and text as a message whose turn finished
 *                     (or an older one): run nothing, show nothing
 * `role` is the acting role (the strongest held at or below the ceiling);
 * `turnsUsed` the admitted messages so far; `metadata` the message's
 * metadata as stored (`viewing` at most), for a re-delivery the stored one.
 */
export type AdmitResult =
  | {
      ok: true;
      status: 'admitted' | 'redelivered' | 'already_answered';
      messageId: string;
      role: AskMojiRole;
      turnsUsed: number;
      metadata: AskMojiMessageMetadata;
    }
  | AskMojiRefusal;

type CheckedMessage = { id: string; text: string; metadata: AskMojiMessageMetadata };

/**
 * The one user text message admission takes, or null: a well-formed id,
 * exactly one text part, not blank, within `MAX_MESSAGE_CHARS`, and metadata
 * that is absent or exactly `AskMojiMessageMetadataSchema` (at most
 * `viewing`; any other key refuses the message).
 */
const checkedMessage = (message: unknown): CheckedMessage | null => {
  if (!isObject(message) || message.role !== 'user') return null;
  const { id, parts } = message;
  if (typeof id !== 'string' || !CLIENT_MESSAGE_ID_PATTERN.test(id)) return null;
  if (!Array.isArray(parts) || parts.length !== 1) return null;
  const [part] = parts;
  if (!isObject(part) || part.type !== 'text' || typeof part.text !== 'string') return null;
  if (part.text.trim() === '' || part.text.length > MAX_MESSAGE_CHARS) return null;
  const metadata = AskMojiMessageMetadataSchema.safeParse(message.metadata ?? {});
  if (!metadata.success) return null;
  return { id, text: part.text, metadata: metadata.data };
};

/** Stored metadata, re-read through the schema (an unreadable value is none). */
const storedMetadata = (value: unknown): AskMojiMessageMetadata => {
  const parsed = AskMojiMessageMetadataSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
};

class Refused extends Error {
  constructor(readonly code: AskMojiRefusalCode) {
    super(`ask moji turn refused: ${code}`);
  }
}

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
 * - Pro, through `canUseSyllabusBot` as the webapp route reads it (read
 *   before the lock on its own connection; a failed lookup is `UNAVAILABLE`
 *   too), and `syllabus_bot_enabled` (`NOT_ENABLED`), both transient;
 * - one user message (`checkedMessage`: id, one text part, the length cap,
 *   metadata at most a valid `viewing`), else `INVALID_MESSAGE`;
 * - an id already stored: with other text or on another role,
 *   `INVALID_MESSAGE`; else re-delivery (`ASK_MOJI_REDELIVERY`): the latest
 *   user row whose reply never finished runs again, anything else is
 *   `already_answered`. Neither is paced nor counted;
 * - a new message within `MIN_TURN_INTERVAL_MS` of the previous one: `PACE`;
 * - then the user row is written (`[{ type: 'text', text }]`, its metadata
 *   when it has any, provenance `user`, the grant's contract version) and
 *   `last_activity` moves.
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
        const latest = await tx.aIConversationMessage.findFirst({
          where: { conversation_id: row.id, role: 'USER', format: 'ui_message_v1' },
          orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
          select: { ui_message_id: true },
        });
        const action =
          latest?.ui_message_id === message.id
            ? ASK_MOJI_REDELIVERY[await replyStateAfter(tx, row.id, stored.created_at)]
            : 'skip';
        if (action === 'rerun') {
          await tx.aIConversation.update({ where: { id: row.id }, data: { last_activity: now } });
        }
        const first = await tx.aIConversationMessage.findUnique({
          where: {
            conversation_id_ui_message_id: { conversation_id: row.id, ui_message_id: message.id },
          },
          select: { metadata: true },
        });
        return {
          ok: true,
          status: action === 'rerun' ? 'redelivered' : 'already_answered',
          messageId: message.id,
          role,
          turnsUsed: turns,
          metadata: storedMetadata(first?.metadata),
        };
      }

      const previous = await tx.aIConversationMessage.findFirst({
        where: { conversation_id: row.id, role: 'USER', format: 'ui_message_v1' },
        orderBy: { created_at: 'desc' },
        select: { created_at: true },
      });
      if (previous && now.getTime() - previous.created_at.getTime() < MIN_TURN_INTERVAL_MS) {
        throw new Refused('PACE');
      }

      await tx.aIConversationMessage.create({
        data: {
          conversation_id: row.id,
          role: 'USER',
          content: message.text,
          parts: [{ type: 'text', text: message.text }],
          ...(message.metadata.viewing
            ? { metadata: message.metadata as Prisma.InputJsonObject }
            : {}),
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
      };
    }, TX_OPTIONS);
  } catch (error) {
    if (error instanceof Refused) return refusal(error.code);
    throw error;
  }
};

// ─── Model history ──────────────────────────────────────────────────────────

/**
 * The conversation as the model reads it, oldest first: every user message
 * whose turn got a final reply, with every final reply in full (text, MCP
 * tool calls and results, cite_content calls, reasoning, data parts: the
 * task converts what it needs), plus the one being answered now:
 * `answeringMessageId`, or without it the latest user message when nothing
 * final follows it. A user message whose turn never got a final reply (it
 * failed, or was stopped) is dropped with its partial replies, so it leaves
 * no trace in what the model reads; partial rows never reach the model.
 */
export const loadModelHistory = async (
  conversationId: string,
  o: { answeringMessageId?: string } = {}
): Promise<AskMojiUIMessage[]> => {
  const rows = await getPrisma().aIConversationMessage.findMany({
    where: {
      conversation_id: conversationId,
      format: 'ui_message_v1',
      ui_message_id: { not: null },
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
 * Under the conversation's row lock. Not stored (`stored: false`) once the
 * conversation is no longer an ACTIVE Ask Moji conversation with a grant, or
 * when a partial save would overwrite a final one. An id that belongs to a
 * user row throws.
 */
export const persistAssistantMessage = async (i: {
  conversationId: string;
  message: AskMojiUIMessage;
  provenance?: 'model' | 'server';
  final?: boolean;
}): Promise<{ stored: boolean }> => {
  const m = i.message;
  if (!m || m.role !== 'assistant' || typeof m.id !== 'string' || !m.id || m.id.length > 200) {
    throw new Error('persistAssistantMessage: expected an assistant message with an id');
  }
  if (!validId(i.conversationId)) return { stored: false };
  const final = i.final ?? true;
  return getPrisma().$transaction(async tx => {
    if (!(await lockConversation(tx, i.conversationId))) return { stored: false };
    const row = await tx.aIConversation.findUnique({
      where: { id: i.conversationId },
      select: { id: true, type: true, status: true, context: true },
    });
    const grant = row && row.type === TYPE ? readGrant(row.context) : null;
    if (!row || !grant || row.status !== 'ACTIVE') return { stored: false };

    const partsList: unknown[] = Array.isArray(m.parts) ? m.parts : [];
    const parts = JSON.parse(JSON.stringify(partsList)) as Prisma.InputJsonValue;
    const content = textOf(partsList);
    const metadata = isObject(m.metadata)
      ? (JSON.parse(JSON.stringify(m.metadata)) as Prisma.InputJsonObject)
      : undefined;
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
        data: { parts, content, final, ...(metadata ? { metadata } : {}) },
      });
    } else {
      await tx.aIConversationMessage.create({
        data: {
          conversation_id: row.id,
          role: 'ASSISTANT',
          content,
          parts,
          ...(metadata ? { metadata } : {}),
          format: 'ui_message_v1',
          ui_message_id: m.id,
          final,
          provenance: i.provenance ?? 'model',
          contract_version: grant.contract_version,
          created_at: await nextCreatedAt(tx, row.id),
        },
      });
    }
    await tx.aIConversation.update({ where: { id: row.id }, data: { last_activity: new Date() } });
    return { stored: true };
  }, TX_OPTIONS);
};

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * The transcript the conversation's owner sees, projected through the Ask
 * Moji registry: text, cite_content, notice and step parts only (the stored
 * MCP tool calls, their results and reasoning never leave the server). Null when the conversation
 * is not this user's Ask Moji conversation (with a grant) in this classroom.
 * Ended conversations are still readable by their owner.
 */
export const loadTranscriptForViewer = async (i: {
  conversationId: string;
  userId: string;
  classroomId: string;
}): Promise<AskMojiUIMessage[] | null> => {
  if (!validId(i.conversationId)) return null;
  const prisma = getPrisma();
  const conversation = await prisma.aIConversation.findFirst({
    where: { id: i.conversationId, user_id: i.userId, classroom_id: i.classroomId, type: TYPE },
    select: { id: true, context: true },
  });
  if (!conversation || !readGrant(conversation.context)) return null;
  const rows = await prisma.aIConversationMessage.findMany({
    where: {
      conversation_id: conversation.id,
      format: 'ui_message_v1',
      ui_message_id: { not: null },
    },
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    select: { ui_message_id: true, role: true, parts: true, metadata: true },
  });
  return projectTranscript(
    rows.map(row => toUIMessage<AskMojiUIMessage>(row)),
    askMojiVisibility
  );
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
    actorUserId: grant.actor_user_id,
    impersonation: grant.impersonation,
    contractVersion: grant.contract_version,
  };
};
