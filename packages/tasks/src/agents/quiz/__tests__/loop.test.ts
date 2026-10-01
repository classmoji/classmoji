import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool, type ModelMessage, type UIMessageChunk } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import {
  quizToolDefs,
  type AttemptProgress,
  type QuizEvaluationRecordV2,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';
import type { AttemptContext } from '../context.ts';
import { CODE_UNAVAILABLE_NOTICE } from '../prompt/index.ts';
import { contentTools } from '../tools/content.ts';
import {
  lastUserTextParts,
  needsEvaluation,
  PERSIST_RETRY_DELAY_MS,
  runQuizTurn,
  STEP_CEILING,
  stepCeilingFor,
  watchModelText,
  withoutEarlierFailedToolCalls,
  withStepCacheBreakpoint,
  type QuizToolsFactory,
  type QuizTurnDeps,
} from '../loop.ts';
import { OFFER_AFTER_HINT_TEXT } from '../tools/errors.ts';
import { serverNoticeMarker, serverNoticeToken } from '../serverNotice.ts';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

type Part = Record<string, unknown>;

const toolCall = (id: string, toolName: string, input: unknown): Part => ({
  type: 'tool-call',
  toolCallId: id,
  toolName,
  input: JSON.stringify(input),
});
const text = (id: string, value: string): Part[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta: value },
  { type: 'text-end', id },
];
const finish = (unified: 'stop' | 'tool-calls'): Part => ({
  type: 'finish',
  finishReason: { unified, raw: unified },
  usage,
});
const step = (parts: Part[], unified: 'stop' | 'tool-calls' = 'tool-calls') => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start', warnings: [] },
    ...parts,
    finish(unified),
  ]),
});

/** A model that answers each call with the next scripted step (the last repeats). */
function scriptedModel(steps: Part[][], finishes?: Array<'stop' | 'tool-calls'>) {
  let n = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const i = Math.min(n, steps.length - 1);
      n += 1;
      const hasCall = steps[i].some(p => p.type === 'tool-call');
      return step(steps[i], finishes?.[i] ?? (hasCall ? 'tool-calls' : 'stop')) as never;
    },
  });
  return model;
}

const question = (n: number, total = 2) => ({
  preamble: 'Here is one.',
  question_number: n,
  total_questions: total,
  question_text: `What does line ${n} do?`,
});

/** An in-memory attempt with the grading rules the services enforce (order, exact-count completion). */
function fakeAttempt(questionCount = 2, init: Partial<AttemptProgress> = {}) {
  const state = {
    presented: init.presented ?? 0,
    finalized: new Set<number>(init.finalized ?? []),
    completed: init.completed ?? false,
    hasEvaluation: init.hasEvaluation ?? false,
  };
  const order: string[] = [];
  const persisted: Array<{ message: QuizUIMessage; final: boolean }> = [];
  let serverCompletions = 0;

  const progress = (): AttemptProgress => ({
    questionCount,
    presented: state.presented,
    finalized: [...state.finalized].sort((a, b) => a - b),
    completed: state.completed,
    hasEvaluation: state.hasEvaluation,
  });

  const record = (source: 'model' | 'server'): QuizEvaluationRecordV2 =>
    ({
      v: 2,
      source,
      partial_credit_percentage: 100,
      first_attempt_percentage: 100,
      question_results: [...state.finalized].map(n => ({
        question_num: n,
        attempts: 1,
        tries: 1,
        eventually_correct: true,
        first_attempt_correct: true,
        credit_earned: 100,
        emoji: '🚀',
        brief_feedback: 'ok',
      })),
    }) as unknown as QuizEvaluationRecordV2;

  const tools: QuizToolsFactory = (_ctx, { queue, writer }) => ({
    present_question: tool({
      ...quizToolDefs.present_question,
      execute: input =>
        queue(async () => {
          order.push(`present:${input.question_number}`);
          if (input.question_number !== state.presented + 1) throw new Error('out of order');
          if (state.presented > 0 && !state.finalized.has(state.presented)) {
            throw new Error('previous question has no result');
          }
          state.presented = input.question_number;
          return {
            card: input,
            question_number: input.question_number,
            total_questions: questionCount,
          };
        }),
    }),
    record_question_result: tool({
      ...quizToolDefs.record_question_result,
      execute: input =>
        queue(async () => {
          await new Promise(r => setTimeout(r, 20)); // slower than the call after it
          order.push(`record:${input.question_num}`);
          if (input.question_num > state.presented) throw new Error('not presented');
          state.finalized.add(input.question_num);
          const out = {
            question_num: input.question_num,
            emoji: '🚀',
            brief_feedback: input.brief_feedback,
          };
          writer.write({ type: 'data-question-result', data: out });
          return out;
        }),
    }),
    offer_next_step: tool({
      ...quizToolDefs.offer_next_step,
      // As the real tool: the buttons and the lead-in, never the input's text.
      execute: input =>
        queue(async () => ({ actions: input.actions, lead_in: 'Ready for the next question?' })),
    }),
    submit_quiz_evaluation: tool({
      ...quizToolDefs.submit_quiz_evaluation,
      execute: () =>
        queue(async () => {
          if (state.finalized.size < questionCount) throw new Error('not every result is recorded');
          state.completed = true;
          state.hasEvaluation = true;
          return record('model') as never;
        }),
    }),
    explore_codebase: tool({
      ...quizToolDefs.explore_codebase,
      execute: () => queue(async () => ({ excerpts: '', files_read: [] })),
    }),
  });

  const deps: QuizTurnDeps = {
    tools,
    getProgress: async () => progress(),
    completeFromGrades: async () => {
      serverCompletions += 1;
      state.completed = true;
      state.hasEvaluation = true;
      return record('server');
    },
    persistAssistant: async (_id, message, o) => {
      persisted.push({ message, final: o.final });
    },
    evaluationNotice: () => 'SYSTEM NOTICE: record the last result, then submit the evaluation.',
    log: () => {},
  };

  return { state, order, persisted, deps, progress, serverCompletions: () => serverCompletions };
}

function ctxFor(progress: AttemptProgress, over: Partial<AttemptContext> = {}): AttemptContext {
  return {
    attemptId: 'attempt-1',
    userId: 'user-1',
    classroomId: 'class-1',
    quizId: 'quiz-1',
    questionCount: progress.questionCount,
    isCodeAware: false,
    fence: 'fence-1',
    inputMessageId: 'msg-1',
    runId: 'run_1',
    model: 'claude-sonnet-5',
    questionEffort: 'medium',
    gradingEffort: 'high',
    apiKey: 'test-key',
    keySource: 'platform',
    exploration: null,
    prompt: { staticPrompt: 'STATIC', dynamicPrompt: 'DYNAMIC' },
    progress,
    ...over,
  };
}

