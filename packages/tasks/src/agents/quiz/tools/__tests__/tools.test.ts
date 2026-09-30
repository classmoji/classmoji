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

const { quizTools, questionResultPartId } = await import('../index.ts');
const { OFFER_AFTER_QUESTION_TEXT, QUESTION_AFTER_OFFER_TEXT, TURN_STOPPED_TEXT, retryText } =
  await import('../errors.ts');
const { EXPLORATION_FAILED_TEXT } = await import('../../../shared/exploration/core.ts');
const {
  EXPLORATION_BUSY_TEXT,
  EXPLORATION_LIMIT_TEXT,
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
      finalized: [],
      completed: false,
      hasEvaluation: false,
    },
    ...overrides,
  } as AttemptContext;
}

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

  it('adds explore_codebase last for a code-aware attempt', () => {
    const { tools } = setup({ ctx: codeAware() });
    expect(Object.keys(tools)).toEqual([...QUIZ_TOOL_ORDER]);
  });

  it('builds byte-identical tool descriptions and schemas on every turn', () => {
    const first = setup({ ctx: codeAware() }).tools;
    const second = setup({ ctx: codeAware({ fence: 'fence-2', runId: 'run_2' }) }).tools;
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
});

describe('offer_next_step and submit_quiz_evaluation', () => {
  it('offer_next_step returns the choices and writes nothing', async () => {
    const { tools, grading, writes } = setup();
    await expect(
      call(tools, 'offer_next_step', { actions: ['try_again', 'next'] })
    ).resolves.toEqual({
      actions: ['try_again', 'next'],
    });
    expect(writes).toEqual([]);
    expect(Object.values(grading).every(fn => fn.mock.calls.length === 0)).toBe(true);
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
    expect(offered).toEqual({ status: 'fulfilled', value: { actions: ['next'] } });
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
        input: JSON.stringify({ focus_area: 'initial' }),
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
