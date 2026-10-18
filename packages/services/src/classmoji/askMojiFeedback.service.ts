/**
 * Thumbs up / down on Ask Moji answers (R10), by the conversation's owner.
 *
 * The rated row must be an ASSISTANT row of that conversation, final, written
 * by the model (`provenance = 'model'`), in an Ask Moji conversation the
 * caller owns under the request's scope (`askMojiChat.findOwned`, any status).
 * The message id is checked by length only (assistant ids contain `:`). One
 * row per answer; clearing deletes it.
 *
 * Nothing here writes audit rows. The caller audits each change with what
 * these return: `resource_id` = the feedback row id, `dedupe: false`,
 * `data.value` = the rating (null on a clear), plus `impersonated_by`
 * (`askMojiSession.feedback` does exactly that). The staff review list and
 * the single exchange read are in askMojiInsights.
 */
import getPrisma from '@classmoji/database';
import type { AskMojiScope } from './askMojiChat.service.ts';
import { findOwned, validMessageId } from './askMojiChat.service.ts';

export const ASK_MOJI_RATINGS = ['UP', 'DOWN'] as const;
export type AskMojiRating = (typeof ASK_MOJI_RATINGS)[number];

export const isAskMojiRating = (v: unknown): v is AskMojiRating => v === 'UP' || v === 'DOWN';

/** Refused: not this caller's conversation or answer (`NOT_FOUND`), or a bad rating (`INVALID`). */
export type FeedbackRefusal = { ok: false; code: 'NOT_FOUND' | 'INVALID' };

export type FeedbackSetResult =
  | {
      ok: true;
      /** The feedback row's id (the audit row's `resource_id`). */
      id: string;
      action: 'created' | 'updated' | 'unchanged';
      rating: AskMojiRating;
      previous: AskMojiRating | null;
      conversationId: string;
      classroomId: string;
    }
  | FeedbackRefusal;

export type FeedbackClearResult =
  | {
      ok: true;
      /** The deleted row's id, null when there was no rating to clear. */
      id: string | null;
      deleted: boolean;
      previous: AskMojiRating | null;
      conversationId: string;
      classroomId: string;
    }
  | FeedbackRefusal;

type Target = AskMojiScope & { conversationId: string; classroomId: string; uiMessageId: string };

/** The rated answer, when the caller may rate it; else null (one answer for every refusal). */
const ratableAnswer = async (i: Target) => {
  if (!validMessageId(i.uiMessageId)) return null;
  const owned = await findOwned({ ...i, anyStatus: true });
  if (!owned) return null;
  const answer = await getPrisma().aIConversationMessage.findUnique({
    where: {
      conversation_id_ui_message_id: {
        conversation_id: owned.conversationId,
        ui_message_id: i.uiMessageId,
      },
    },
    select: { role: true, final: true, provenance: true, format: true },
  });
  if (
    !answer ||
    answer.role !== 'ASSISTANT' ||
    !answer.final ||
    answer.provenance !== 'model' ||
    answer.format !== 'ui_message_v1'
  ) {
    return null;
  }
  return owned;
};

/** Rate an answer (create, or change the existing rating). */
export const set = async (i: Target & { rating: unknown }): Promise<FeedbackSetResult> => {
  if (!isAskMojiRating(i.rating)) return { ok: false, code: 'INVALID' };
  const rating = i.rating;
  const owned = await ratableAnswer(i);
  if (!owned) return { ok: false, code: 'NOT_FOUND' };
  const key = { conversation_id: owned.conversationId, ui_message_id: i.uiMessageId };
  return getPrisma().$transaction(async tx => {
    const existing = await tx.askMojiFeedback.findUnique({
      where: { conversation_id_ui_message_id: key },
      select: { id: true, rating: true },
    });
    const base = { conversationId: owned.conversationId, classroomId: i.classroomId, rating };
    if (existing) {
      if (existing.rating === rating) {
        return { ok: true, id: existing.id, action: 'unchanged', previous: rating, ...base };
      }
      await tx.askMojiFeedback.update({ where: { id: existing.id }, data: { rating } });
      return {
        ok: true,
        id: existing.id,
        action: 'updated',
        previous: existing.rating,
        ...base,
      };
    }
    const row = await tx.askMojiFeedback.create({
      data: {
        ...key,
        classroom_id: i.classroomId,
        user_id: i.userId,
        rating,
      },
      select: { id: true },
    });
    return { ok: true, id: row.id, action: 'created', previous: null, ...base };
  });
};

/** Clear an answer's rating. Clearing none is not a refusal (`deleted: false`). */
export const clear = async (i: Target): Promise<FeedbackClearResult> => {
  const owned = await ratableAnswer(i);
  if (!owned) return { ok: false, code: 'NOT_FOUND' };
  const key = { conversation_id: owned.conversationId, ui_message_id: i.uiMessageId };
  const existing = await getPrisma().askMojiFeedback.findUnique({
    where: { conversation_id_ui_message_id: key },
    select: { id: true, rating: true },
  });
  const base = { conversationId: owned.conversationId, classroomId: i.classroomId };
  if (!existing) return { ok: true, id: null, deleted: false, previous: null, ...base };
  const { count } = await getPrisma().askMojiFeedback.deleteMany({ where: { id: existing.id } });
  return { ok: true, id: existing.id, deleted: count > 0, previous: existing.rating, ...base };
};

/**
 * The owner's ratings in one conversation under this scope, by answer id
 * (the widget's thumbs on reload). Empty for a conversation that is not theirs.
 */
export const ratingsFor = async (
  i: AskMojiScope & { conversationId: string; classroomId: string }
): Promise<Record<string, AskMojiRating>> => {
  const owned = await findOwned({ ...i, anyStatus: true });
  if (!owned) return {};
  const rows = await getPrisma().askMojiFeedback.findMany({
    where: { conversation_id: owned.conversationId, user_id: i.userId },
    select: { ui_message_id: true, rating: true },
  });
  return Object.fromEntries(rows.map(r => [r.ui_message_id, r.rating]));
};