const history: ModelMessage[] = [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'my answer' },
      { type: 'text', text: 'CURRENT STATUS' },
    ],
  },
];

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<UIMessageChunk>) out.push(chunk);
  return out;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('runQuizTurn: the welcome', () => {
  const WELCOME =
    "Welcome to your quiz on **Loops**! I'll be asking you 2 questions to assess your understanding. Let's get started!";

  it('opens the begin turn with the welcome, before the first model call, and saves it first', async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { inputMessageId: null, welcome: WELCOME }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    const types = chunks.map(c => c.type);
    const welcomeAt = chunks.findIndex(c => c.type === 'text-delta' && c.delta === WELCOME);
    expect(welcomeAt).toBeGreaterThan(-1);
    expect(types.indexOf('text-start')).toBeLessThan(welcomeAt);
    // Before anything from the model call.
    expect(welcomeAt).toBeLessThan(types.indexOf('start-step'));
    expect(welcomeAt).toBeLessThan(types.indexOf('tool-input-available'));
    expect(a.state.presented).toBe(1);
    // Saved with the reply, as its first part, so later turns send it to the model.
    const saved = a.persisted.at(-1)?.message.parts ?? [];
    expect(saved[0]).toMatchObject({ type: 'text', text: WELCOME });
    expect(saved.filter(p => p.type === 'text')).toHaveLength(1);
  });

  it('adds no welcome to a turn on a student message', async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { welcome: WELCOME }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(chunks.some(c => c.type === 'text-delta')).toBe(false);
    const saved = a.persisted.at(-1)?.message.parts ?? [];
    expect(saved.some(p => p.type === 'text')).toBe(false);
  });

  it('adds no welcome once a question is out', async () => {
    const a = fakeAttempt(2, { presented: 1 });
    const model = scriptedModel([
      [...text('t', 'Right.'), toolCall('c1', 'offer_next_step', { actions: ['next'] })],
    ]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { inputMessageId: null, welcome: WELCOME }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(chunks.some(c => c.type === 'text-delta' && c.delta === WELCOME)).toBe(false);
  });
});

describe('runQuizTurn: the messages left', () => {
  const leftChunks = (chunks: UIMessageChunk[]) =>
    chunks.filter(c => c.type === 'data-messages-left') as Array<{
      data: { remaining: number };
      transient?: boolean;
    }>;

  it("opens the reply to a student message with admission's count, transient, and saves none of it", async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { messagesLeft: 19 }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    // Through the browser projection, right after the reply's start.
    expect(chunks[0].type).toBe('start');
    expect(chunks[1]).toEqual({
      type: 'data-messages-left',
      data: { remaining: 19 },
      transient: true,
    });
    expect(leftChunks(chunks)).toHaveLength(1);
    const saved = a.persisted.at(-1)?.message.parts ?? [];
    expect(saved.some(p => p.type === 'data-messages-left')).toBe(false);
  });

  it('sends it with a turn that answers unavailable source material too', async () => {
    const a = fakeAttempt(2);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { messagesLeft: 0, sourceMaterialUnavailable: true }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model: scriptedModel([[...text('t', 'x')]]),
      })
    );
    expect(leftChunks(chunks).map(c => c.data.remaining)).toEqual([0]);
  });

  it('sends none on the begin turn, which admits no student message', async () => {
    const a = fakeAttempt(2);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { inputMessageId: null }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model: scriptedModel([[toolCall('c1', 'present_question', question(1))]]),
      })
    );
    expect(leftChunks(chunks)).toHaveLength(0);
  });
});

