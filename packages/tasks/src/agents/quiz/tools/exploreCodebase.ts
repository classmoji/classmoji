/**
 * `explore_codebase` for code-aware quizzes: the exploration pipeline run in
 * this process (design §3.10, Q14), not a child run.
 *
 * - Credentials: a read-only installation token for this one repository,
 *   minted here per call (never in a payload, never logged). A call after an
 *   expired token gets a fresh one.
 * - Payer: the attempt's resolved key (`ctx.apiKey`: the classroom's when it
 *   has one, else the platform's) with the resolved exploration model (Q18).
 * - What the student sees: one `data-step` per file read, path only. The tool
 *   part itself is `label` in the projection, so its input (the focus area,
 *   which names the next question) and its output never leave the task.
 * - History: each exploration is journalled (`exploration_completed`) with the
 *   excerpted paths and one summary line per file; the next exploration reads
 *   them back, in this run or a later one.
 * - At most one exploration in flight: a second concurrent call is refused.
 * - A failed exploration (token or pipeline) tells the model only
 *   `EXPLORATION_FAILED_TEXT`; the prompt says what to do next.
 */
import Anthropic from '@anthropic-ai/sdk';
import { tool } from 'ai';
import {
  ExploreCodebaseOutputSchema,
  ExploreCodebaseSchema,
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
import { logDiagnostic } from '../../shared/sanitize.ts';
import type { AttemptContext, GitOrgLike } from '../context.ts';
import { TOOL_DESCRIPTIONS } from './descriptions.ts';
import { aborted, isGradingRefusal } from './errors.ts';
import type { QuizToolDeps, QuizToolServices } from './index.ts';

/** How many earlier summary lines the file picker is shown. */
const MAX_PREVIOUS_FINDINGS = 30;

export const EXPLORATION_STOPPED_TEXT = 'This turn was stopped. Nothing was explored.';
export const EXPLORATION_BUSY_TEXT =
  'Another exploration is still running. Wait for its result before exploring again.';

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

export function exploreCodebaseTool(
  ctx: AttemptContext,
  exploration: NonNullable<AttemptContext['exploration']>,
  d: QuizToolDeps,
  services: QuizToolServices
) {
  let inFlight = false;
  const ids = { chatId: ctx.attemptId, runId: ctx.runId };

  return tool({
    description: TOOL_DESCRIPTIONS.explore_codebase,
    inputSchema: ExploreCodebaseSchema,
    outputSchema: ExploreCodebaseOutputSchema,
    execute: async (input, { toolCallId, abortSignal }): Promise<ExploreCodebaseOutput> => {
      // Refused at entry, before queueing: two calls in one step start together.
      if (inFlight) throw new Error(EXPLORATION_BUSY_TEXT);
      inFlight = true;
      try {
        return await d.queue(async () => {
          if (aborted(d.signal, abortSignal)) throw new Error(EXPLORATION_STOPPED_TEXT);
          const signal = abortSignal ? AbortSignal.any([d.signal, abortSignal]) : d.signal;

          const history = await services.grading
            .listExplorations(ctx.attemptId)
            .catch((error: unknown) => {
              logDiagnostic('explore_history', error, ids, d.log);
              return { filesRead: [] as string[], excerpts: [] as string[] };
            });
          const previousFindings = history.excerpts
            .flatMap(entry => entry.split('\n'))
            .filter(Boolean)
            .slice(-MAX_PREVIOUS_FINDINGS);

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
              previouslyReadFiles: history.filesRead,
              client: services.anthropic(ctx.apiKey),
              signal,
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
