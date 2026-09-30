/**
 * The quiz tools' executes against fake grading services, a recording stream
 * writer and the real per-attempt queue. The exploration tests run the real
 * in-process pipeline on a fixture repository with GitHub and the model
 * stubbed. Nothing touches the database or the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolSet } from 'ai';
import { QUIZ_TOOL_ORDER, type QuestionResultOutput } from '@classmoji/utils/quiz-agent';
import { githubStub } from '../../__fixtures__/githubStub.ts';
import { createToolQueue } from '../../../shared/toolQueue.ts';
import type { AttemptContext } from '../../context.ts';

vi.mock('@trigger.dev/sdk/v3', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), log: vi.fn() },
  metadata: { set: vi.fn(), append: vi.fn(), flush: vi.fn() },
}));

const {
  editedQuestionNumbers,
  MAX_FEEDBACK_REFUSALS,
  MIN_FEEDBACK_WORDS,
  quizTools,
  questionResultPartId,
} = await import('../index.ts');
const {
  OFFER_AFTER_HINT_TEXT,
  OFFER_AFTER_QUESTION_TEXT,
  OFFER_BEFORE_FEEDBACK_TEXT,
  OFFER_TRY_AGAIN_ALONE_TEXT,
  QUESTION_AFTER_OFFER_TEXT,
  QUOTE_READ_FAILED_TEXT,
  RECORD_BEFORE_ANSWER_TEXT,
  RECORD_BEFORE_NEXT_TEXT,
  recordBeforePresentText,
  editLimitText,
  TURN_STOPPED_TEXT,
  retryText,
} = await import('../errors.ts');
const { QuoteFileCache } = await import('../codeQuote.ts');
const { EXPLORATION_FAILED_TEXT } = await import('../../../shared/exploration/core.ts');
const {
  EXPLORATION_BUSY_TEXT,
  EXPLORATION_LIMIT_TEXT,
  EXPLORATION_QUESTION_OPEN_TEXT,
  EXPLORATION_STOPPED_TEXT,
  MAX_EXPLORATIONS_PER_TURN,
} = await import('../exploreCodebase.ts');
const { TOOL_DESCRIPTIONS } = await import('../descriptions.ts');

class QuizGradingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'QuizGradingError';
    this.code = code;
  }
}

const FOCUS = 'focus-area-that-names-the-next-question';

function context(overrides: Partial<AttemptContext> = {}): AttemptContext {
  return {
    attemptId: 'attempt-1',
    userId: 'user-1',
    classroomId: 'class-1',
    quizId: 'quiz-1',
    questionCount: 8,
    isCodeAware: false,
    fence: 'fence-1',
    inputMessageId: 'msg-1',
    runId: 'run_1',
    model: 'claude-sonnet-5',
    questionEffort: 'medium',
    gradingEffort: 'medium',
    apiKey: 'key-for-this-attempt',
    keySource: 'platform',
    exploration: null,
    prompt: { staticPrompt: 's', dynamicPrompt: 'd' },
    progress: {
      questionCount: 8,
      presented: 1,
      finalized: [1],
      completed: false,
      hasEvaluation: false,
    },
    ...overrides,
  } as AttemptContext;
}

/** An attempt with one linked page and course search off. */
const CONTENT = {
  mcpUrl: 'https://mcp.example.test/mcp',
  classroomRef: 'sample-org/sample-class',
  courseSearchEnabled: false,
  docs: [{ kind: 'page', id: 'page-1', title: 'Semantic HTML' }],
};

/** Stored progress at turn start: questions 1..`presented` out, `finalized` recorded. */
const progressAt = (presented: number, finalized: number[] = []) => ({
  questionCount: 8,
  presented,
  finalized,
  completed: false,
  hasEvaluation: false,
});

const codeAware = (overrides: Partial<AttemptContext> = {}) =>
  context({
    isCodeAware: true,
    exploration: {
      model: 'claude-sonnet-5',
      effort: 'low',
      owner: 'sample-org',
      repo: 'landing-page',
      gitOrganization: { provider: 'GITHUB', github_installation_id: '1', login: 'sample-org' },
    },
    ...overrides,
  });

function fakeGrading() {
  return {
    presentQuestion: vi.fn(),
    finalizeQuestion: vi.fn(),
    completeWithEvaluation: vi.fn(),
    recordExploration: vi.fn(async () => undefined),
    listExplorations: vi.fn(async () => ({ filesRead: [] as string[], excerpts: [] as string[] })),
  };
}

function recordingWriter() {
  const writes: Array<Record<string, unknown>> = [];
  return {
    writes,
    writer: {
      write: (chunk: Record<string, unknown>) => writes.push(chunk),
      merge: vi.fn(),
      onError: undefined,
    },
  };
}

type Setup = {
  ctx?: AttemptContext;
  signal?: AbortSignal;
  services?: Record<string, unknown>;
  /** How many words the model has written this turn; defaults to plenty. */
  wordsWritten?: () => number;
};

function setup(o: Setup = {}) {
  const grading = fakeGrading();
  const { writes, writer } = recordingWriter();
  const log = vi.fn();
  const tools = quizTools(o.ctx ?? context(), {
    writer: writer as never,
    queue: createToolQueue(),
    signal: o.signal ?? new AbortController().signal,
    services: { grading, ...(o.services ?? {}) } as never,
    log,
    wordsWritten: o.wordsWritten ?? (() => 40),
  });
  return { tools, grading, writes, log };
}

const call = (
  tools: ToolSet,
  name: string,
  input: unknown,
  toolCallId = `call-${name}`,
  abortSignal?: AbortSignal
) => {
  const execute = tools[name].execute;
  if (!execute) throw new Error(`${name} has no execute`);
  return execute(
    input as never,
    {
      toolCallId,
      messages: [],
      abortSignal,
      context: undefined,
    } as never
  );
};

const card = {
  preamble: 'Stored preamble.',
  question_number: 2,
  total_questions: 8,
  question_text: 'Stored question?',
};

/** Feedback long enough for offer_next_step (MIN_FEEDBACK_WORDS). */
const FEEDBACK =
  'Yes, that is right: your grid gives the cards two equal columns, so the page reads as a tidy row of features.';
const CLOSE =
  'Close: the loop is right, but the bound is off by one, so the last item of your list is never read.';

