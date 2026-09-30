/**
 * The `quiz-attempt` chat agent: one durable conversation per quiz attempt
 * (chat id = attempt id), suspended between messages.
 *
 * - Storage (storage.ts) owns the model's context: `loadContext` admits
 *   exactly one student message or the `begin` action per turn and returns
 *   the canonical history from Neon; `save` keeps cursors only.
 * - `onAction('begin')` stores the hidden opening message and runs a turn on
 *   it (the action's turn does not hydrate again, so the opening is also
 *   appended to the runtime chain).
 * - `run()` builds the turn's context from Neon and pipes the projected
 *   stream from `runQuizTurn` (loop.ts).
 * - `onBeforeTurnComplete` closes the session once the attempt is complete.
 * - Every callback is sanitized: whatever it throws leaves as fixed copy.
 */
import { chat } from '@trigger.dev/sdk/ai';
import type { ModelMessage, UIMessage } from 'ai';
import { z } from 'zod';
import { ClassmojiService } from '@classmoji/services';
import { buildTurnStatus, quizToolDefs, type QuizUIMessage } from '@classmoji/utils/quiz-agent';
import { currentAdmission } from './admission.ts';
import { attemptCompleted, attemptHasQuestion, loadAttemptContext } from './context.ts';
import { runQuizTurn } from './loop.ts';
import { evaluationNotice } from './prompt/index.ts';
import { createQuizTranscriptStorage } from './storage.ts';
import { quizTools } from './tools/index.ts';
import { QuizTurnError, sanitized, type DiagnosticLog } from '../shared/sanitize.ts';

export const QUIZ_AGENT_CONCURRENCY = 35;

// One line per event, ids and counts only. Plain console output: the run's logs
// capture it in every environment and `trigger dev` prints it locally.
const log: DiagnosticLog = (line, fields) => console.log(line, JSON.stringify(fields));

/** The run this process serves, set at boot (loadContext's event carries no run id). */
let currentRunId = 'unknown';

const quizTranscriptStorage = createQuizTranscriptStorage({
  admitStudentMessage: i => ClassmojiService.quizChat.admitStudentMessage(i),
  admitAction: i => ClassmojiService.quizChat.admitAction(i),
  loadCanonicalMessages: attemptId => ClassmojiService.quizChat.loadCanonicalMessages(attemptId),
  recordTurnRefused: (attemptId, code, runId) =>
    ClassmojiService.quizChat.recordTurnRefused(attemptId, code, runId),
  readRuntimeState: attemptId => ClassmojiService.quizChat.readRuntimeState(attemptId),
  writeRuntimeState: (attemptId, v) => ClassmojiService.quizChat.writeRuntimeState(attemptId, v),
  onPermanentRefusal: () => chat.close(),
  runId: () => currentRunId,
  log,
});

/** Text parts on a UI message (the admitted student row carries the hidden status as its second). */
function textPartCount(message: UIMessage | undefined): number {
  return message ? message.parts.filter(p => p.type === 'text').length : 0;
}

export const quizAttemptAgent = chat.agent({
  id: 'quiz-attempt',
  // Exploration holds file reads in memory, as the explore-repo task does.
  machine: 'small-2x',
  oomMachine: 'medium-1x',
  maxDuration: 3600,
  queue: { name: 'quiz-attempt', concurrencyLimit: QUIZ_AGENT_CONCURRENCY },
  idleTimeoutInSeconds: 10,
  turnTimeout: '1h',
  chatAccessTokenTTL: '15m',
  // A hint at most, never identity or settings; absent when the client sends none.
  clientDataSchema: z.object({ timezone: z.string().max(64).optional() }).optional(),
  actionSchema: z.discriminatedUnion('type', [z.object({ type: z.literal('begin') })]),
  tools: quizToolDefs,
  storage: quizTranscriptStorage,

  onBoot: sanitized('onBoot', async ({ runId }: { runId: string }) => {
    currentRunId = runId;
    const integrations = (globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown[] })
      .AI_SDK_TELEMETRY_INTEGRATIONS;
    log('[quiz-agent] boot', {
      runId,
      telemetryIntegrations: Array.isArray(integrations) ? integrations.length : 0,
    });
  }),

  onAction: sanitized('onAction', async ({ action, chatId }: { action: { type: 'begin' }; chatId: string }) => {
    if (action.type !== 'begin') return;
    if (await attemptHasQuestion(chatId)) return;
    const opening = (await ClassmojiService.quizChat.storeHiddenOpening(chatId)) as QuizUIMessage;
    const chain = chat.history.all();
    if (!chain.some(m => m.id === opening.id)) {
      chat.history.set([...chain, opening as unknown as UIMessage]);
    }
    return chat.turn();
  }),

  run: sanitized(
    'run',
    async ({
      chatId,
      messages,
      signal,
      ctx,
    }: {
      chatId: string;
      messages: ModelMessage[];
      signal: AbortSignal;
      ctx: { run: { id: string } };
    }) => {
      const admission = currentAdmission(chatId);
      if (!admission) throw new QuizTurnError('reply_failed');
      if (messages.at(-1)?.role !== 'user') {
        log('[quiz-agent] turn has nothing to answer', { attemptId: chatId, runId: ctx.run.id });
        return;
      }

      const attempt = await loadAttemptContext(chatId, admission, { log });

      // The admitted row carries the per-turn status as a hidden second text
      // part. If the runtime's chain lost it, send the status as a separate,
      // non-persisted user message instead.
      const chain = chat.history.all();
      // The begin turn has no admitted student message; its hidden opening
      // message (the chain's last user message) carries the status instead.
      const admitted = admission.inputMessageId
        ? chain.find(m => m.id === admission.inputMessageId)
        : [...chain].reverse().find(m => m.role === 'user');
      const statusInChain = admitted ? textPartCount(admitted) >= 2 : null;
      const extraMessages: ModelMessage[] =
        statusInChain === false
          ? [{ role: 'user', content: buildTurnStatus(attempt.progress) }]
          : [];
      log('[quiz-agent] turn', {
        attemptId: chatId,
        runId: ctx.run.id,
        codeAware: attempt.isCodeAware ? 1 : 0,
        presented: attempt.progress.presented,
        finalized: attempt.progress.finalized.length,
        statusInChain: statusInChain === null ? 'n/a' : statusInChain ? 'yes' : 'no',
        action: admission.action ?? 'none',
      });

      const stream = runQuizTurn({
        ctx: attempt,
        messages,
        signal,
        extraMessages,
        deps: {
          tools: quizTools,
          getProgress: attemptId => ClassmojiService.quizGrading.getProgress(attemptId),
          completeFromGrades: f =>
            ClassmojiService.quizGrading.completeWithEvaluation(f, { source: 'server' }),
          persistAssistant: (attemptId, message, o) =>
            ClassmojiService.quizChat.persistAssistantMessage(attemptId, message, o),
          evaluationNotice,
          cleanupParts: message => chat.cleanupAbortedParts(message),
          log,
        },
      });
      await chat.pipe(stream);
    }
  ),

  onBeforeTurnComplete: sanitized('onBeforeTurnComplete', async ({ chatId }: { chatId: string }) => {
    if (await attemptCompleted(chatId)) chat.close();
  }),
});
