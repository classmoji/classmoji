/**
 * Reading a live page (classrooms with collab_enabled) for the MCP's read
 * tools: page_content_outline/_get, page_render and the page comment tools.
 * Kept apart from tools/pageContent.ts so a light tool can import it.
 */

import type { SnapshotResponse } from '@classmoji/collab';
import { ToolError } from '../mcp/errors.ts';
import {
  CollabRequestError,
  fetchSnapshot,
  liveReadError,
  type CollabEnv,
  type SnapshotViewer,
} from './client.ts';

const LIVE_UNCONFIGURED_NOTE =
  'The live editing service is not configured here, so this is the last saved version from ' +
  "git — it may be behind the live page. Live edits are refused; mode: 'preview' still works.";

/** Said whenever a read falls back to git because the live service is down. */
const LIVE_FALLBACK_NOTE =
  'The live editing service did not answer, so this is the last saved version from git — it ' +
  "may be behind the live page. Live edits fail until the service is back; mode: 'preview' " +
  'still works.';

/**
 * The live page for a read, or why the read falls back to git: `note` when
 * the service is down (said in the result), none for a page the live service
 * cannot hold (legacy HTML, no content file) — git then answers as today.
 */
export async function readLivePage(
  env: CollabEnv | null,
  page: { id: string },
  viewer: SnapshotViewer | null
): Promise<{ snapshot: SnapshotResponse<'page'> } | { fallbackNote: string | null }> {
  if (!env) return { fallbackNote: LIVE_UNCONFIGURED_NOTE };
  try {
    // An agent's read (viewer) is remembered by the live service for its pin;
    // a render passes null, so a picture never stands in for a read.
    const snapshot = await fetchSnapshot(env, 'page', page.id, viewer);
    return { snapshot };
  } catch (error) {
    if (error instanceof CollabRequestError) {
      if (error.unavailable) {
        console.warn('[mcp] Live page snapshot unavailable, reading git:', error.message);
        return { fallbackNote: LIVE_FALLBACK_NOTE };
      }
      if (error.code === 'legacy-html' || error.code === 'content-missing') {
        return { fallbackNote: null };
      }
      if (error.status === 404)
        throw new ToolError('not_found', 'Page not found in this classroom');
      throw liveReadError(error, 'page');
    }
    throw error;
  }
}
