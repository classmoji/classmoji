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

export type ResolvedModel = {
  model: string;
  /** requested: the stored/configured choice; platform_default / fallback: it was not allowed. */
  source: 'requested' | 'platform_default' | 'fallback';
};

/**
 * The model to run: the requested id when allowed, else the platform default when
 * allowed, else FALLBACK_MODEL. A null or empty request means "use the platform
 * default" and resolves the same way.
 */
export function resolveAllowedModel(
  requested: string | null | undefined,
  platformDefault: string | null | undefined
): ResolvedModel {
  if (requested && isAllowedModel(requested)) return { model: requested, source: 'requested' };
  if (platformDefault && isAllowedModel(platformDefault)) {
    return { model: platformDefault, source: 'platform_default' };
  }
  return { model: FALLBACK_MODEL, source: 'fallback' };
}