describe('runQuizTurn', () => {
  it('continues the turn after an invalid present_question call', async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([
      [toolCall('c1', 'present_question', { preamble: 'x', question_number: 1 })], // missing fields
      [toolCall('c2', 'present_question', question(1))],
    ]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(2);
    expect(a.state.presented).toBe(1);
  });

  it('stops once present_question succeeds', async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([
      [toolCall('c1', 'present_question', question(1))],
      [...text('t', 'should not be requested')],
    ]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('stops once offer_next_step succeeds, so no text trails the buttons', async () => {
    const a = fakeAttempt(2, { presented: 1 });
    const model = scriptedModel([
      [
        ...text('t', 'Close, but not quite.'),
        toolCall('c1', 'offer_next_step', { actions: ['try_again', 'next'] }),
      ],
      [...text('t2', 'trailing text')],
    ]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('runs a record and a present from one step in the order the model emitted them', async () => {
    const a = fakeAttempt(2, { presented: 1 });
    const model = scriptedModel([
      [
        toolCall('c1', 'record_question_result', {
          question_num: 1,
          answers: [{ level: 'correct', hints_before: 0 }],
          brief_feedback: 'Right.',
        }),
        toolCall('c2', 'present_question', question(2)),
      ],
    ]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(a.order).toEqual(['record:1', 'present:2']);
    expect(a.state.presented).toBe(2);
    expect([...a.state.finalized]).toEqual([1]);
  });

  it('makes two recovery calls, then completes from the recorded grades', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1, 2] });
    const model = scriptedModel([[...text('t', 'Great work!')]]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(3);
    expect(a.serverCompletions()).toBe(1);
    expect(chunks.some(c => c.type === 'data-evaluation')).toBe(true);
    // The recovery call carries the notice as the last user message.
    const lastPrompt = model.doStreamCalls[2].prompt;
    const lastUser = [...lastPrompt].reverse().find(m => m.role === 'user');
    expect(JSON.stringify(lastUser)).toContain('SYSTEM NOTICE');
    // The persisted message carries the evaluation part.
    const saved = a.persisted.at(-1)!.message;
    expect(saved.parts.some(p => p.type === 'data-evaluation')).toBe(true);
  });

  it('completes from the recorded grades when the model call fails after the last result', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1] });
    let calls = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 1) {
          return step([
            toolCall('r2', 'record_question_result', {
              question_num: 2,
              answers: [{ level: 'correct', hints_before: 0 }],
              brief_feedback: 'Nice.',
            }),
          ]) as never;
        }
        throw new Error('overloaded');
      },
    });
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { lastAction: 'next' }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    // No recovery call after the model error, but the server completion runs.
    expect(calls).toBe(2);
    expect(a.serverCompletions()).toBe(1);
    expect(chunks.some(c => c.type === 'data-evaluation')).toBe(true);
    // The attempt is complete, so no "send it again" notice.
    expect(chunks.some(c => c.type === 'data-notice')).toBe(false);
    // Saved as a partial reply that carries the evaluation.
    const saved = a.persisted.at(-1)!;
    expect(saved.final).toBe(false);
    expect(saved.message.parts.some(p => p.type === 'data-evaluation')).toBe(true);
  });

  it('still writes reply_failed after a model error when a result is missing', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1] });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('overloaded');
      },
    });
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { lastAction: 'next' }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(1);
    expect(a.serverCompletions()).toBe(0);
    const notices = chunks.filter(c => c.type === 'data-notice') as Array<{
      data: { code: string };
    }>;
    expect(notices.map(n => n.data.code)).toEqual(['reply_failed']);
  });

  it('stops recovering once the model submits the evaluation', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1, 2] });
    const model = scriptedModel([
      [...text('t', 'Done.')],
      [toolCall('e1', 'submit_quiz_evaluation', evaluationFeedback())],
    ]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(2);
    expect(a.serverCompletions()).toBe(0);
    expect(chunks.some(c => c.type === 'data-evaluation')).toBe(false);
  });

  it('writes reply_failed when the last result is still missing after Next', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1] });
    const model = scriptedModel([[...text('t', 'Moving on.')]]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { lastAction: 'next' }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(3);
    expect(a.serverCompletions()).toBe(0);
    const notices = chunks.filter(c => c.type === 'data-notice') as Array<{
      data: { code: string };
    }>;
    expect(notices.map(n => n.data.code)).toEqual(['reply_failed']);
  });

  it('does not owe the evaluation when Next on the second-to-last question presents the last one', async () => {
    const a = fakeAttempt(8, { presented: 7, finalized: [1, 2, 3, 4, 5, 6] });
    const model = scriptedModel([
      [
        toolCall('c1', 'record_question_result', {
          question_num: 7,
          answers: [{ level: 'correct', hints_before: 0 }],
          brief_feedback: 'Right.',
        }),
        toolCall('c2', 'present_question', question(8, 8)),
      ],
      // What a recovery call would do: rate the unseen last question and finish.
      [
        toolCall('c3', 'record_question_result', {
          question_num: 8,
          answers: [],
          brief_feedback: 'Moved on.',
        }),
        toolCall('c4', 'submit_quiz_evaluation', evaluationFeedback()),
      ],
    ]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { lastAction: 'next' }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(1);
    expect(a.order).toEqual(['record:7', 'present:8']);
    expect(a.state.presented).toBe(8);
    expect([...a.state.finalized].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(a.state.completed).toBe(false);
    expect(a.serverCompletions()).toBe(0);
    expect(chunks.some(c => c.type === 'data-evaluation')).toBe(false);
    expect(chunks.some(c => c.type === 'data-notice')).toBe(false);
    expect(a.persisted.at(-1)?.final).toBe(true);
  });

  it('owes the evaluation when Next is clicked on a last question presented in an earlier turn', async () => {
    const a = fakeAttempt(8, { presented: 8, finalized: [1, 2, 3, 4, 5, 6, 7] });
    const model = scriptedModel([
      [...text('t', 'Moving on.')],
      [
        toolCall('c1', 'record_question_result', {
          question_num: 8,
          answers: [],
          brief_feedback: 'Skipped.',
        }),
        toolCall('c2', 'submit_quiz_evaluation', evaluationFeedback()),
      ],
    ]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { lastAction: 'next' }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(2);
    const lastUser = [...model.doStreamCalls[1].prompt].reverse().find(m => m.role === 'user');
    expect(JSON.stringify(lastUser)).toContain('SYSTEM NOTICE');
    expect(a.state.completed).toBe(true);
    expect([...a.state.finalized]).toContain(8);
    expect(a.serverCompletions()).toBe(0);
    expect(chunks.some(c => c.type === 'data-notice')).toBe(false);
  });

  it('treats a text-only reply on the last question as a legitimate ending', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1] });
    const model = scriptedModel([[...text('t', 'Could you say more?')]]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(1);
    expect(chunks.some(c => c.type === 'data-notice')).toBe(false);
  });

  it('projects the browser stream and persists the full message', async () => {
    const a = fakeAttempt(2, { presented: 1 });
    const model = scriptedModel([
      [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: '' },
        { type: 'reasoning-end', id: 'r1' },
        ...text('t', 'Nice.'),
        toolCall('c1', 'record_question_result', {
          question_num: 1,
          answers: [{ level: 'correct', hints_before: 0 }],
          brief_feedback: 'Right.',
        }),
        toolCall('c2', 'present_question', question(2)),
      ],
    ]);
    const projected = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    const types = projected.map(c => c.type);
    expect(types.some(t => t.startsWith('reasoning'))).toBe(false);
    const named = projected.filter(c => 'toolName' in c) as Array<{ toolName: string }>;
    expect(named.some(c => c.toolName === 'record_question_result')).toBe(false);
    expect(named.some(c => c.toolName === 'present_question')).toBe(true);
    expect(types).toContain('data-question-result');
    expect(types[0]).toBe('start');
    expect(types.at(-1)).toBe('finish');

    const saved = a.persisted.at(-1)!;
    expect(saved.final).toBe(true);
    const savedTypes = saved.message.parts.map(p => p.type);
    expect(savedTypes).toContain('tool-record_question_result');
    expect(savedTypes).toContain('tool-present_question');
    expect(savedTypes).toContain('data-question-result');
    const start = projected[0] as { messageId?: string };
    expect(saved.message.id).toBe(start.messageId);
  });

  it('writes turn_stopped when the turn deadline passes', async () => {
    const a = fakeAttempt(2);
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) =>
        ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason));
            },
          }),
        }) as never,
    });
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
        deadlineMs: 50,
      })
    );
    const notices = chunks.filter(c => c.type === 'data-notice') as Array<{
      data: { code: string };
    }>;
    expect(notices.map(n => n.data.code)).toEqual(['turn_stopped']);
    expect(chunks.at(-1)?.type).toBe('finish');
  });

  it('writes nothing extra when the student stops the turn', async () => {
    const a = fakeAttempt(2);
    const stop = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) =>
        ({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              abortSignal?.addEventListener('abort', () => controller.error(abortSignal.reason));
              setTimeout(() => stop.abort(), 10);
            },
          }),
        }) as never,
    });
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: stop.signal,
        deps: a.deps,
        model,
      })
    );
    expect(chunks.some(c => c.type === 'data-notice')).toBe(false);
  });

  it('sends a model error to the browser only as fixed text', async () => {
    const a = fakeAttempt(2);
    const model = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error('SENTINEL-provider-detail');
      },
    });
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(JSON.stringify(chunks)).not.toContain('SENTINEL');
    const notices = chunks.filter(c => c.type === 'data-notice') as Array<{
      data: { code: string };
    }>;
    expect(notices.map(n => n.data.code)).toEqual(['reply_failed']);
  });

  it('answers unavailable source material with a notice and no model call', async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([[...text('t', 'x')]]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { sourceMaterialUnavailable: true }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(0);
    const notices = chunks.filter(c => c.type === 'data-notice') as Array<{
      data: { code: string };
    }>;
    expect(notices.map(n => n.data.code)).toEqual(['source_material_unavailable']);
  });

  it('saves the reply again once when the first save fails, logging ids only', async () => {
    const a = fakeAttempt(2);
    const lines: Array<[string, Record<string, unknown>]> = [];
    let calls = 0;
    const deps: QuizTurnDeps = {
      ...a.deps,
      log: (line, fields) => lines.push([line, fields]),
      persistAssistant: async (id, message, o) => {
        calls += 1;
        if (calls === 1) throw new Error('SENTINEL-db-detail connection reset');
        await a.deps.persistAssistant(id, message, o);
      },
    };
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps,
        model,
      })
    );
    await vi.waitFor(() => expect(a.persisted).toHaveLength(1));
    expect(calls).toBe(2);
    expect(a.persisted[0].final).toBe(true);
    expect(lines.map(l => l[0])).toEqual(
      expect.arrayContaining([
        '[quiz-agent] persistAssistant failed',
        '[quiz-agent] persistAssistant retry saved',
      ])
    );
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it('gives up after the one retry and never throws out of the turn', async () => {
    const a = fakeAttempt(2);
    const lines: Array<[string, Record<string, unknown>]> = [];
    let calls = 0;
    const deps: QuizTurnDeps = {
      ...a.deps,
      log: (line, fields) => lines.push([line, fields]),
      persistAssistant: async () => {
        calls += 1;
        throw new Error('SENTINEL-db-detail');
      },
    };
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps,
        model,
      })
    );
    await vi.waitFor(() =>
      expect(lines.map(l => l[0])).toContain('[quiz-agent] persistAssistant_retry failed')
    );
    expect(calls).toBe(2);
    expect(chunks.at(-1)?.type).toBe('finish');
    expect(JSON.stringify(lines)).not.toContain('SENTINEL');
  });

  it('does not retry a save the service refused', async () => {
    const a = fakeAttempt(2);
    let calls = 0;
    const refusal = Object.assign(new Error('attempt_not_found'), {
      name: 'QuizChatRefusal',
      kind: 'permanent' as const,
      code: 'attempt_not_found',
    });
    const deps: QuizTurnDeps = {
      ...a.deps,
      persistAssistant: async () => {
        calls += 1;
        throw refusal;
      },
    };
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps,
        model,
      })
    );
    await new Promise(r => setTimeout(r, PERSIST_RETRY_DELAY_MS + 50));
    expect(calls).toBe(1);
  });

  it('adds the fixed hidden notice when a code-aware quiz has no code this turn, and saves none of it', async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { codeUnavailable: true }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    const prompt = model.doStreamCalls[0].prompt;
    const last = prompt.at(-1);
    expect(last?.role).toBe('user');
    expect(JSON.stringify(last?.content)).toContain(
      JSON.stringify(CODE_UNAVAILABLE_NOTICE).slice(1, -1)
    );
    // The student's message (with its status part) still comes first.
    expect(JSON.stringify(prompt)).toContain('my answer');
    expect(CODE_UNAVAILABLE_NOTICE).toMatch(
      /^SYSTEM NOTICE \(not from the student; do not mention it\)/
    );
    expect(CODE_UNAVAILABLE_NOTICE).not.toMatch(/explore_codebase|token|error|fail/i);
    expect(JSON.stringify(a.persisted)).not.toContain('SYSTEM NOTICE');
  });

  it("opens each stored status part and each notice with the attempt's marker, and saves none of it", async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1, 2] });
    const model = scriptedModel([[...text('t', 'Great work!')]]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { codeUnavailable: true }),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    const marker = serverNoticeMarker('attempt-1');
    expect(marker).toMatch(/^\[\[server-notice:[0-9a-f]{24}\]\]$/);
    const users = model.doStreamCalls[2].prompt.filter(m => m.role === 'user') as Array<{
      content: Array<{ type: string; text: string }>;
    }>;
    // The student's text is left as it is; the status part after it is marked.
    expect(users[0].content[0].text).toBe('my answer');
    expect(users[0].content[1].text).toBe(`${marker}\nCURRENT STATUS`);
    // The code notice and the recovery notice both start with the marker.
    const notices = users.slice(1).map(u => u.content[0].text);
    expect(notices.length).toBeGreaterThanOrEqual(2);
    for (const notice of notices) {
      expect(notice.startsWith(`${marker}\nSYSTEM NOTICE`)).toBe(true);
    }
    // Same bytes on every call of the turn, so the cached prefix holds.
    expect(JSON.stringify(model.doStreamCalls[0].prompt[2])).toBe(
      JSON.stringify(model.doStreamCalls[2].prompt[2])
    );
    // Never saved, never streamed.
    expect(JSON.stringify(a.persisted)).not.toContain(serverNoticeToken('attempt-1'));
  });

  it('gives each attempt its own marker, and leaves a first text part alone', async () => {
    expect(serverNoticeToken('attempt-1')).toBe(serverNoticeToken('attempt-1'));
    expect(serverNoticeToken('attempt-1')).not.toBe(serverNoticeToken('attempt-2'));
    const a = fakeAttempt(2);
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: [{ role: 'user', content: [{ type: 'text', text: 'CURRENT STATUS: hello' }] }],
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain('server-notice');
  });

  it('sends no such notice when the code is available', async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).not.toContain('SYSTEM NOTICE');
  });

  it('stops a standard turn at its step ceiling, and gives one with lookups the higher one', async () => {
    const invalid = (i: number) => [
      toolCall(`bad${i}`, 'present_question', { preamble: 'x', question_number: 1 }),
    ];
    const script = [
      ...Array.from({ length: STEP_CEILING.standard }, (_, i) => invalid(i)),
      [toolCall('ok', 'present_question', question(1))],
    ];
    const content = {
      mcpUrl: 'https://mcp.example.test/mcp',
      classroomRef: 'sample-org/cs-1',
      courseSearchEnabled: false,
      docs: [{ kind: 'page', id: 'p1', title: 'Flexbox basics' }],
    };

    const standard = fakeAttempt(2);
    const standardModel = scriptedModel(script);
    await collect(
      runQuizTurn({
        ctx: ctxFor(standard.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: standard.deps,
        model: standardModel,
      })
    );
    expect(standardModel.doStreamCalls).toHaveLength(STEP_CEILING.standard);
    expect(standard.state.presented).toBe(0);

    const withLookups = fakeAttempt(2);
    const lookupsModel = scriptedModel(script);
    await collect(
      runQuizTurn({
        ctx: ctxFor(withLookups.progress(), { content }),
        messages: history,
        signal: new AbortController().signal,
        deps: withLookups.deps,
        model: lookupsModel,
      })
    );
    expect(lookupsModel.doStreamCalls).toHaveLength(STEP_CEILING.standard + 1);
    expect(withLookups.state.presented).toBe(1);
  });

  it("hands the turn's log to the tools", async () => {
    const a = fakeAttempt(2);
    const log = vi.fn();
    const tools = vi.fn(a.deps.tools);
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: { ...a.deps, tools, log },
        model,
      })
    );
    expect(tools).toHaveBeenCalledTimes(1);
    expect(tools.mock.calls[0][1].log).toBe(log);
  });

  it('sends two cached system blocks, one message breakpoint, adaptive thinking and the effort', async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([[toolCall('c1', 'present_question', question(1))]]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    const call = model.doStreamCalls[0];
    const systems = call.prompt.filter(m => m.role === 'system');
    expect(systems).toHaveLength(2);
    for (const s of systems) {
      expect(s.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
    }
    const rest = call.prompt.filter(m => m.role !== 'system');
    const marked = rest.filter(m => m.providerOptions?.anthropic?.cacheControl);
    expect(marked).toHaveLength(1);
    expect(rest.at(-1)?.providerOptions?.anthropic?.cacheControl).toEqual({ type: 'ephemeral' });
    expect(call.providerOptions?.anthropic).toMatchObject({
      effort: 'medium',
      thinking: { type: 'adaptive', display: 'omitted' },
    });
  });

  it('uses the grading effort once the last question is out', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1] });
    const model = scriptedModel([[...text('t', 'Tell me more.')]]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls[0].providerOptions?.anthropic).toMatchObject({ effort: 'high' });
  });
});

