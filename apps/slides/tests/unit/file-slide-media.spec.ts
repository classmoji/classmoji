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
    expect(NEW_SOURCE).toContain('ClassmojiService.media.uploadCapabilityFor(classroom)');
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
});
