/**
 * One quiz turn: the model loop, bounded recovery and server completion,
 * streamed as UI message chunks.
 *
 * No Trigger import: `agent.ts` wires the services, tools and cleanup in, and
 * tests drive this with `MockLanguageModelV4` and fake dependencies.
 *
 * Shape (see the design's §4.1-4.3):
 * - `instructions` are two cached system blocks (static prompt + material,
 *   then the per-attempt block); nothing that changes per turn goes there.
 *   A code-aware quiz whose repository was not found this turn gets a fixed
 *   hidden user-role notice after the history instead (never persisted).
 * - Every server text in the user role (each stored status part, each notice)
 *   is opened by the attempt's marker line (serverNotice.ts), added to the
 *   request only, never stored.
 * - The opening turn (the `begin` action's) starts with the fixed welcome
 *   (`ctx.welcome`), written before the first model call and saved with the
 *   reply.
 * - The reply to a student message opens with a transient
 *   `data-messages-left` part: the messages the attempt still admits, as
 *   admission counted them (`ctx.messagesLeft`). Never saved.
 * - `prepareStep` rebuilds each step's messages and moves one cache
 *   breakpoint to the last message, so an older breakpoint never piles up.
 * - Tool calls that failed in EARLIER turns are left out of the history
 *   (`withoutEarlierFailedToolCalls`): their saved error is only "An error
 *   occurred.", which reads as a broken interface. This turn's own refusals
 *   stay in its steps, so the model reads them and recovers.
 * - The turn stops once `present_question`, `offer_next_step` or
 *   `submit_quiz_evaluation` SUCCEEDED (an invalid call is a tool error the
 *   model corrects in the same turn), or at the step ceiling
 *   (`stepCeilingFor`: the higher one when the attempt explores code or has
 *   the course-material lookups). Stopping on the buttons keeps text from
 *   trailing after them.
 * - After the stream ends, persisted state decides whether the evaluation is
 *   still owed (for a Next click, only when the last question was already out
 *   before the turn began); if so, up to two more calls carry the evaluation
 *   notice (none after a model error). If every result is recorded and the
 *   evaluation still did not arrive, the server completes the attempt from the
 *   recorded grades and writes a `data-evaluation` part, after a model error
 *   too, since that needs no model. If the last result is missing, a
 *   `reply_failed` notice is written and the student's next message retries.
 * - A turn the student stops writes no notice; one that fails or runs out of
 *   time writes one (the server's completion after a model error writes its
 *   evaluation instead). The services tell a stopped reply from a failed one
 *   by that alone: a stopped reply's text stays in the transcript and the
 *   history, and a Try again whose reply has text counts as a hint
 *   (`replyShowsHint`).
 * - Everything the model or the tools write is persisted in `onEnd`, upstream
 *   of the projection; the returned stream is projected for the browser. A
 *   failed save is tried once more (the save is an upsert by message id); a
 *   refusal is not retried. Each failure logs ids only.
 * - Telemetry is off on every call. One log line per model call: ids, model,
 *   key source, token and cache counts. Never content.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import {
  createUIMessageStream,
  generateId,
  isStepCount,
  streamText,
  toUIMessageStream,
  wrapLanguageModel,
  type LanguageModel,
  type ModelMessage,
  type StopCondition,
  type ToolSet,
  type UIMessageChunk,
  type UIMessageStreamWriter,
} from 'ai';
import type {
  AttemptProgress,
  QuizEvaluationRecordV2,
  QuizUIMessage,
} from '@classmoji/utils/quiz-agent';
import { THINKING } from '@classmoji/utils/ai-models';
import type { AttemptContext } from './context.ts';
import { CODE_UNAVAILABLE_NOTICE } from './prompt/index.ts';
import { markServerText, markStatusParts } from './serverNotice.ts';
import type { Effort } from './settings.ts';
import { isRefusal, logDiagnostic, type DiagnosticLog } from '../shared/sanitize.ts';
import { createToolQueue, type ToolQueue } from '../shared/toolQueue.ts';
import { projectChunks } from '../shared/uiFilter.ts';

/** The turn's own deadline, across every call and tool of the turn. */
export const TURN_DEADLINE_MS = 240_000;
/** Bounded recovery calls when the evaluation is owed (Q17). */
export const RECOVERY_CALLS = 2;
export const STEP_CEILING = { standard: 10, codeAware: 20 } as const;