describe('runQuizTurn: the text written in the turn', () => {
  /** A tool set whose offer_next_step records whether text was written when it ran. */
  function offerProbe() {
    const seen: boolean[] = [];
    const a = fakeAttempt(2, { presented: 1 });
    const inner = a.deps.tools;
    const tools: QuizToolsFactory = (ctx, d) => ({
      ...inner(ctx, d),
      offer_next_step: tool({
        ...quizToolDefs.offer_next_step,
        execute: input => {
          seen.push(d.textWritten());
          return d.queue(async () => ({
            ...input,
            lead_in: 'Would you like to try again or move on?',
          }));
        },
      }),
    });
    return { seen, a, deps: { ...a.deps, tools } };
  }

  const turn = (
    deps: QuizTurnDeps,
    model: MockLanguageModelV4,
    over: Partial<AttemptContext> = {}
  ) =>
    collect(
      runQuizTurn({
        ctx: ctxFor({ ...fakeAttempt(2, { presented: 1 }).progress() }, over),
        messages: history,
        signal: new AbortController().signal,
        deps,
        model,
        project: false,
      })
    );

  it('sees feedback written before offer_next_step in the same step', async () => {
    const { seen, deps } = offerProbe();
    await turn(
      deps,
      scriptedModel([
        [...text('t', 'Right.'), toolCall('b', 'offer_next_step', { actions: ['next'] })],
      ])
    );
    expect(seen).toEqual([true]);
  });

  it('sees feedback written in an earlier step of the turn', async () => {
    const { seen, deps } = offerProbe();
    const model = scriptedModel([
      [
        ...text('t', 'Right.'),
        toolCall('x', 'explore_codebase', { purpose: 'check_current', focus_area: 'the loop' }),
      ],
      [toolCall('b', 'offer_next_step', { actions: ['next'] })],
    ]);
    const chunks = await turn(deps, model);
    expect(model.doStreamCalls).toHaveLength(2);
    // The exploration ran (not refused as invalid input) before the buttons.
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool-output-available', toolCallId: 'x' })
    );
    expect(seen).toEqual([true]);
  });

  it('sees feedback streamed in many deltas, whitespace deltas included', async () => {
    const { seen, deps } = offerProbe();
    await turn(
      deps,
      scriptedModel([
        [
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: ' ' },
          { type: 'text-delta', id: 't', delta: '**Cor' },
          { type: 'text-delta', id: 't', delta: 'rect**' },
          { type: 'text-delta', id: 't', delta: '\n' },
          { type: 'text-end', id: 't' },
          toolCall('b', 'offer_next_step', { actions: ['next'] }),
        ],
      ])
    );
    expect(seen).toEqual([true]);
  });

  it('does not count blank text, or the welcome the loop writes itself', async () => {
    const { seen, a, deps } = offerProbe();
    const model = scriptedModel([
      [...text('t', ' \n '), toolCall('b', 'offer_next_step', { actions: ['next'] })],
    ]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(
          { ...a.progress(), presented: 0 },
          { inputMessageId: null, welcome: 'Welcome!' }
        ),
        messages: history,
        signal: new AbortController().signal,
        deps,
        model,
      })
    );
    expect(seen).toEqual([false]);
  });

  it('sees each delta as it leaves the model, with no UI stream reading it', async () => {
    let written = 0;
    const mock = new MockLanguageModelV4({
      doStream: async () =>
        step([
          ...text('t', 'Right idea.'),
          toolCall('b', 'offer_next_step', { actions: ['next'] }),
        ]) as never,
    });
    const wrapped = watchModelText(mock, () => {
      written += 1;
    }) as MockLanguageModelV4;
    const { stream } = await wrapped.doStream({ prompt: [] } as never);
    const reader = stream.getReader();
    const types: string[] = [];
    const seenAt: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      types.push(value.type);
      seenAt.push(written);
    }
    // Nothing until the text delta, then the flag: all before the tool call
    // reaches the SDK.
    const delta = types.indexOf('text-delta');
    expect(seenAt.slice(0, delta)).toEqual(seenAt.slice(0, delta).map(() => 0));
    expect(seenAt[delta]).toBe(1);
    expect(delta).toBeLessThan(types.indexOf('tool-call'));
    // Every part passes through unchanged.
    expect(types).toEqual([
      'stream-start',
      'text-start',
      'text-delta',
      'text-end',
      'tool-call',
      'finish',
    ]);
  });
});

