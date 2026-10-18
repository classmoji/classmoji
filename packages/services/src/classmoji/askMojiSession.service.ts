/**
 * Ask Moji's session module (R4, R14): what the webapp's
 * `api.ask-moji.$class.*` routes (and its embed route) call after
 * `assertAskMojiAccess`. One copy of the availability gates, conversation
 * start and reuse, Trigger session start, token minting, ending and ratings,
 * with their audit rows.
 *
 * NO REQUEST AUTH HERE. The caller passes the `assertAskMojiAccess` result
 * (`AskMojiAccess`); every id below comes from it, and every conversation id
 * the client sends is re-checked against it (owner, classroom, type, scope).
 * The caller also checks the request's origin.
 *
 * AUDIT. Written here, through `ClassmojiService.audit`, with the caller's
 * `tool` as `data.tool` and `impersonated_by` whenever an impersonation is
 * behind the request: a conversation created (CREATE `ASK_MOJI_CONVERSATION`,
 * only when one actually was), ended (UPDATE, only when it was active), and a
 * rating set, changed or cleared (CREATE / UPDATE / DELETE `ASK_MOJI_FEEDBACK`,
 * `resource_id` = the feedback row, `dedupe: false`, `data.value` = the
 * rating or null). Reading one's own conversation is not audited. A failed
 * audit write is logged and the action stands.
 *
 * TRIGGER SESSIONS. `chat.createStartSessionAction` calls `sessions.start`,
 * which is idempotent on the chat id but always returns a run: it boots one
 * (trigger "preload") whenever the session has no live run, on every call. So
 * `start` never calls it: it mints a session-scoped token
 * (`auth.createPublicToken`, read+write on `sessions:<conversationId>`, 15 m,
 * a local signature, no network) and reports `sessionReady` (a Trigger
 * session is recorded for the conversation). `ensureSession` is the one call
 * that creates the session (and so boots its first run): the transport's
 * `startSession` callback, reached on composer focus (`transport.preload`)
 * or the first send. Ended and replaced conversations get `sessions.close`.
 */
import type { Role } from '@prisma/client';
import {
  ASK_MOJI_WELCOME,
  isAskMojiRole,
  suggestionsForRole,
  type AskMojiAvailabilityCode,
  type AskMojiRefusalCode,
  type AskMojiRole,
  type AskMojiSuggestion,
  type AskMojiUIMessage,
} from '@classmoji/utils/ask-moji';
import getPrisma from '@classmoji/database';
import * as askMojiChat from './askMojiChat.service.ts';
import * as askMojiFeedback from './askMojiFeedback.service.ts';
import * as audit from './audit.service.ts';
import { canUseSyllabusBot } from './entitlement.service.ts';

/** The Trigger task every Ask Moji conversation runs. */
export const ASK_MOJI_TASK_ID = 'ask-moji';

/** How long a minted session token lives. */
export const ASK_MOJI_TOKEN_TTL = '15m';

/** The audit resource types this module writes. */
export const ASK_MOJI_AUDIT = {
  conversation: 'ASK_MOJI_CONVERSATION',
  feedback: 'ASK_MOJI_FEEDBACK',
} as const;

/**
 * Who is asking, as `@classmoji/auth/server`'s `assertAskMojiAccess` resolved
 * it from the request. `roles` are all the bot roles held in the classroom;
 * `highestRole` the strongest of them.
 */
export interface AskMojiAccess {
  userId: string;
  actorUserId: string;
  impersonation: { by: string; sessionId: string | null; expiresAt: string | null } | null;
  webSessionId: string | null;
  classroom: { id: string; slug: string; status: string; name?: string };
  roles: Role[];
  highestRole: Role;
}

/** Whether this deployment can reach Trigger at all. */
export const isTriggerConfigured = () =>
  Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN);

/** The rollout switch: `trigger` serves Ask Moji on the Trigger runtime; anything else does not. */
export const askMojiRuntimeIsTrigger = () => process.env.ASK_MOJI_RUNTIME === 'trigger';

export type AskMojiAvailability =
  | { available: true }
  | { available: false; reason: AskMojiAvailabilityCode };

/**
 * Whether Ask Moji runs in this classroom on this runtime, and if not why
 * (`ASK_MOJI_AVAILABILITY_COPY` has a staff line per reason; members see
 * `ASK_MOJI_COPY.UNAVAILABLE`). In order: the switch (`ASK_MOJI_RUNTIME ===
 * 'trigger'`), Trigger configured, an Anthropic key (the platform's
 * `ANTHROPIC_API_KEY` or the classroom's own), Pro (`canUseSyllabusBot`; a
 * failed lookup reads as not Pro), `syllabus_bot_enabled`.
 */
