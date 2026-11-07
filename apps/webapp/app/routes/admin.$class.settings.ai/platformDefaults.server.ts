/**
 * What runs when a classroom names no model or effort (or has no key of its
 * own): the "Default: X" on each AI settings select.
 *
 * Quiz models (standard, code-aware, exploration) come from
 * platformDefaultModel in @classmoji/utils/ai-models, the env step of
 * pickQuizModel, which the Trigger.dev quiz tasks import: LLM_MODEL or
 * EXPLORATION_MODEL when it is on the allow-list, else FALLBACK_MODEL.
 * Code-aware quizzes fall through the same chain as standard ones.
 *
 * Ask Moji's model is SYLLABUS_BOT_MODEL, then LLM_MODEL, under the same
 * allow-list: the env value runs only when it is allowed, else FALLBACK_MODEL
 * (the ask-moji agent's settings).
 *
 * The efforts mirror the Trigger.dev tasks' settings (the ai-agent
 * submodule's src/trigger/quiz/settings.ts and src/trigger/askMoji/settings.ts:
 * an env value that is not a level is ignored; exploration is capped at
 * high). If a fallback changes there, change it here. Ask Moji's is
 * SYLLABUS_BOT_EFFORT, then low.
 */

import { platformDefaultModel } from '@classmoji/utils/ai-models';

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

type EffortLevel = (typeof EFFORT_LEVELS)[number];

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
    syllabus_bot_model: platformDefaultModel(env.SYLLABUS_BOT_MODEL?.trim() || env.LLM_MODEL),
    question_effort: effortFromEnv(env.QUIZ_QUESTION_EFFORT, 'medium'),
    grading_effort: effortFromEnv(env.QUIZ_GRADING_EFFORT, 'high'),
    exploration_effort:
      explorationEffort === 'xhigh' || explorationEffort === 'max' ? 'high' : explorationEffort,
    syllabus_bot_effort: effortFromEnv(env.SYLLABUS_BOT_EFFORT, 'low'),
  };
}
