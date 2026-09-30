/**
 * The quiz agent's tools with their server-side executes (design §2.3).
 *
 * The set is fixed for an attempt and built in one order
 * (`QUIZ_TOOL_ORDER`), because the tools block is the front of the cached
 * prefix: present_question, record_question_result, offer_next_step,
 * submit_quiz_evaluation, explore_codebase for code-aware attempts, then
 * content_get and content_search for attempts with course material.
 *
 * Each execute hands its body to the per-attempt FIFO queue first, so the
 * calls of one step write in the order the model made them. Every write goes
 * through `ClassmojiService.quizGrading` with the turn's fence and the tool
 * call id (row lock, fence check, journal, replay-safe). Outputs are what the
 * service stored, never the call's own input: a re-run returns the original
 * card or grade.
 *
 * A set is built once per turn (the loop calls the factory per turn, and its
 * recovery calls share the set), so state kept in this closure is per turn:
 * once present_question has succeeded, an offer_next_step in the same turn is
 * refused, and once offer_next_step has succeeded, a present_question in the
 * same turn is refused (before anything is written), so a question card and
 * buttons never arrive together, in either order. A present_question that
 * shows the current question again (an earlier turn's card) is refused once
 * the model has written text in the turn: re-showing is for a student who
 * asks to see the question, at the start of the reply. A record_question_result
 * for a question whose card went out in the same turn is refused too, before
 * anything is written: the student has not seen it yet, so there is nothing
 * to rate. Recording an earlier question (the one the student is moving on
 * from) is unaffected. A first result for a question is recorded only when
 * the student moves on from it: in a turn they opened with Next, or when the
 * call says their message asked to skip or move on
 * (`student_asked_to_move_on`); otherwise it is refused before anything is
 * written, so a correct answer never shows its result before the Next click.
 * A result already recorded (a revision) is left to the service's own rules.
 * offer_next_step carries the model's feedback on the answer in its input
 * (`feedback`, which the schema requires to be non-blank; the browser shows it
 * as the agent's message, above the buttons), so feedback and buttons arrive
 * together. Before it comes the correct answer (`expected_answer`), saved with
 * the reply for staff and cut by the projection for every student. How much feedback to write is the description's to say, never a
 * count here. The call is refused in a turn the student opened with Try again
 * (that reply is a hint, which ends with a question), for Try again without
 * Next, and once an offer has gone out in the turn. Its output carries the
 * buttons and the fixed line shown with them (`lead_in`, chosen from the
 * buttons and whether the student is on the last question).
 *
 * A question is open while the last presented question has no recorded
 * result. While one is open, present_question for a later question is refused
 * (question 1 has nothing to wait for), and so is explore_codebase with
 * purpose `prepare_next`, in every turn: the student's result comes before any
 * exploration for the next question. Exploring with `check_current` (the
 * question the student is on) is always allowed. The open-question state
 * starts from the turn's stored progress and follows this turn's successful
 * calls. The checks run inside the queue, after every call the model made
 * before them in the same step.
 *
 * In a code-aware attempt present_question also takes `code_quote`: lines of
 * the student's file by number, which the server reads and puts on the card
 * as exact code with its `source` (codeQuote.ts). The quote is resolved after
 * the checks above and before the write, so a refused quote writes nothing.
 * A free-typed `code_snippet` is still accepted when there is no quote. A
 * quote with `edit` (one line changed, for the question that asks the student
 * to find the change) is taken for one question per attempt: the journal's
 * presented cards say which question already has one, and a second is
 * refused before the file is read.
 *
 * An attempt whose quiz has linked material or course search also gets
 * content_get and content_search, after the others (content.ts): lookups in
 * the course material through the Classmoji MCP server, as the attempt's user.
 */