const RECORD = {
  question_num: 1,
  answers: [
    { level: 'partly_right', hints_before: 0 },
    { level: 'correct', hints_before: 1 },
  ],
  brief_feedback: 'Got it with a hint!',
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('quizTools: the fixed set', () => {
  it('sends four tools for a standard attempt, in the fixed order', () => {
    const { tools } = setup();
    expect(Object.keys(tools)).toEqual(QUIZ_TOOL_ORDER.slice(0, 4));
  });

  it('adds explore_codebase after them for a code-aware attempt', () => {
    const { tools } = setup({ ctx: codeAware() });
    expect(Object.keys(tools)).toEqual(QUIZ_TOOL_ORDER.slice(0, 5));
  });

  it('adds content_get and content_search last for an attempt with course material', () => {
    expect(Object.keys(setup({ ctx: context({ content: CONTENT }) }).tools)).toEqual([
      ...QUIZ_TOOL_ORDER.slice(0, 4),
      'content_get',
      'content_search',
    ]);
    expect(Object.keys(setup({ ctx: codeAware({ content: CONTENT }) }).tools)).toEqual([
      ...QUIZ_TOOL_ORDER,
    ]);
  });

  it('builds byte-identical tool descriptions and schemas on every turn', () => {
    const first = setup({ ctx: codeAware({ content: CONTENT }) }).tools;
    const second = setup({
      ctx: codeAware({ content: CONTENT, fence: 'fence-2', runId: 'run_2' }),
    }).tools;
    for (const name of QUIZ_TOOL_ORDER) {
      expect(second[name].description).toBe(first[name].description);
      expect(second[name].inputSchema).toBe(first[name].inputSchema);
    }
  });

  it('states no credit, score or percentage in any description', () => {
    for (const text of Object.values(TOOL_DESCRIPTIONS)) {
      expect(text).not.toMatch(/\d+\s*%|credit_earned|\b15\b/);
    }
  });
});

describe('present_question', () => {
  it("writes through the grading service with the turn's fence and returns the stored card", async () => {
    const { tools, grading } = setup();
    const stored = { card, question_number: 2, total_questions: 8 };
    grading.presentQuestion.mockResolvedValue(stored);

    const out = await call(
      tools,
      'present_question',
      { ...card, question_text: 'Reworded?' },
      'call-7'
    );

    expect(out).toBe(stored);
    expect(grading.presentQuestion).toHaveBeenCalledWith(
      {
        attemptId: 'attempt-1',
        fence: 'fence-1',
        toolCallId: 'call-7',
        inputMessageId: 'msg-1',
        runId: 'run_1',
      },
      expect.objectContaining({ question_text: 'Reworded?' })
    );
  });

  it("passes a grading refusal's message to the model", async () => {
    const { tools, grading } = setup();
    grading.presentQuestion.mockRejectedValue(
      new QuizGradingError(
        'out_of_order',
        'Question 3 cannot be presented yet: record question 2 first.'
      )
    );
    await expect(call(tools, 'present_question', card)).rejects.toThrow(
      'Question 3 cannot be presented yet: record question 2 first.'
    );
  });

  it('replaces any other error with fixed text and logs no message', async () => {
    const { tools, grading, log } = setup();
    grading.presentQuestion.mockRejectedValue(
      new Error('connection to db-host:5432 failed for user x')
    );
    const error = await call(tools, 'present_question', card).catch((e: Error) => e);
    expect((error as Error).message).toBe(retryText('present_question'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('db-host');
  });

  it('refuses without writing once the turn has stopped', async () => {
    const controller = new AbortController();
    controller.abort();
    const { tools, grading } = setup({ signal: controller.signal });
    await expect(call(tools, 'present_question', card)).rejects.toThrow(TURN_STOPPED_TEXT);
    expect(grading.presentQuestion).not.toHaveBeenCalled();
  });

  it('refuses the next question while the current one has no result, before any write', async () => {
    const { tools, grading, writes } = setup({ ctx: context({ progress: progressAt(1) }) });
    await expect(call(tools, 'present_question', card)).rejects.toThrow(recordBeforePresentText(1));
    expect(recordBeforePresentText(1)).toBe('Record question 1 before presenting the next one.');
    expect(grading.presentQuestion).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('presents the next question once the current one is recorded earlier in the step', async () => {
    const { tools, grading } = setup({
      ctx: context({ progress: progressAt(1), lastAction: 'next' }),
    });
    grading.finalizeQuestion.mockResolvedValue({
      question_num: 1,
      emoji: 'x',
      brief_feedback: 'y',
    });
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });
    const [recorded, presented] = await Promise.allSettled([
      call(tools, 'record_question_result', RECORD),
      call(tools, 'present_question', card),
    ]);
    expect(recorded.status).toBe('fulfilled');
    expect(presented).toMatchObject({ status: 'fulfilled', value: { question_number: 2 } });
  });

  it('keeps the next question refused after a refused record', async () => {
    const { tools, grading } = setup({
      ctx: context({ progress: progressAt(1), lastAction: 'next' }),
    });
    grading.finalizeQuestion.mockRejectedValue(
      new QuizGradingError('invalid_input', 'Invalid question result: answers.')
    );
    await expect(call(tools, 'record_question_result', RECORD)).rejects.toThrow('answers');
    await expect(call(tools, 'present_question', card)).rejects.toThrow(recordBeforePresentText(1));
    expect(grading.presentQuestion).not.toHaveBeenCalled();
  });

  it('presents question 1 with nothing to wait for', async () => {
    const { tools, grading } = setup({ ctx: context({ progress: progressAt(0) }) });
    const first = { ...card, question_number: 1 };
    grading.presentQuestion.mockResolvedValue({
      card: first,
      question_number: 1,
      total_questions: 8,
    });
    await expect(call(tools, 'present_question', first)).resolves.toMatchObject({
      question_number: 1,
    });
  });

  it('leaves showing the current question again to the service', async () => {
    const { tools, grading } = setup({ ctx: context({ progress: progressAt(2, [1]) }) });
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });
    await expect(call(tools, 'present_question', card)).resolves.toMatchObject({
      question_number: 2,
    });
    expect(grading.presentQuestion).toHaveBeenCalledTimes(1);
  });
});

describe('record_question_result', () => {
  it('returns the stored result and writes it as the divider part', async () => {
    const { tools, grading, writes } = setup();
    const stored: QuestionResultOutput = {
      question_num: 1,
      emoji: 'tada',
      brief_feedback: 'Got it with a hint!',
    };
    grading.finalizeQuestion.mockResolvedValue(stored);

    const out = await call(tools, 'record_question_result', RECORD);

    expect(out).toBe(stored);
    expect(grading.finalizeQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ fence: 'fence-1' }),
      RECORD
    );
    expect(writes).toEqual([
      { type: 'data-question-result', id: 'question-result-1', data: stored },
    ]);
  });

  it('gives a revision its own divider id', () => {
    expect(
      questionResultPartId({ question_num: 2, emoji: 'x', brief_feedback: 'y', revised: true })
    ).toBe('question-result-2-revised');
  });

  it('writes no divider when the service refuses', async () => {
    const { tools, grading, writes } = setup();
    grading.finalizeQuestion.mockRejectedValue(
      new QuizGradingError('revision_refused', 'Question 1 was already revised once.')
    );
    await expect(call(tools, 'record_question_result', RECORD)).rejects.toThrow(
      'already revised once'
    );
    expect(writes).toEqual([]);
  });

  it('runs before a present_question the model made after it in the same step', async () => {
    const { tools, grading } = setup();
    const order: string[] = [];
    grading.finalizeQuestion.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push('record');
      return { question_num: 1, emoji: 'x', brief_feedback: 'y' };
    });
    grading.presentQuestion.mockImplementation(async () => {
      order.push('present');
      return { card, question_number: 2, total_questions: 8 };
    });

    await Promise.all([
      call(tools, 'record_question_result', RECORD),
      call(tools, 'present_question', card),
    ]);
    expect(order).toEqual(['record', 'present']);
  });
  it('refuses a result for the question presented in the same turn, writing nothing', async () => {
    const { tools, grading, writes } = setup();
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });

    await call(tools, 'present_question', card);
    await expect(
      call(tools, 'record_question_result', { ...RECORD, question_num: 2, answers: [] })
    ).rejects.toThrow(RECORD_BEFORE_ANSWER_TEXT);
    expect(RECORD_BEFORE_ANSWER_TEXT).toBe(
      'The student has not answered this question yet. Wait for their answer.'
    );
    expect(grading.finalizeQuestion).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('refuses it when both calls come in one step, present_question first', async () => {
    const { tools, grading } = setup();
    grading.presentQuestion.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20));
      return { card, question_number: 2, total_questions: 8 };
    });
    const [presented, recorded] = await Promise.allSettled([
      call(tools, 'present_question', card),
      call(tools, 'record_question_result', { ...RECORD, question_num: 2, answers: [] }),
    ]);
    expect(presented.status).toBe('fulfilled');
    expect(recorded).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: RECORD_BEFORE_ANSWER_TEXT }),
    });
    expect(grading.finalizeQuestion).not.toHaveBeenCalled();
  });

  it('still records the earlier question after presenting the next one in the same turn', async () => {
    const { tools, grading } = setup();
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });
    const stored = { question_num: 1, emoji: 'x', brief_feedback: 'y' };
    grading.finalizeQuestion.mockResolvedValue(stored);

    await call(tools, 'present_question', card);
    await expect(call(tools, 'record_question_result', RECORD)).resolves.toBe(stored);
    expect(grading.finalizeQuestion).toHaveBeenCalledTimes(1);
  });

  it('records a question presented in an earlier turn', async () => {
    const first = setup();
    first.grading.presentQuestion.mockResolvedValue({
      card,
      question_number: 2,
      total_questions: 8,
    });
    await call(first.tools, 'present_question', card);
    const next = setup({ ctx: context({ lastAction: 'next' }) });
    const stored = { question_num: 2, emoji: 'x', brief_feedback: 'y' };
    next.grading.finalizeQuestion.mockResolvedValue(stored);
    await expect(
      call(next.tools, 'record_question_result', { ...RECORD, question_num: 2 })
    ).resolves.toBe(stored);
  });

  it("keeps a refused present_question from blocking that question's result", async () => {
    const { tools, grading } = setup({ ctx: context({ lastAction: 'next' }) });
    grading.presentQuestion.mockRejectedValue(
      new QuizGradingError('out_of_order', 'Question 2 cannot be presented yet.')
    );
    const stored = { question_num: 2, emoji: 'x', brief_feedback: 'y' };
    grading.finalizeQuestion.mockResolvedValue(stored);
    await expect(call(tools, 'present_question', card)).rejects.toThrow('cannot be presented');
    await expect(
      call(tools, 'record_question_result', { ...RECORD, question_num: 2 })
    ).resolves.toBe(stored);
  });

  describe('waits for the student to move on', () => {
    /** Question 2 is out and open; the turn opened with `lastAction`. */
    const onQuestion2 = (lastAction?: 'next' | 'try_again') =>
      context({ progress: progressAt(2, [1]), ...(lastAction ? { lastAction } : {}) });
    const Q2 = { ...RECORD, question_num: 2 };

    it('refuses a first result in a turn the student opened with an answer, writing nothing', async () => {
      for (const lastAction of [undefined, 'try_again'] as const) {
        const { tools, grading, writes } = setup({ ctx: onQuestion2(lastAction) });
        await expect(call(tools, 'record_question_result', Q2)).rejects.toThrow(
          RECORD_BEFORE_NEXT_TEXT
        );
        expect(grading.finalizeQuestion).not.toHaveBeenCalled();
        expect(writes).toEqual([]);
      }
      // A false flag is no request to move on either.
      const { tools, grading } = setup({ ctx: onQuestion2() });
      await expect(
        call(tools, 'record_question_result', { ...Q2, student_asked_to_move_on: false })
      ).rejects.toThrow(RECORD_BEFORE_NEXT_TEXT);
      expect(grading.finalizeQuestion).not.toHaveBeenCalled();
    });

    it('records it in a Next turn', async () => {
      const { tools, grading } = setup({ ctx: onQuestion2('next') });
      const stored = { question_num: 2, emoji: 'x', brief_feedback: 'y' };
      grading.finalizeQuestion.mockResolvedValue(stored);
      await expect(call(tools, 'record_question_result', Q2)).resolves.toBe(stored);
    });

    it('records it when the call says the student asked to move on, and keeps that flag to itself', async () => {
      const { tools, grading, writes } = setup({ ctx: onQuestion2() });
      const stored = { question_num: 2, emoji: 'x', brief_feedback: 'Moved on' };
      grading.finalizeQuestion.mockResolvedValue(stored);
      await expect(
        call(tools, 'record_question_result', {
          ...Q2,
          answers: [],
          student_asked_to_move_on: true,
        })
      ).resolves.toBe(stored);
      expect(grading.finalizeQuestion).toHaveBeenCalledWith(expect.anything(), {
        ...Q2,
        answers: [],
      });
      expect(writes).toHaveLength(1);
    });

    it('leaves a result already recorded (a revision) to the service', async () => {
      const { tools, grading } = setup({ ctx: onQuestion2() });
      grading.finalizeQuestion.mockResolvedValue({
        question_num: 1,
        emoji: 'x',
        brief_feedback: 'y',
        revised: true,
      });
      await expect(call(tools, 'record_question_result', RECORD)).resolves.toMatchObject({
        revised: true,
      });
    });
  });
});