/**
 * The turn's step ceiling: the higher one for an attempt that explores code
 * or has the course-material lookups (tools/index.ts registers them when
 * `ctx.content` is set), whose steps those calls also use.
 */
export function stepCeilingFor(ctx: Pick<AttemptContext, 'isCodeAware' | 'content'>): number {
  return ctx.isCodeAware || ctx.content ? STEP_CEILING.codeAware : STEP_CEILING.standard;
}

/** Output ceiling per call, by phase; thinking tokens count against it. */
export const MAX_OUTPUT_TOKENS = { question: 16_000, evaluation: 32_000 } as const;
/** Pause before the one retry of a failed end-of-turn save. */
export const PERSIST_RETRY_DELAY_MS = 250;

const EPHEMERAL = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

export type QuizToolsFactory = (
  ctx: AttemptContext,
  d: {
    writer: UIMessageStreamWriter<QuizUIMessage>;
    queue: ToolQueue;
    signal: AbortSignal;
    /** The turn's log, so tool diagnostics and usage lines land with the loop's. */
    log?: DiagnosticLog;
    /**
     * Whether the model has written visible text in this turn (a text delta
     * with a non-space character), read from the model's own stream
     * (`watchModelText`) before any tool of the same step runs.
     */
    textWritten: () => boolean;
  }
) => ToolSet;

export type ServerCompletionFence = {
  attemptId: string;
  fence: string;
  inputMessageId: string | null;
  runId: string;
};

export type QuizTurnDeps = {
  tools: QuizToolsFactory;
  getProgress: (attemptId: string) => Promise<AttemptProgress>;
  completeFromGrades: (f: ServerCompletionFence) => Promise<QuizEvaluationRecordV2>;
  persistAssistant: (
    attemptId: string,
    message: QuizUIMessage,
    o: { final: boolean }
  ) => Promise<void>;
  evaluationNotice: (p: AttemptProgress) => string;
  /** Removes tool parts left without a result by a stopped or failed turn. */
  cleanupParts?: (m: QuizUIMessage) => QuizUIMessage;
  log?: DiagnosticLog;
};

export type QuizTurnInput = {
  ctx: AttemptContext;
  /** The conversation, already converted from the canonical history. */
  messages: ModelMessage[];
  /** The run's signal (cancel or the student's stop). */
  signal: AbortSignal;
  deps: QuizTurnDeps;
  /** Tests inject a mock; otherwise the Anthropic model for `ctx.model` on `ctx.apiKey`. */
  model?: ModelObject;
  deadlineMs?: number;
  /** Non-persisted messages appended after the history (e.g. a status fallback). */
  extraMessages?: ModelMessage[];
  /** Default true. False returns the unprojected stream (tests only). */
  project?: boolean;
};

type Phase = 'question' | 'evaluation';

/** A model object (not a gateway id string): the turn wraps it. */
export type ModelObject = Exclude<LanguageModel, string>;

/**
 * The model, with `onText` called as each text delta with a non-space
 * character leaves it. This sits at the model's own stream, upstream of the
 * SDK's tool execution (a step's tools run once its model call has ended), so
 * every delta of a step has passed here before any tool of that step runs: a
 * tool reading the flag sees the text written before its call in the same
 * step, or in an earlier step of the turn, whatever the downstream UI stream
 * has consumed so far.
 */
export function watchModelText(model: ModelObject, onText: () => void): ModelObject {
  return wrapLanguageModel({
    model,
    middleware: {
      wrapStream: async ({ doStream }) => {
        const result = await doStream();
        type Part = typeof result.stream extends ReadableStream<infer P> ? P : never;
        return {
          ...result,
          stream: result.stream.pipeThrough(
            new TransformStream<Part, Part>({
              transform(part, controller) {
                if (part.type === 'text-delta' && part.delta.trim() !== '') onText();
                controller.enqueue(part);
              },
            })
          ),
        };
      },
    },
  });
}

