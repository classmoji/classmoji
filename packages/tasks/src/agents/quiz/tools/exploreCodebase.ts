/**
 * `explore_codebase` for code-aware quizzes: the exploration pipeline run in
 * this process (design §3.10, Q14), not a child run.
 *
 * - Credentials: a read-only installation token for this one repository,
 *   minted here per call (never in a payload, never logged). A call after an
 *   expired token gets a fresh one.
 * - Payer: the attempt's resolved key (`ctx.apiKey`: the classroom's when it
 *   has one, else the platform's) with the resolved exploration model (Q18).
 *   Each exploration model call logs one usage line (ids, model, key source,
 *   token counts) like the quiz loop's.
 * - What the student sees: one `data-step` per file read, path only. The tool
 *   part itself is `label` in the projection, so its input (the focus area,
 *   which names the next question) and its output never leave the task.
 * - History: each exploration is journalled (`exploration_completed`) with the
 *   excerpted paths and one summary line per file; the next exploration reads
 *   them back, in this run or a later one.
 * - At most one exploration in flight: a second concurrent call is refused.
 * - At most `MAX_EXPLORATIONS_PER_TURN` per turn (the set is built per turn),
 *   failed ones included; after that the call is refused with fixed text, so
 *   a model that keeps exploring moves on to the question instead.
 * - Every call names its purpose. `check_current` (re-reading code for the
 *   question the student is on) is always allowed. `prepare_next` (code for
 *   the next question) is refused while a question is open, i.e. the last
 *   presented question has no recorded result; the quiz tools say which.
 *   That check runs in the queue, after the calls the model made before this
 *   one; a refused call reads nothing and does not count toward the per-turn
 *   limit.
 * - A failed exploration (token or pipeline) tells the model only
 *   `EXPLORATION_FAILED_TEXT`; the prompt says what to do next.
 * - Every file read is kept (server side, per process) in the code-quote
 *   cache, so a later `code_quote` checks the lines the model was shown.
 * - The quiz's excluded paths (`exploration.excludedPaths`, read every turn,
 *   so an edit applies from the next turn) are left out of the tree the file
 *   picker sees and are never read; earlier explorations' notes on them are
 *   dropped too (they may predate an edit). What an earlier turn's
 *   exploration already showed the model stays in its history.
 */
import Anthropic from '@anthropic-ai/sdk';
import { tool } from 'ai';
import {
  ExploreCodebaseOutputSchema,
  ExploreCodebaseSchema,
  TOOL_DESCRIPTIONS,
  type ExploreCodebaseOutput,
} from '@classmoji/utils/quiz-agent';
import {
  excerptedPaths,
  excerptSummaryLines,
  EXPLORATION_FAILED_TEXT,
  ExplorationStoppedError,
  formatExcerptResult,
  providerStatus,
} from '../../shared/exploration/core.ts';
import { pathExclusion } from '../../shared/exploration/excludedPaths.ts';
import { logDiagnostic, type DiagnosticLog } from '../../shared/sanitize.ts';
import type { AttemptContext, GitOrgLike } from '../context.ts';
import { QuoteFileCache } from './codeQuote.ts';
import { aborted, isGradingRefusal } from './errors.ts';
import type { QuizToolDeps, QuizToolServices } from './index.ts';

/** How many earlier summary lines the file picker is shown. */
const MAX_PREVIOUS_FINDINGS = 30;

export const EXPLORATION_STOPPED_TEXT = 'This turn was stopped. Nothing was explored.';
export const EXPLORATION_BUSY_TEXT =
  'Another exploration is still running. Wait for its result before exploring again.';
export const EXPLORATION_LIMIT_TEXT =
  'You have explored enough this turn. Continue with what you have.';

export const EXPLORATION_QUESTION_OPEN_TEXT =
  'A question is still open. Use purpose check_current for it; explore for the next only after the student moves on and you record its result.';

/** The quiz tools' view of the turn: whether a question is open right now. */
export type ExploreGate = { questionOpen: () => boolean };

/** Explorations one turn may start, successful and failed alike. */
export const MAX_EXPLORATIONS_PER_TURN = 3;

/** Mint a read-only installation token for one repository of the organization. */
export async function mintRepoToken(gitOrganization: GitOrgLike, repo: string): Promise<string> {
  const { getGitProvider } = await import('@classmoji/services');
  const { token } = await getGitProvider(gitOrganization).getInstallationToken({
    repositories: [repo],
    permissions: { contents: 'read' },
  });
  return token;
}

export const defaultAnthropic = (apiKey: string): Anthropic => new Anthropic({ apiKey });

/** The usage and rate-limit lines' sink when the turn passes no log (agent.ts's format). */
// eslint-disable-next-line no-console -- a plain run log line, as agent.ts writes them
const consoleLog: DiagnosticLog = (line, fields) => console.log(line, JSON.stringify(fields));