describe('the history of earlier turns: failed tool calls left out', () => {
  const MASKED = { type: 'error-text' as const, value: 'An error occurred.' };
  const user = (text: string): ModelMessage => ({
    role: 'user',
    content: [{ type: 'text', text }],
  });
  const assistant = (...content: unknown[]): ModelMessage =>
    ({ role: 'assistant', content }) as ModelMessage;
  const toolMsg = (...content: unknown[]): ModelMessage =>
    ({ role: 'tool', content }) as ModelMessage;
  const callPart = (id: string, toolName = 'offer_next_step') => ({
    type: 'tool-call',
    toolCallId: id,
    toolName,
    input: { actions: ['next'] },
  });
  const resultPart = (id: string, output: unknown, toolName = 'offer_next_step') => ({
    type: 'tool-result',
    toolCallId: id,
    toolName,
    output,
  });
  const ok = {
    type: 'json',
    value: { actions: ['next'], lead_in: 'Ready for the next question?' },
  };
  const reasoning = {
    type: 'reasoning',
    text: '',
    providerOptions: { anthropic: { signature: 's' } },
  };

  /** Turn 1: a question. Turn 2: buttons refused, then feedback and buttons. */
  const turn1: ModelMessage[] = [
    user('begin'),
    assistant(callPart('q1', 'present_question')),
    toolMsg(resultPart('q1', { type: 'json', value: {} }, 'present_question')),
    user('my answer'),
  ];
  const turn2Reply: ModelMessage[] = [
    assistant(reasoning, callPart('b1')),
    toolMsg(resultPart('b1', MASKED)),
    assistant({ type: 'text', text: 'Right: the loop visits each item once.' }, callPart('b2')),
    toolMsg(resultPart('b2', ok)),
  ];
  const turn3Reply: ModelMessage[] = [
    assistant(
      { type: 'text', text: 'Recorded.' },
      callPart('r2', 'record_question_result'),
      callPart('q2', 'present_question')
    ),
    toolMsg(
      resultPart('r2', MASKED, 'record_question_result'),
      resultPart('q2', { type: 'json', value: {} }, 'present_question')
    ),
  ];

  it('removes a failed call and its result, and a step left with only reasoning', () => {
    const history = [...turn1, ...turn2Reply, user('next')];
    const out = withoutEarlierFailedToolCalls(history);
    const flat = JSON.stringify(out);
    expect(flat).not.toContain('"b1"');
    expect(flat).not.toContain('An error occurred.');
    expect(out).toHaveLength(history.length - 2);
    // Everything before the first failed call is the same object.
    turn1.forEach((m, i) => expect(out[i]).toBe(m));
    // The accepted call and its feedback stay, in order.
    expect(out.slice(turn1.length)).toEqual([turn2Reply[2], turn2Reply[3], history.at(-1)]);
  });

  it('keeps the other calls of a step whose one call failed', () => {
    const history = [...turn1, ...turn2Reply, user('next'), ...turn3Reply, user('my answer 2')];
    const out = withoutEarlierFailedToolCalls(history);
    const step = out.at(-3) as { content: Array<{ type: string; toolCallId?: string }> };
    expect(step.content.map(p => p.toolCallId ?? p.type)).toEqual(['text', 'q2']);
    const results = out.at(-2) as { content: Array<{ toolCallId: string }> };
    expect(results.content.map(p => p.toolCallId)).toEqual(['q2']);
  });

  it('returns the same array when nothing failed, and the same result every time', () => {
    expect(withoutEarlierFailedToolCalls(turn1)).toBe(turn1);
    const history = [...turn1, ...turn2Reply, user('next')];
    expect(withoutEarlierFailedToolCalls(history)).toEqual(withoutEarlierFailedToolCalls(history));
  });

  it("keeps each turn's history a prefix of the next turn's", () => {
    // Turn 3's history, then turn 4's (turn 3's reply had a failed call of its own).
    const t3 = [...turn1, ...turn2Reply, user('next')];
    const t4 = [...t3, ...turn3Reply, user('my answer 2')];
    const t5 = [
      ...t4,
      assistant({ type: 'text', text: 'Close.' }, callPart('b3')),
      toolMsg(resultPart('b3', ok)),
      user('next'),
    ];
    const [o3, o4, o5] = [t3, t4, t5].map(withoutEarlierFailedToolCalls);
    // Byte for byte: a later turn only appends.
    expect(JSON.stringify(o4.slice(0, o3.length))).toBe(JSON.stringify(o3));
    expect(JSON.stringify(o5.slice(0, o4.length))).toBe(JSON.stringify(o4));
  });

  /** Two assistant messages in a row, anywhere in `messages`. */
  const hasAdjacentAssistants = (messages: ModelMessage[]) =>
    messages.some(
      (m, i) => i > 0 && m.role === 'assistant' && messages[i - 1].role === 'assistant'
    );

  it('keeps a failed call when removing it would put two assistant messages together', () => {
    // [reasoning, text, failed] then [reasoning, call]: removing b1 leaves
    // [reasoning, text] right before [reasoning, call].
    const reply: ModelMessage[] = [
      assistant(reasoning, { type: 'text', text: 'Right.' }, callPart('b1')),
      toolMsg(resultPart('b1', MASKED)),
      assistant(reasoning, callPart('b2')),
      toolMsg(resultPart('b2', ok)),
    ];
    const history = [...turn1, ...reply, user('next')];
    const out = withoutEarlierFailedToolCalls(history);
    expect(out).toHaveLength(history.length);
    out.forEach((m, i) => expect(m).toBe(history[i]));
    expect(hasAdjacentAssistants(out)).toBe(false);
  });

  it('still removes a failed call when no two assistant messages end up together', () => {
    // Text kept, its tool message dropped, the student's message after it.
    const closing = [
      ...turn1,
      assistant({ type: 'text', text: 'Close.' }, callPart('b1')),
      toolMsg(resultPart('b1', MASKED)),
      user('next'),
    ];
    const out = withoutEarlierFailedToolCalls(closing);
    expect(JSON.stringify(out)).not.toContain('"b1"');
    expect(out.slice(turn1.length)).toEqual([
      assistant({ type: 'text', text: 'Close.' }),
      user('next'),
    ]);

    // The first step is kept (removing b1 would join two assistant messages);
    // the second, a step left with only reasoning, is removed with its results.
    const chained = [
      ...turn1,
      assistant({ type: 'text', text: 'Close.' }, callPart('b1')),
      toolMsg(resultPart('b1', MASKED)),
      assistant(reasoning, callPart('b2')),
      toolMsg(resultPart('b2', MASKED)),
      assistant({ type: 'text', text: 'What do you think?' }),
      user('next'),
    ];
    const kept = withoutEarlierFailedToolCalls(chained);
    const flat = JSON.stringify(kept);
    expect(flat).toContain('"b1"');
    expect(flat).not.toContain('"b2"');
    expect(kept.slice(turn1.length)).toEqual([chained[4], chained[5], chained[8], chained[9]]);
    expect(hasAdjacentAssistants(kept)).toBe(false);
  });

  it('never leaves two assistant messages together, keeps calls and results paired, and stays a prefix', () => {
    let id = 0;
    const failed = () => `f${id++}`;
    const good = () => `g${id++}`;
    const text = (t: string) => ({ type: 'text', text: t });
    /** The shapes a saved step takes: its assistant message and tool message. */
    const shapes: Record<string, () => ModelMessage[]> = {
      reasoningFail: () => {
        const f = failed();
        return [assistant(reasoning, callPart(f)), toolMsg(resultPart(f, MASKED))];
      },
      textFail: () => {
        const f = failed();
        return [assistant(reasoning, text('Hmm.'), callPart(f)), toolMsg(resultPart(f, MASKED))];
      },
      reasoningOk: () => {
        const g = good();
        return [assistant(reasoning, callPart(g)), toolMsg(resultPart(g, ok))];
      },
      textOk: () => {
        const g = good();
        return [assistant(text('Right.'), callPart(g)), toolMsg(resultPart(g, ok))];
      },
      mixed: () => {
        const [g, f] = [good(), failed()];
        return [
          assistant(text('Both.'), callPart(g), callPart(f)),
          toolMsg(resultPart(g, ok), resultPart(f, MASKED)),
        ];
      },
    };
    const names = Object.keys(shapes);
    /** Every reply of one to three steps, optionally ending with a text-only step. */
    const replies: string[][] = [];
    for (const a of names) {
      replies.push([a]);
      for (const b of names) {
        replies.push([a, b]);
        for (const c of names) replies.push([a, b, c]);
      }
    }
    const idsOf = (messages: ModelMessage[], type: string) =>
      messages
        .flatMap(m => (typeof m.content === 'string' ? [] : (m.content as unknown[])))
        .filter(p => (p as { type?: unknown }).type === type)
        .map(p => (p as { toolCallId: string }).toolCallId)
        .sort();
    let removedFrom = 0;
    for (const reply of replies) {
      for (const endsWithText of [false, true]) {
        const history = [
          ...turn1,
          ...reply.flatMap(name => shapes[name]()),
          ...(endsWithText ? [assistant(text('What do you think?'))] : []),
          user('next'),
        ];
        const out = withoutEarlierFailedToolCalls(history);
        if (JSON.stringify(out).length < JSON.stringify(history).length) removedFrom += 1;
        expect(hasAdjacentAssistants(out)).toBe(false);
        expect(idsOf(out, 'tool-call')).toEqual(idsOf(out, 'tool-result'));
        const later = [...history, assistant(text('Later.')), user('again')];
        const laterOut = withoutEarlierFailedToolCalls(later);
        expect(JSON.stringify(laterOut.slice(0, out.length))).toBe(JSON.stringify(out));
      }
    }
    // Most histories still lose a failed call: the filter is not keeping everything.
    expect(removedFrom).toBeGreaterThan(replies.length);
  });

  it('sends the model no failed call of an earlier turn, and keeps this turn refusals', async () => {
    const a = fakeAttempt(2, { presented: 1 });
    const refusing: QuizToolsFactory = (c, d) => {
      let refused = false;
      const inner = a.deps.tools(c, d);
      return {
        ...inner,
        offer_next_step: tool({
          ...quizToolDefs.offer_next_step,
          execute: input =>
            d.queue(async () => {
              if (!refused) {
                refused = true;
                throw new Error(OFFER_AFTER_HINT_TEXT);
              }
              return { actions: input.actions, lead_in: 'Ready for the next question?' };
            }),
        }),
      };
    };
    const model = scriptedModel([
      [...text('t', 'Right.'), toolCall('now-1', 'offer_next_step', { actions: ['next'] })],
      [toolCall('now-2', 'offer_next_step', { actions: ['next'] })],
    ]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: [...turn1, ...turn2Reply, user('my answer')],
        signal: new AbortController().signal,
        deps: { ...a.deps, tools: refusing },
        model,
      })
    );
    const first = JSON.stringify(model.doStreamCalls[0].prompt);
    expect(first).not.toContain('"b1"');
    expect(first).not.toContain('An error occurred.');
    expect(first).toContain('"b2"');
    // This turn's refusal reaches the model's next step, with its text.
    const second = JSON.stringify(model.doStreamCalls[1].prompt);
    expect(second).toContain('now-1');
    expect(second).toContain(JSON.stringify(OFFER_AFTER_HINT_TEXT).slice(1, -1));
  });
});

