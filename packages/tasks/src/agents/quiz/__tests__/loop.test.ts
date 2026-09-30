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
import {
  lastUserTextParts,
  needsEvaluation,
  PERSIST_RETRY_DELAY_MS,
  runQuizTurn,
  withStepCacheBreakpoint,
  type QuizToolsFactory,
  type QuizTurnDeps,
} from '../loop.ts';

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
  stream: convertArrayToReadableStream([{ type: 'stream-start', warnings: [] }, ...parts, finish(unified)]),
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

  const record = (source: 'model' | 'server'): QuizEvaluationRecordV2 => ({
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
          return { card: input, question_number: input.question_number, total_questions: questionCount };
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
          const out = { question_num: input.question_num, emoji: '🚀', brief_feedback: input.brief_feedback };
          writer.write({ type: 'data-question-result', data: out });
          return out;
        }),
    }),
    offer_next_step: tool({
      ...quizToolDefs.offer_next_step,
      execute: input => queue(async () => input),
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

describe('runQuizTurn', () => {
  it('continues the turn after an invalid present_question call', async () => {
    const a = fakeAttempt(2);
    const model = scriptedModel([
      [toolCall('c1', 'present_question', { preamble: 'x', question_number: 1 })], // missing fields
      [toolCall('c2', 'present_question', question(1))],
    ]);
    await collect(
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
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
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
    );
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it('stops once offer_next_step succeeds, so no text trails the buttons', async () => {
    const a = fakeAttempt(2, { presented: 1 });
    const model = scriptedModel([
      [...text('t', 'Close, but not quite.'), toolCall('c1', 'offer_next_step', { actions: ['try_again', 'next'] })],
      [...text('t2', 'trailing text')],
    ]);
    await collect(
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
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
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
    );
    expect(a.order).toEqual(['record:1', 'present:2']);
    expect(a.state.presented).toBe(2);
    expect([...a.state.finalized]).toEqual([1]);
  });

  it('makes two recovery calls, then completes from the recorded grades', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1, 2] });
    const model = scriptedModel([[...text('t', 'Great work!')]]);
    const chunks = await collect(
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
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

  it('stops recovering once the model submits the evaluation', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1, 2] });
    const model = scriptedModel([
      [...text('t', 'Done.')],
      [toolCall('e1', 'submit_quiz_evaluation', evaluationFeedback())],
    ]);
    const chunks = await collect(
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
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
    const notices = chunks.filter(c => c.type === 'data-notice') as Array<{ data: { code: string } }>;
    expect(notices.map(n => n.data.code)).toEqual(['reply_failed']);
  });

  it('treats a text-only reply on the last question as a legitimate ending', async () => {
    const a = fakeAttempt(2, { presented: 2, finalized: [1] });
    const model = scriptedModel([[...text('t', 'Could you say more?')]]);
    const chunks = await collect(
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
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
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
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
      doStream: async ({ abortSignal }) => ({
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
    const notices = chunks.filter(c => c.type === 'data-notice') as Array<{ data: { code: string } }>;
    expect(notices.map(n => n.data.code)).toEqual(['turn_stopped']);
    expect(chunks.at(-1)?.type).toBe('finish');
  });

  it('writes nothing extra when the student stops the turn', async () => {
    const a = fakeAttempt(2);
    const stop = new AbortController();
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
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
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: stop.signal, deps: a.deps, model })
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
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
    );
    expect(JSON.stringify(chunks)).not.toContain('SENTINEL');
    const notices = chunks.filter(c => c.type === 'data-notice') as Array<{ data: { code: string } }>;
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
    const notices = chunks.filter(c => c.type === 'data-notice') as Array<{ data: { code: string } }>;
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
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
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
      runQuizTurn({ ctx: ctxFor(a.progress()), messages: history, signal: new AbortController().signal, deps: a.deps, model })
    );
    expect(model.doStreamCalls[0].providerOptions?.anthropic).toMatchObject({ effort: 'high' });
  });
});

describe('loop helpers', () => {
  it('needsEvaluation follows the recorded state and the Next click', () => {
    const base = { questionCount: 3, presented: 3, completed: false, hasEvaluation: false };
    expect(needsEvaluation({ ...base, finalized: [1, 2, 3] })).toBe(true);
    expect(needsEvaluation({ ...base, finalized: [1, 2] })).toBe(false);
    expect(needsEvaluation({ ...base, finalized: [1, 2] }, 'next')).toBe(true);
    expect(needsEvaluation({ ...base, finalized: [1, 2] }, 'try_again')).toBe(false);
    expect(needsEvaluation({ ...base, finalized: [1, 2, 3], completed: true })).toBe(false);
    expect(needsEvaluation({ ...base, presented: 2, finalized: [1] }, 'next')).toBe(false);
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
      const found = source.match(/\b(streamText|generateText|streamObject|generateObject)\(/g) ?? [];
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
