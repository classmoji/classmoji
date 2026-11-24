/**
 * A reader's Download button for media files: who gets one, for what, and
 * where it points.
 *
 * Three layers, each held where it can be:
 *  - the map a page ships (`ref → downloadable`) — pure, called directly, and
 *    required to mirror `contentDelivery.mediaDownloadUrl`'s rule exactly;
 *  - `/api/media-download` and the loader — they need Postgres to run, so
 *    their gates are pinned in ORDER, read from source (the
 *    `media-editor-gates.spec.ts` approach);
 *  - the reader's lookup — a button only for a ref the map says yes to, on
 *    every surface (the class site mounts the same reader).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { createImageBlockSpec } from '@blocknote/core';

import {
  collectMediaDownloadRefs,
  downloadMapRole,
  downloadableByRef,
  isDownloadable,
  mediaDownloadHref,
  type DownloadableRecord,
} from '~/utils/mediaDownloads.ts';
import { mediaDownloadLookup, NO_MEDIA_DOWNLOADS } from '~/hooks/useMediaDownloads.ts';
import { viewerSchema } from '~/components/viewer/viewerBlocks.tsx';
import { schema as editorSchema } from '~/components/editor/blocks/index.tsx';

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const ROUTE_SOURCE = source('../../app/routes/api.media-download/route.ts');
const LOADER_SOURCE = source('../../app/routes/$classroomSlug.$pageId/route.server.ts');
const SITE_RENDER_SOURCE = source('../../app/site/pageRender.server.ts');

const VIDEO_ID = '0b6c1d3e-8f2a-4c5b-9d7e-1a2b3c4d5e6f';
const LOCKED_VIDEO_ID = '1b6c1d3e-8f2a-4c5b-9d7e-1a2b3c4d5e6f';
const PDF_ID = '2b6c1d3e-8f2a-4c5b-9d7e-1a2b3c4d5e6f';
const AUDIO_ID = '3b6c1d3e-8f2a-4c5b-9d7e-1a2b3c4d5e6f';
const GONE_ID = '4b6c1d3e-8f2a-4c5b-9d7e-1a2b3c4d5e6f';
const ref = (id: string) => `media://${id}`;

const RECORDS = new Map<string, DownloadableRecord>([
  [VIDEO_ID, { kind: 'VIDEO', allowDownload: true }],
  [LOCKED_VIDEO_ID, { kind: 'VIDEO', allowDownload: false }],
  [PDF_ID, { kind: 'DOCUMENT', allowDownload: false }],
  [AUDIO_ID, { kind: 'AUDIO', allowDownload: false }],
]);

const DOC = [
  { type: 'video', props: { url: ref(VIDEO_ID) } },
  { type: 'video', props: { url: ref(LOCKED_VIDEO_ID) } },
  { type: 'video', props: { url: 'https://youtu.be/abc' } },
  {
    type: 'columnList',
    children: [
      {
        type: 'column',
        children: [
          { type: 'file', props: { url: ref(PDF_ID), name: 'notes.pdf' } },
          { type: 'audio', props: { url: ref(AUDIO_ID) } },
        ],
      },
      { type: 'column', children: [{ type: 'file', props: { url: ref(GONE_ID) } }] },
    ],
  },
  // An image is shown, not downloaded; a cover-like media image is not a button.
  { type: 'image', props: { url: ref(PDF_ID) } },
  // The same file twice is one entry.
  { type: 'file', props: { url: ref(PDF_ID) } },
];

test.describe('which refs a page asks about', () => {
  test('media refs in video, file and audio blocks, nested ones too, each once', () => {
    expect(collectMediaDownloadRefs(DOC)).toEqual([
      ref(VIDEO_ID),
      ref(LOCKED_VIDEO_ID),
      ref(PDF_ID),
      ref(AUDIO_ID),
      ref(GONE_ID),
    ]);
  });

  test('never a repository path, an external link, or another block type', () => {
    expect(
      collectMediaDownloadRefs([
        { type: 'file', props: { url: 'pages/a/assets/x.pdf' } },
        { type: 'video', props: { url: 'https://example.test/a.mp4' } },
        { type: 'profile', props: { imageUrl: ref(PDF_ID) } },
      ])
    ).toEqual([]);
  });
});

test.describe('the rule, as mediaDownloadUrl applies it', () => {
  test('a student gets a video only when its uploader allowed downloads', () => {
    expect(isDownloadable({ kind: 'VIDEO', allowDownload: true }, true)).toBe(true);
    expect(isDownloadable({ kind: 'VIDEO', allowDownload: false }, true)).toBe(false);
  });

  test('every other kind is the file itself, and always downloadable', () => {
    for (const kind of ['DOCUMENT', 'AUDIO', 'ARCHIVE', 'IMAGE', 'OTHER']) {
      expect(isDownloadable({ kind, allowDownload: false }, true), kind).toBe(true);
    }
  });

  test('the teaching team downloads anything', () => {
    expect(isDownloadable({ kind: 'VIDEO', allowDownload: false }, false)).toBe(true);
  });
});

test.describe('the map a page ships', () => {
  const refs = collectMediaDownloadRefs(DOC);

  test('for a student: allowed videos and every non-video; a missing row is false', () => {
    expect(downloadableByRef(refs, RECORDS, true)).toEqual({
      [ref(VIDEO_ID)]: true,
      [ref(LOCKED_VIDEO_ID)]: false,
      [ref(PDF_ID)]: true,
      [ref(AUDIO_ID)]: true,
      [ref(GONE_ID)]: false,
    });
  });

  test('for the teaching team: everything that exists', () => {
    const map = downloadableByRef(refs, RECORDS, false);
    expect(map[ref(LOCKED_VIDEO_ID)]).toBe(true);
    expect(map[ref(GONE_ID)]).toBe(false);
  });

  test('holds the page refs it was asked about and nothing else', () => {
    const map = downloadableByRef([ref(PDF_ID)], RECORDS, true);
    expect(Object.keys(map)).toEqual([ref(PDF_ID)]);
  });
});

test.describe('where the button points', () => {
  test('the route on this host, or on the canonical pages host from a class site', () => {
    expect(mediaDownloadHref('page-1', ref(PDF_ID))).toBe(
      `/api/media-download?pageId=page-1&ref=media%3A%2F%2F${PDF_ID}`
    );
    expect(mediaDownloadHref('page-1', ref(PDF_ID), 'https://pages.classmoji.io')).toBe(
      `https://pages.classmoji.io/api/media-download?pageId=page-1&ref=media%3A%2F%2F${PDF_ID}`
    );
  });
});

test.describe('/api/media-download', () => {
  const loader = ROUTE_SOURCE.slice(ROUTE_SOURCE.indexOf('export const loader'));

  test('gates in order: a media ref, the page, view access, membership, a READY row, the rule', () => {
    const steps = [
      'const mediaId = parseMediaRef(ref);',
      'if (!pageId || !mediaId) return notFound();',
      'await ClassmojiService.page.findById(pageId, { includeClassroom: true })',
      "accessType: 'view'",
      'if (!access.membership) return notFound();',
      'await ClassmojiService.media.lookupReadyMedia(page.classroom_id, [mediaId])',
      'if (!record) return notFound();',
      'forStudent: downloadsAsStudent(access.membership.role)',
      'if (!downloadUrl) return notFound();',
      "return redirect(downloadUrl, { headers: { 'Cache-Control': 'no-store' } });",
    ];
    let at = -1;
    for (const step of steps) {
      const next = loader.indexOf(step);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
  });

  test('a membership counts only once its invite was accepted, as on the class site', () => {
    // An invited-but-never-joined user is anonymous on the site; the route that
    // mints the site's download links must not treat them as a member either.
    expect(loader).toMatch(/accessType: 'view',\s+acceptedOnly: true,/);
    const auth = source('../../app/utils/auth.server.ts');
    expect(auth).toContain('acceptedOnly = false,');
    // The filter itself lives in the one role lookup assertPageAccess uses.
    // (`~/utils/classroomRole.server.ts` re-exports `@classmoji/auth/classroom-role`.)
    expect(source('../../app/utils/classroomRole.server.ts')).toContain(
      "from '@classmoji/auth/classroom-role'"
    );
    expect(source('../../../../packages/auth/src/classroomRole.ts')).toContain(
      '...(acceptedOnly ? { has_accepted_invite: true } : {}),'
    );
    // Without one, it is the same 404 as every other refusal.
    expect(loader).toContain('if (!access.membership) return notFound();');
  });

  test('a page the reader cannot view is the same 404 as everything else', () => {
    expect(loader).toContain('if (thrown instanceof Response) return notFound();');
  });

  test('the row is looked up in the PAGE’s classroom, never one named by the caller', () => {
    expect(loader).not.toMatch(/searchParams\.get\('classroom/);
    expect(loader.match(/lookupReadyMedia\(/g)).toHaveLength(1);
  });
});

test.describe('the role a download map is drawn for', () => {
  test('a pending invite draws nothing: the route counts accepted members only', () => {
    // A pending TEACHER, or a roster student who never joined, reads the page
    // through their unaccepted row; the route's lookup finds no role at all.
    expect(downloadMapRole(null, false)).toBeNull();
    expect(downloadMapRole(null, true)).toBeNull();
  });

  test('an accepted member of a published page gets their accepted role', () => {
    expect(downloadMapRole('STUDENT', false)).toBe('STUDENT');
    expect(downloadMapRole('TEACHER', false)).toBe('TEACHER');
  });

  test('a draft only for an accepted role on the teaching team, as the route views it', () => {
    // Accepted STUDENT with a pending TEACHER row: the page opens (the highest
    // role, pending or not), but the route sees a student on a draft.
    expect(downloadMapRole('STUDENT', true)).toBeNull();
    expect(downloadMapRole('ASSISTANT', true)).toBe('ASSISTANT');
    expect(downloadMapRole('OWNER', true)).toBe('OWNER');
  });
});

test.describe('the page loader', () => {
  // The map is built by the reader payload (utils/readerPayload.server.ts) for
  // the viewer the loader hands it; the leak cases run in reader-payload.spec.ts.
  const BUILDER_SOURCE = source('../../app/utils/readerPayload.server.ts');

  test('ships the map only to a member looking at the viewer, where the class can sign', () => {
    // A signed-in viewer with a role here, where this view draws buttons, and
    // the classroom can sign at all.
    expect(BUILDER_SOURCE).toContain(
      'viewer && viewer.access.role && options.offerDownloads !== false && ctx'
    );
    expect(BUILDER_SOURCE).toContain(
      'await deps.loadMediaDownloads(classroom.id, finalBlocks, downloadRole)'
    );
    expect(BUILDER_SOURCE).toMatch(/\n {4}mediaDownloads,\n/);
    // "Looking at the viewer": the reader of a page, or staff on a preview.
    expect(LOADER_SOURCE).toContain('const viewerShown = !canEdit || previewActive;');
    expect(LOADER_SOURCE).toContain('offerDownloads: viewerShown,');
    // The viewer is signed in, with the loader's one reader-rule read.
    expect(LOADER_SOURCE).toMatch(/const readerViewer: ReaderViewer \| null = authData\?\.userId/);
    expect(LOADER_SOURCE).toContain('access: sectionViewer,');
  });

  test('draws it for the accepted-only role the download route reads', () => {
    const map = BUILDER_SOURCE.slice(BUILDER_SOURCE.indexOf('const downloadRole ='));
    // The highest ACCEPTED role, from the loader's one shared reader-rule read.
    expect(map).toMatch(/downloadMapRole\(viewer\.access\.acceptedRole, page\.is_draft\)/);
    // Never the role that opened the page.
    expect(BUILDER_SOURCE).not.toMatch(/loadMediaDownloads\([^)]*viewer\.access\.role\)/);
    expect(LOADER_SOURCE).not.toContain('loadMediaDownloads(');
  });

  test('the class site asks only for a signed-in member', () => {
    // Through the shared builder, which draws downloads only for a viewer; the
    // site's viewer is null for anyone who is not an accepted member
    // (site-reader.spec.ts runs it).
    expect(SITE_RENDER_SOURCE).toContain(
      'const readerViewer = await siteReaderViewer(viewer, page, site.classroom);'
    );
    expect(SITE_RENDER_SOURCE).toContain(
      'if (!viewer.userId || viewer.role === null || viewer.acceptedRoles.length === 0) return null;'
    );
  });
});

test.describe("the reader's lookup", () => {
  // The client half of the gate (hooks/useMediaDownloads.ts): the reader on
  // every surface, the class site included, draws a Download link only for a
  // ref the page's map says yes to. Replaces the class site's static-render
  // cases ("a file not in the map gets no link, even in a member render").
  const downloads = {
    [ref(VIDEO_ID)]: true,
    [ref(LOCKED_VIDEO_ID)]: false,
    [ref(PDF_ID)]: true,
  };

  test('a link only for a ref the map says yes to, on the origin it was given', () => {
    const lookup = mediaDownloadLookup('page-1', downloads, 'https://pages.test');
    expect(lookup(ref(VIDEO_ID))).toBe(
      mediaDownloadHref('page-1', ref(VIDEO_ID), 'https://pages.test')
    );
    expect(lookup(ref(PDF_ID))).toBe(
      mediaDownloadHref('page-1', ref(PDF_ID), 'https://pages.test')
    );
    // Refused, or not in the map at all: no link.
    expect(lookup(ref(LOCKED_VIDEO_ID))).toBeNull();
    expect(lookup(ref(AUDIO_ID))).toBeNull();
    expect(lookup(ref(GONE_ID))).toBeNull();
    // A signed URL is not a key: the map holds stored references only.
    expect(lookup(`https://content.test/c/x/media/${PDF_ID}/orig.pdf?sig=1`)).toBeNull();
  });

  test('no map (a non-member, the editor): no links at all', () => {
    for (const none of [null, undefined]) {
      expect(mediaDownloadLookup('page-1', none)).toBe(NO_MEDIA_DOWNLOADS);
    }
    expect(mediaDownloadLookup('page-1', {})(ref(PDF_ID))).toBeNull();
    expect(NO_MEDIA_DOWNLOADS(ref(PDF_ID))).toBeNull();
  });
});

test.describe('the viewer schema', () => {
  type Impl = { implementation?: { meta?: { fileBlockAccept?: string[] } } };
  const specs = viewerSchema.blockSpecs as unknown as Record<string, Impl>;
  const editorSpecs = editorSchema.blockSpecs as unknown as Record<string, Impl>;

  test('its file and audio blocks are still file blocks, styled as BlockNote styles them', () => {
    // `fileBlockAccept` is what puts `data-file-block` on the DOM, and every
    // BlockNote file-block style is scoped under that attribute.
    for (const type of ['file', 'audio']) {
      expect(specs[type].implementation?.meta?.fileBlockAccept, type).toEqual(
        editorSpecs[type].implementation?.meta?.fileBlockAccept
      );
    }
  });

  test('the image block is still a file block, with BlockNote’s own accept and order', () => {
    // The app overrides BlockNote's image block for responsive candidates. The
    // override must keep what makes it a file block: `data-file-block` styling,
    // the upload tab's accept, and drop/paste matching an image to it.
    type Spec = { implementation?: { meta?: unknown; runsBefore?: unknown } };
    const ours = editorSchema.blockSpecs.image as unknown as Spec;
    const blocknote = createImageBlockSpec() as unknown as Spec;
    expect(ours.implementation?.meta).toEqual(blocknote.implementation?.meta);
    expect(ours.implementation?.meta).toEqual({ fileBlockAccept: ['image/*'] });
    expect(ours.implementation?.runsBefore).toEqual(blocknote.implementation?.runsBefore);
  });

  test('reads documents with the same props as the editor', () => {
    for (const type of ['file', 'audio']) {
      const viewer = (viewerSchema.blockSpecs as Record<string, { config: unknown }>)[type];
      const editor = (editorSchema.blockSpecs as Record<string, { config: unknown }>)[type];
      expect(viewer.config, type).toEqual(editor.config);
    }
  });
});
