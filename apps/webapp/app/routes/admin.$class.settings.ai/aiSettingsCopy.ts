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
} as const;

export const isInstructionsErrorCode = (
  code: string
): code is keyof typeof INSTRUCTIONS_ERROR_COPY =>
  Object.prototype.hasOwnProperty.call(INSTRUCTIONS_ERROR_COPY, code);