import { tool, type ToolSet, type UIMessageStreamWriter } from 'ai';
import type Anthropic from '@anthropic-ai/sdk';
import {
  CodeAwareQuizQuestionSchema,
  nextStepLeadIn,
  OfferNextStepOutputSchema,
  OfferNextStepSchema,
  PresentQuestionOutputSchema,
  QuestionResultOutputSchema,
  QuizEvaluationFeedbackSchema,
  QuizEvaluationRecordV2Schema,
  QuizQuestionSchema,
  RecordQuestionResultSchema,
  TOOL_DESCRIPTIONS,
  type CodeAwareQuizQuestion,
  type OfferNextStepOutput,
  type PresentQuestionOutput,
  type QuestionCard,
  type QuestionResultOutput,
  type QuizEvaluationRecordV2,
  type QuizUIMessage,
} from '@classmoji/utils/quiz-agent';
import type { ClassmojiService } from '@classmoji/services';
import {
  ExplorationStoppedError,
  exploreRepository,
  providerStatus,
} from '../../shared/exploration/core.ts';
import { logDiagnostic, type DiagnosticLog } from '../../shared/sanitize.ts';
import type { ToolQueue } from '../../shared/toolQueue.ts';
import type { AttemptContext, GitOrgLike } from '../context.ts';
import {
  languageForPath,
  QuoteRefusal,
  quoteFileCache,
  resolveCodeQuote,
  type QuoteFileCache,
} from './codeQuote.ts';
import {
  aborted,
  editLimitText,
  OFFER_AFTER_HINT_TEXT,
  OFFER_AFTER_QUESTION_TEXT,
  OFFER_TRY_AGAIN_ALONE_TEXT,
  OFFER_TWICE_TEXT,
  QUESTION_AFTER_OFFER_TEXT,
  QUOTE_READ_FAILED_TEXT,
  RECORD_BEFORE_ANSWER_TEXT,
  reshowAfterText,
  RECORD_BEFORE_NEXT_TEXT,
  recordBeforePresentText,
  toolFailure,
  TURN_STOPPED_TEXT,
} from './errors.ts';
import { connectMcp, contentTools, mintMcpToken, type ConnectMcp } from './content.ts';
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
  /** Where file lines are kept for code quotes; exploration fills it too. */
  quoteCache: QuoteFileCache;
  /** Reads one file for a code quote; defaults to the Contents API read. */
  readFile?: (owner: string, repo: string, path: string, token: string) => Promise<string>;
  /** The attempt user's MCP bearer for the content tools (content.ts). */
  mintMcpToken?: (userId: string) => Promise<string>;
  /** Opens the MCP client one content lookup uses. */
  connectMcp?: ConnectMcp;
  /**
   * The question numbers whose stored card shows edited code (`source.changed`);
   * defaults to reading the attempt's journal.
   */
  editedQuestions?: (attemptId: string) => Promise<number[]>;
};

export type QuizToolDeps = {
  writer: UIMessageStreamWriter<QuizUIMessage>;
  queue: ToolQueue;
  /** The turn's deadline: the run's signal combined with the turn timeout. */
  signal: AbortSignal;
  /** Defaults to the real services; tests inject fakes. */
  services?: Partial<QuizToolServices>;
  log?: DiagnosticLog;
  /**
   * Whether the model has written visible text in this turn; the loop sets it.
   * Read by present_question (a re-show after text is refused).
   */
  textWritten: () => boolean;
};

/** The grading service, loaded on first use so the prompt and tests stay light. */
async function realGrading(): Promise<QuizToolServices['grading']> {
  const { ClassmojiService: services } = await import('@classmoji/services');
  return services.quizGrading;
}

/**
 * From `question_presented` journal payloads, the numbers of the questions
 * whose stored card shows edited code, ascending.
 */
export function editedQuestionNumbers(payloads: readonly unknown[]): number[] {
  const numbers = new Set<number>();
  for (const payload of payloads) {
    const p = payload as {
      question_number?: unknown;
      output?: { question_number?: unknown; card?: { source?: { changed?: unknown } } };
    } | null;
    const n = p?.output?.question_number ?? p?.question_number;
    if (p?.output?.card?.source?.changed === true && typeof n === 'number') numbers.add(n);
  }
  return [...numbers].sort((a, b) => a - b);
}

