/**
 * Which runtime a NEW quiz attempt runs on.
 *
 * `QUIZ_TRIGGER_RUNTIME` is read here and nowhere else, and only when an
 * attempt is created: the result is stamped on the attempt
 * (`quiz_attempts.agent_runtime`), and everything after that — the session
 * route, the chat drawer, the legacy api.quiz actions, the Trigger task — acts
 * on the stamp, never on the switch. Turning the switch off sends new attempts
 * to the ai-agent while attempts already on the chat runtime finish there.
 *
 * - unset, `off`, or any value not listed below → `ai_agent`
 * - `code_aware` → `trigger_chat` for quizzes with a linked repository and
 *   code context turned on, `ai_agent` for every other quiz
 * - `all` → `trigger_chat` for every quiz
 */

export type AgentRuntime = 'ai_agent' | 'trigger_chat';

export interface RuntimeQuiz {
  repository_id?: string | null;
  include_code_context?: boolean | null;
}

type RuntimeSwitch = 'off' | 'code_aware' | 'all';

const readSwitch = (env: NodeJS.ProcessEnv): RuntimeSwitch => {
  const value = (env.QUIZ_TRIGGER_RUNTIME ?? '').trim().toLowerCase();
  return value === 'code_aware' || value === 'all' ? value : 'off';
};

export const isCodeAwareQuiz = (quiz: RuntimeQuiz | null | undefined): boolean =>
  Boolean(quiz?.repository_id && quiz?.include_code_context);

export function runtimeFor(
  quiz: RuntimeQuiz | null | undefined,
  env: NodeJS.ProcessEnv = process.env
): AgentRuntime {
  switch (readSwitch(env)) {
    case 'all':
      return 'trigger_chat';
    case 'code_aware':
      return isCodeAwareQuiz(quiz) ? 'trigger_chat' : 'ai_agent';
    default:
      return 'ai_agent';
  }
}

/**
 * Whether the legacy api.quiz actions (startQuiz, sendMessage, completeQuiz)
 * may act on this attempt: only one stamped `ai_agent`. A value the field does
 * not carry (a row read without the column) is the column's default,
 * `ai_agent`; any other stamp belongs to another runtime.
 */
export const isLegacyRuntimeAttempt = (
  attempt: { agent_runtime?: unknown } | null | undefined
): boolean => attempt?.agent_runtime == null || attempt.agent_runtime === 'ai_agent';

/** Whether this attempt runs on the chat runtime (the session route's rule). */
export const isTriggerChatAttempt = (
  attempt: { agent_runtime?: unknown } | null | undefined
): boolean => attempt?.agent_runtime === 'trigger_chat';