export const askMojiAvailable = async (i: {
  classroomId: string;
}): Promise<AskMojiAvailability> => {
  if (!askMojiRuntimeIsTrigger()) return { available: false, reason: 'RUNTIME_OFF' };
  if (!isTriggerConfigured()) return { available: false, reason: 'TRIGGER_NOT_CONFIGURED' };
  const settings = await getPrisma().classroomSettings.findUnique({
    where: { classroom_id: i.classroomId },
    select: { anthropic_api_key: true, syllabus_bot_enabled: true },
  });
  const hasKey = Boolean(
    process.env.ANTHROPIC_API_KEY?.trim() || settings?.anthropic_api_key?.trim()
  );
  if (!hasKey) return { available: false, reason: 'NO_API_KEY' };
  let pro = false;
  try {
    pro = (await canUseSyllabusBot(i.classroomId)).allowed;
  } catch (error) {
    console.error('[askMojiSession] Pro lookup failed', error);
  }
  if (!pro) return { available: false, reason: 'PRO_REQUIRED' };
  if (!settings?.syllabus_bot_enabled) return { available: false, reason: 'NOT_ENABLED' };
  return { available: true };
};

// ─── Trigger ────────────────────────────────────────────────────────────────

/** Loaded on first use: the services barrel is on every app's boot path. */
const trigger = async () => {
  const [{ auth, sessions }, { chat }] = await Promise.all([
    import('@trigger.dev/sdk'),
    // A package subpath export (resolved by TypeScript; the lint resolver reads `main` only).
    import('@trigger.dev/sdk/ai'),
  ]);
  return { auth, sessions, chat };
};

/** A token for one conversation's session only (never task-scoped). */
const mintToken = async (conversationId: string): Promise<string> => {
  const { auth } = await trigger();
  return auth.createPublicToken({
    scopes: { read: { sessions: conversationId }, write: { sessions: conversationId } },
    expirationTime: ASK_MOJI_TOKEN_TTL,
  });
};

/** Close Trigger sessions; a failure is logged, never thrown (the conversation is already ended). */
const closeSessions = async (conversationIds: readonly string[]) => {
  if (conversationIds.length === 0) return;
  const { sessions } = await trigger();
  for (const id of conversationIds) {
    try {
      await sessions.close(id);
    } catch (error) {
      console.warn('[askMojiSession] sessions.close failed', { conversationId: id, error });
    }
  }
};

// ─── Audit ──────────────────────────────────────────────────────────────────

const scopeOf = (a: AskMojiAccess): askMojiChat.AskMojiScope => ({
  userId: a.userId,
  actorUserId: a.actorUserId,
  impersonation: a.impersonation ? { sessionId: a.impersonation.sessionId } : null,
});

const writeAudit = async (
  a: AskMojiAccess,
  row: {
    resourceType: string;
    resourceId: string;
    action: 'CREATE' | 'UPDATE' | 'DELETE';
    data: Record<string, unknown>;
  }
) => {
  try {
    await audit.create(
      {
        user_id: a.userId,
        classroom_id: a.classroom.id,
        role: a.highestRole,
        resource_type: row.resourceType,
        resource_id: row.resourceId,
        action: row.action,
        data: {
          ...row.data,
          ...(a.impersonation ? { impersonated_by: a.impersonation.by } : {}),
        } as never,
      },
      { dedupe: false }
    );
  } catch (error) {
    console.error('[askMojiSession] audit write failed', error);
  }
};

// ─── Start ──────────────────────────────────────────────────────────────────

export type AskMojiSessionRefusal = {
  ok: false;
  /** A refusal code (`ASK_MOJI_COPY` has its line) or `UNAVAILABLE` / `NOT_ENABLED` with `reason`. */
  code: AskMojiRefusalCode | 'NOT_FOUND';
  permanent?: boolean;
  /** Why Ask Moji is unavailable (staff see `ASK_MOJI_AVAILABILITY_COPY[reason]`). */
  reason?: AskMojiAvailabilityCode;
};

export type AskMojiStartResult =
  | {
      ok: true;
      conversationId: string;
      /** Read+write on this conversation's session, 15 minutes. */
      publicAccessToken: string;
      /**
       * A Trigger session exists for it. False: do NOT `setSession`; let the
       * transport's `startSession` (→ `ensureSession`) create it on composer
       * focus or the first send.
       */
      sessionReady: boolean;
      resumeCursor: string | null;
      transcript: AskMojiUIMessage[];
      /** The owner's ratings in this conversation, by answer id. */
      ratings: Record<string, askMojiFeedback.AskMojiRating>;
      welcome: string;
      suggestions: readonly AskMojiSuggestion[];
      /** The view the conversation runs as (the requested one, clamped to the roles held). */
      viewAs: AskMojiRole;
      state: { status: 'ACTIVE'; lastMessageId: string | null; inFlight: boolean };
      /** Whether this call created the conversation (audited only then). */
      created: boolean;
    }
  | AskMojiSessionRefusal;

