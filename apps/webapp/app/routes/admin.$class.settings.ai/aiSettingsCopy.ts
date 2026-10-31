/**
 * Fixed values of the AI settings actions: the audit surface name and the
 * lines a refused instructions save shows, by validation code
 * (`ClassroomSettingsValidationError.code` from updateSettings).
 */
import { INSTRUCTIONS_MAX_CHARS } from '@classmoji/utils/ask-moji/limits';

/** The audit `data.tool` of every save on the AI settings page. */
export const AI_SETTINGS_AUDIT_TOOL = 'web:settings.ai';

/** The fixed lines for a refused instructions save, by validation code. */
export const INSTRUCTIONS_ERROR_COPY = {
  INSTRUCTIONS_INVALID: 'Ask Moji instructions must be text.',
  INSTRUCTIONS_TOO_LONG: `Ask Moji instructions can be at most ${INSTRUCTIONS_MAX_CHARS.toLocaleString('en-US')} characters.`,
  /** Not a validation code: the save was refused because this server's Ask Moji does not read them. */
  INSTRUCTIONS_UNAVAILABLE: "Ask Moji instructions aren't available on this server.",
} as const;

/** The validation codes updateSettings may refuse an instructions save with. */
const VALIDATION_CODES: ReadonlySet<string> = new Set([
  'INSTRUCTIONS_INVALID',
  'INSTRUCTIONS_TOO_LONG',
]);

export const isInstructionsErrorCode = (
  code: string
): code is 'INSTRUCTIONS_INVALID' | 'INSTRUCTIONS_TOO_LONG' => VALIDATION_CODES.has(code);