describe('offer_next_step and submit_quiz_evaluation', () => {
  it('offer_next_step returns the choices and writes nothing', async () => {
    const { tools, grading, writes } = setup();
    await expect(
      call(tools, 'offer_next_step', { actions: ['try_again', 'next'] })
    ).resolves.toEqual({
      actions: ['try_again', 'next'],
      lead_in: 'Would you like to try again or move on?',
    });
    expect(writes).toEqual([]);
    expect(Object.values(grading).every(fn => fn.mock.calls.length === 0)).toBe(true);
  });

  it('carries the fixed lead-in for the buttons: next, results on the last question, or try again', async () => {
    const onSecond = setup({ ctx: context({ progress: progressAt(2, [1]) }) });
    await expect(call(onSecond.tools, 'offer_next_step', { actions: ['next'] })).resolves.toEqual({
      actions: ['next'],
      lead_in: 'Ready for the next question?',
    });
    const onLast = setup({ ctx: context({ progress: progressAt(8, [1, 2, 3, 4, 5, 6, 7]) }) });
    await expect(call(onLast.tools, 'offer_next_step', { actions: ['next'] })).resolves.toEqual({
      actions: ['next'],
      lead_in: 'Ready to see your results?',
    });
    const retryOnLast = setup({ ctx: context({ progress: progressAt(8, [1, 2, 3, 4, 5, 6, 7]) }) });
    await expect(
      call(retryOnLast.tools, 'offer_next_step', { actions: ['next', 'try_again'] })
    ).resolves.toEqual({
      actions: ['next', 'try_again'],
      lead_in: 'Would you like to try again or move on?',
    });
  });

  it('refuses Try again without Next, writing nothing', async () => {
    const { tools, grading, writes } = setup();
    await expect(call(tools, 'offer_next_step', { actions: ['try_again'] })).rejects.toThrow(
      OFFER_TRY_AGAIN_ALONE_TEXT
    );
    expect(writes).toEqual([]);
    expect(Object.values(grading).every(fn => fn.mock.calls.length === 0)).toBe(true);
    // The refusal leaves the offer open for a corrected call.
    await expect(
      call(tools, 'offer_next_step', { actions: ['try_again', 'next'] })
    ).resolves.toMatchObject({ actions: ['try_again', 'next'] });
  });

  it('refuses buttons in a turn the student opened with Try again: a hint ends with a question', async () => {
    const { tools, grading, writes } = setup({ ctx: context({ lastAction: 'try_again' }) });
    for (const actions of [['try_again', 'next'], ['next']]) {
      await expect(call(tools, 'offer_next_step', { actions })).rejects.toThrow(
        OFFER_AFTER_HINT_TEXT
      );
    }
    expect(OFFER_AFTER_HINT_TEXT).toBe(
      'The student clicked Try again, so this reply is a hint: give exactly one hint, end with a question such as "What do you think?", and wait for their answer. No buttons after a hint.'
    );
    expect(writes).toEqual([]);
    expect(Object.values(grading).every(fn => fn.mock.calls.length === 0)).toBe(true);
    // A Next turn offers as usual.
    const afterNext = setup({ ctx: context({ lastAction: 'next' }) });
    await expect(
      call(afterNext.tools, 'offer_next_step', { actions: ['next'] })
    ).resolves.toMatchObject({ actions: ['next'] });
  });

  it('refuses offer_next_step after a question card in the same turn, writing nothing', async () => {
    const { tools, grading, writes } = setup();
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });

    await call(tools, 'present_question', card);
    await expect(call(tools, 'offer_next_step', { actions: ['next'] })).rejects.toThrow(
      OFFER_AFTER_QUESTION_TEXT
    );
    expect(OFFER_AFTER_QUESTION_TEXT).toBe(
      "Wait for the student's answer to this question before offering next steps."
    );
    expect(writes).toEqual([]);
  });

  it('refuses it when both calls come in one step, present_question first', async () => {
    const { tools, grading } = setup();
    grading.presentQuestion.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20));
      return { card, question_number: 2, total_questions: 8 };
    });
    const [presented, offered] = await Promise.allSettled([
      call(tools, 'present_question', card),
      call(tools, 'offer_next_step', { actions: ['next'] }),
    ]);
    expect(presented.status).toBe('fulfilled');
    expect(offered).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: OFFER_AFTER_QUESTION_TEXT }),
    });
  });

  it('still offers after a present_question that was refused', async () => {
    const { tools, grading } = setup();
    grading.presentQuestion.mockRejectedValue(
      new QuizGradingError('out_of_order', 'Question 3 cannot be presented yet.')
    );
    await expect(call(tools, 'present_question', card)).rejects.toThrow('cannot be presented');
    await expect(call(tools, 'offer_next_step', { actions: ['next'] })).resolves.toEqual({
      actions: ['next'],
      lead_in: 'Ready for the next question?',
    });
  });

  it('refuses present_question after buttons in the same turn, before any write', async () => {
    const { tools, grading, writes } = setup();
    await call(tools, 'offer_next_step', { actions: ['try_again', 'next'] });
    await expect(call(tools, 'present_question', card)).rejects.toThrow(QUESTION_AFTER_OFFER_TEXT);
    expect(QUESTION_AFTER_OFFER_TEXT).toBe(
      "Wait for the student's choice before presenting the next question."
    );
    expect(grading.presentQuestion).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('refuses it when both calls come in one step, offer_next_step first', async () => {
    const { tools, grading } = setup();
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });
    const [offered, presented] = await Promise.allSettled([
      call(tools, 'offer_next_step', { actions: ['next'] }),
      call(tools, 'present_question', card),
    ]);
    expect(offered).toEqual({
      status: 'fulfilled',
      value: { actions: ['next'], lead_in: 'Ready for the next question?' },
    });
    expect(presented).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ message: QUESTION_AFTER_OFFER_TEXT }),
    });
    expect(grading.presentQuestion).not.toHaveBeenCalled();
  });

  it('still presents after an offer_next_step that was refused', async () => {
    const { tools, grading } = setup();
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });
    const stopped = new AbortController();
    stopped.abort();
    await expect(
      call(tools, 'offer_next_step', { actions: ['next'] }, 'call-offer', stopped.signal)
    ).rejects.toThrow(TURN_STOPPED_TEXT);
    await expect(call(tools, 'present_question', card)).resolves.toMatchObject({
      question_number: 2,
    });
  });

  it("presents again in the next turn's tool set", async () => {
    const first = setup();
    await call(first.tools, 'offer_next_step', { actions: ['next'] });
    const next = setup();
    next.grading.presentQuestion.mockResolvedValue({
      card,
      question_number: 2,
      total_questions: 8,
    });
    await expect(call(next.tools, 'present_question', card)).resolves.toMatchObject({
      question_number: 2,
    });
  });

  it('in a live turn, sends the buttons but never a question card after them, and stops', async () => {
    const { runQuizTurn } = await import('../../loop.ts');
    // eslint-disable-next-line import/no-unresolved -- package subpath export, resolved by vitest
    const { MockLanguageModelV4, convertArrayToReadableStream } = await import('ai/test');
    const grading = fakeGrading();
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: FEEDBACK },
            { type: 'text-end', id: 't' },
            {
              type: 'tool-call',
              toolCallId: 'b',
              toolName: 'offer_next_step',
              input: JSON.stringify({ actions: ['next'] }),
            },
            {
              type: 'tool-call',
              toolCallId: 'q',
              toolName: 'present_question',
              input: JSON.stringify(card),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          ]),
        }) as never,
    });
    const persisted: Array<{ parts: Array<Record<string, unknown>> }> = [];
    const stream = runQuizTurn({
      ctx: context(),
      messages: [{ role: 'user', content: 'my answer' }],
      signal: new AbortController().signal,
      model,
      deps: {
        tools: (ctx, d) => quizTools(ctx, { ...d, services: { grading } as never, log: vi.fn() }),
        getProgress: async () => ({
          questionCount: 8,
          presented: 1,
          finalized: [],
          completed: false,
          hasEvaluation: false,
        }),
        completeFromGrades: vi.fn(),
        persistAssistant: async (_id, message) => {
          persisted.push(message as never);
        },
        evaluationNotice: () => 'notice',
        log: vi.fn(),
      },
    });
    const chunks: Array<Record<string, unknown>> = [];
    for await (const c of stream as unknown as AsyncIterable<Record<string, unknown>>)
      chunks.push(c);

    // One model call: the successful offer_next_step ended the turn.
    expect(model.doStreamCalls).toHaveLength(1);
    expect(grading.presentQuestion).not.toHaveBeenCalled();
    const outputs = chunks.filter(c => c.type === 'tool-output-available');
    expect(outputs.map(c => c.toolCallId)).toEqual(['b']);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool-output-error', toolCallId: 'q' })
    );
    const saved = persisted.at(-1)?.parts ?? [];
    expect(saved.find(p => p.type === 'tool-present_question')).toMatchObject({
      state: 'output-error',
    });
    expect(
      saved.some(p => p.type === 'tool-offer_next_step' && p.state === 'output-available')
    ).toBe(true);
  });

  it('in a live turn, sends the question card but never buttons with it, and stops', async () => {
    const { runQuizTurn } = await import('../../loop.ts');
    // eslint-disable-next-line import/no-unresolved -- package subpath export, resolved by vitest
    const { MockLanguageModelV4, convertArrayToReadableStream } = await import('ai/test');
    const grading = fakeGrading();
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'q',
              toolName: 'present_question',
              input: JSON.stringify(card),
            },
            {
              type: 'tool-call',
              toolCallId: 'b',
              toolName: 'offer_next_step',
              input: JSON.stringify({ actions: ['next'] }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          ]),
        }) as never,
    });
    const persisted: Array<{ parts: Array<Record<string, unknown>> }> = [];
    const stream = runQuizTurn({
      ctx: context({
        progress: {
          questionCount: 8,
          presented: 1,
          finalized: [1],
          completed: false,
          hasEvaluation: false,
        },
      }),
      messages: [{ role: 'user', content: 'next' }],
      signal: new AbortController().signal,
      model,
      deps: {
        tools: (ctx, d) => quizTools(ctx, { ...d, services: { grading } as never, log: vi.fn() }),
        getProgress: async () => ({
          questionCount: 8,
          presented: 2,
          finalized: [1],
          completed: false,
          hasEvaluation: false,
        }),
        completeFromGrades: vi.fn(),
        persistAssistant: async (_id, message) => {
          persisted.push(message as never);
        },
        evaluationNotice: () => 'notice',
        log: vi.fn(),
      },
    });
    const chunks: Array<Record<string, unknown>> = [];
    for await (const c of stream as unknown as AsyncIterable<Record<string, unknown>>)
      chunks.push(c);

    // One model call: the successful present_question ended the turn.
    expect(model.doStreamCalls).toHaveLength(1);
    // The card's result reaches the browser; the buttons' call only as an error
    // (the chat renders buttons from a successful result only).
    const outputs = chunks.filter(c => c.type === 'tool-output-available');
    expect(outputs.map(c => c.toolCallId)).toEqual(['q']);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool-output-error', toolCallId: 'b' })
    );
    const saved = persisted.at(-1)?.parts ?? [];
    expect(saved.find(p => p.type === 'tool-offer_next_step')).toMatchObject({
      state: 'output-error',
    });
    expect(
      saved.some(p => p.type === 'tool-present_question' && p.state === 'output-available')
    ).toBe(true);
  });

  it("offers again in the next turn's tool set", async () => {
    const first = setup();
    first.grading.presentQuestion.mockResolvedValue({
      card,
      question_number: 2,
      total_questions: 8,
    });
    await call(first.tools, 'present_question', card);
    const next = setup();
    await expect(call(next.tools, 'offer_next_step', { actions: ['next'] })).resolves.toEqual({
      actions: ['next'],
      lead_in: 'Ready for the next question?',
    });
  });

  it('refuses offer_next_step before the feedback is written, then offers once it is', async () => {
    let written = 0;
    const { tools, grading, writes } = setup({ wordsWritten: () => written });
    await expect(
      call(tools, 'offer_next_step', { actions: ['try_again', 'next'] })
    ).rejects.toThrow(OFFER_BEFORE_FEEDBACK_TEXT);
    expect(OFFER_BEFORE_FEEDBACK_TEXT).toBe(
      "Write your feedback on the student's answer first: 2 to 4 sentences on what is right, what is wrong (if anything) and why it matters. Then call offer_next_step."
    );
    expect(writes).toEqual([]);
    expect(Object.values(grading).every(fn => fn.mock.calls.length === 0)).toBe(true);

    // The feedback reaches the minimum: the next call is taken on the count
    // (one refusal so far, so the refusal limit plays no part).
    written = MIN_FEEDBACK_WORDS;
    await expect(
      call(tools, 'offer_next_step', { actions: ['try_again', 'next'] })
    ).resolves.toEqual({
      actions: ['try_again', 'next'],
      lead_in: 'Would you like to try again or move on?',
    });
  });

  it('refuses a bare "Correct." (one word short of the minimum)', async () => {
    const { tools } = setup({ wordsWritten: () => MIN_FEEDBACK_WORDS - 1 });
    await expect(call(tools, 'offer_next_step', { actions: ['next'] })).rejects.toThrow(
      OFFER_BEFORE_FEEDBACK_TEXT
    );
  });

  it('takes offer_next_step after two refusals for feedback in one turn, whatever the count', async () => {
    expect(MAX_FEEDBACK_REFUSALS).toBe(2);
    const { tools, log } = setup({ wordsWritten: () => 0 });
    for (let i = 0; i < MAX_FEEDBACK_REFUSALS; i++) {
      await expect(call(tools, 'offer_next_step', { actions: ['next'] })).rejects.toThrow(
        OFFER_BEFORE_FEEDBACK_TEXT
      );
    }
    await expect(call(tools, 'offer_next_step', { actions: ['next'] })).resolves.toEqual({
      actions: ['next'],
      lead_in: 'Ready for the next question?',
    });
    expect(log).toHaveBeenCalledWith('[quiz-agent] offer_next_step taken after refusals', {
      attemptId: 'attempt-1',
      runId: 'run_1',
      refusals: MAX_FEEDBACK_REFUSALS,
    });

    // The next turn's set counts afresh.
    const next = setup({ wordsWritten: () => 0 });
    await expect(call(next.tools, 'offer_next_step', { actions: ['next'] })).rejects.toThrow(
      OFFER_BEFORE_FEEDBACK_TEXT
    );
  });

  it('keeps the other offer_next_step refusals after the feedback refusals run out', async () => {
    // A hint turn: no buttons at all, however often the model asks.
    const hint = setup({ ctx: context({ lastAction: 'try_again' }), wordsWritten: () => 0 });
    for (let i = 0; i < MAX_FEEDBACK_REFUSALS + 2; i++) {
      await expect(call(hint.tools, 'offer_next_step', { actions: ['next'] })).rejects.toThrow(
        OFFER_AFTER_HINT_TEXT
      );
    }

    // Try again alone, and buttons after a card in the same turn, stay refused.
    const { tools, grading } = setup({
      ctx: context({ progress: progressAt(1, [1]) }),
      wordsWritten: () => 0,
    });
    for (let i = 0; i < MAX_FEEDBACK_REFUSALS; i++) {
      await expect(call(tools, 'offer_next_step', { actions: ['next'] })).rejects.toThrow(
        OFFER_BEFORE_FEEDBACK_TEXT
      );
    }
    await expect(call(tools, 'offer_next_step', { actions: ['try_again'] })).rejects.toThrow(
      OFFER_TRY_AGAIN_ALONE_TEXT
    );
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });
    await call(tools, 'present_question', card);
    await expect(call(tools, 'offer_next_step', { actions: ['next'] })).rejects.toThrow(
      OFFER_AFTER_QUESTION_TEXT
    );
  });

  it('keeps present_question open after an offer_next_step refused for missing feedback', async () => {
    const { tools, grading } = setup({ wordsWritten: () => 0 });
    grading.presentQuestion.mockResolvedValue({ card, question_number: 2, total_questions: 8 });
    await expect(call(tools, 'offer_next_step', { actions: ['next'] })).rejects.toThrow(
      OFFER_BEFORE_FEEDBACK_TEXT
    );
    await expect(call(tools, 'present_question', card)).resolves.toMatchObject({
      question_number: 2,
    });
  });

  describe('in a live turn', () => {
    type Chunk = Record<string, unknown>;
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const offer = (id: string): Chunk => ({
      type: 'tool-call',
      toolCallId: id,
      toolName: 'offer_next_step',
      input: JSON.stringify({ actions: ['try_again', 'next'] }),
    });
    const feedback = (id: string, delta: string): Chunk[] => [
      { type: 'text-start', id },
      { type: 'text-delta', id, delta },
      { type: 'text-end', id },
    ];

    /** Runs one answer turn on scripted model steps; returns the calls, the chunks and the saved parts. */
    async function answerTurn(steps: Chunk[][], ctx: AttemptContext = context()) {
      const { runQuizTurn } = await import('../../loop.ts');
      // eslint-disable-next-line import/no-unresolved -- package subpath export, resolved by vitest
      const { MockLanguageModelV4, convertArrayToReadableStream } = await import('ai/test');
      let n = 0;
      const model = new MockLanguageModelV4({
        doStream: async () => {
          const parts = steps[Math.min(n, steps.length - 1)];
          n += 1;
          return {
            stream: convertArrayToReadableStream([
              { type: 'stream-start', warnings: [] },
              ...parts,
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
            ]),
          } as never;
        },
      });
      const persisted: Array<{ parts: Chunk[] }> = [];
      const progress = {
        questionCount: 8,
        presented: 1,
        finalized: [],
        completed: false,
        hasEvaluation: false,
      };
      const stream = runQuizTurn({
        ctx,
        messages: [{ role: 'user', content: 'my answer' }],
        signal: new AbortController().signal,
        model,
        deps: {
          tools: (c, d) =>
            quizTools(c, { ...d, services: { grading: fakeGrading() } as never, log: vi.fn() }),
          getProgress: async () => progress,
          completeFromGrades: vi.fn(),
          persistAssistant: async (_id, message) => {
            persisted.push(message as never);
          },
          evaluationNotice: () => 'notice',
          log: vi.fn(),
        },
      });
      const chunks: Chunk[] = [];
      for await (const c of stream as unknown as AsyncIterable<Chunk>) chunks.push(c);
      return { model, chunks, saved: persisted.at(-1)?.parts ?? [] };
    }

    it('refuses buttons sent before any feedback, keeps the turn going, then takes them after the feedback', async () => {
      const { model, chunks, saved } = await answerTurn([
        [offer('b1')],
        [...feedback('t', CLOSE), offer('b2')],
        [...feedback('t2', 'should not be requested')],
      ]);

      // The refused call did not end the turn; the accepted one did.
      expect(model.doStreamCalls).toHaveLength(2);
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: 'tool-output-error', toolCallId: 'b1' })
      );
      expect(chunks.filter(c => c.type === 'tool-output-available').map(c => c.toolCallId)).toEqual(
        ['b2']
      );
      // The model's next call read the refusal.
      expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
        JSON.stringify(OFFER_BEFORE_FEEDBACK_TEXT).slice(1, -1)
      );
      expect(saved.find(p => p.toolCallId === 'b1')).toMatchObject({ state: 'output-error' });
      // The saved reply carries the feedback text and the buttons.
      expect(saved).toContainEqual(
        expect.objectContaining({
          type: 'text',
          text: CLOSE,
        })
      );
      expect(saved.find(p => p.toolCallId === 'b2')).toMatchObject({
        type: 'tool-offer_next_step',
        state: 'output-available',
      });
      expect(saved.some(p => p.type === 'text' && p.text === 'should not be requested')).toBe(
        false
      );
    });

    it('refuses a result recorded on an answer, then takes the feedback and the buttons', async () => {
      const record: Chunk = {
        type: 'tool-call',
        toolCallId: 'r',
        toolName: 'record_question_result',
        input: JSON.stringify({
          question_num: 1,
          answers: [{ level: 'correct', hints_before: 0 }],
          brief_feedback: 'Nailed it!',
        }),
      };
      const { model, chunks, saved } = await answerTurn(
        [[record], [...feedback('t', FEEDBACK), offer('b')]],
        context({ progress: progressAt(1) })
      );
      expect(model.doStreamCalls).toHaveLength(2);
      // The call is hidden from the browser; the saved reply keeps it as refused.
      expect(saved.find(p => p.toolCallId === 'r')).toMatchObject({ state: 'output-error' });
      expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
        JSON.stringify(RECORD_BEFORE_NEXT_TEXT).slice(1, -1)
      );
      // No result row before the Next click: only the feedback and the buttons.
      expect(chunks.some(c => c.type === 'data-question-result')).toBe(false);
      expect(saved.some(p => p.type === 'data-question-result')).toBe(false);
      expect(chunks.filter(c => c.type === 'tool-output-available').map(c => c.toolCallId)).toEqual(
        ['b']
      );
    });

    it('refuses buttons after feedback too short to say what is right and why', async () => {
      const { model, chunks } = await answerTurn([
        [...feedback('t', 'Correct.'), offer('b1')],
        [...feedback('t2', FEEDBACK), offer('b2')],
      ]);
      expect(model.doStreamCalls).toHaveLength(2);
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: 'tool-output-error', toolCallId: 'b1' })
      );
      expect(chunks.filter(c => c.type === 'tool-output-available').map(c => c.toolCallId)).toEqual(
        ['b2']
      );
    });

    it('takes buttons that follow feedback in the same step', async () => {
      const { model, chunks } = await answerTurn([[...feedback('t', FEEDBACK), offer('b')]]);
      expect(model.doStreamCalls).toHaveLength(1);
      expect(chunks.filter(c => c.type === 'tool-output-available').map(c => c.toolCallId)).toEqual(
        ['b']
      );
    });

    it("does not count the opening turn's welcome as feedback", async () => {
      const opening = context({
        inputMessageId: null,
        welcome: 'Welcome to your quiz!',
        progress: {
          questionCount: 8,
          presented: 0,
          finalized: [],
          completed: false,
          hasEvaluation: false,
        },
      });
      const { model, chunks } = await answerTurn(
        [[offer('b1')], [...feedback('t', FEEDBACK), offer('b2')]],
        opening
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: 'text-delta', delta: 'Welcome to your quiz!' })
      );
      expect(model.doStreamCalls).toHaveLength(2);
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: 'tool-output-error', toolCallId: 'b1' })
      );
    });

    it('does not count whitespace as feedback', async () => {
      const { model, chunks } = await answerTurn([
        [...feedback('t', '  \n '), offer('b1')],
        [...feedback('t2', FEEDBACK), offer('b2')],
      ]);
      expect(model.doStreamCalls).toHaveLength(2);
      expect(chunks).toContainEqual(
        expect.objectContaining({ type: 'tool-output-error', toolCallId: 'b1' })
      );
    });
  });

  it('submit_quiz_evaluation completes as the model source and returns the stored record', async () => {
    const { tools, grading } = setup();
    const record = {
      v: 2,
      source: 'model',
      partial_credit_percentage: 80,
      first_attempt_percentage: 50,
      question_results: [],
    };
    grading.completeWithEvaluation.mockResolvedValue(record);
    const feedback = {
      final_acknowledgment: 'Nice work.',
      quiz_complete: true,
      evaluation: 'GOOD',
      numeric_score: 3,
      feedback_summary: 'Solid.',
      feedback_strengths: ['a'],
      feedback_improvements: ['b'],
      feedback_recommendation: 'c',
      feedback_effort_note: 'd',
    };

    await expect(call(tools, 'submit_quiz_evaluation', feedback, 'call-eval')).resolves.toBe(
      record
    );
    expect(grading.completeWithEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'call-eval', fence: 'fence-1' }),
      { source: 'model', feedback }
    );
  });

  it("passes an incomplete-results refusal through, naming what's missing", async () => {
    const { tools, grading } = setup();
    grading.completeWithEvaluation.mockRejectedValue(
      new QuizGradingError(
        'incomplete',
        'Record results for questions 3, 8 with record_question_result before submitting the evaluation.'
      )
    );
    await expect(call(tools, 'submit_quiz_evaluation', {})).rejects.toThrow('questions 3, 8');
  });
});

