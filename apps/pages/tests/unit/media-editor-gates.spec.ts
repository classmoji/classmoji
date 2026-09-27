/**
 * Who the pages app hands media powers to, read from source.
 *
 * The loader and `/api/media-url` need Postgres and a content repo to run, so
 * what is pinned here is their ORDER and their conditions — the approach
 * `upload-body-gate.spec.ts` takes for the upload routes. Getting either wrong
 * is silent: a capability handed to a reader, or a media URL signed before the
 * edit check, passes every functional test there is.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const LOADER_SOURCE = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');
const MEDIA_URL_SOURCE = source('../../app/routes/api.media-url/route.ts');

test.describe('the upload capability', () => {
  test('is handed only to someone editing, never in read-only preview', () => {
    expect(LOADER_SOURCE).toContain(
      'const uploadCapability = canEdit && !previewActive ? await loadUploadCapability(page) : null;'
    );
    // Returned to the client under that name, and computed nowhere else.
    expect(LOADER_SOURCE.match(/uploadCapabilityFor\(/g)).toHaveLength(1);
    expect(LOADER_SOURCE).toMatch(/\n {4}uploadCapability,\n/);
  });

  test('a lookup failure degrades to null instead of failing the editor', () => {
    const helper = LOADER_SOURCE.slice(
      LOADER_SOURCE.indexOf('async function loadUploadCapability')
    );
    const tried = helper.indexOf('try {');
    const lookup = helper.indexOf('ClassmojiService.media.uploadCapabilityFor(');
    const fallback = helper.indexOf('return null;');
    for (const at of [tried, lookup, fallback]) expect(at).toBeGreaterThan(-1);
    expect(tried).toBeLessThan(lookup);
    expect(lookup).toBeLessThan(fallback);
  });
});

test.describe('/api/media-url', () => {
  test('refuses anything but a media reference, and checks edit access before signing', () => {
    const shape = MEDIA_URL_SOURCE.indexOf('!isMediaRef(ref)');
    const gate = MEDIA_URL_SOURCE.indexOf(
      "await assertPageAccess({ request, page, accessType: 'edit' });"
    );
    const sign = MEDIA_URL_SOURCE.indexOf('contentDelivery.resolveAssetUrl(');

    for (const at of [shape, gate, sign]) expect(at).toBeGreaterThan(-1);
    expect(shape).toBeLessThan(gate);
    expect(gate).toBeLessThan(sign);
  });

  test('signs on the edit tier, for the page’s own classroom', () => {
    expect(MEDIA_URL_SOURCE).toContain('tierFor({ canEdit: true })');
    expect(MEDIA_URL_SOURCE).toContain('page.classroom as unknown');
    // A loader (GET), with no action: it changes nothing.
    expect(MEDIA_URL_SOURCE).toContain('export const loader');
    expect(MEDIA_URL_SOURCE).not.toContain('export const action');
  });
});