describe('an offer that carries its feedback', () => {
  const FEEDBACK = 'Right: `map` returns a new array. The original is left alone.';
  const ANSWER = 'SENTINEL: `map` builds a new array and never changes the original.';

  it('ends the turn on a reply that is only the call, and saves a part carrying the feedback', async () => {
    const a = fakeAttempt(2, { presented: 1 });
    const model = scriptedModel([
      [
        toolCall('b', 'offer_next_step', {
          expected_answer: ANSWER,
          feedback: FEEDBACK,
          actions: ['next'],
        }),
      ],
      [...text('t', 'should not be requested')],
    ]);
    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: a.deps,
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(1);
    const saved = a.persisted.at(-1)?.message.parts ?? [];
    expect(saved.some(p => p.type === 'text')).toBe(false);
    // Saved whole, the expected answer included (staff read it).
    expect(saved.find(p => p.type === 'tool-offer_next_step')).toMatchObject({
      state: 'output-available',
      input: { expected_answer: ANSWER, feedback: FEEDBACK, actions: ['next'] },
      output: { actions: ['next'], lead_in: 'Ready for the next question?' },
    });
    // The browser receives the feedback with the call's input, never the answer.
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-input-available',
        toolCallId: 'b',
        input: { feedback: FEEDBACK, actions: ['next'] },
      })
    );
    expect(JSON.stringify(chunks)).not.toContain('SENTINEL');
    expect(JSON.stringify(chunks)).not.toContain('expected_answer');
  });

  it('adds no buttons at the end of a turn whose offer was refused', async () => {
    const a = fakeAttempt(2, { presented: 1 });
    const refusing: QuizToolsFactory = (c, d) => ({
      ...a.deps.tools(c, d),
      offer_next_step: tool({
        ...quizToolDefs.offer_next_step,
        execute: () =>
          d.queue(async () => {
            throw new Error(OFFER_AFTER_HINT_TEXT);
          }),
      }),
    });
    const model = scriptedModel([
      [toolCall('b', 'offer_next_step', { feedback: FEEDBACK, actions: ['next'] })],
      [...text('t', 'Look at line 3. What do you think?')],
    ]);
    await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress()),
        messages: history,
        signal: new AbortController().signal,
        deps: { ...a.deps, tools: refusing },
        model,
      })
    );
    expect(model.doStreamCalls).toHaveLength(2);
    const saved = a.persisted.at(-1)?.message.parts ?? [];
    expect(
      saved.filter(p => p.type === 'tool-offer_next_step' && p.state === 'output-available')
    ).toHaveLength(0);
  });
});

