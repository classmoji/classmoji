/**
 * Slides deck engine — subpath entry (content-tools plan §2, Phase 3).
 *
 * NOT exported through the root services barrel: cheerio must not load through
 * `@classmoji/services` (webapp, mcp, hook-station, tasks all import the root
 * barrel at startup). The orchestrator wires this file into package.json as a
 * `./slides` subpath export (precedent: existing `./flags`) and hooks
 * `slideService` into ClassmojiService.
 */

export * from './deckTypes.ts';
export * from './deckHtml.ts';
export * from './slideContent.service.ts';
export * from './deckPreview.service.ts';
export * as slideService from './slide.service.ts';
