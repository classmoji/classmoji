/**
 * What the ai-agent runs when a classroom names no model or effort (or has no
 * key of its own): the "Default: X" on each AI settings select.
 *
 * A mirror, not a source. The ai-agent decides; this reads the same env vars
 * with the same code fallbacks so the page names what the ai-agent will use.
 * If a fallback changes there, change it here:
 *   - quiz models: apps/ai-agent/src/llm/providers/agent-sdk/index.js
 *     (AgentSDKProvider: LLM_MODEL, then the literal below). Code-aware quizzes
 *     fall through the same chain: api.quiz sends code_aware_model as `model`.
 *   - exploration model: explorationTool.js DEFAULT_EXPLORATION_MODEL
 *   - Ask Moji model: services/syllabusBot.js (SYLLABUS_BOT_MODEL, then
 *     LLM_MODEL, then the literal)
 *   - efforts: utils/effort.js (resolveEffort: an env value that is not a level
 *     is ignored; exploration is capped at high). Ask Moji's is
 *     SYLLABUS_BOT_EFFORT, then low.
 */

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** The ai-agent's literal when LLM_MODEL is unset. */
const DEFAULT_LLM_MODEL = 'claude-sonnet-5';
const DEFAULT_EXPLORATION_MODEL = 'claude-sonnet-5';

export interface PlatformAIDefaults {
  llm_model: string;
  code_aware_model: string;
  exploration_model: string;
  syllabus_bot_model: string;
  question_effort: EffortLevel;
  grading_effort: EffortLevel;
  exploration_effort: EffortLevel;
  syllabus_bot_effort: EffortLevel;
}

/** The level an env value names (case and whitespace forgiven), or the default. */
const effortFromEnv = (value: string | undefined, codeDefault: EffortLevel): EffortLevel => {
  const level = value?.trim().toLowerCase();
  return EFFORT_LEVELS.find(known => known === level) ?? codeDefault;
};

export function getPlatformAIDefaults(
  env: Record<string, string | undefined> = process.env
): PlatformAIDefaults {
  const quizModel = env.LLM_MODEL || DEFAULT_LLM_MODEL;
  const explorationEffort = effortFromEnv(env.EXPLORATION_EFFORT, 'low');

  return {
    llm_model: quizModel,
    code_aware_model: quizModel,
    exploration_model: env.EXPLORATION_MODEL || DEFAULT_EXPLORATION_MODEL,
    syllabus_bot_model: env.SYLLABUS_BOT_MODEL || quizModel,
    question_effort: effortFromEnv(env.QUIZ_QUESTION_EFFORT, 'medium'),
    grading_effort: effortFromEnv(env.QUIZ_GRADING_EFFORT, 'high'),
    exploration_effort:
      explorationEffort === 'xhigh' || explorationEffort === 'max' ? 'high' : explorationEffort,
    syllabus_bot_effort: effortFromEnv(env.SYLLABUS_BOT_EFFORT, 'low'),
  };
}
