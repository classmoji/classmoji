/**
 * Model, key and effort for a quiz attempt's turn, resolved from the
 * classroom's settings row and the platform env.
 *
 * Ported from the ai-agent (`llm/utils/classroomKey.js`, `llm/utils/effort.js`
 * `resolveQuizEffortLevels`, the model priority in the agent-sdk provider):
 *
 * - The classroom's model and effort choices count only when the classroom
 *   has its own Anthropic key. Model and effort are cost knobs; a classroom on
 *   the platform key runs the platform's choices. A blank key is no key.
 * - Model priority: the classroom's (keyed only) > the platform env var > the
 *   code default. Code-aware quizzes read `code_aware_model`, standard quizzes
 *   `llm_model`; exploration reads `exploration_model` / `EXPLORATION_MODEL`.
 * - Every model must be on the adaptive-thinking allowlist. A stored model
 *   outside it falls back to the platform default for this run (the setting's
 *   name is logged, never its value's owner or the key); a platform default
 *   outside it falls back to the code default.
 * - Effort: classroom (keyed only) > env > code default; an invalid value at
 *   any tier is skipped. Exploration is capped at `high`. Every allowlisted
 *   model takes all five levels, so there is no per-model table.
 * - The key: the classroom's when it has one, else the platform's. The same
 *   key pays for exploration. A classroom key that fails is never retried on
 *   the platform key.
 */
import { FALLBACK_MODEL, isAllowedModel } from '@classmoji/utils/ai-models';

export { FALLBACK_MODEL };

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_QUESTION_EFFORT: Effort = 'medium';
export const DEFAULT_GRADING_EFFORT: Effort = 'high';
export const DEFAULT_EXPLORATION_EFFORT: Effort = 'low';
export const MAX_EXPLORATION_EFFORT: Effort = 'high';

/** The classroom settings columns this module reads. */
export type QuizSettingsRow = {
  anthropic_api_key?: string | null;
  llm_model?: string | null;
  code_aware_model?: string | null;
  exploration_model?: string | null;
  question_effort?: string | null;
  grading_effort?: string | null;
  exploration_effort?: string | null;
} | null;

export type QuizRunSettings = {
  model: string;
  questionEffort: Effort;
  gradingEffort: Effort;
  apiKey: string;
  keySource: 'platform' | 'classroom';
  exploration: { model: string; effort: Effort };
  /** Setting names whose stored value was not used (for one log line). */
  fallbacks: string[];
};

type Env = Record<string, string | undefined>;

export function hasClassroomKey(settings: QuizSettingsRow): boolean {
  const key = settings?.anthropic_api_key;
  return typeof key === 'string' && key.trim() !== '';
}

export function normalizeEffort(value: unknown): Effort | null {
  if (typeof value !== 'string') return null;
  const level = value.trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(level) ? (level as Effort) : null;
}

/** classroom > env > code default; invalid values are skipped. */
export function resolveEffort(
  classroomValue: unknown,
  envValue: unknown,
  codeDefault: Effort
): Effort {
  return normalizeEffort(classroomValue) ?? normalizeEffort(envValue) ?? codeDefault;
}

/** A level no higher than `ceiling`. */
export function capEffort(level: Effort, ceiling: Effort): Effort {
  return EFFORT_LEVELS.indexOf(level) > EFFORT_LEVELS.indexOf(ceiling) ? ceiling : level;
}

function present(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * One model slot: the classroom's choice when allowed, else the platform
 * default when allowed, else the code default. Records which named setting
 * was not used.
 */
function pickModel(
  classroomValue: string | null | undefined,
  envValue: string | undefined,
  settingName: string,
  envName: string,
  fallbacks: string[]
): string {
  if (present(classroomValue)) {
    const id = classroomValue.trim();
    if (isAllowedModel(id)) return id;
    fallbacks.push(settingName);
  }
  if (present(envValue)) {
    const id = envValue.trim();
    if (isAllowedModel(id)) return id;
    fallbacks.push(envName);
  }
  return FALLBACK_MODEL;
}

/**
 * Resolve the turn's model, efforts and key.
 *
 * @throws Error when neither the classroom nor the platform has a key
 */
export function resolveQuizRunSettings(
  settings: QuizSettingsRow,
  opts: { isCodeAware: boolean },
  env: Env = process.env
): QuizRunSettings {
  const keyed = hasClassroomKey(settings);
  const choice = <T>(value: T): T | undefined => (keyed ? value : undefined);
  const fallbacks: string[] = [];

  const apiKey = keyed ? settings!.anthropic_api_key!.trim() : env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error('No Anthropic key is configured');
    (error as Error & { code?: string }).code = 'NO_API_KEY';
    throw error;
  }

  if (!keyed) {
    const named = [
      settings?.llm_model,
      settings?.code_aware_model,
      settings?.exploration_model,
      settings?.question_effort,
      settings?.grading_effort,
      settings?.exploration_effort,
    ].some(present);
    if (named) fallbacks.push('classroom_choices_without_key');
  }

  const model = opts.isCodeAware
    ? pickModel(choice(settings?.code_aware_model), env.LLM_MODEL, 'code_aware_model', 'LLM_MODEL', fallbacks)
    : pickModel(choice(settings?.llm_model), env.LLM_MODEL, 'llm_model', 'LLM_MODEL', fallbacks);

  const explorationModel = pickModel(
    choice(settings?.exploration_model),
    env.EXPLORATION_MODEL,
    'exploration_model',
    'EXPLORATION_MODEL',
    fallbacks
  );

  return {
    model,
    questionEffort: resolveEffort(
      choice(settings?.question_effort),
      env.QUIZ_QUESTION_EFFORT,
      DEFAULT_QUESTION_EFFORT
    ),
    gradingEffort: resolveEffort(
      choice(settings?.grading_effort),
      env.QUIZ_GRADING_EFFORT,
      DEFAULT_GRADING_EFFORT
    ),
    apiKey,
    keySource: keyed ? 'classroom' : 'platform',
    exploration: {
      model: explorationModel,
      effort: capEffort(
        resolveEffort(
          choice(settings?.exploration_effort),
          env.EXPLORATION_EFFORT,
          DEFAULT_EXPLORATION_EFFORT
        ),
        MAX_EXPLORATION_EFFORT
      ),
    },
    fallbacks,
  };
}
