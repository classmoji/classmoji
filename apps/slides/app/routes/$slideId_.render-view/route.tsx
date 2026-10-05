/**
 * `/{slideId}/render-view` — the page the MCP's `deck_render` screenshots.
 *
 * A RESOURCE route (no component, no app chrome). Everything lives in
 * `~/utils/deckView.server.ts`; only `loader` is exported, so nothing
 * server-side can be pulled into the client bundle through this module.
 */
import { deckViewLoader } from '~/utils/deckView.server';

export const loader = deckViewLoader;
