/**
 * The models the chat agents may run: the GA models that think adaptively with
 * thinking display omitted by default. A model id matches an entry exactly, or
 * the entry plus a date suffix (`claude-sonnet-5-20260101`); never by prefix, so
 * `claude-opus-5` does not admit `claude-opus-5-5`.
 */

export const ALLOWED_MODELS = [
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
  'claude-sonnet-5',
  'claude-fable-5-1',
  'claude-fable-5',
] as const;

export type AllowedModel = (typeof ALLOWED_MODELS)[number];

/**
 * The code default for every AI surface: what a quiz model slot (quiz,
 * exploration, prompt assistant) runs when neither the classroom's choice nor
 * the platform's env value is allowed (or set), and what Ask Moji runs when
 * SYLLABUS_BOT_MODEL and LLM_MODEL are both unset.
 */
export const FALLBACK_MODEL: AllowedModel = 'claude-sonnet-5-5';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MODEL_PATTERNS = ALLOWED_MODELS.map(m => new RegExp(`^${escape(m)}(-\\d{8})?$`));

export const isAllowedModel = (id: string | null | undefined): id is string =>
  typeof id === 'string' && MODEL_PATTERNS.some(re => re.test(id));

/**
 * The model a slot runs when the classroom names none: the platform's env value
 * (trimmed) when it is allowed, else FALLBACK_MODEL. Both quiz runtimes (the
 * ai-agent and the Trigger.dev quiz tasks) and the "Default: X" on the AI
 * settings page read it, so they name the same model.
 */
export function platformDefaultModel(envValue: string | null | undefined): string {
  const id = typeof envValue === 'string' ? envValue.trim() : '';
  return isAllowedModel(id) ? id : FALLBACK_MODEL;
}

/** Thinking options for every model call of every agent. */
export const THINKING = { type: 'adaptive', display: 'omitted' } as const;

export type QuizModelPick = {
  /** The model the slot runs. */
  model: string;
  /**
   * The NAMES of the settings that named a model off the allow-list and were
   * skipped: the classroom setting, the env var, or both. Never their values.
   */
  fallbacks: string[];
};

/**
 * One quiz model slot (standard or code-aware quiz, exploration, the prompt
 * assistant), the one rule both quiz runtimes apply — the ai-agent and the
 * Trigger.dev quiz tasks: the classroom's choice when it is allowed, else the
 * platform's env value when it is allowed, else FALLBACK_MODEL. Values are
 * trimmed, a dated id of an allowed model is allowed, and a blank value names
 * nothing (it is not recorded as a fallback).
 *
 * The caller gates the classroom's choice on its key first and passes
 * undefined for a classroom without one.
 */
export function pickQuizModel(
  classroomValue: string | null | undefined,
  envValue: string | null | undefined,
  names: { setting: string; env: string }
): QuizModelPick {
  const fallbacks: string[] = [];
  const requested = typeof classroomValue === 'string' ? classroomValue.trim() : '';
  if (requested) {
    if (isAllowedModel(requested)) return { model: requested, fallbacks };
    fallbacks.push(names.setting);
  }
  const platform = typeof envValue === 'string' ? envValue.trim() : '';
  if (platform && !isAllowedModel(platform)) fallbacks.push(names.env);
  return { model: platformDefaultModel(envValue), fallbacks };
}
