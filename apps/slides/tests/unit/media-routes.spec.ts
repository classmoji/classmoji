/**
 * The six media routes the slides app mounts.
 *
 * The upload client (`uploadMultipart`) and the "choose from media" picker talk
 * to whichever origin their editor is on, so the slides app has to answer the
 * same six endpoints the webapp does, with the same handlers — a copy per app
 * would be a chance per app to answer differently. Each route is a one-line
 * re-export from `@classmoji/auth/media-http`, where the gate and the error
 * shape live (and are tested). What is pinned here is the mount: the file
 * names React Router's flat routes turn into URLs, and which handler each one
 * exports under which name.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const read = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** Route folder → the export line it must carry. */
const MOUNTS: Record<string, string> = {
  'api.media.uploads': 'export { mediaUploadsAction as action }',
  'api.media.uploads_.$mediaId.parts': 'export { mediaPartsAction as action }',
  'api.media.uploads_.$mediaId.complete': 'export { mediaCompleteAction as action }',
  'api.media.uploads_.$mediaId.abort': 'export { mediaAbortAction as action }',
  'api.media.$mediaId': 'export { mediaDeleteAction as action }',
  'api.media.list': 'export { mediaListLoader as loader }',
};

test.describe('media routes', () => {
  for (const [folder, exportLine] of Object.entries(MOUNTS)) {
    test(`${folder} re-exports the shared handler`, () => {
      const slides = read(`../../app/routes/${folder}/route.ts`);
      expect(slides).toContain(`${exportLine} from '@classmoji/auth/media-http';`);
      // Nothing else: a route that grew its own logic would stop answering
      // exactly as the webapp's does.
      expect(slides.split('\n').filter(line => line.startsWith('export'))).toHaveLength(1);
      // And the same file the webapp mounts, so the two cannot drift.
      expect(slides).toBe(read(`../../../webapp/app/routes/${folder}/route.ts`));
    });
  }
});