describe('loop helpers', () => {
  it('needsEvaluation follows the recorded state and the Next click', () => {
    const base = { questionCount: 3, presented: 3, completed: false, hasEvaluation: false };
    const start = { presentedAtStart: 3 };
    expect(needsEvaluation({ ...base, finalized: [1, 2, 3] }, start)).toBe(true);
    expect(needsEvaluation({ ...base, finalized: [1, 2] }, start)).toBe(false);
    expect(needsEvaluation({ ...base, finalized: [1, 2] }, { ...start, lastAction: 'next' })).toBe(
      true
    );
    expect(
      needsEvaluation({ ...base, finalized: [1, 2] }, { ...start, lastAction: 'try_again' })
    ).toBe(false);
    expect(needsEvaluation({ ...base, finalized: [1, 2, 3], completed: true }, start)).toBe(false);
    expect(
      needsEvaluation(
        { ...base, presented: 2, finalized: [1] },
        { presentedAtStart: 2, lastAction: 'next' }
      )
    ).toBe(false);
  });

  it('needsEvaluation does not count a last question presented during the turn', () => {
    // Next on question 2 of 3: question 2 recorded, question 3 presented in the same turn.
    const after = {
      questionCount: 3,
      presented: 3,
      finalized: [1, 2],
      completed: false,
      hasEvaluation: false,
    };
    expect(needsEvaluation(after, { presentedAtStart: 2, lastAction: 'next' })).toBe(false);
    expect(needsEvaluation(after, { presentedAtStart: 3, lastAction: 'next' })).toBe(true);
  });

  it('keeps exactly one message breakpoint', () => {
    const marked = withStepCacheBreakpoint(
      withStepCacheBreakpoint([
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
      ]).concat([{ role: 'user', content: 'c' }])
    );
    expect(marked.filter(m => m.providerOptions?.anthropic?.cacheControl)).toHaveLength(1);
    expect(marked.at(-1)?.providerOptions?.anthropic?.cacheControl).toBeDefined();
  });

  it('raises the step ceiling for an attempt with the course-material lookups', () => {
    expect(STEP_CEILING).toEqual({ standard: 10, codeAware: 20 });
    const content = {
      mcpUrl: 'https://mcp.example.test/mcp',
      classroomRef: 'sample-org/cs-1',
      courseSearchEnabled: false,
      docs: [],
    };
    expect(stepCeilingFor({ isCodeAware: false })).toBe(10);
    expect(stepCeilingFor({ isCodeAware: false, content: null })).toBe(10);
    expect(stepCeilingFor({ isCodeAware: false, content })).toBe(20);
    expect(stepCeilingFor({ isCodeAware: true })).toBe(20);
  });

  it('counts the text parts of the last user message', () => {
    expect(lastUserTextParts(history)).toBe(2);
    expect(lastUserTextParts([{ role: 'user', content: 'x' }])).toBe(1);
  });
});

