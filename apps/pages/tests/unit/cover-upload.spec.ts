/**
 * Page covers go through the storage router, and their failures read as
 * sentences.
 *
 * The hook needs a live fetcher and the media routes, so its WIRING is read
 * from source (the approach `upload-body-gate.spec.ts` takes); the one pure
 * piece — which string a failed action is shown as — is called directly.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import { actionFailureMessage } from '~/components/editor/media/uploadRouting.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const HOOK_SOURCE = source('../../app/components/editor/media/useCoverUpload.ts');
const HEADER_SOURCE = source('../../app/components/editor/HeaderImage.tsx');
const ROUTE_SOURCE = source('../../app/routes/$classroomSlug.$pageId/route.tsx');

test.describe('a failed cover action is shown as a sentence', () => {
  test('the server message wins over its code', () => {
    expect(
      actionFailureMessage({ error: 'USE_MEDIA', message: 'This file belongs in media.' })
    ).toBe('This file belongs in media.');
    expect(
      actionFailureMessage({
        error: 'CLASSROOM_LOCKED',
        message: 'This classroom is locked.',
      })
    ).toBe('This classroom is locked.');
  });

  test('an action that only sent a sentence as `error` is shown as it is', () => {
    expect(
      actionFailureMessage({
        error: 'This page changed while updating the cover image — please try again.',
      })
    ).toContain('please try again');
  });

  test('success, and a body with no error, show nothing', () => {
    expect(actionFailureMessage({ success: true } as never)).toBeNull();
    expect(actionFailureMessage(undefined)).toBeNull();
    expect(actionFailureMessage({ error: { nested: true } })).toBeNull();
  });
});

test.describe('the cover uploaders', () => {
  test('both surfaces upload through the routing hook, not a raw form post', () => {
    expect(HEADER_SOURCE).toContain('useCoverUpload(fetcher, uploadCapability)');
    expect(HEADER_SOURCE).toContain('cover.upload(file)');
    expect(HEADER_SOURCE).not.toContain("formData.append('intent', 'upload-header-image')");

    expect(ROUTE_SOURCE).toContain('useCoverUpload(fetcher, capability)');
    expect(ROUTE_SOURCE).toContain('cover.upload(file)');
    expect(ROUTE_SOURCE).not.toContain("formData.append('intent', 'upload-header-image')");
  });

  test('neither toasts a raw code any more', () => {
    for (const src of [HEADER_SOURCE, ROUTE_SOURCE]) {
      expect(src).not.toContain('toast.error(fetcher.data.error)');
      expect(src).not.toContain('toast.error(coverFetcher.data.error)');
    }
    expect(HOOK_SOURCE).toContain('const message = actionFailureMessage(data);');
  });

  test('the router picks the store before any byte is sent', () => {
    const upload = HOOK_SOURCE.slice(HOOK_SOURCE.indexOf('const upload = useCallback('));
    const route = upload.indexOf('firstDestination(capabilityRef.current, file)');
    const refused = upload.indexOf("if (first.kind === 'refused')");
    const media = upload.indexOf("if (first.kind === 'media') void submitToMedia(file, false);");
    for (const at of [route, refused, media]) expect(at).toBeGreaterThan(-1);
    expect(route).toBeLessThan(refused);
    expect(refused).toBeLessThan(media);
  });

  test('a media cover is uploaded first, then set by its media:// reference', () => {
    const toMedia = HOOK_SOURCE.slice(HOOK_SOURCE.indexOf('const submitToMedia = useCallback('));
    const imageOnly = toMedia.indexOf("kindOfFilename(file.name) !== 'IMAGE'");
    const send = toMedia.indexOf('await sendToMedia({');
    const set = toMedia.indexOf("{ intent: 'set-header-image', url: ref, position: 50 }");
    for (const at of [imageOnly, send, set]) expect(at).toBeGreaterThan(-1);
    expect(imageOnly).toBeLessThan(send);
    expect(send).toBeLessThan(set);
  });

  test('USE_MEDIA from the repository is followed once, to media', () => {
    expect(HOOK_SOURCE).toContain(
      "if (data?.error === 'USE_MEDIA' && file) {\n      void submitToMedia(file, true);"
    );
    // A media upload the server sends back is not chased a second time.
    expect(HOOK_SOURCE).toContain('if (redirected) toast.error(COVER_NOWHERE);');
  });
});