export function exploreCodebaseTool(
  ctx: AttemptContext,
  exploration: NonNullable<AttemptContext['exploration']>,
  d: QuizToolDeps,
  services: QuizToolServices,
  gate?: ExploreGate
) {
  let inFlight = false;
  let started = 0;
  const ids = { chatId: ctx.attemptId, runId: ctx.runId };
  const isExcluded = pathExclusion(exploration.excludedPaths);
  /** The path an exploration summary line is about (`path: lines a–b: why`). */
  const summaryPath = (line: string) => {
    const end = line.indexOf(': ');
    return end === -1 ? line : line.slice(0, end);
  };

  return tool({
    description: TOOL_DESCRIPTIONS.explore_codebase,
    inputSchema: ExploreCodebaseSchema,
    outputSchema: ExploreCodebaseOutputSchema,
    execute: async (input, { toolCallId, abortSignal }): Promise<ExploreCodebaseOutput> => {
      // Refused at entry, before queueing: two calls in one step start together.
      if (inFlight) throw new Error(EXPLORATION_BUSY_TEXT);
      if (started >= MAX_EXPLORATIONS_PER_TURN) throw new Error(EXPLORATION_LIMIT_TEXT);
      started += 1;
      inFlight = true;
      try {
        return await d.queue(async () => {
          if (aborted(d.signal, abortSignal)) throw new Error(EXPLORATION_STOPPED_TEXT);
          // Preparing the next question waits until the current one is
          // finished; checking the current one never does.
          if (input.purpose !== 'check_current' && gate?.questionOpen()) {
            started -= 1;
            throw new Error(EXPLORATION_QUESTION_OPEN_TEXT);
          }
          const signal = abortSignal ? AbortSignal.any([d.signal, abortSignal]) : d.signal;

          const history = await services.grading
            .listExplorations(ctx.attemptId)
            .catch((error: unknown) => {
              logDiagnostic('explore_history', error, ids, d.log);
              return { filesRead: [] as string[], excerpts: [] as string[] };
            });
          const previousFindings = history.excerpts
            .flatMap(entry => entry.split('\n'))
            .filter(line => line && !isExcluded(summaryPath(line)))
            .slice(-MAX_PREVIOUS_FINDINGS);
          const previouslyReadFiles = history.filesRead.filter(path => !isExcluded(path));

          // Any failure below reaches the model as EXPLORATION_FAILED_TEXT only;
          // the real error is logged with ids and error facts, by phase.
          const failed = (label: 'explore_token' | 'explore_codebase', error: unknown) => {
            if (error instanceof ExplorationStoppedError || aborted(d.signal, abortSignal)) {
              return new Error(EXPLORATION_STOPPED_TEXT);
            }
            logDiagnostic(label, error, ids, d.log, { status: providerStatus(error) });
            return new Error(EXPLORATION_FAILED_TEXT);
          };

          let token: string;
          try {
            token = await services.mintRepoToken(exploration.gitOrganization, exploration.repo);
          } catch (error) {
            throw failed('explore_token', error);
          }

          let result;
          try {
            result = await services.explore({
              owner: exploration.owner,
              repo: exploration.repo,
              token,
              model: exploration.model,
              effort: exploration.effort,
              focusArea: input.focus_area,
              depth: input.depth ?? 'focused',
              specificQuestion: input.specific_question ?? null,
              previousFindings,
              previouslyReadFiles,
              excludedPaths: exploration.excludedPaths ?? [],
              client: services.anthropic(ctx.apiKey),
              signal,
              callLog: {
                log: d.log ?? consoleLog,
                attemptId: ctx.attemptId,
                runId: ctx.runId,
                keySource: ctx.keySource,
              },
              onFileContent: (path, content) => {
                services.quoteCache.set(
                  QuoteFileCache.key(ctx.attemptId, exploration.owner, exploration.repo, path),
                  content
                );
              },
              onFileRead: (path, o) => {
                try {
                  d.writer.write({
                    type: 'data-step',
                    data: {
                      kind: 'read_file',
                      path,
                      ...(o?.error ? { error: true as const } : {}),
                    },
                  });
                } catch (error) {
                  logDiagnostic('explore_step', error, ids, d.log);
                }
              },
            });
          } catch (error) {
            throw failed('explore_codebase', error);
          }
          if (aborted(d.signal, abortSignal)) throw new Error(EXPLORATION_STOPPED_TEXT);

          const filesRead = excerptedPaths(result.excerpts);
          try {
            await services.grading.recordExploration(
              {
                attemptId: ctx.attemptId,
                fence: ctx.fence,
                toolCallId,
                inputMessageId: ctx.inputMessageId,
                runId: ctx.runId,
              },
              { filesRead, excerpts: excerptSummaryLines(result.excerpts).join('\n') }
            );
          } catch (error) {
            logDiagnostic('explore_journal', error, ids, d.log);
            // A superseded turn keeps nothing; any other failure only loses history.
            if (isGradingRefusal(error) && error.code === 'stale_turn')
              throw new Error(error.message);
          }

          return { excerpts: formatExcerptResult(result, input.focus_area), files_read: filesRead };
        });
      } finally {
        inFlight = false;
      }
    },
  });
}