describe('telemetry', () => {
  it('turns telemetry off on every model call in the agents code', () => {
    const root = join(fileURLToPath(import.meta.url), '../../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__' && name !== '__fixtures__') walk(path);
        } else if (name.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    let calls = 0;
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const found =
        source.match(/\b(streamText|generateText|streamObject|generateObject)\(/g) ?? [];
      const off = source.match(/telemetry: \{ isEnabled: false \}/g) ?? [];
      calls += found.length;
      expect(off.length, file).toBeGreaterThanOrEqual(found.length);
    }
    expect(calls).toBeGreaterThan(0);
  });
});

describe('telemetry layer 1: @ai-sdk/otel is not installed', () => {
  // Trigger registers AI SDK telemetry at every chat-agent boot whenever
  // `@ai-sdk/otel` can be imported, so it must never be resolvable here.
  const tasksRoot = join(fileURLToPath(import.meta.url), '../../../../..');
  const repoRoot = join(tasksRoot, '../..');

  it('does not resolve from packages/tasks', () => {
    expect(JSON.parse(readFileSync(join(tasksRoot, 'package.json'), 'utf8')).name).toBe(
      '@classmoji/tasks'
    );
    const requireFromTasks = createRequire(join(tasksRoot, 'package.json'));
    let code: unknown = null;
    try {
      requireFromTasks.resolve('@ai-sdk/otel');
    } catch (error) {
      code = (error as { code?: unknown }).code;
    }
    // Not "throws": an installed ESM-only package throws a different code.
    expect(code).toBe('MODULE_NOT_FOUND');
  });

  it('is in no node_modules folder Node would search from packages/tasks', () => {
    const found: string[] = [];
    for (let dir = tasksRoot; ; dir = dirname(dir)) {
      const candidate = join(dir, 'node_modules', '@ai-sdk', 'otel');
      if (existsSync(candidate)) found.push(candidate);
      if (dirname(dir) === dir) break;
    }
    expect(found).toEqual([]);
  });

  it('is installed by no workspace in the lockfile', () => {
    const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, unknown>;
    };
    expect(Object.keys(lock.packages ?? {}).length).toBeGreaterThan(0);
    const installed = Object.keys(lock.packages ?? {}).filter(key =>
      key.endsWith('node_modules/@ai-sdk/otel')
    );
    expect(installed).toEqual([]);
  });
});

function evaluationFeedback() {
  return {
    final_acknowledgment: 'Thanks.',
    quiz_complete: true,
    evaluation: 'Solid work.',
    numeric_score: 3,
    feedback_summary: 'Solid.',
    feedback_strengths: ['clear'],
    feedback_improvements: ['depth'],
    feedback_recommendation: 'Practice.',
    feedback_effort_note: 'Good effort.',
  };
}

describe('runQuizTurn: a lookup in the course material', () => {
  it('reads a linked document, then presents the question; the browser gets its title only', async () => {
    const a = fakeAttempt(2);
    const DOC_TEXT = 'Flex containers lay out their children along a main axis.';
    const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const connect = async () => ({
      callTool: async ({
        name,
        arguments: args = {},
      }: {
        name: string;
        arguments?: Record<string, unknown>;
      }) => {
        mcpCalls.push({ name, args });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                kind: 'page',
                id: 'p1',
                title: 'Flexbox basics',
                text: DOC_TEXT,
              }),
            },
          ],
        };
      },
      close: async () => undefined,
    });
    const content = {
      mcpUrl: 'https://mcp.example.test/mcp',
      classroomRef: 'sample-org/cs-1',
      courseSearchEnabled: false,
      docs: [{ kind: 'page', id: 'p1', title: 'Flexbox basics' }],
    };
    const tools: QuizToolsFactory = (ctx, d) => ({
      ...a.deps.tools(ctx, d),
      ...contentTools(ctx, content, d, { mintToken: async () => 'bearer', connect }),
    });
    const model = scriptedModel([
      [toolCall('c1', 'content_get', { kind: 'page', id: 'p1' })],
      [toolCall('c2', 'present_question', question(1))],
    ]);

    const chunks = await collect(
      runQuizTurn({
        ctx: ctxFor(a.progress(), { inputMessageId: null, content }),
        messages: history,
        signal: new AbortController().signal,
        deps: { ...a.deps, tools },
        model,
      })
    );

    // The model read the document as the tool's result, then asked question 1.
    expect(mcpCalls).toEqual([
      { name: 'content_get', args: { classroom: 'sample-org/cs-1', kind: 'page', id: 'p1' } },
    ]);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(DOC_TEXT);
    expect(a.state.presented).toBe(1);

    // The browser: one titled step before the card; no content tool part, id or text.
    const step = chunks.findIndex(c => c.type === 'data-step');
    expect(chunks[step]).toMatchObject({
      type: 'data-step',
      data: { kind: 'course_material', title: 'Flexbox basics' },
    });
    const card = chunks.findIndex(
      c => c.type === 'tool-input-available' && c.toolName === 'present_question'
    );
    expect(step).toBeLessThan(card);
    const sent = JSON.stringify(chunks);
    expect(sent).not.toContain('content_get');
    expect(sent).not.toContain(DOC_TEXT);
    expect(sent).not.toContain('"p1"');
    expect(sent).not.toContain('bearer');

    // Saved with the reply for the next turn's history, tool result included.
    const saved = a.persisted.at(-1)?.message.parts ?? [];
    expect(saved.some(p => p.type === 'tool-content_get')).toBe(true);
    expect(saved).toContainEqual(
      expect.objectContaining({
        type: 'data-step',
        data: { kind: 'course_material', title: 'Flexbox basics' },
      })
    );
  });
});
