/**
 * Clean slide markup — browser-safe entry (`@classmoji/services/slides/safe-markup`):
 * the lists (rules.ts) and the DOM engine (client.ts). The cheerio engine is
 * `@classmoji/services/slides/safe-markup/server`.
 */

export * from './rules.ts';
export * from './client.ts';
export { walkMarkup, type MarkupAdapter, type SanitizeMode } from './walk.ts';
