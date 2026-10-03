/**
 * Pins how `findWithMessages` shows a failed quiz reply.
 *
 * Every transcript reader (the student drawer, the staff attempt and preview
 * drawers, api.quiz) takes its messages from here. A failed-reply row saved
 * before the reply copy was fixed holds the ai-agent's raw error as `content`
 * and again as `metadata.errorMessage`; it reads as the fixed line, with only
 * the type and code left in its metadata. A row whose code is one the ai-agent
 * writes for students (BUDGET_EXCEEDED) keeps its text; an API_ERROR row, whose
 * text describes the upstream failure, does not. A GENERAL_FAILURE row reads as
 * the fixed line whatever older copy it holds, and every other row is untouched.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const attemptFindUnique = vi.fn();
const conversationFindFirst = vi.fn();

vi.mock('@classmoji/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@classmoji/database')>()),
  default: () => ({
    quizAttempt: { findUnique: attemptFindUnique },
    aIConversation: { findFirst: conversationFindFirst },
  }),
}));

const { findWithMessages } = await import('../quizAttempt.service.ts');

const REPLY_FAILED = "That reply couldn't be finished. Please send your message again.";
const RAW = "Invalid `prisma.quizAttempt.update()` invocation: Can't reach database server";

const created = new Date('2026-09-20T12:00:00Z');
const message = (id: string, role: string, content: string, metadata: unknown = null) => ({
  id,
  conversation_id: 'conv-1',
  role,
  content,
  metadata,
  created_at: created,
});

const withMessages = (messages: ReturnType<typeof message>[]) =>
  conversationFindFirst.mockResolvedValue({ id: 'conv-1', messages });

beforeEach(() => {
  vi.clearAllMocks();
  attemptFindUnique.mockResolvedValue({
    id: 'attempt-1',
    quiz: { question_count: 5, classroom: { settings: {} } },
  });
});

describe('findWithMessages — failed replies in the transcript', () => {
  it('shows an older raw-error row as the fixed line, without its error text', async () => {
    withMessages([
      message('m1', 'ASSISTANT', RAW, { errorType: 'AGENT_FAILURE', errorMessage: RAW }),
    ]);

    const { messages } = await findWithMessages('attempt-1');

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe(REPLY_FAILED);
    expect(messages[0].metadata).toEqual({ errorType: 'AGENT_FAILURE', code: null });
    expect(JSON.stringify(messages)).not.toContain('prisma');
  });

  it('shows an older timeout row as the fixed line', async () => {
    const timeout =
      'The AI API appears to be slow or overloaded right now. This is on their end, not ours!';
    withMessages([
      message('m1', 'ASSISTANT', timeout, {
        errorType: 'AGENT_FAILURE',
        errorMessage: 'Request timeout after 300000ms for requestId: 1234',
      }),
    ]);

    const { messages } = await findWithMessages('attempt-1');

    expect(messages[0].content).toBe(REPLY_FAILED);
    expect(JSON.stringify(messages)).not.toContain('requestId');
  });

  it('shows the fixed line for any code the ai-agent does not write for students', async () => {
    withMessages([
      message('m1', 'ASSISTANT', RAW, { errorType: 'AGENT_FAILURE', code: 'RESPONSE_FAILED' }),
    ]);

    const { messages } = await findWithMessages('attempt-1');

    expect(messages[0].content).toBe(REPLY_FAILED);
    expect(messages[0].metadata).toEqual({ errorType: 'AGENT_FAILURE', code: 'RESPONSE_FAILED' });
  });

  it('keeps the saved text for BUDGET_EXCEEDED', async () => {
    const stopped = "Your first question couldn't be prepared. Send any message to try again.";
    withMessages([
      message('m1', 'ASSISTANT', stopped, { errorType: 'AGENT_FAILURE', code: 'BUDGET_EXCEEDED' }),
    ]);

    const { messages } = await findWithMessages('attempt-1');

    expect(messages[0].content).toBe(stopped);
    expect(messages[0].metadata).toEqual({ errorType: 'AGENT_FAILURE', code: 'BUDGET_EXCEEDED' });
  });

  it('shows a stopped start as saved, with its code', async () => {
    const stopped = "Your first question couldn't be prepared. Send any message to try again.";
    withMessages([
      message('m1', 'ASSISTANT', stopped, {
        errorType: 'START_INTERRUPTED',
        code: 'TURN_DEADLINE',
      }),
    ]);

    const { messages } = await findWithMessages('attempt-1');

    expect(messages[0].content).toBe(stopped);
    expect(messages[0].metadata).toEqual({ errorType: 'START_INTERRUPTED', code: 'TURN_DEADLINE' });
  });

  it('keeps the saved text for turn_in_progress', async () => {
    const stillAnswering = 'Your last message is still being answered.';
    withMessages([
      message('m1', 'ASSISTANT', stillAnswering, {
        errorType: 'AGENT_FAILURE',
        code: 'turn_in_progress',
      }),
    ]);

    const { messages } = await findWithMessages('attempt-1');

    expect(messages[0].content).toBe(stillAnswering);
    expect(messages[0].metadata).toEqual({ errorType: 'AGENT_FAILURE', code: 'turn_in_progress' });
  });

  it('shows an older API_ERROR row as the fixed line, keeping its code', async () => {
    const busy = 'The AI service is temporarily busy. Please wait a moment and try again.';
    withMessages([
      message('m1', 'ASSISTANT', busy, { errorType: 'AGENT_FAILURE', code: 'API_ERROR' }),
    ]);

    const { messages } = await findWithMessages('attempt-1');

    expect(messages[0].content).toBe(REPLY_FAILED);
    expect(messages[0].metadata).toEqual({ errorType: 'AGENT_FAILURE', code: 'API_ERROR' });
  });

  it('shows an older GENERAL_FAILURE row as the fixed line', async () => {
    const closing =
      'I\'m having trouble closing out your quiz right now. Please wait a moment and tap "Next" again, or refresh the page if it persists—your progress is already saved.';
    withMessages([message('m1', 'ASSISTANT', closing, { errorType: 'GENERAL_FAILURE' })]);

    const { messages } = await findWithMessages('attempt-1');

    expect(messages[0].content).toBe(REPLY_FAILED);
    expect(messages[0].metadata).toEqual({ errorType: 'GENERAL_FAILURE' });
  });

  it('passes every other row through unchanged', async () => {
    const opening = {
      isOpeningMessage: true,
      explorationSteps: [{ action: 'Read src/index.js', toolName: 'Read' }],
    };
    const step = { isExplorationStep: true, toolName: 'Read', toolInput: { path: 'a.js' } };
    const welcome = { isWelcomeMessage: true };
    withMessages([
      message('m1', 'ASSISTANT', 'Question 1: what does this do?', opening),
      message('m2', 'SYSTEM', 'Read a.js', step),
      message('m3', 'USER', 'It adds two numbers.'),
      message('m4', 'ASSISTANT', 'Welcome to your quiz!', welcome),
    ]);

    const { messages } = await findWithMessages('attempt-1');

    expect(messages).toEqual([
      {
        id: 'm1',
        role: 'assistant',
        content: 'Question 1: what does this do?',
        metadata: opening,
        timestamp: created,
      },
      { id: 'm2', role: 'system', content: 'Read a.js', metadata: step, timestamp: created },
      {
        id: 'm3',
        role: 'user',
        content: 'It adds two numbers.',
        metadata: null,
        timestamp: created,
      },
      {
        id: 'm4',
        role: 'assistant',
        content: 'Welcome to your quiz!',
        metadata: welcome,
        timestamp: created,
      },
    ]);
  });
});
