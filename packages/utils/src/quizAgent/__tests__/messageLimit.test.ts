/**
 * The per-attempt message limit as the screens state it, and the count the
 * task sends with each reply (`data-messages-left`).
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_STUDENT_TURNS,
  MESSAGES_LEFT_NOTICE_AT,
  MessagesLeftDataSchema,
  QUIZ_AGENT_ERROR_COPY,
  QUIZ_MESSAGE_LIMIT_COPY,
  QUIZ_RUN_MAX_TURNS,
  createChunkProjector,
  quizVisibility,
} from '../index.ts';
import * as limits from '../limits.ts';
import * as copy from '../copy.ts';

describe('the message limit', () => {
  it('is one constant, also reachable without the rest of the module', () => {
    expect(MAX_STUDENT_TURNS).toBe(200);
    expect(MESSAGES_LEFT_NOTICE_AT).toBe(20);
    expect(limits.MAX_STUDENT_TURNS).toBe(MAX_STUDENT_TURNS);
    expect(limits.QUIZ_RUN_MAX_TURNS).toBe(QUIZ_RUN_MAX_TURNS);
    expect(limits.QUIZ_RUN_COMPUTE_BUDGET_MS).toBe(3_300_000);
    expect(copy.QUIZ_MESSAGE_LIMIT_COPY).toBe(QUIZ_MESSAGE_LIMIT_COPY);
  });

  it('is stated on the quiz form with N', () => {
    expect(QUIZ_MESSAGE_LIMIT_COPY.form(MAX_STUDENT_TURNS)).toBe(
      'Students can send up to 200 messages per attempt. At 200 the attempt is submitted, ' +
        'and unanswered questions count as skipped.'
    );
  });

  it('counts the messages left, singular for one', () => {
    expect(QUIZ_MESSAGE_LIMIT_COPY.messagesLeft(20)).toBe('20 messages left in this attempt.');
    expect(QUIZ_MESSAGE_LIMIT_COPY.messagesLeft(2)).toBe('2 messages left in this attempt.');
    expect(QUIZ_MESSAGE_LIMIT_COPY.messagesLeft(1)).toBe('1 message left in this attempt.');
    expect(QUIZ_MESSAGE_LIMIT_COPY.messagesLeft(0)).toBe('0 messages left in this attempt.');
  });

  it('says an attempt was submitted at the limit, and none of this is error text', () => {
    expect(QUIZ_MESSAGE_LIMIT_COPY.submittedAtLimit).toBe(
      'This quiz reached its message limit and was submitted.'
    );
    expect(QUIZ_AGENT_ERROR_COPY).not.toContain(QUIZ_MESSAGE_LIMIT_COPY.submittedAtLimit);
  });
});

describe('data-messages-left', () => {
  it('carries a whole count, never below 0', () => {
    expect(MessagesLeftDataSchema.safeParse({ remaining: 19 }).success).toBe(true);
    expect(MessagesLeftDataSchema.safeParse({ remaining: 0 }).success).toBe(true);
    expect(MessagesLeftDataSchema.safeParse({ remaining: -1 }).success).toBe(false);
    expect(MessagesLeftDataSchema.safeParse({ remaining: 1.5 }).success).toBe(false);
    expect(MessagesLeftDataSchema.safeParse({}).success).toBe(false);
  });

  it('reaches the browser as sent, transient, with its declared field only', () => {
    const project = createChunkProjector(quizVisibility);
    expect(
      project({
        type: 'data-messages-left',
        data: { remaining: 7, attemptId: 'x' },
        transient: true,
      } as never)
    ).toEqual({ type: 'data-messages-left', data: { remaining: 7 }, transient: true });
    expect(
      project({ type: 'data-messages-left', data: { remaining: -3 }, transient: true } as never)
    ).toBeNull();
  });
});
