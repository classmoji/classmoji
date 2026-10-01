/**
 * What runs when a classroom names no model or effort (or has no key of its
 * own): the "Default: X" on each AI settings select.
 *
 * Quiz models (standard, code-aware, exploration) come from
 * platformDefaultModel in @classmoji/utils/ai-models, the resolver the quiz
 * runtime (packages/tasks agents/quiz/settings.ts) uses: LLM_MODEL or
 * EXPLORATION_MODEL when it is on the allow-list, else FALLBACK_MODEL. Code-aware
 * quizzes fall through the same chain as standard ones.
 *
 * The rest mirror the ai-agent. If a fallback changes there, change it here:
 *   - Ask Moji model: services/syllabusBot.js (SYLLABUS_BOT_MODEL, then
 *     LLM_MODEL, then the literal below; no allow-list)
 *   - efforts: utils/effort.js (resolveEffort: an env value that is not a level
 *     is ignored; exploration is capped at high). Ask Moji's is
 *     SYLLABUS_BOT_EFFORT, then low.
 */

import { platformDefaultModel } from '@classmoji/utils/ai-models';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** Ask Moji's literal in the ai-agent when SYLLABUS_BOT_MODEL and LLM_MODEL are unset. */
const DEFAULT_ASK_MOJI_MODEL = 'claude-sonnet-5';

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
  const quizModel = platformDefaultModel(env.LLM_MODEL);
  const explorationEffort = effortFromEnv(env.EXPLORATION_EFFORT, 'low');

  return {
    llm_model: quizModel,
    code_aware_model: quizModel,
    exploration_model: platformDefaultModel(env.EXPLORATION_MODEL),
    syllabus_bot_model: env.SYLLABUS_BOT_MODEL || env.LLM_MODEL || DEFAULT_ASK_MOJI_MODEL,
    question_effort: effortFromEnv(env.QUIZ_QUESTION_EFFORT, 'medium'),
    grading_effort: effortFromEnv(env.QUIZ_GRADING_EFFORT, 'high'),
    exploration_effort:
      explorationEffort === 'xhigh' || explorationEffort === 'max' ? 'high' : explorationEffort,
    syllabus_bot_effort: effortFromEnv(env.SYLLABUS_BOT_EFFORT, 'low'),
  };
}
