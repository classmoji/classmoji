/**
 * What the slides editors decide before an upload starts — `mediaUpload.ts` —
 * and the structural rules around the deck editor's video element.
 *
 * The decisions are pure, so they are pinned directly: where a video, an image
 * or a slide document goes on each kind of classroom, the three video choices
 * and the rule that ties two of them together, and what an uploader is told
 * when it fails (a sentence, never a code). The rest is pinned by reading the
 * source, because the components and routes need a browser or a database: the
 * video panel no longer offers Cloudinary, the editor's resolve route is gated
 * like an edit, and nothing a component imports can pull the S3 client into
 * the browser.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

import {
  DEFAULT_VIDEO_OPTIONS,
  applyVideoOption,
  canDropOriginal,
  deckAssetTarget,
  deckUploadErrorMessage,
  isMediaSource,
  isVideoFile,
  mediaUploadMessage,
  slideFileTarget,
  warnsWithoutOptimising,
  type UploadCapability,
} from '../../app/utils/mediaUpload.ts';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const MB = 1024 * 1024;
const GB = 1024 * MB;

const PRO: UploadCapability = {
  repoMaxBytes: 35 * MB,
  repoFileTypes: 'any',
  isPro: true,
  media: { perFileMaxBytes: 2 * GB, remainingBytes: 10 * GB },
};
const FREE: UploadCapability = { ...PRO, isPro: false, media: null };
/** A classroom the delivery layer does not serve: images and PDFs only. */
const FREE_ALLOWLIST: UploadCapability = { ...FREE, repoFileTypes: 'allowlist' };
/**
 * Pro, but media cannot be offered here — no bucket on this deployment, or the
 * classroom cannot be served signed. The router answers `MEDIA_UNAVAILABLE`,
 * not `TOO_LARGE_FOR_REPO`: a Pro classroom is not sold what it already has.
 */
const PRO_NO_MEDIA: UploadCapability = { ...PRO, media: null };

test.describe('where a deck asset goes', () => {
  test('a Pro video goes to media, whatever its size', () => {
    expect(deckAssetTarget(PRO, { name: 'intro.mp4', size: 3 * MB }).kind).toBe('media');
    expect(deckAssetTarget(PRO, { name: 'lecture.mov', size: 900 * MB }).kind).toBe('media');
  });

  test('a Free video that fits stays in the repository', () => {
    expect(deckAssetTarget(FREE, { name: 'intro.mp4', size: 3 * MB }).kind).toBe('repo');
  });

  test('a Free video over the cap is refused with what Pro would do', () => {
    const target = deckAssetTarget(FREE, { name: 'lecture.mp4', size: 80 * MB });
    expect(target.kind).toBe('refused');
    if (target.kind !== 'refused') return;
    expect(target.message).toContain('Pro stores files up to 2 GB');
  });

  test('a Pro file over the per-file ceiling is refused', () => {
    expect(deckAssetTarget(PRO, { name: 'huge.mp4', size: 3 * GB }).kind).toBe('refused');
  });

  test('a small image stays in the repository even on Pro', () => {
    expect(deckAssetTarget(PRO, { name: 'diagram.png', size: 2 * MB }).kind).toBe('repo');
  });

  test('a classroom on the image/PDF allowlist cannot keep a video in the repository', () => {
    expect(deckAssetTarget(FREE_ALLOWLIST, { name: 'intro.mp4', size: 3 * MB }).kind).toBe(
      'refused'
    );
  });
});

test.describe('where a slide document goes', () => {
  test('one that fits takes the slide’s own repository path, on any classroom', () => {
    // Not judged by the page-asset type rule: a .pptx is a slide document even
    // where page assets are images and PDFs only.
    expect(slideFileTarget(FREE_ALLOWLIST, { name: 'deck.pptx', size: 10 * MB }).kind).toBe('repo');
    expect(slideFileTarget(PRO, { name: 'deck.pdf', size: 35 * MB }).kind).toBe('repo');
  });

  test('one over the repository cap goes to media on Pro', () => {
    expect(slideFileTarget(PRO, { name: 'deck.pdf', size: 35 * MB + 1 }).kind).toBe('media');
  });

  test('one over the repository cap on Free is refused with the Pro note', () => {
    const target = slideFileTarget(FREE, { name: 'deck.pdf', size: 80 * MB });
    expect(target.kind).toBe('refused');
    if (target.kind !== 'refused') return;
    expect(target.message).toMatch(/35 MB/);
    expect(target.message).toContain('Pro stores files up to 2 GB');
  });
});