const grantFor = (
  a: AskMojiAccess,
  viewAs: unknown,
  browserTimeZone: unknown
): Omit<askMojiChat.AskMojiGrant, 'contract_version'> => ({
  actor_user_id: a.actorUserId,
  effective_user_id: a.userId,
  classroom_id: a.classroom.id,
  role: a.highestRole,
  web_session_id: a.webSessionId,
  impersonation: a.impersonation
    ? {
        by: a.impersonation.by,
        session_id: a.impersonation.sessionId,
        expires_at: a.impersonation.expiresAt,
      }
    : null,
  issued_at: new Date().toISOString(),
  view_as: isAskMojiRole(viewAs) ? viewAs : (a.highestRole as AskMojiRole),
  // Re-derived from current memberships by findOrCreate.
  role_ceiling: null,
  browser_timezone: typeof browserTimeZone === 'string' ? browserTimeZone : null,
});

const open = async (
  a: AskMojiAccess,
  i: { viewAs?: unknown; browserTimeZone?: unknown; tool: string; replace?: string }
): Promise<AskMojiStartResult> => {
  const availability = await askMojiAvailable({ classroomId: a.classroom.id });
  if (!availability.available) {
    return {
      ok: false,
      code: availability.reason === 'NOT_ENABLED' ? 'NOT_ENABLED' : 'UNAVAILABLE',
      permanent: false,
      reason: availability.reason,
    };
  }
  const result = await askMojiChat.findOrCreate({
    grant: grantFor(a, i.viewAs, i.browserTimeZone),
    ...(i.replace !== undefined ? { replace: i.replace } : {}),
  });
  if (!result.ok) return { ok: false, code: result.code, permanent: result.permanent };

  await closeSessions(result.closedWithSession);
  if (result.created) {
    await writeAudit(a, {
      resourceType: ASK_MOJI_AUDIT.conversation,
      resourceId: result.conversationId,
      action: 'CREATE',
      data: {
        tool: i.tool,
        view_as: result.grant.view_as,
        ...(result.closedConversationIds.length > 0
          ? { ended_conversation_ids: result.closedConversationIds }
          : {}),
      },
    });
  }

  const scope = scopeOf(a);
  const [publicAccessToken, st, ratings] = await Promise.all([
    mintToken(result.conversationId),
    askMojiChat.state({
      ...scope,
      conversationId: result.conversationId,
      classroomId: a.classroom.id,
    }),
    askMojiFeedback.ratingsFor({
      ...scope,
      conversationId: result.conversationId,
      classroomId: a.classroom.id,
    }),
  ]);
  return {
    ok: true,
    conversationId: result.conversationId,
    publicAccessToken,
    sessionReady: result.triggerSessionId !== null,
    resumeCursor: st?.resumeCursor ?? null,
    transcript: st?.transcript ?? [],
    ratings,
    welcome: ASK_MOJI_WELCOME,
    suggestions: suggestionsForRole(result.grant.view_as),
    viewAs: result.grant.view_as,
    state: {
      status: 'ACTIVE',
      lastMessageId: st?.lastMessageId ?? null,
      inFlight: st?.inFlight ?? false,
    },
    created: result.created,
  };
};

/**
 * Open the widget: the ongoing conversation for this classroom, view and
 * request scope, or a new one (audited CREATE). Does not start a Trigger
 * run (see the header).
 */
export const start = (
  a: AskMojiAccess,
  i: { viewAs?: unknown; browserTimeZone?: unknown; tool: string }
): Promise<AskMojiStartResult> => open(a, i);

/**
 * New conversation (R4): atomic across devices. `conversationId` is the one
 * the caller is on; if another device already replaced it, its replacement
 * is returned (`created: false`). Otherwise it is ended (its session closed,
 * its tool outputs stubbed) and a new one created (audited CREATE with
 * `ended_conversation_ids`).
 */
export const newConversation = (
  a: AskMojiAccess,
  i: { conversationId: string; viewAs?: unknown; browserTimeZone?: unknown; tool: string }
): Promise<AskMojiStartResult> => open(a, { ...i, replace: i.conversationId });

/**
 * Create the conversation's Trigger session (booting its first run) and
 * record it: the transport's `startSession`. Idempotent on the chat id; on a
 * session that already exists it re-joins it (and boots a run only when none
 * is live). Null when the conversation is not the caller's active one.
 */