/** The turn is in the evaluation phase once the last question is out. */
export function phaseFor(p: AttemptProgress): Phase {
  return p.presented >= p.questionCount ? 'evaluation' : 'question';
}

export function allResultsFinalized(p: AttemptProgress): boolean {
  for (let n = 1; n <= p.questionCount; n++) {
    if (!p.finalized.includes(n)) return false;
  }
  return true;
}

/** The `begin` action's turn (no admitted student message) before any question is out. */
export function isOpeningTurn(ctx: Pick<AttemptContext, 'inputMessageId' | 'progress'>): boolean {
  return ctx.inputMessageId === null && ctx.progress.presented === 0;
}

/** What the turn started from: the student's action and the progress before any call. */
export type TurnStart = {
  lastAction?: 'next' | 'try_again';
  /** `presented` as it was before the turn's first model call. */
  presentedAtStart: number;
};

/**
 * Whether the evaluation is owed after the model's reply (`p` is the progress
 * read after it): every result is recorded and there is no evaluation, or the
 * student moved on (Next) from the last question and its result is still
 * missing. The Next case needs the last question to have been presented
 * BEFORE this turn: a Next on the second-to-last question presents the last
 * one in this turn, and the student has not seen it yet. A clarifying
 * question or a retry on the last question is a legitimate text-only ending.
 */
export function needsEvaluation(p: AttemptProgress, turn: TurnStart): boolean {
  if (p.completed || p.hasEvaluation) return false;
  if (allResultsFinalized(p)) return true;
  return (
    turn.lastAction === 'next' &&
    turn.presentedAtStart >= p.questionCount &&
    !p.finalized.includes(p.questionCount)
  );
}

/** Stop once the named tool returned a result in the last step (a tool error does not count). */
export function succeeded(name: string): StopCondition<ToolSet> {
  return ({ steps }) => steps.at(-1)?.toolResults.some(r => r.toolName === name) ?? false;
}

/** Mark only the last message with a cache breakpoint. */
export function withStepCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.map(m => {
    const opts = m.providerOptions as Record<string, Record<string, unknown>> | undefined;
    if (!opts?.anthropic?.cacheControl) return m;
    const { cacheControl: _drop, ...restAnthropic } = opts.anthropic;
    const rest = { ...opts, anthropic: restAnthropic };
    return { ...m, providerOptions: rest } as ModelMessage;
  });
  const last = out[out.length - 1];
  const opts = (last.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
  out[out.length - 1] = {
    ...last,
    providerOptions: { ...opts, anthropic: { ...(opts.anthropic ?? {}), ...EPHEMERAL.anthropic } },
  } as ModelMessage;
  return out;
}

/** Drop tool parts that never got a result, so no `tool_use` reaches the next request alone. */
export function dropIncompleteToolParts(message: QuizUIMessage): QuizUIMessage {
  const parts = message.parts.filter(part => {
    const p = part as { type: string; state?: string };
    if (!(p.type.startsWith('tool-') || p.type === 'dynamic-tool')) return true;
    return (
      p.state === 'output-available' || p.state === 'output-error' || p.state === 'output-denied'
    );
  });
  return { ...message, parts } as QuizUIMessage;
}

/** A tool result whose saved state was `output-error` (the SDK converts it to an error output). */
function isErrorResult(part: unknown): part is { type: 'tool-result'; toolCallId: string } {
  const p = part as { type?: unknown; output?: { type?: unknown } } | null;
  return (
    p?.type === 'tool-result' &&
    (p.output?.type === 'error-text' || p.output?.type === 'error-json')
  );
}