describe('explore_codebase (fake pipeline)', () => {
  function exploreSetup(
    explore: (i: Record<string, unknown>) => Promise<unknown>,
    extra: Setup = {}
  ) {
    const mintRepoToken = vi.fn(async () => 'repo-token');
    const anthropic = vi.fn(() => ({}) as Anthropic);
    const s = setup({
      ctx: codeAware(),
      ...extra,
      services: { explore: vi.fn(explore), mintRepoToken, anthropic },
    });
    return { ...s, mintRepoToken, anthropic };
  }

  const result = (paths: string[]) => ({
    format: 'excerpts-v1',
    excerptText: '=== a.css lines 1–2 ===\n1| a {\n2| }',
    excerpts: paths.map(path => ({
      path,
      startLine: 1,
      endLine: 2,
      wholeFile: false,
      why: 'rule',
    })),
    overview: null,
    findings: '{}',
    filesRead: paths,
    focusArea: FOCUS,
    fileCount: 3,
  });

  it('reads with the attempt key and a token for this repository, and journals the history', async () => {
    const { tools, grading, mintRepoToken, anthropic } = exploreSetup(async () =>
      result(['a.css'])
    );
    grading.listExplorations.mockResolvedValue({
      filesRead: ['index.html'],
      excerpts: ['index.html: lines 1–9: nav'],
    });

    const out = await call(
      tools,
      'explore_codebase',
      { focus_area: FOCUS, depth: 'focused' },
      'call-x'
    );

    expect(mintRepoToken).toHaveBeenCalledWith(
      expect.objectContaining({ login: 'sample-org' }),
      'landing-page'
    );
    expect(anthropic).toHaveBeenCalledWith('key-for-this-attempt');
    expect(out).toEqual({ excerpts: expect.stringContaining('1| a {'), files_read: ['a.css'] });
    expect(grading.recordExploration).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'call-x', fence: 'fence-1' }),
      { filesRead: ['a.css'], excerpts: 'a.css: lines 1–2: rule' }
    );
  });

  it('hands earlier explorations to the pipeline as context', async () => {
    let seen: Record<string, unknown> = {};
    const { tools, grading, log } = exploreSetup(async i => {
      seen = i;
      return result(['a.css']);
    });
    grading.listExplorations.mockResolvedValue({
      filesRead: ['index.html', 'css/style.css'],
      excerpts: ['index.html: lines 1–9: nav\ncss/style.css: whole file: layout'],
    });

    await call(tools, 'explore_codebase', { focus_area: FOCUS });
    expect(seen.callLog).toEqual({
      log,
      attemptId: 'attempt-1',
      runId: 'run_1',
      keySource: 'platform',
    });
    expect(seen.previouslyReadFiles).toEqual(['index.html', 'css/style.css']);
    expect(seen.previousFindings).toEqual([
      'index.html: lines 1–9: nav',
      'css/style.css: whole file: layout',
    ]);
    expect(seen.depth).toBe('focused');
  });

  it('refuses prepare_next while a question is open in a typed-answer turn, reading nothing', async () => {
    const { tools, grading, mintRepoToken } = exploreSetup(async () => result(['a.css']), {
      ctx: codeAware({ progress: progressAt(2, [1]) }),
    });
    await expect(
      call(tools, 'explore_codebase', { purpose: 'prepare_next', focus_area: FOCUS })
    ).rejects.toThrow(EXPLORATION_QUESTION_OPEN_TEXT);
    expect(EXPLORATION_QUESTION_OPEN_TEXT).toBe(
      'Finish the current question first: give your feedback and record the result, then explore for the next question.'
    );
    expect(mintRepoToken).not.toHaveBeenCalled();
    expect(grading.listExplorations).not.toHaveBeenCalled();
    expect(grading.recordExploration).not.toHaveBeenCalled();
  });

  it('refuses prepare_next while a question is open in a Next turn', async () => {
    const { tools, mintRepoToken } = exploreSetup(async () => result(['a.css']), {
      ctx: codeAware({ progress: progressAt(2, [1]), lastAction: 'next' }),
    });
    await expect(
      call(tools, 'explore_codebase', { purpose: 'prepare_next', focus_area: FOCUS })
    ).rejects.toThrow(EXPLORATION_QUESTION_OPEN_TEXT);
    expect(mintRepoToken).not.toHaveBeenCalled();
  });

  it('allows check_current while a question is open', async () => {
    const { tools, mintRepoToken } = exploreSetup(async () => result(['a.css']), {
      ctx: codeAware({ progress: progressAt(2, [1]) }),
    });
    await expect(
      call(tools, 'explore_codebase', { purpose: 'check_current', focus_area: 'a.css' })
    ).resolves.toMatchObject({ files_read: ['a.css'] });
    expect(mintRepoToken).toHaveBeenCalledTimes(1);
  });

  it('allows the opening prepare_next before the first question', async () => {
    const { tools } = exploreSetup(async () => result(['a.css']), {
      ctx: codeAware({ progress: progressAt(0) }),
    });
    await expect(
      call(tools, 'explore_codebase', { purpose: 'prepare_next', focus_area: 'initial' })
    ).resolves.toMatchObject({ files_read: ['a.css'] });
  });

  it('runs record, prepare_next and present from one step in that order', async () => {
    const order: string[] = [];
    const { tools, grading } = exploreSetup(
      async () => {
        order.push('explore');
        return result(['a.css']);
      },
      { ctx: codeAware({ progress: progressAt(2, [1]), lastAction: 'next' }) }
    );
    grading.finalizeQuestion.mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push('record');
      return { question_num: 2, emoji: 'x', brief_feedback: 'y' };
    });
    const third = { ...card, question_number: 3 };
    grading.presentQuestion.mockImplementation(async () => {
      order.push('present');
      return { card: third, question_number: 3, total_questions: 8 };
    });

    const settled = await Promise.allSettled([
      call(tools, 'record_question_result', { ...RECORD, question_num: 2 }),
      call(tools, 'explore_codebase', { purpose: 'prepare_next', focus_area: FOCUS }),
      call(tools, 'present_question', third),
    ]);
    expect(settled.map(r => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
    expect(order).toEqual(['record', 'explore', 'present']);
  });

  it('counts both purposes toward the limit, but not a refused call', async () => {
    const { tools, grading } = exploreSetup(async () => result(['a.css']), {
      ctx: codeAware({ progress: progressAt(2, [1]), lastAction: 'next' }),
    });
    grading.finalizeQuestion.mockResolvedValue({
      question_num: 2,
      emoji: 'x',
      brief_feedback: 'y',
    });
    const explore = (purpose: string, id: string) =>
      call(tools, 'explore_codebase', { purpose, focus_area: id }, id);

    await expect(explore('prepare_next', 'e1')).rejects.toThrow(EXPLORATION_QUESTION_OPEN_TEXT);
    await expect(explore('prepare_next', 'e2')).rejects.toThrow(EXPLORATION_QUESTION_OPEN_TEXT);
    await expect(explore('check_current', 'e3')).resolves.toBeTruthy();
    await call(tools, 'record_question_result', { ...RECORD, question_num: 2 });
    for (let i = 1; i < MAX_EXPLORATIONS_PER_TURN; i++) {
      await expect(explore('prepare_next', `n${i}`)).resolves.toBeTruthy();
    }
    await expect(explore('prepare_next', 'last')).rejects.toThrow(EXPLORATION_LIMIT_TEXT);
  });

  it('in a live Next turn, refuses prepare_next first, then records, explores and presents in order', async () => {
    const { runQuizTurn } = await import('../../loop.ts');
    // eslint-disable-next-line import/no-unresolved -- package subpath export, resolved by vitest
    const { MockLanguageModelV4, convertArrayToReadableStream } = await import('ai/test');
    const order: string[] = [];
    const grading = fakeGrading();
    grading.finalizeQuestion.mockImplementation(async () => {
      order.push('record');
      return { question_num: 3, emoji: 'x', brief_feedback: 'y' };
    });
    const fourth = { ...card, question_number: 4 };
    grading.presentQuestion.mockImplementation(async () => {
      order.push('present');
      return { card: fourth, question_number: 4, total_questions: 8 };
    });
    const explore = vi.fn(async () => {
      order.push('explore');
      return result(['a.css']);
    });
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const toolCall = (toolCallId: string, toolName: string, input: unknown) => ({
      type: 'tool-call',
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    });
    const steps = [
      toolCall('x1', 'explore_codebase', { purpose: 'prepare_next', focus_area: FOCUS }),
      toolCall('r1', 'record_question_result', {
        question_num: 3,
        answers: [{ level: 'correct', hints_before: 0 }],
        brief_feedback: 'Nailed it!',
      }),
      toolCall('x2', 'explore_codebase', { purpose: 'prepare_next', focus_area: FOCUS }),
      toolCall('p1', 'present_question', fourth),
    ];
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            steps[Math.min(n++, steps.length - 1)],
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          ]),
        }) as never,
    });
    const stream = runQuizTurn({
      ctx: codeAware({ progress: progressAt(3, [1, 2]), lastAction: 'next' }),
      messages: [{ role: 'user', content: 'next' }],
      signal: new AbortController().signal,
      model,
      // Unprojected, so the hidden tools' results can be checked too.
      project: false,
      deps: {
        tools: (ctx, d) =>
          quizTools(ctx, {
            ...d,
            services: {
              grading,
              mintRepoToken: async () => 'repo-token',
              anthropic: () => ({}) as Anthropic,
              explore,
            } as never,
            log: vi.fn(),
          }),
        getProgress: async () => progressAt(4, [1, 2, 3]),
        completeFromGrades: vi.fn(),
        persistAssistant: async () => {},
        evaluationNotice: () => 'notice',
        log: vi.fn(),
      },
    });
    const chunks: Array<Record<string, unknown>> = [];
    for await (const c of stream as unknown as AsyncIterable<Record<string, unknown>>)
      chunks.push(c);

    // Four steps: the refused exploration, the record, the exploration, the card (which ends the turn).
    expect(model.doStreamCalls).toHaveLength(4);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(EXPLORATION_QUESTION_OPEN_TEXT);
    expect(order).toEqual(['record', 'explore', 'present']);
    expect(explore).toHaveBeenCalledTimes(1);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool-output-error', toolCallId: 'x1' })
    );
    const outputs = chunks.filter(c => c.type === 'tool-output-available').map(c => c.toolCallId);
    expect(outputs).toEqual(['r1', 'x2', 'p1']);
  });

  it('refuses a second exploration while one is running', async () => {
    const releases: Array<() => void> = [];
    const { tools } = exploreSetup(
      () => new Promise(r => releases.push(() => r(result(['a.css']))))
    );
    const first = call(tools, 'explore_codebase', { focus_area: FOCUS }, 'call-1');
    await expect(
      call(tools, 'explore_codebase', { focus_area: 'other' }, 'call-2')
    ).rejects.toThrow(EXPLORATION_BUSY_TEXT);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]();
    await expect(first).resolves.toBeTruthy();
    // Free again once the first one has finished.
    const third = call(tools, 'explore_codebase', { focus_area: 'other' }, 'call-3');
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]();
    await expect(third).resolves.toBeTruthy();
  });

  it('refuses a fourth exploration in one turn, failed ones included', async () => {
    let n = 0;
    const { tools, mintRepoToken } = exploreSetup(async () => {
      n += 1;
      if (n === 2) throw new Error('GitHub tree API (sample-org/landing-page) failed (502): x');
      return result(['a.css']);
    });
    expect(MAX_EXPLORATIONS_PER_TURN).toBe(3);
    await expect(call(tools, 'explore_codebase', { focus_area: 'a' }, 'e1')).resolves.toBeTruthy();
    await expect(call(tools, 'explore_codebase', { focus_area: 'b' }, 'e2')).rejects.toThrow(
      EXPLORATION_FAILED_TEXT
    );
    await expect(call(tools, 'explore_codebase', { focus_area: 'c' }, 'e3')).resolves.toBeTruthy();
    await expect(call(tools, 'explore_codebase', { focus_area: 'd' }, 'e4')).rejects.toThrow(
      EXPLORATION_LIMIT_TEXT
    );
    expect(EXPLORATION_LIMIT_TEXT).toBe(
      'You have explored enough this turn. Continue with what you have.'
    );
    expect(n).toBe(3);
    expect(mintRepoToken).toHaveBeenCalledTimes(3);
  });

  it('counts an exploration whose token could not be minted', async () => {
    const explore = vi.fn(async () => result(['a.css']));
    const { tools, mintRepoToken } = exploreSetup(explore);
    mintRepoToken.mockRejectedValue(
      new Error('Failed to retrieve GitHub installation token (422)')
    );
    for (const id of ['e1', 'e2', 'e3']) {
      await expect(call(tools, 'explore_codebase', { focus_area: FOCUS }, id)).rejects.toThrow(
        EXPLORATION_FAILED_TEXT
      );
    }
    await expect(call(tools, 'explore_codebase', { focus_area: FOCUS }, 'e4')).rejects.toThrow(
      EXPLORATION_LIMIT_TEXT
    );
    expect(mintRepoToken).toHaveBeenCalledTimes(3);
  });

  it('does not count a call refused while another exploration was running', async () => {
    const releases: Array<() => void> = [];
    const { tools } = exploreSetup(
      () => new Promise(r => releases.push(() => r(result(['a.css']))))
    );
    const first = call(tools, 'explore_codebase', { focus_area: 'a' }, 'e1');
    await expect(call(tools, 'explore_codebase', { focus_area: 'b' }, 'e2')).rejects.toThrow(
      EXPLORATION_BUSY_TEXT
    );
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases[0]();
    await first;
    for (const [i, id] of ['e3', 'e4'].entries()) {
      const pending = call(tools, 'explore_codebase', { focus_area: id }, id);
      await vi.waitFor(() => expect(releases).toHaveLength(i + 2));
      releases[i + 1]();
      await expect(pending).resolves.toBeTruthy();
    }
    await expect(call(tools, 'explore_codebase', { focus_area: 'e5' }, 'e5')).rejects.toThrow(
      EXPLORATION_LIMIT_TEXT
    );
  });

  it("explores again in the next turn's tool set", async () => {
    const first = exploreSetup(async () => result(['a.css']));
    for (const id of ['e1', 'e2', 'e3'])
      await call(first.tools, 'explore_codebase', { focus_area: id }, id);
    await expect(call(first.tools, 'explore_codebase', { focus_area: 'x' })).rejects.toThrow(
      EXPLORATION_LIMIT_TEXT
    );
    const next = exploreSetup(async () => result(['a.css']));
    await expect(call(next.tools, 'explore_codebase', { focus_area: 'x' })).resolves.toBeTruthy();
  });

  it('tells the model only the fixed line when a read fails, and logs the status privately', async () => {
    const { tools, grading, log } = exploreSetup(async () => {
      throw new Error(
        'GitHub tree API (sample-org/landing-page) failed (401): Bad credentials ghs_secretvalue'
      );
    });
    const error = (await call(tools, 'explore_codebase', { focus_area: FOCUS }).catch(
      (e: unknown) => e
    )) as Error;
    expect(error.message).toBe(EXPLORATION_FAILED_TEXT);
    expect(grading.recordExploration).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[quiz-agent] explore_codebase failed',
      expect.objectContaining({ status: 401, chatId: 'attempt-1', runId: 'run_1' })
    );
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toMatch(/ghs_secretvalue|Bad credentials|sample-org|landing-page/);
    expect(logged).not.toContain(FOCUS);
  });

  it('in a live turn, the model reads only the fixed line after a failed exploration', async () => {
    const { runQuizTurn } = await import('../../loop.ts');
    // eslint-disable-next-line import/no-unresolved -- package subpath export, resolved by vitest
    const { MockLanguageModelV4, convertArrayToReadableStream } = await import('ai/test');
    const grading = fakeGrading();
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const steps = [
      {
        type: 'tool-call',
        toolCallId: 'e1',
        toolName: 'explore_codebase',
        input: JSON.stringify({ purpose: 'prepare_next', focus_area: 'initial' }),
      },
      { type: 'text-start', id: 't' },
      { type: 'text-end', id: 't' },
    ];
    let n = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const first = n++ === 0;
        return {
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            ...(first ? steps.slice(0, 1) : steps.slice(1)),
            {
              type: 'finish',
              finishReason: { unified: first ? 'tool-calls' : 'stop', raw: 'x' },
              usage,
            },
          ]),
        } as never;
      },
    });
    const stream = runQuizTurn({
      ctx: codeAware({
        progress: {
          questionCount: 8,
          presented: 0,
          finalized: [],
          completed: false,
          hasEvaluation: false,
        },
      }),
      messages: [{ role: 'user', content: 'start' }],
      signal: new AbortController().signal,
      model,
      deps: {
        tools: (ctx, d) =>
          quizTools(ctx, {
            ...d,
            services: {
              grading,
              mintRepoToken: async () => {
                throw new Error('Failed to retrieve GitHub installation token (422)');
              },
              anthropic: () => ({}) as Anthropic,
              explore: vi.fn(),
            } as never,
            log: vi.fn(),
          }),
        getProgress: async () => ({
          questionCount: 8,
          presented: 0,
          finalized: [],
          completed: false,
          hasEvaluation: false,
        }),
        completeFromGrades: vi.fn(),
        persistAssistant: async () => {},
        evaluationNotice: () => 'notice',
        log: vi.fn(),
      },
    });
    for await (const _ of stream as unknown as AsyncIterable<unknown>) void _;

    expect(model.doStreamCalls).toHaveLength(2);
    const toolMessages = model.doStreamCalls[1].prompt.filter(m => m.role === 'tool');
    expect(JSON.stringify(toolMessages)).toContain(
      JSON.stringify(EXPLORATION_FAILED_TEXT).slice(1, -1)
    );
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).not.toMatch(/422|installation token/);
  });

  it('tells the model only the fixed line when no token can be minted', async () => {
    const explore = vi.fn();
    const { tools, grading, log, mintRepoToken } = exploreSetup(explore);
    mintRepoToken.mockRejectedValue(
      new Error('Failed to retrieve GitHub installation token (422)')
    );
    const error = (await call(tools, 'explore_codebase', { focus_area: FOCUS }).catch(
      (e: unknown) => e
    )) as Error;
    expect(error.message).toBe(EXPLORATION_FAILED_TEXT);
    expect(error.message).not.toMatch(/422|GitHub|token/i);
    expect(explore).not.toHaveBeenCalled();
    expect(grading.recordExploration).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      '[quiz-agent] explore_token failed',
      expect.objectContaining({ status: 422, errorClass: 'Error', chatId: 'attempt-1' })
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('installation token');
  });

  it('keeps nothing from an exploration whose turn stopped', async () => {
    const controller = new AbortController();
    const { tools, grading } = exploreSetup(
      async () => {
        controller.abort();
        return result(['a.css']);
      },
      { signal: controller.signal }
    );
    await expect(call(tools, 'explore_codebase', { focus_area: FOCUS })).rejects.toThrow(
      EXPLORATION_STOPPED_TEXT
    );
    expect(grading.recordExploration).not.toHaveBeenCalled();
  });

  it('still returns the excerpts when only the journal write fails', async () => {
    const { tools, grading } = exploreSetup(async () => result(['a.css']));
    grading.recordExploration.mockRejectedValue(new Error('db down'));
    await expect(call(tools, 'explore_codebase', { focus_area: FOCUS })).resolves.toMatchObject({
      files_read: ['a.css'],
    });
  });

  it('stops when the journal says the turn was superseded', async () => {
    const { tools, grading } = exploreSetup(async () => result(['a.css']));
    grading.recordExploration.mockRejectedValue(
      new QuizGradingError('stale_turn', 'This turn was superseded. Stop.')
    );
    await expect(call(tools, 'explore_codebase', { focus_area: FOCUS })).rejects.toThrow(
      'superseded'
    );
  });
});