/** The attempt's questions presented with edited code, from its journal. */
async function editedQuestionsFromJournal(attemptId: string): Promise<number[]> {
  const { default: getPrisma } = await import('@classmoji/database');
  const events = await getPrisma().quizAttemptEvent.findMany({
    where: { attempt_id: attemptId, type: 'question_presented' },
    select: { payload: true },
  });
  return editedQuestionNumbers(events.map(e => e.payload));
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
  /** The question numbers whose card went out in this turn (as stored). */
  const presentedThisTurn = new Set<number>();
  /** The last question presented so far, this turn included. */
  let lastPresented = ctx.progress.presented;
  /** The questions with a recorded result so far, this turn included. */
  const recorded = new Set<number>(ctx.progress.finalized);
  /** No question is open: none presented yet, or the last one has its result. */
  const noQuestionOpen = () => lastPresented < 1 || recorded.has(lastPresented);
  /** Next-step buttons went out in this turn: the student chooses next. */
  let offerMade = false;
  const editedQuestions = d.services?.editedQuestions ?? editedQuestionsFromJournal;

  /**
   * The earlier question whose stored card already shows edited code, or
   * null. Read only for a quote with `edit`, for a question not yet out (a
   * turn presents at most one, and stops once it has); a failed read is a
   * retryable tool failure.
   */
  const earlierEdit = async (questionNumber: number): Promise<number | null> => {
    let stored: number[];
    try {
      stored = await editedQuestions(ctx.attemptId);
    } catch (error) {
      throw toolFailure('present_question', error, ids, d.log);
    }
    return stored.find(n => n !== questionNumber) ?? null;
  };
  /** The repository a code quote reads, for a code-aware attempt; null otherwise. */
  const quoteRepo = ctx.isCodeAware && ctx.exploration ? ctx.exploration : null;
  const quoteCache = d.services?.quoteCache ?? quoteFileCache;
  const repoToken = d.services?.mintRepoToken ?? mintRepoToken;

  /**
   * The card to store: the input without `code_quote`, and, when there is a
   * quote, its exact code and source in place of any typed code. A refused
   * quote throws its message for the model; nothing has been written.
   */
  const cardFor = async (
    input: CodeAwareQuizQuestion,
    abortSignal?: AbortSignal
  ): Promise<QuestionCard> => {
    const { code_quote: quote, ...card } = input;
    // The question already out comes back from the service as stored (or is
    // refused), whatever this call says, so there is nothing to read for it.
    if (!quote || !quoteRepo || input.question_number <= lastPresented) return card;
    // One question per attempt shows edited code: the one that asks the
    // student to find the change. Refused before the file is read.
    if (quote.edit) {
      const earlier = await earlierEdit(input.question_number);
      if (earlier !== null) {
        d.log?.('[quiz-agent] code quote refused', { ...ids, reason: 'edit_limit' });
        throw new Error(editLimitText(earlier));
      }
    }
    const signal = abortSignal ? AbortSignal.any([d.signal, abortSignal]) : d.signal;
    let built;
    try {
      built = await resolveCodeQuote(
        quote,
        { attemptId: ctx.attemptId, ...quoteRepo },
        { mintRepoToken: repoToken, readFile: d.services?.readFile, cache: quoteCache },
        signal
      );
    } catch (error) {
      if (error instanceof QuoteRefusal) {
        d.log?.('[quiz-agent] code quote refused', { ...ids, reason: error.reason });
        throw new Error(error.message);
      }
      if (error instanceof ExplorationStoppedError || aborted(d.signal, abortSignal)) {
        throw new Error(TURN_STOPPED_TEXT);
      }
      logDiagnostic('code_quote', error, { chatId: ids.attemptId, runId: ids.runId }, d.log, {
        status: providerStatus(error),
      });
      throw new Error(QUOTE_READ_FAILED_TEXT);
    }
    d.log?.('[quiz-agent] code quote', {
      ...ids,
      lines: built.shownLines,
      ranges: quote.ranges.length,
      changed: built.source.changed,
      cached: built.cached,
    });
    return {
      ...card,
      code_snippet: built.code,
      code_language: card.code_language ?? languageForPath(built.source.path),
      source: built.source,
    };
  };

  const present_question = tool({
    description: TOOL_DESCRIPTIONS.present_question,
    // Fixed for the attempt: only a code-aware attempt's schema has
    // `code_quote`. A standard attempt's input never carries one (the schema
    // drops unknown keys), so both are typed as the code-aware input.
    inputSchema: (quoteRepo
      ? CodeAwareQuizQuestionSchema
      : QuizQuestionSchema) as typeof CodeAwareQuizQuestionSchema,
    outputSchema: PresentQuestionOutputSchema,
    execute: (input, { toolCallId, abortSignal }): Promise<PresentQuestionOutput> =>
      d.queue(async () => {
        stopIfAborted(abortSignal);
        // Refused before the write: a card the student never sees must not
        // count as presented.
        if (offerMade) throw new Error(QUESTION_AFTER_OFFER_TEXT);
        // Showing the question already out again is for a student who asks
        // to see it, at the start of the reply: after text (feedback, say)
        // the turn would end with the old card and no buttons.
        if (
          input.question_number === lastPresented &&
          !presentedThisTurn.has(input.question_number) &&
          d.textWritten()
        ) {
          throw new Error(reshowAfterText(lastPresented, !noQuestionOpen()));
        }
        // The question the student is leaving is recorded first, so its
        // result shows before the next card. Showing the current question
        // again is left to the service (it returns the stored card).
        if (input.question_number > lastPresented && !noQuestionOpen()) {
          throw new Error(recordBeforePresentText(lastPresented));
        }
        const card = await cardFor(input, abortSignal);
        stopIfAborted(abortSignal);
        let out: PresentQuestionOutput;
        try {
          out = await (await grading()).presentQuestion(fenced(toolCallId), card);
        } catch (error) {
          throw toolFailure('present_question', error, ids, d.log);
        }
        questionPresented = true;
        presentedThisTurn.add(out.question_number);
        lastPresented = Math.max(lastPresented, out.question_number);
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
        const { student_asked_to_move_on: askedToMoveOn, ...result } = input;
        // Refused before the write: a question presented in this turn has no
        // answer yet.
        if (presentedThisTurn.has(result.question_num)) {
          throw new Error(RECORD_BEFORE_ANSWER_TEXT);
        }
        // A first result waits for the student to move on: a Next click, or
        // their message asking to skip or move on, which the call says. An
        // answer alone, even a correct one, gets feedback and the buttons.
        if (
          !recorded.has(result.question_num) &&
          ctx.lastAction !== 'next' &&
          askedToMoveOn !== true
        ) {
          throw new Error(RECORD_BEFORE_NEXT_TEXT);
        }
        let out: QuestionResultOutput;
        try {
          out = await (await grading()).finalizeQuestion(fenced(toolCallId), result);
        } catch (error) {
          throw toolFailure('record_question_result', error, ids, d.log);
        }
        recorded.add(out.question_num);
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
    outputSchema: OfferNextStepOutputSchema,
    execute: (input, { abortSignal }): Promise<OfferNextStepOutput> =>
      d.queue(async () => {
        stopIfAborted(abortSignal);
        if (questionPresented) throw new Error(OFFER_AFTER_QUESTION_TEXT);
        // A Try again turn is a hint: it ends with a question, not buttons.
        if (ctx.lastAction === 'try_again') throw new Error(OFFER_AFTER_HINT_TEXT);
        // One offer per turn: a second (same step) would show its feedback
        // and buttons twice.
        if (offerMade) throw new Error(OFFER_TWICE_TEXT);
        // The line shown with the buttons, from the buttons and whether the
        // student is on the last question (no card goes out in an offer's turn).
        const leadIn = nextStepLeadIn(input.actions, lastPresented >= ctx.questionCount);
        if (leadIn === null) throw new Error(OFFER_TRY_AGAIN_ALONE_TEXT);
        offerMade = true;
        // The feedback stays in the input, which the browser renders.
        return { actions: [...input.actions], lead_in: leadIn };
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
    tools.explore_codebase = exploreCodebaseTool(
      ctx,
      ctx.exploration,
      d,
      {
        grading: lazyGrading,
        mintRepoToken: repoToken,
        anthropic: d.services?.anthropic ?? defaultAnthropic,
        explore: d.services?.explore ?? exploreRepository,
        quoteCache,
      },
      { questionOpen: () => !noQuestionOpen() }
    );
  }

  // The course-material lookups, last: only for an attempt that has them.
  if (ctx.content) {
    Object.assign(
      tools,
      contentTools(ctx, ctx.content, d, {
        mintToken: d.services?.mintMcpToken ?? mintMcpToken,
        connect: d.services?.connectMcp ?? connectMcp,
      })
    );
  }

  return tools;
}