/**
 * The history of earlier turns without the tool calls that failed in them:
 * each such call and its result are removed, a tool message left empty is
 * dropped, and so is an assistant message left with nothing but reasoning
 * (the step made only that call). Saved, those failures read "An error
 * occurred.", which tells the model nothing but that something is broken.
 *
 * A step is its assistant message and the tool message after it; its failed
 * calls are removed together or not at all. They are kept, step unchanged,
 * when removing them would put two assistant messages next to each other
 * (the provider would merge them into one turn with two signed thinking
 * blocks). The check looks at the message kept before the step and the one
 * after it as given, so it is conservative: an assistant message after it
 * counts even if a later step drops it.
 *
 * It depends on nothing but the messages, and removes only: every message
 * before the first one that held a failed call is the same object, and each
 * step's outcome depends only on the messages before it and the one after
 * it, so the history of a later turn starts with the same bytes. With nothing
 * to remove, the array itself comes back. The quiz tools use no approvals,
 * so an error output here is always a failed call.
 */
export function withoutEarlierFailedToolCalls(messages: ModelMessage[]): ModelMessage[] {
  const failed = new Set<string>();
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const part of m.content) if (isErrorResult(part)) failed.add(part.toolCallId);
  }
  if (failed.size === 0) return messages;

  const isFailedPart = (part: unknown) => {
    const p = part as { type?: unknown; toolCallId?: unknown };
    return (
      (p.type === 'tool-call' || p.type === 'tool-result') &&
      typeof p.toolCallId === 'string' &&
      failed.has(p.toolCallId)
    );
  };
  /** `m` without its failed parts: `m` itself if it has none, null if nothing is left. */
  const filtered = (m: ModelMessage): ModelMessage | null => {
    if ((m.role !== 'assistant' && m.role !== 'tool') || typeof m.content === 'string') return m;
    const content = (m.content as unknown[]).filter(part => !isFailedPart(part));
    if (content.length === m.content.length) return m;
    const kept = content.some(part => (part as { type?: unknown }).type !== 'reasoning');
    return kept ? ({ ...m, content } as ModelMessage) : null;
  };
  const isAssistant = (m: ModelMessage | undefined) => m?.role === 'assistant';

  const out: ModelMessage[] = [];
  for (let i = 0; i < messages.length; ) {
    // One step: an assistant message and the tool message after it, if any.
    const end =
      messages[i].role === 'assistant' && messages[i + 1]?.role === 'tool' ? i + 2 : i + 1;
    const step = messages.slice(i, end);
    const next = messages[end];
    const kept = step.map(filtered);
    const changed = kept.some((m, k) => m !== step[k]);
    const replacement = kept.filter((m): m is ModelMessage => m !== null);
    const sequence = [out.at(-1), ...replacement, next];
    const adjacent = sequence.some(
      (m, k) => k > 0 && isAssistant(m) && isAssistant(sequence[k - 1])
    );
    out.push(...(changed && adjacent ? step : replacement));
    i = end;
  }
  return out;
}

