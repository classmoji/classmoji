/**
 * The quiz agent's transcript storage: Neon is the system of record and
 * application code writes every row.
 *
 * - `loadContext` is the admission boundary (admission.ts): it runs for every
 *   turn and every action and returns the canonical history.
 * - `load` returns the canonical rows in order plus the runtime's cursors and
 *   opaque state, which the runtime seeds its shadow and `.in` resume point
 *   from.
 * - `save` keeps ONLY the cursors and the runtime state. It never persists a
 *   message: the runtime folds a failed turn's wire message (including one
 *   admission refused) into what it saves, and derives removals from its own
 *   accumulator, which can differ from Neon. Message ops are counted and
 *   logged by id count only.
 *
 * Every method throws only fixed copy (sanitize.ts): the runtime logs and
 * streams `error.message` from storage failures verbatim.
 */
import type {
  LoadContextEvent,
  TranscriptChangeset,
  TranscriptCursors,
  TranscriptScope,
  TranscriptStorage,
  TranscriptStorageContext,
} from '@trigger.dev/sdk/ai';
import type { UIMessage } from 'ai';
import type { QuizUIMessage } from '@classmoji/utils/quiz-agent';
import { admitTurn, type AdmissionDeps } from './admission.ts';
import { toTurnError, type DiagnosticLog } from '../shared/sanitize.ts';

export type RuntimeState = { cursors?: unknown; state?: unknown };

export type StorageDeps = AdmissionDeps & {
  loadCanonicalMessages: (attemptId: string) => Promise<QuizUIMessage[]>;
  readRuntimeState: (attemptId: string) => Promise<RuntimeState | null>;
  writeRuntimeState: (
    attemptId: string,
    v: { cursors: TranscriptCursors | undefined; state: unknown }
  ) => Promise<void>;
  /** The current run's id (set at boot by the agent). */
  runId: () => string;
  log?: DiagnosticLog;
};

export function createQuizTranscriptStorage(deps: StorageDeps): TranscriptStorage<unknown> {
  const log: DiagnosticLog = deps.log ?? ((line, fields) => console.log(line, fields));

  return {
    async load<TUIMessage extends UIMessage = UIMessage>(scope: TranscriptScope<unknown>) {
      try {
        const [messages, runtime] = await Promise.all([
          deps.loadCanonicalMessages(scope.chatId),
          deps.readRuntimeState(scope.chatId),
        ]);
        return {
          messages: messages as unknown as TUIMessage[],
          state: runtime?.state ?? null,
          ...(runtime?.cursors ? { cursors: runtime.cursors as TranscriptCursors } : {}),
        };
      } catch (error) {
        throw toTurnError('storage.load', error, { chatId: scope.chatId, runId: deps.runId() }, { log });
      }
    },

    async save(ctx: TranscriptStorageContext<unknown>, changeset: TranscriptChangeset) {
      const ids = { chatId: ctx.chatId, runId: ctx.runId };
      try {
        let puts = 0;
        let removals = 0;
        for (const change of changeset.changes) {
          if (change.op === 'put') puts += 1;
          else if (change.op === 'remove' || change.op === 'truncateAfter') removals += 1;
        }
        if (removals > 0) {
          log('[quiz-agent] storage ignored removals', { ...ids, removals, reason: changeset.reason });
        }
        if (puts > 0) {
          log('[quiz-agent] storage ignored message puts', { ...ids, puts, reason: changeset.reason });
        }
        await deps.writeRuntimeState(ctx.chatId, {
          cursors: changeset.cursors,
          state: changeset.transcript?.state ?? null,
        });
      } catch (error) {
        throw toTurnError('storage.save', error, ids, { log });
      }
    },

    async loadContext<TUIMessage extends UIMessage = UIMessage>(
      scope: TranscriptScope<unknown>,
      event: LoadContextEvent<unknown, TUIMessage>
    ): Promise<TUIMessage[]> {
      const runId = deps.runId();
      try {
        const messages = await admitTurn(
          scope.chatId,
          { trigger: event.trigger, incomingMessages: event.incomingMessages },
          runId,
          deps
        );
        return messages as unknown as TUIMessage[];
      } catch (error) {
        throw toTurnError('storage.loadContext', error, { chatId: scope.chatId, runId }, { log });
      }
    },
  };
}
