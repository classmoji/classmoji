/**
 * The quiz agent's tools with their server-side executes (design §2.3).
 *
 * The set is fixed for an attempt and built in one order
 * (`QUIZ_TOOL_ORDER`), because the tools block is the front of the cached
 * prefix: present_question, record_question_result, offer_next_step,
 * submit_quiz_evaluation, and explore_codebase for code-aware attempts.
 *
 * Each execute hands its body to the per-attempt FIFO queue first, so the
 * calls of one step write in the order the model made them. Every write goes
 * through `ClassmojiService.quizGrading` with the turn's fence and the tool
 * call id (row lock, fence check, journal, replay-safe). Outputs are what the
 * service stored, never the call's own input: a re-run returns the original
 * card or grade.
 *
 * A set is built once per turn (the loop calls the factory per turn), so state
 * kept in this closure is per turn: once present_question has succeeded, an
 * offer_next_step in the same turn is refused, so a new question card never
 * arrives with buttons under it. The check runs inside the queue, after every
 * call the model made before it in the same step.
 */
import { tool, type ToolSet, type UIMessageStreamWriter } from 'ai';
import type Anthropic from '@anthropic-ai/sdk';
import {
  OfferNextStepSchema,
  PresentQuestionOutputSchema,
  QuestionResultOutputSchema,
  QuizEvaluationFeedbackSchema,
  QuizEvaluationRecordV2Schema,
  QuizQuestionSchema,
  RecordQuestionResultSchema,
  type OfferNextStep,
  type PresentQuestionOutput,
  type QuestionResultOutput,
  type QuizEvaluationRecordV2,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';
import type { ClassmojiService } from '@classmoji/services';
import { exploreRepository } from '../../shared/exploration/core.ts';
import type { DiagnosticLog } from '../../shared/sanitize.ts';
import type { ToolQueue } from '../../shared/toolQueue.ts';
import type { AttemptContext, GitOrgLike } from '../context.ts';
import { TOOL_DESCRIPTIONS } from './descriptions.ts';
import { aborted, OFFER_AFTER_QUESTION_TEXT, toolFailure, TURN_STOPPED_TEXT } from './errors.ts';
import { defaultAnthropic, exploreCodebaseTool, mintRepoToken } from './exploreCodebase.ts';

type Grading = typeof ClassmojiService.quizGrading;

/** The service calls the tools make; tests pass fakes. */
export type QuizToolServices = {
  grading: Pick<
    Grading,
    | 'presentQuestion'
    | 'finalizeQuestion'
    | 'completeWithEvaluation'
    | 'recordExploration'
    | 'listExplorations'
  >;
  mintRepoToken: (gitOrganization: GitOrgLike, repo: string) => Promise<string>;
  anthropic: (apiKey: string) => Anthropic;
  explore: typeof exploreRepository;
};

export type QuizToolDeps = {
  writer: UIMessageStreamWriter<QuizUIMessage>;
  queue: ToolQueue;
  /** The turn's deadline: the run's signal combined with the turn timeout. */
  signal: AbortSignal;
  /** Defaults to the real services; tests inject fakes. */
  services?: Partial<QuizToolServices>;
  log?: DiagnosticLog;
};

/** The grading service, loaded on first use so the prompt and tests stay light. */
async function realGrading(): Promise<QuizToolServices['grading']> {
  const { ClassmojiService: services } = await import('@classmoji/services');
  return services.quizGrading;
}

/** Lazily resolved grading service, shared by every tool of one set. */
function gradingResolver(injected?: QuizToolServices['grading']) {
  let pending: Promise<QuizToolServices['grading']> | null = injected
    ? Promise.resolve(injected)
    : null;
  return () => (pending ??= realGrading());
}

/** The `data-question-result` part id: one divider per question, one more for a revision. */
export const questionResultPartId = (out: QuestionResultOutput) =>
  `question-result-${out.question_num}${out.revised ? '-revised' : ''}`;

/**
 * The tool set for one turn. The order of the keys is the order the tools are
 * sent in; it never changes for an attempt.
 */
export function quizTools(ctx: AttemptContext, d: QuizToolDeps): ToolSet {
  const grading = gradingResolver(d.services?.grading);
  const ids = { attemptId: ctx.attemptId, runId: ctx.runId };
  const fenced = (toolCallId: string) => ({
    attemptId: ctx.attemptId,
    fence: ctx.fence,
    toolCallId,
    inputMessageId: ctx.inputMessageId,
    runId: ctx.runId,
  });
  const stopIfAborted = (abortSignal?: AbortSignal) => {
    if (aborted(d.signal, abortSignal)) throw new Error(TURN_STOPPED_TEXT);
  };
  /** A question card went out in this turn: the student answers next. */
  let questionPresented = false;

  const present_question = tool({
    description: TOOL_DESCRIPTIONS.present_question,
    inputSchema: QuizQuestionSchema,
    outputSchema: PresentQuestionOutputSchema,
    execute: (input, { toolCallId, abortSignal }): Promise<PresentQuestionOutput> =>
      d.queue(async () => {
        stopIfAborted(abortSignal);
        let out: PresentQuestionOutput;
        try {
          out = await (await grading()).presentQuestion(fenced(toolCallId), input);
        } catch (error) {
          throw toolFailure('present_question', error, ids, d.log);
        }
        questionPresented = true;
        return out;
      }),
  });

  const record_question_result = tool({
    description: TOOL_DESCRIPTIONS.record_question_result,
    inputSchema: RecordQuestionResultSchema,
    outputSchema: QuestionResultOutputSchema,
    execute: (input, { toolCallId, abortSignal }): Promise<QuestionResultOutput> =>
      d.queue(async () => {
        stopIfAborted(abortSignal);
        let out: QuestionResultOutput;
        try {
          out = await (await grading()).finalizeQuestion(fenced(toolCallId), input);
        } catch (error) {
          throw toolFailure('record_question_result', error, ids, d.log);
        }
        // The tool part is hidden from every viewer; the divider is this part,
        // carrying the stored result only. A fixed id per question keeps a
        // replayed call from drawing a second divider.
        try {
          d.writer.write({
            type: 'data-question-result',
            id: questionResultPartId(out),
            data: out,
          });
        } catch (error) {
          toolFailure('record_question_result', error, ids, d.log);
        }
        return out;
      }),
  });

  const offer_next_step = tool({
    description: TOOL_DESCRIPTIONS.offer_next_step,
    inputSchema: OfferNextStepSchema,
    outputSchema: OfferNextStepSchema,
    execute: (input, { abortSignal }): Promise<OfferNextStep> =>
      d.queue(async () => {
        stopIfAborted(abortSignal);
        if (questionPresented) throw new Error(OFFER_AFTER_QUESTION_TEXT);
        return { actions: [...input.actions] };
      }),
  });

  const submit_quiz_evaluation = tool({
    description: TOOL_DESCRIPTIONS.submit_quiz_evaluation,
    inputSchema: QuizEvaluationFeedbackSchema,
    outputSchema: QuizEvaluationRecordV2Schema,
    execute: (input, { toolCallId, abortSignal }): Promise<QuizEvaluationRecordV2> =>
      d.queue(async () => {
        stopIfAborted(abortSignal);
        try {
          return await (
            await grading()
          ).completeWithEvaluation(fenced(toolCallId), {
            source: 'model',
            feedback: input,
          });
        } catch (error) {
          throw toolFailure('submit_quiz_evaluation', error, ids, d.log);
        }
      }),
  });

  const tools: ToolSet = {
    present_question,
    record_question_result,
    offer_next_step,
    submit_quiz_evaluation,
  };

  if (ctx.isCodeAware && ctx.exploration) {
    const lazyGrading: QuizToolServices['grading'] = {
      presentQuestion: async (...a) => (await grading()).presentQuestion(...a),
      finalizeQuestion: async (...a) => (await grading()).finalizeQuestion(...a),
      completeWithEvaluation: async (...a) => (await grading()).completeWithEvaluation(...a),
      recordExploration: async (...a) => (await grading()).recordExploration(...a),
      listExplorations: async (...a) => (await grading()).listExplorations(...a),
    };
    tools.explore_codebase = exploreCodebaseTool(ctx, ctx.exploration, d, {
      grading: lazyGrading,
      mintRepoToken: d.services?.mintRepoToken ?? mintRepoToken,
      anthropic: d.services?.anthropic ?? defaultAnthropic,
      explore: d.services?.explore ?? exploreRepository,
    });
  }

  return tools;
}