describe('explore_codebase (real pipeline on a fixture repository)', () => {
  it('streams one read_file step per file, path only, and never the focus area', async () => {
    vi.stubGlobal('fetch', githubStub('landing-page').fetchImpl);
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(['index.html', 'css/style.css']) }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              excerpts: [{ path: 'css/style.css', start_line: 1, end_line: 5, why: 'hero layout' }],
            }),
          },
        ],
      });
    const { tools, writes, grading } = setup({
      ctx: codeAware(),
      services: {
        mintRepoToken: async () => 'repo-token',
        anthropic: () => ({ messages: { create } }) as unknown as Anthropic,
      },
    });

    const out = (await call(tools, 'explore_codebase', {
      focus_area: FOCUS,
      specific_question: 'why flex?',
    })) as { excerpts: string; files_read: string[] };

    expect(writes).toEqual([
      { type: 'data-step', data: { kind: 'read_file', path: 'index.html' } },
      { type: 'data-step', data: { kind: 'read_file', path: 'css/style.css' } },
    ]);
    expect(JSON.stringify(writes)).not.toContain(FOCUS);
    expect(JSON.stringify(writes)).not.toContain('why flex?');
    expect(out.files_read).toEqual(['css/style.css']);
    expect(out.excerpts).toContain('2|   display: flex;');
    expect(grading.recordExploration).toHaveBeenCalledWith(expect.anything(), {
      filesRead: ['css/style.css'],
      excerpts: 'css/style.css: lines 1–5: hero layout',
    });
  });
});

