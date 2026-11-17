// The address check lives in @classmoji/utils so the roster service, the MCP
// and the email task share it with registration and account settings.
export { INVALID_EMAIL_MESSAGE, isValidEmail, normalizeEmail } from '@classmoji/utils/email';