test.describe('a Pro classroom whose media is unavailable (MEDIA_UNAVAILABLE)', () => {
  /** The refusal, asserted to be one, with its sentence. */
  function refusal(target: ReturnType<typeof deckAssetTarget>) {
    expect(target.kind).toBe('refused');
    if (target.kind !== 'refused') throw new Error('not refused');
    return target;
  }

  test('a video over the repository cap is refused with the router’s sentence, not the Pro pitch', () => {
    const target = refusal(deckAssetTarget(PRO_NO_MEDIA, { name: 'lecture.mp4', size: 80 * MB }));
    expect(target.code).toBe('MEDIA_UNAVAILABLE');
    expect(target.message).toContain("Media storage isn't available for this class right now");
    expect(target.message).not.toContain('Pro stores files up to');
  });

  test('a deck image over the repository cap says the same', () => {
    const target = refusal(deckAssetTarget(PRO_NO_MEDIA, { name: 'poster.png', size: 40 * MB }));
    expect(target.code).toBe('MEDIA_UNAVAILABLE');
    expect(target.message).toContain("Media storage isn't available");
  });

  test('a slide document over the repository cap says the same', () => {
    const target = refusal(slideFileTarget(PRO_NO_MEDIA, { name: 'deck.pdf', size: 80 * MB }));
    expect(target.code).toBe('MEDIA_UNAVAILABLE');
    expect(target.message).toContain("Media storage isn't available");
    expect(target.message).not.toContain('Pro stores files up to');
  });

  test('a video that fits still goes to the repository', () => {
    expect(deckAssetTarget(PRO_NO_MEDIA, { name: 'intro.mp4', size: 3 * MB }).kind).toBe('repo');
  });

  // Every surface shows the refusal's own sentence rather than branching on a
  // code, so a new refusal code can never fall through to a generic message or
  // be sold as a Pro upgrade. Pinned by reading the sources, which need a
  // browser to run.
  test('every upload surface shows the router’s message, and none branches on a code', () => {
    const surfaces = {
      video: source('../../app/components/properties/editors/VideoProperties.tsx'),
      deckImage: source('../../app/routes/$slideId/route.tsx'),
      newFile: source('../../app/routes/$classroomSlug.new/route.tsx'),
      replaceFile: source('../../app/routes/$classroomSlug.$slideId.replace/route.tsx'),
    };
    expect(surfaces.video).toContain('toast.error(target.message);');
    expect(surfaces.deckImage).toContain(
      "if (target.kind === 'refused') throw new Error(target.message);"
    );
    expect(surfaces.newFile).toContain("if (target.kind === 'refused') return target.message;");
    expect(surfaces.replaceFile).toContain("if (target.kind === 'refused') return target.message;");
    for (const text of Object.values(surfaces)) {
      expect(text).not.toContain('TOO_LARGE_FOR_REPO');
      expect(text).not.toContain('MEDIA_UNAVAILABLE');
    }
  });
});

test.describe('the three video choices', () => {
  test('default to optimise, keep the original, no download', () => {
    expect(DEFAULT_VIDEO_OPTIONS).toEqual({
      optimise: true,
      keepOriginal: true,
      allowDownload: false,
    });
  });

  test('turning optimise off forces the original to be kept', () => {
    const dropped = applyVideoOption(DEFAULT_VIDEO_OPTIONS, 'keepOriginal', false);
    expect(dropped.keepOriginal).toBe(false);
    const noOptimise = applyVideoOption(dropped, 'optimise', false);
    expect(noOptimise).toMatchObject({ optimise: false, keepOriginal: true });
    expect(canDropOriginal(noOptimise)).toBe(false);
    expect(canDropOriginal(DEFAULT_VIDEO_OPTIONS)).toBe(true);
  });

  test('warns about a .mov only when it will not be optimised', () => {
    expect(warnsWithoutOptimising('talk.mov', DEFAULT_VIDEO_OPTIONS)).toBe(false);
    expect(warnsWithoutOptimising('talk.MOV', { ...DEFAULT_VIDEO_OPTIONS, optimise: false })).toBe(
      true
    );
    expect(warnsWithoutOptimising('talk.mp4', { ...DEFAULT_VIDEO_OPTIONS, optimise: false })).toBe(
      false
    );
  });

  test('say what each choice does, in the wording every surface shares', () => {
    // The shared ui-components copy of these fields uses the same sentences, so
    // swapping this local one for it later changes nothing on screen.
    const fields = source('../../app/components/media/VideoOptionsFields.tsx');
    expect(fields).toContain('help="Converts it to a format that plays in every browser."');
    expect(fields).toContain('help="Show students a download button."');
  });

  test('knows a video by the store’s own kind table', () => {
    expect(isVideoFile({ name: 'a.mp4' })).toBe(true);
    expect(isVideoFile({ name: 'a.pdf' })).toBe(false);
  });
});