/** Text-part count of the last user message in a request (the hidden status is part 2). */
export function lastUserTextParts(messages: ModelMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return 1;
    return m.content.filter(c => c.type === 'text').length;
  }
  return 0;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function runQuizTurn(input: QuizTurnInput): ReadableStream<UIMessageChunk> {
  const { ctx, deps } = input;
  const log: DiagnosticLog = deps.log ?? ((line, fields) => console.log(line, fields));
  const ids = { chatId: ctx.attemptId, runId: ctx.runId };
  const timeout = AbortSignal.timeout(input.deadlineMs ?? TURN_DEADLINE_MS);
  const deadline = AbortSignal.any([input.signal, timeout]);
  const messageId = generateId();
  const cleanup = deps.cleanupParts ?? dropIncompleteToolParts;
  let failed = false;

  const stream = createUIMessageStream<QuizUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: 'start', messageId });
      // How many more messages the attempt admits, for the chat's countdown:
      // transient, so it is never part of the saved reply.
      if (typeof ctx.messagesLeft === 'number') {
        writer.write({
          type: 'data-messages-left',
          data: { remaining: ctx.messagesLeft },
          transient: true,
        });
      }
      let noticeWritten = false;
      const notice = (code: 'turn_stopped' | 'reply_failed' | 'source_material_unavailable') => {
        if (noticeWritten) return;
        noticeWritten = true;
        writer.write({ type: 'data-notice', data: { code } });
      };

      if (ctx.sourceMaterialUnavailable) {
        notice('source_material_unavailable');
        writer.write({ type: 'finish' });
        return;
      }

      // The opening turn starts with the fixed welcome, shown at once and saved
      // with the reply; the model's work (exploring, question 1) follows it.
      if (isOpeningTurn(ctx) && ctx.welcome) {
        const id = generateId();
        writer.write({ type: 'text-start', id });
        writer.write({ type: 'text-delta', id, delta: ctx.welcome });
        writer.write({ type: 'text-end', id });
      }

      // `ctx.progress` is the progress read just before this turn: the phase,
      // the hidden status and the Next check all use this one snapshot.
      const turnStart: TurnStart = {
        lastAction: ctx.lastAction,
        presentedAtStart: ctx.progress.presented,
      };
      const phase = phaseFor(ctx.progress);
      const effort: Effort = phase === 'evaluation' ? ctx.gradingEffort : ctx.questionEffort;
      // Set from the model's own stream (watchModelText), never from the loop's
      // writes such as the welcome, and before any tool of the same step runs.
      // One flag for the whole turn: text in any earlier step counts too.
      let textWritten = false;
      const model = watchModelText(
        input.model ?? createAnthropic({ apiKey: ctx.apiKey })(ctx.model),
        () => {
          textWritten = true;
        }
      );
      const queue = createToolQueue();
      const tools = deps.tools(ctx, {
        writer: writer as UIMessageStreamWriter<QuizUIMessage>,
        queue,
        signal: deadline,
        log,
        textWritten: () => textWritten,
      });
      let callIndex = 0;
      let sawStreamError = false;

      const call = (history: ModelMessage[]) =>
        streamText({
          model,
          instructions: [
            { role: 'system', content: ctx.prompt.staticPrompt, providerOptions: EPHEMERAL },
            { role: 'system', content: ctx.prompt.dynamicPrompt, providerOptions: EPHEMERAL },
          ],
          messages: history,
          tools,
          stopWhen: [
            succeeded('present_question'),
            succeeded('offer_next_step'),
            succeeded('submit_quiz_evaluation'),
            isStepCount(stepCeilingFor(ctx)),
          ],
          prepareStep: ({ initialMessages, responseMessages }) => ({
            messages: withStepCacheBreakpoint([
              ...initialMessages,
              ...(responseMessages as ModelMessage[]),
            ]),
          }),
          providerOptions: { anthropic: { effort, thinking: { ...THINKING } } },
          maxOutputTokens: MAX_OUTPUT_TOKENS[phase],
          telemetry: { isEnabled: false },
          abortSignal: deadline,
          onError: ({ error }) => {
            sawStreamError = true;
            logDiagnostic('streamText', error, ids, log);
          },
          onLanguageModelCallStart: event => {
            callIndex += 1;
            if (callIndex === 1) {
              log('[quiz-agent] request', {
                attemptId: ctx.attemptId,
                runId: ctx.runId,
                messages: event.messages.length,
                lastUserTextParts: lastUserTextParts(event.messages),
              });
            }
          },
          onLanguageModelCallEnd: event => {
            const u = event.usage;
            log('[quiz-agent] model call', {
              attemptId: ctx.attemptId,
              runId: ctx.runId,
              call: callIndex,
              model: event.modelId,
              keySource: ctx.keySource,
              phase,
              finish: String(event.finishReason ?? ''),
              inputTokens: numberOrZero(u?.inputTokens),
              noCacheTokens: numberOrZero(u?.inputTokenDetails?.noCacheTokens),
              cacheReadTokens: numberOrZero(u?.inputTokenDetails?.cacheReadTokens),
              cacheWriteTokens: numberOrZero(u?.inputTokenDetails?.cacheWriteTokens),
              outputTokens: numberOrZero(u?.outputTokens),
              reasoningTokens: numberOrZero(u?.outputTokenDetails?.reasoningTokens),
              ms: numberOrZero(event.performance?.responseTimeMs),
            });
          },
        });

      const pump = async (result: ReturnType<typeof call>) => {
        const ui = toUIMessageStream({
          stream: result.stream,
          tools,
          sendStart: false,
          sendFinish: false,
        });
        for await (const chunk of ui as unknown as AsyncIterable<UIMessageChunk>) {
          if (chunk.type === 'error') sawStreamError = true;
          writer.write(chunk as never);
        }
      };

      try {
        // A code-aware quiz without a repository this turn: a fixed hidden notice
        // after the student's message, never persisted.
        const codeNotice: ModelMessage[] = ctx.codeUnavailable
          ? [{ role: 'user', content: markServerText(ctx.attemptId, CODE_UNAVAILABLE_NOTICE) }]
          : [];
        let history: ModelMessage[] = [
          ...markStatusParts(ctx.attemptId, withoutEarlierFailedToolCalls(input.messages)),
          ...(input.extraMessages ?? []),
          ...codeNotice,
        ];
        let result = call(history);
        await pump(result);

        for (let i = 0; i < RECOVERY_CALLS && !deadline.aborted && !sawStreamError; i++) {
          const progress = await deps.getProgress(ctx.attemptId);
          if (!needsEvaluation(progress, turnStart)) break;
          const response = (await result.responseMessages) as ModelMessage[];
          history = [
            ...history,
            ...response,
            {
              role: 'user',
              content: markServerText(ctx.attemptId, deps.evaluationNotice(progress)),
            },
          ];
          log('[quiz-agent] recovery call', {
            attemptId: ctx.attemptId,
            runId: ctx.runId,
            n: i + 1,
          });
          result = call(history);
          await pump(result);
        }

        // Server completion needs no model, so a model error does not stop
        // it: every result is recorded, and the evaluation is written from them.
        let completedByServer = false;
        if (!deadline.aborted) {
          const progress = await deps.getProgress(ctx.attemptId);
          if (needsEvaluation(progress, turnStart)) {
            if (allResultsFinalized(progress)) {
              const record = await deps.completeFromGrades({
                attemptId: ctx.attemptId,
                fence: ctx.fence,
                inputMessageId: ctx.inputMessageId,
                runId: ctx.runId,
              });
              completedByServer = true;
              log('[quiz-agent] server completion', { attemptId: ctx.attemptId, runId: ctx.runId });
              writer.write({ type: 'data-evaluation', data: record });
            } else {
              notice('reply_failed');
            }
          }
        }
        if (sawStreamError && !deadline.aborted) {
          failed = true;
          // A completed attempt takes no more messages: no "send it again".
          if (!completedByServer) notice('reply_failed');
        }
      } catch (error) {
        failed = true;
        if (!(deadline.aborted && !timeout.aborted)) {
          // Not the student's own stop: record why (ids only) and say the reply failed.
          if (!timeout.aborted) {
            logDiagnostic('runQuizTurn', error, ids, log);
            notice('reply_failed');
          }
        }
      }
      if (timeout.aborted) {
        failed = true;
        notice('turn_stopped');
      }
      writer.write({ type: 'finish' });
    },
    onEnd: async ({ responseMessage, isAborted }) => {
      const message = cleanup(responseMessage as QuizUIMessage);
      if (!message.parts || message.parts.length === 0) return;
      const final = !isAborted && !failed && !deadline.aborted;
      try {
        await deps.persistAssistant(ctx.attemptId, message, { final });
      } catch (error) {
        logDiagnostic('persistAssistant', error, ids, log);
        if (isRefusal(error)) return;
        await new Promise(resolve => setTimeout(resolve, PERSIST_RETRY_DELAY_MS));
        try {
          await deps.persistAssistant(ctx.attemptId, message, { final });
          log('[quiz-agent] persistAssistant retry saved', {
            attemptId: ctx.attemptId,
            runId: ctx.runId,
          });
        } catch (retryError) {
          logDiagnostic('persistAssistant_retry', retryError, ids, log);
        }
      }
    },
  });

  const raw = stream as unknown as ReadableStream<UIMessageChunk>;
  return input.project === false ? raw : raw.pipeThrough(projectChunks());
}