export const ensureSession = async (
  a: AskMojiAccess,
  i: { conversationId: string }
): Promise<{ publicAccessToken: string; sessionId: string } | null> => {
  const owned = await askMojiChat.findOwned({
    ...scopeOf(a),
    conversationId: i.conversationId,
    classroomId: a.classroom.id,
  });
  if (!owned) return null;
  const { chat } = await trigger();
  const startSession = chat.createStartSessionAction(ASK_MOJI_TASK_ID, {
    tokenTTL: ASK_MOJI_TOKEN_TTL,
    triggerConfig: {
      tags: [`conversation:${owned.conversationId}`, `classroom:${a.classroom.id}`],
    },
  });
  const { publicAccessToken, sessionId } = await startSession({ chatId: owned.conversationId });
  if (sessionId && sessionId !== owned.triggerSessionId) {
    await askMojiChat.recordTriggerSession(owned.conversationId, sessionId);
  }
  return { publicAccessToken, sessionId };
};

/** A fresh token for the caller's active conversation (the transport's `accessToken`); mints only. */
export const token = async (
  a: AskMojiAccess,
  i: { conversationId: string }
): Promise<{ publicAccessToken: string } | null> => {
  const owned = await askMojiChat.findOwned({
    ...scopeOf(a),
    conversationId: i.conversationId,
    classroomId: a.classroom.id,
  });
  if (!owned) return null;
  return { publicAccessToken: await mintToken(owned.conversationId) };
};

/** The widget's poll (`askMojiChat.state` under the caller's scope). Never starts anything. */
export const state = (
  a: AskMojiAccess,
  i: { conversationId: string; knownLastMessageId?: string | null }
) =>
  askMojiChat.state({
    ...scopeOf(a),
    conversationId: i.conversationId,
    classroomId: a.classroom.id,
    knownLastMessageId: i.knownLastMessageId ?? null,
  });

/**
 * End the caller's conversation: COMPLETED (tool outputs stubbed), its
 * Trigger session closed, audited UPDATE when it was active. `owned: false`
 * for one that is not theirs.
 */
export const end = async (
  a: AskMojiAccess,
  i: { conversationId: string; tool: string }
): Promise<{ owned: boolean; changed: boolean }> => {
  const { hadSession, ...result } = await askMojiChat.end({
    ...scopeOf(a),
    conversationId: i.conversationId,
    classroomId: a.classroom.id,
  });
  if (result.changed) {
    if (hadSession) await closeSessions([i.conversationId]);
    await writeAudit(a, {
      resourceType: ASK_MOJI_AUDIT.conversation,
      resourceId: i.conversationId,
      action: 'UPDATE',
      data: { tool: i.tool, status: 'COMPLETED' },
    });
  }
  return result;
};

export type AskMojiFeedbackResult =
  | { ok: true; id: string | null; rating: askMojiFeedback.AskMojiRating | null; changed: boolean }
  | { ok: false; code: 'NOT_FOUND' | 'INVALID' };

/**
 * Rate an answer (`rating` UP / DOWN) or clear its rating (`rating: null`),
 * audited CREATE / UPDATE / DELETE on a real change.
 */
export const feedback = async (
  a: AskMojiAccess,
  i: { conversationId: string; uiMessageId: string; rating: unknown; tool: string }
): Promise<AskMojiFeedbackResult> => {
  const target = {
    ...scopeOf(a),
    conversationId: i.conversationId,
    classroomId: a.classroom.id,
    uiMessageId: i.uiMessageId,
  };
  const data = { tool: i.tool, conversation_id: i.conversationId, message_id: i.uiMessageId };
  if (i.rating === null) {
    const cleared = await askMojiFeedback.clear(target);
    if (!cleared.ok) return cleared;
    if (cleared.deleted && cleared.id) {
      await writeAudit(a, {
        resourceType: ASK_MOJI_AUDIT.feedback,
        resourceId: cleared.id,
        action: 'DELETE',
        data: { ...data, value: null, previous: cleared.previous },
      });
    }
    return { ok: true, id: cleared.id, rating: null, changed: cleared.deleted };
  }
  const set = await askMojiFeedback.set({ ...target, rating: i.rating });
  if (!set.ok) return set;
  if (set.action !== 'unchanged') {
    await writeAudit(a, {
      resourceType: ASK_MOJI_AUDIT.feedback,
      resourceId: set.id,
      action: set.action === 'created' ? 'CREATE' : 'UPDATE',
      data: { ...data, value: set.rating, previous: set.previous },
    });
  }
  return { ok: true, id: set.id, rating: set.rating, changed: set.action !== 'unchanged' };
};