describe('present_question with code_quote', () => {
  /** The fixture's css/style.css, lines 11-15. */
  const FEATURES = [
    '.features {',
    '  display: grid;',
    '  grid-template-columns: repeat(2, 1fr);',
    '  gap: 1rem;',
    '}',
  ];
  const quoted = {
    preamble: 'Let me ask about your features grid.',
    question_number: 2,
    total_questions: 8,
    question_text: 'Why two columns?',
    code_quote: { path: 'css/style.css', ranges: [[11, 15]], anchor: '.features {' },
  };
  const contentsRequests = (requested: string[]) =>
    requested.filter(url => url.includes('/contents/')).length;

  /** Grading that stores the card it is given, as the service does. */
  function echoGrading() {
    const grading = fakeGrading();
    grading.presentQuestion.mockImplementation(
      async (_f: unknown, q: { question_number: number }) => ({
        card: q,
        question_number: q.question_number,
        total_questions: 8,
      })
    );
    return grading;
  }

  /** A code-aware set reading the fixture repository through its own cache. */
  function quoteSetup(o: Setup = {}) {
    const stub = githubStub('landing-page');
    vi.stubGlobal('fetch', stub.fetchImpl);
    const quoteCache = new QuoteFileCache();
    const mintRepoToken = vi.fn(async () => 'repo-token');
    const grading = echoGrading();
    const { writer } = recordingWriter();
    const log = vi.fn();
    const tools = quizTools(o.ctx ?? codeAware(), {
      writer: writer as never,
      queue: createToolQueue(),
      signal: o.signal ?? new AbortController().signal,
      services: {
        grading,
        mintRepoToken,
        quoteCache,
        editedQuestions: async () => [],
        ...(o.services ?? {}),
      } as never,
      log,
      wordsWritten: () => 40,
    });
    return { tools, grading, log, stub, quoteCache, mintRepoToken };
  }

  it('takes code_quote only in a code-aware attempt', async () => {
    const { CodeAwareQuizQuestionSchema, QuizQuestionSchema } =
      await import('@classmoji/utils/quiz-agent');
    expect(setup({ ctx: codeAware() }).tools.present_question.inputSchema).toBe(
      CodeAwareQuizQuestionSchema
    );
    expect(setup().tools.present_question.inputSchema).toBe(QuizQuestionSchema);
  });

  it('fills the card with the exact lines and their source, and never stores the quote', async () => {
    const { tools, grading, mintRepoToken, log } = quoteSetup();
    const out = (await call(tools, 'present_question', quoted)) as {
      card: Record<string, unknown>;
    };

    const stored = grading.presentQuestion.mock.calls[0][1] as Record<string, unknown>;
    expect(stored).not.toHaveProperty('code_quote');
    expect(stored).toMatchObject({
      code_snippet: FEATURES.join('\n'),
      code_language: 'css',
      source: { path: 'css/style.css', lines: '11-15', changed: false },
      question_text: 'Why two columns?',
    });
    expect(out.card.code_snippet).toBe(FEATURES.join('\n'));
    expect(mintRepoToken).toHaveBeenCalledWith(expect.anything(), 'landing-page');
    // One counts-only line: no path, no code.
    const line = log.mock.calls.find(([l]) => l === '[quiz-agent] code quote');
    expect(line?.[1]).toEqual({
      attemptId: 'attempt-1',
      runId: 'run_1',
      lines: 5,
      ranges: 1,
      changed: false,
      cached: false,
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain('features');
  });

  it('puts the quote in place of any typed code, keeping a language the model gave', async () => {
    const { tools, grading } = quoteSetup();
    await call(tools, 'present_question', {
      ...quoted,
      code_snippet: '.features { display: flex; }',
      code_language: 'scss',
    });
    expect(grading.presentQuestion.mock.calls[0][1]).toMatchObject({
      code_snippet: FEATURES.join('\n'),
      code_language: 'scss',
    });
  });

  it('marks cuts and a "break it" edit on the card', async () => {
    const { tools, grading } = quoteSetup();
    await call(tools, 'present_question', {
      ...quoted,
      code_quote: {
        path: 'css/style.css',
        ranges: [
          [1, 2],
          [11, 15],
        ],
        omit: [12],
        anchor: '.hero {',
        edit: { line: 13, replace: 'grid-template-columns: 1fr;' },
      },
    });
    expect(grading.presentQuestion.mock.calls[0][1]).toMatchObject({
      code_snippet: [
        '.hero {',
        '  display: flex;',
        '...',
        '.features {',
        '...',
        '  grid-template-columns: 1fr;',
        '  gap: 1rem;',
        '}',
      ].join('\n'),
      source: { path: 'css/style.css', lines: '1-2, 11-15', changed: true },
    });
  });

  describe('edited code, once per attempt', () => {
    const edited = {
      ...quoted,
      code_quote: {
        ...quoted.code_quote,
        edit: { line: 13, replace: 'grid-template-columns: 1fr;' },
      },
    };

    it('refuses a second quote with edit before reading the file, writing nothing', async () => {
      const editedQuestions = vi.fn(async () => [1]);
      const { tools, grading, stub, log } = quoteSetup({ services: { editedQuestions } });
      await expect(call(tools, 'present_question', edited)).rejects.toThrow(editLimitText(1));
      expect(editLimitText(1)).toBe(
        'Only one question per quiz may show edited code, and question 1 already does. Quote the real code without edit and describe any change in words in question_text.'
      );
      expect(editedQuestions).toHaveBeenCalledWith('attempt-1');
      expect(grading.presentQuestion).not.toHaveBeenCalled();
      expect(contentsRequests(stub.requested)).toBe(0);
      expect(log).toHaveBeenCalledWith(
        '[quiz-agent] code quote refused',
        expect.objectContaining({ reason: 'edit_limit' })
      );

      // The same lines quoted as they are go through.
      await expect(call(tools, 'present_question', quoted)).resolves.toMatchObject({
        card: { code_snippet: FEATURES.join('\n') },
      });
    });

    it('takes the first one, and reads the journal only for a quote with edit', async () => {
      const editedQuestions = vi.fn(async () => [] as number[]);
      const plain = quoteSetup({ services: { editedQuestions } });
      await call(plain.tools, 'present_question', quoted);
      expect(editedQuestions).not.toHaveBeenCalled();

      const first = quoteSetup({ services: { editedQuestions } });
      await expect(call(first.tools, 'present_question', edited)).resolves.toMatchObject({
        card: { source: { changed: true } },
      });
      expect(editedQuestions).toHaveBeenCalledTimes(1);
    });

    it('tells the model to call again when the journal cannot be read', async () => {
      const { tools, grading } = quoteSetup({
        services: { editedQuestions: async () => Promise.reject(new Error('db down')) },
      });
      await expect(call(tools, 'present_question', edited)).rejects.toThrow(
        retryText('present_question')
      );
      expect(grading.presentQuestion).not.toHaveBeenCalled();
    });

    it('reads the edited questions from the presented cards in the journal', () => {
      const presented = (n: number, changed?: boolean) => ({
        question_number: n,
        output: {
          question_number: n,
          total_questions: 8,
          card: {
            question_number: n,
            ...(changed === undefined ? {} : { source: { path: 'a.css', lines: '1', changed } }),
          },
        },
      });
      expect(
        editedQuestionNumbers([
          presented(1),
          presented(4, true),
          presented(2, false),
          null,
          'junk',
          presented(3, true),
        ])
      ).toEqual([3, 4]);
    });
  });

  it('refuses a quote whose anchor is not the first line, writing nothing, then takes the fixed call', async () => {
    const { tools, grading, log } = quoteSetup();
    await expect(
      call(tools, 'present_question', {
        ...quoted,
        code_quote: { ...quoted.code_quote, anchor: '.header {' },
      })
    ).rejects.toThrow(
      'Line 11 of css/style.css is `.features {`, not `.header {`. Check the line numbers from your exploration.'
    );
    expect(grading.presentQuestion).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('[quiz-agent] code quote refused', {
      attemptId: 'attempt-1',
      runId: 'run_1',
      reason: 'anchor_mismatch',
    });

    await call(tools, 'present_question', quoted, 'call-2');
    expect(grading.presentQuestion).toHaveBeenCalledTimes(1);
  });

  it('refuses a range past the end of the file, writing nothing', async () => {
    const { tools, grading } = quoteSetup();
    await expect(
      call(tools, 'present_question', {
        ...quoted,
        code_quote: { ...quoted.code_quote, ranges: [[11, 30]] },
      })
    ).rejects.toThrow('css/style.css has 15 lines; range 11-30 runs past the end.');
    expect(grading.presentQuestion).not.toHaveBeenCalled();
  });

  it('refuses a file that is not in the repository, writing nothing', async () => {
    const { tools, grading } = quoteSetup();
    await expect(
      call(tools, 'present_question', {
        ...quoted,
        code_quote: { ...quoted.code_quote, path: 'styles/main.css' },
      })
    ).rejects.toThrow("styles/main.css is not in the student's repository.");
    expect(grading.presentQuestion).not.toHaveBeenCalled();
  });

  it('reads a file once for quotes in later turns of the attempt', async () => {
    const first = quoteSetup();
    await call(first.tools, 'present_question', quoted);
    expect(contentsRequests(first.stub.requested)).toBe(1);

    // The next turn's set, the same process cache.
    const grading = echoGrading();
    const next = quizTools(codeAware({ progress: progressAt(2, [1, 2]), fence: 'fence-2' }), {
      writer: recordingWriter().writer as never,
      queue: createToolQueue(),
      signal: new AbortController().signal,
      wordsWritten: () => 40,
      services: {
        grading,
        mintRepoToken: first.mintRepoToken,
        quoteCache: first.quoteCache,
      } as never,
      log: vi.fn(),
    });
    await call(next, 'present_question', {
      ...quoted,
      question_number: 3,
      code_quote: { path: 'css/style.css', ranges: [[1, 5]], anchor: '.hero {' },
    });
    expect(grading.presentQuestion.mock.calls[0][1]).toMatchObject({
      source: { lines: '1-5' },
    });
    expect(contentsRequests(first.stub.requested)).toBe(1);
    expect(first.mintRepoToken).toHaveBeenCalledTimes(1);
  });

  it('quotes the lines an exploration read, without reading the file again', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(['css/style.css']) }],
      })
      .mockResolvedValueOnce({
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              excerpts: [{ path: 'css/style.css', start_line: 11, end_line: 15, why: 'grid' }],
            }),
          },
        ],
      });
    const { tools, grading, stub } = quoteSetup({
      services: { anthropic: () => ({ messages: { create } }) as unknown as Anthropic },
    });

    const explored = (await call(tools, 'explore_codebase', {
      purpose: 'prepare_next',
      focus_area: FOCUS,
    })) as { excerpts: string };
    expect(explored.excerpts).toContain('11| .features {');
    expect(contentsRequests(stub.requested)).toBe(1);

    await call(tools, 'present_question', quoted);
    expect(contentsRequests(stub.requested)).toBe(1);
    expect(grading.presentQuestion.mock.calls[0][1]).toMatchObject({
      code_snippet: FEATURES.join('\n'),
    });
  });

  it('still accepts typed code when there is no quote', async () => {
    const { tools, grading, stub } = quoteSetup();
    const { code_quote: _quote, ...typed } = quoted;
    await call(tools, 'present_question', { ...typed, code_snippet: '.features { gap: 1rem; }' });
    const stored = grading.presentQuestion.mock.calls[0][1] as Record<string, unknown>;
    expect(stored.code_snippet).toBe('.features { gap: 1rem; }');
    expect(stored).not.toHaveProperty('source');
    expect(stub.requested).toEqual([]);
  });

  it('ignores a quote in a standard attempt', async () => {
    const { tools, grading, stub } = quoteSetup({ ctx: context() });
    await call(tools, 'present_question', quoted);
    const stored = grading.presentQuestion.mock.calls[0][1] as Record<string, unknown>;
    expect(stored).not.toHaveProperty('code_quote');
    expect(stored).not.toHaveProperty('source');
    expect(stub.requested).toEqual([]);
  });

  it('reads nothing for the question already out: the service returns the stored card', async () => {
    const { tools, grading, stub } = quoteSetup({
      ctx: codeAware({ progress: progressAt(2, [1]) }),
    });
    await call(tools, 'present_question', quoted);
    expect(stub.requested).toEqual([]);
    expect(grading.presentQuestion.mock.calls[0][1]).not.toHaveProperty('code_quote');
  });

  it('keeps the order check first: no read while the current question is open', async () => {
    const { tools, grading, stub } = quoteSetup({
      ctx: codeAware({ progress: progressAt(1, []) }),
    });
    await expect(call(tools, 'present_question', quoted)).rejects.toThrow(
      recordBeforePresentText(1)
    );
    expect(stub.requested).toEqual([]);
    expect(grading.presentQuestion).not.toHaveBeenCalled();
  });

  it('tells the model a fixed line when the file cannot be read, and logs the status privately', async () => {
    const { tools, grading, log } = quoteSetup();
    vi.stubGlobal('fetch', async () => new Response('{"message":"boom"}', { status: 502 }));
    await expect(call(tools, 'present_question', quoted)).rejects.toThrow(QUOTE_READ_FAILED_TEXT);
    expect(grading.presentQuestion).not.toHaveBeenCalled();
    const line = log.mock.calls.find(([l]) => l === '[quiz-agent] code_quote failed');
    expect(line?.[1]).toMatchObject({ chatId: 'attempt-1', runId: 'run_1', status: 502 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('boom');
  });

  it('tells the model the same fixed line when no token can be minted', async () => {
    const { tools, grading } = quoteSetup({
      services: {
        mintRepoToken: async () => {
          throw new Error('installation suspended');
        },
      },
    });
    await expect(call(tools, 'present_question', quoted)).rejects.toThrow(QUOTE_READ_FAILED_TEXT);
    expect(grading.presentQuestion).not.toHaveBeenCalled();
  });

  it('writes nothing once the turn has stopped during the read', async () => {
    const controller = new AbortController();
    const { tools, grading } = quoteSetup({
      signal: controller.signal,
      services: {
        mintRepoToken: async () => {
          controller.abort();
          return 'repo-token';
        },
      },
    });
    await expect(call(tools, 'present_question', quoted)).rejects.toThrow(TURN_STOPPED_TEXT);
    expect(grading.presentQuestion).not.toHaveBeenCalled();
  });

  it('in a live turn, presents a card from code_quote with the exact lines', async () => {
    const { runQuizTurn } = await import('../../loop.ts');
    // eslint-disable-next-line import/no-unresolved -- package subpath export, resolved by vitest
    const { MockLanguageModelV4, convertArrayToReadableStream } = await import('ai/test');
    vi.stubGlobal('fetch', githubStub('landing-page').fetchImpl);
    const grading = echoGrading();
    const usage = {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
    const model = new MockLanguageModelV4({
      doStream: async () =>
        ({
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'q',
              toolName: 'present_question',
              input: JSON.stringify({
                ...quoted,
                code_quote: {
                  path: 'css/style.css',
                  ranges: [
                    [11, 12],
                    [14, 15],
                  ],
                  anchor: '  .features  {',
                },
              }),
            },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
          ]),
        }) as never,
    });
    const persisted: Array<{ parts: Array<Record<string, unknown>> }> = [];
    const stream = runQuizTurn({
      ctx: codeAware({ progress: progressAt(1, [1]) }),
      messages: [{ role: 'user', content: 'next' }],
      signal: new AbortController().signal,
      model,
      deps: {
        tools: (ctx, d) =>
          quizTools(ctx, {
            ...d,
            services: {
              grading,
              mintRepoToken: async () => 'repo-token',
              quoteCache: new QuoteFileCache(),
            } as never,
            log: vi.fn(),
          }),
        getProgress: async () => progressAt(2, [1]),
        completeFromGrades: vi.fn(),
        persistAssistant: async (_id, message) => {
          persisted.push(message as never);
        },
        evaluationNotice: () => 'notice',
        log: vi.fn(),
      },
    });
    const chunks: Array<Record<string, unknown>> = [];
    for await (const c of stream as unknown as AsyncIterable<Record<string, unknown>>)
      chunks.push(c);

    // One model call: the card ended the turn.
    expect(model.doStreamCalls).toHaveLength(1);
    const output = chunks.find(c => c.type === 'tool-output-available' && c.toolCallId === 'q') as
      | { output: { card: Record<string, unknown> } }
      | undefined;
    expect(output?.output.card).toMatchObject({
      code_snippet: ['.features {', '  display: grid;', '...', '  gap: 1rem;', '}'].join('\n'),
      code_language: 'css',
      source: { path: 'css/style.css', lines: '11-12, 14-15', changed: false },
    });
    expect(output?.output.card).not.toHaveProperty('code_quote');
    const saved = persisted.at(-1)?.parts ?? [];
    expect(saved.find(p => p.type === 'tool-present_question')).toMatchObject({
      state: 'output-available',
      output: { card: { source: { lines: '11-12, 14-15' } } },
    });
  });
});
