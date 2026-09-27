/**
 * FILE slides whose document lives in the classroom's media store.
 *
 * On a Pro classroom a document over the repository's cap goes from the
 * browser straight to media, and the create/replace form then posts only the
 * uploaded object's id. The service re-checks everything about that object
 * from its row (pinned in `slideFile.service.test.ts`); what is pinned here is
 * the route structure around it, which needs a database to run: the id path
 * sits behind the same gate as the upload, holds no upload slot, and a
 * media-backed slide is never bounced to the GitHub stream or described as
 * being deleted from GitHub.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const NEW_SOURCE = source('../../app/routes/$classroomSlug.new/route.tsx');
const REPLACE_SOURCE = source('../../app/routes/$classroomSlug.$slideId.replace/route.tsx');
const VIEWER_SOURCE = source('../../app/routes/$slideId/route.tsx');
const DELETE_SOURCE = source('../../app/routes/$classroomSlug.$slideId.delete/route.tsx');

test.describe('creating a file slide from media', () => {
  test('the id path runs behind the teaching-team gate', () => {
    const action = NEW_SOURCE.slice(NEW_SOURCE.indexOf('export const action'));
    const gate = action.indexOf('requireClassroomTeachingTeam(');
    const media = action.indexOf('createFileSlideFromMedia(');
    expect(gate).toBeGreaterThan(-1);
    expect(media).toBeGreaterThan(gate);
  });

  test('the form routes a large document with the storage router, not a size literal', () => {
    expect(NEW_SOURCE).toContain('slideFileTarget(uploadCapability, file)');
    expect(NEW_SOURCE).not.toContain('file.size > upload.maxBytes');
    expect(NEW_SOURCE).toContain("loadUploadCapability(classroom, 'new slide')");
  });
});

test.describe('a capability lookup that fails', () => {
  const HELPER = source('../../app/utils/uploadCapability.server.ts');
  const IMPORT_PAGE = source('../../app/routes/import/route.tsx');

  test('is null with a warning, never a failed loader', () => {
    const body = HELPER.slice(HELPER.indexOf('export async function loadUploadCapability'));
    expect(body).toMatch(
      /try \{\s*return await ClassmojiService\.media\.uploadCapabilityFor\(classroom\);\s*\} catch/
    );
    expect(body).toContain('console.warn(');
    expect(body).toContain('return null;');
  });

  test('every slides loader asks through it, and none calls the service bare', () => {
    expect(VIEWER_SOURCE).toContain("loadUploadCapability(slide.classroom, 'deck editor')");
    expect(NEW_SOURCE).toContain("loadUploadCapability(classroom, 'new slide')");
    expect(REPLACE_SOURCE).toContain("loadUploadCapability(slide.classroom, 'replace slide file')");
    expect(IMPORT_PAGE).toContain("loadUploadCapability(classroom, 'slides.com import')");
    for (const text of [VIEWER_SOURCE, NEW_SOURCE, REPLACE_SOURCE, IMPORT_PAGE]) {
      expect(text).not.toContain('ClassmojiService.media.uploadCapabilityFor(');
    }
    // The null answer is read as "no media" wherever a loader looks inside it.
    expect(NEW_SOURCE).toContain('uploadCapability?.media');
    expect(REPLACE_SOURCE).toContain('uploadCapability?.media');
    expect(IMPORT_PAGE).toContain('videosToMedia: uploadCapability?.media != null');
  });
});

test.describe('replacing a file slide with media', () => {
  const action = REPLACE_SOURCE.slice(REPLACE_SOURCE.indexOf('export const action'));

  test('is gated like the upload, and takes no upload slot', () => {
    const gate = action.indexOf('authorizeFileSlide(');
    const media = action.indexOf('replaceFromMedia(');
    const slot = action.indexOf('acquireUploadSlot()');
    expect(gate).toBeGreaterThan(-1);
    expect(media).toBeGreaterThan(gate);
    expect(slot).toBeGreaterThan(media);
  });

  test('hands the id to the service, which checks the row', () => {
    expect(REPLACE_SOURCE).toContain('replaceSlideFileWithMedia({ slideId, mediaId })');
    expect(REPLACE_SOURCE).toContain('slideFileTarget(uploadCapability, file)');
    expect(REPLACE_SOURCE).not.toContain('file.size > upload.maxBytes');
  });
});

test.describe('reading and deleting a media-backed file slide', () => {
  test('the viewer never bounces one to the GitHub stream', () => {
    expect(VIEWER_SOURCE).toContain("signed.reason === 'delivery_off' && !slide.media_id");
  });

  test('the delete screen does not say its file leaves GitHub', () => {
    expect(DELETE_SOURCE).toContain('mediaBacked');
    expect(DELETE_SOURCE).toContain("Its file stays in this class's media.");
  });

  test('the delete screen decides "media-backed" by the service’s own rule — media_id wins', () => {
    // Not its own copy of the condition: a row with BOTH media_id and
    // source_path (a class import) is media-backed here exactly as it is to
    // the delete and to every download path.
    expect(DELETE_SOURCE).toContain('const mediaBacked = isMediaBackedFileSlide(slideInfo.slide);');
    expect(DELETE_SOURCE).not.toContain('!slideInfo.slide.source_path');
  });
});

test.describe('a refused document uploaded to media for the slide', () => {
  const HOOK = source('../../app/hooks/useDiscardRefusedUpload.ts');
  const CHECK = source('../../app/utils/uploadedMedia.server.ts');
  const CLIENT = source('../../app/utils/mediaClient.ts');

  test('both actions say whether it may be discarded, from the database', () => {
    const newCatch = NEW_SOURCE.slice(NEW_SOURCE.indexOf('createFileSlideFromMedia('));
    expect(newCatch.slice(0, newCatch.indexOf('const file = formData.get'))).toContain(
      'discardMedia: await mediaUnusedBySlides(mediaId)'
    );
    const replace = REPLACE_SOURCE.slice(REPLACE_SOURCE.indexOf('replaceSlideFileWithMedia('));
    expect(replace.slice(0, replace.indexOf('return redirect('))).toContain(
      'discardMedia: await mediaUnusedBySlides(mediaId)'
    );
    // Unused means NO slide points at it; any doubt keeps it.
    expect(CHECK).toContain('slide.count({ where: { media_id: mediaId } })');
    expect(CHECK).toMatch(/catch[\s\S]*return false;/);
  });

  test('the server never deletes by a posted id; the browser does, through the gated route', () => {
    for (const text of [NEW_SOURCE, REPLACE_SOURCE, CHECK]) {
      expect(text).not.toContain('media.deleteMedia(');
    }
    expect(CLIENT).toContain(
      "fetch(`/api/media/${encodeURIComponent(mediaId)}`, { method: 'DELETE' })"
    );
    expect(HOOK).toContain('actionData.discardMedia === true');
  });

  test('each form remembers the id it posts, and only that one', () => {
    for (const text of [NEW_SOURCE, REPLACE_SOURCE]) {
      expect(text).toContain('useDiscardRefusedUpload(actionData)');
      const remember = text.indexOf('rememberUpload(result.mediaId);');
      expect(remember).toBeGreaterThan(-1);
      expect(text.indexOf('mediaId: result.mediaId }', remember)).toBeGreaterThan(remember);
    }
  });
});