test.describe('what an uploader is told', () => {
  test('a cancel says nothing', () => {
    expect(mediaUploadMessage({ code: 'ABORTED' })).toBeNull();
  });

  test('a quota refusal names the numbers', () => {
    expect(
      mediaUploadMessage({ code: 'QUOTA_EXCEEDED', usedBytes: 9 * GB, quotaBytes: 10 * GB })
    ).toContain('9.0 GB of 10 GB');
  });

  test('never the raw code', () => {
    for (const code of [
      'NOT_CONFIGURED',
      'PRO_REQUIRED',
      'DELIVERY_REQUIRED',
      'FILE_TOO_LARGE',
      'KIND_NOT_ALLOWED',
      'SIZE_MISMATCH',
      'VERIFY_FAILED',
      'UPLOAD_EXPIRED',
      'NOT_FOUND',
      'BAD_STATE',
      'NETWORK',
      'SOMETHING_NEW',
    ]) {
      const message = mediaUploadMessage({ code });
      expect(message).toBeTruthy();
      expect(message).not.toContain(code);
    }
  });

  test('a deck upload refused as USE_MEDIA shows the server’s sentence', () => {
    expect(
      deckUploadErrorMessage({
        error: 'USE_MEDIA',
        message: 'Videos in this class are stored in media storage, not the course repository.',
      })
    ).toBe('Videos in this class are stored in media storage, not the course repository.');
    // A bare code with no sentence still never reaches the author.
    expect(deckUploadErrorMessage({ error: 'USE_MEDIA' })).not.toContain('USE_MEDIA');
    // A sentence in `error` (the older refusals) is shown as it is.
    expect(deckUploadErrorMessage({ error: 'That file type is not allowed.' })).toBe(
      'That file type is not allowed.'
    );
  });
});

test.describe('media sources in the video panel', () => {
  test('a stored reference and the signed URL the editor holds both count', () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    expect(isMediaSource(`media://${id}`)).toBe(true);
    expect(
      isMediaSource(
        `https://content.classmoji.io/c/11111111-2222-3333-4444-555555555555/media/${id}/orig.mp4?e=1`
      )
    ).toBe(true);
    expect(isMediaSource('https://res.cloudinary.com/x/video/upload/a.mp4')).toBe(false);
    expect(isMediaSource('/content/org/repo/slides/a/videos/a.mp4')).toBe(false);
    expect(isMediaSource('')).toBe(false);
  });
});

test.describe('the video element, structurally', () => {
  const PANEL = source('../../app/components/properties/editors/VideoProperties.tsx');
  const RESOLVE = source('../../app/routes/api.slides.$slideId.media-url/route.ts');

  test('no longer uploads to Cloudinary', () => {
    expect(PANEL).not.toContain('/api/video/upload-cloudinary');
    expect(PANEL).not.toContain('Upload to Cloudinary');
    expect(PANEL).toContain('Upload video');
    expect(PANEL).toContain('Choose from media');
  });

  test('the resolve route is gated like an edit, before anything is resolved', () => {
    const gate = RESOLVE.indexOf("accessType: 'edit'");
    expect(gate).toBeGreaterThan(-1);
    expect(RESOLVE.indexOf('resolveDelivery(')).toBeGreaterThan(gate);
    // Only media references are ever resolved.
    expect(RESOLVE).toContain('.filter(isMediaRef)');
  });

  test('no browser module reaches the services barrel', () => {
    for (const file of [
      '../../app/utils/mediaUpload.ts',
      '../../app/utils/mediaClient.ts',
      '../../app/hooks/useMediaUpload.ts',
      '../../app/components/media/VideoUploadDialog.tsx',
      '../../app/components/media/MediaPickerDialog.tsx',
      '../../app/components/media/VideoOptionsFields.tsx',
      '../../app/components/media/MediaUploadProgress.tsx',
      '../../app/components/properties/editors/VideoProperties.tsx',
    ]) {
      const text = source(file);
      expect(text, file).not.toMatch(/from '@classmoji\/services'/);
      expect(text, file).not.toMatch(/from '@classmoji\/services\/slides'/);
    }
  });
});
