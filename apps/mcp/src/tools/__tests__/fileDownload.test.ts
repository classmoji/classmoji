/**
 * file_download_url: a ten-minute signed GET for one course file.
 *
 * What is pinned here is the tool's half: exactly one target, the classroom
 * check on every row (S1), the read gate per kind (page = OWNER/TEACHER, deck
 * and media = teaching team), the path rule (inside the page's assets folder
 * or the deck's folder, no traversal), the refusal mapping and the payload.
 * Signing itself is `contentDelivery.repoFileDownload.test.ts`'s.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';
import { toolAnnotations } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  pageFindById: vi.fn(),
  slideFindById: vi.fn(),
  auditCreate: vi.fn(),
  findMembership: vi.fn(),
  lookupReadyMedia: vi.fn(),
  mediaDownloadUrl: vi.fn(),
  resolveRepoFileDownloadUrl: vi.fn(),
}));

vi.mock('@classmoji/services/slides', () => ({
  slideService: { findById: (...a: unknown[]) => mocks.slideFindById(...a) },
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    page: { findById: (...a: unknown[]) => mocks.pageFindById(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findMembership(...a),
    },
    media: {
      isMediaError: () => false,
      lookupReadyMedia: (...a: unknown[]) => mocks.lookupReadyMedia(...a),
    },
    contentDelivery: {
      mediaDownloadUrl: (...a: unknown[]) => mocks.mediaDownloadUrl(...a),
      resolveRepoFileDownloadUrl: (...a: unknown[]) => mocks.resolveRepoFileDownloadUrl(...a),
    },
  },
}));

const { fileDownloadUrlTool, downloadPathFor, mediaTools } = await import('../media.ts');

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SLIDE_ID = '22222222-2222-4222-8222-222222222222';
const MEDIA_ID = '44444444-4444-4444-8444-444444444444';
const EXP = 1_790_000_000;

const CLASSROOM = {
  id: 'class-1',
  content_repo: 'content-repo',
  content_key_version: 3,
  content_delivery_enabled: true,
  git_organization: { login: 'org', provider: 'GITHUB' },
};
const PAGE = {
  id: PAGE_ID,
  classroom_id: 'class-1',
  content_path: 'pages/lab-1',
  is_draft: false,
  classroom: CLASSROOM,
};
const SLIDE = {
  id: SLIDE_ID,
  classroom_id: 'class-1',
  content_path: 'slides/week-1',
  created_by: 'teacher-1',
  allow_team_edit: false,
  is_draft: false,
  classroom: CLASSROOM,
};
const MEDIA = {
  id: MEDIA_ID,
  classroomId: 'class-1',
  kind: 'VIDEO',
  filename: 'Lecture 1.mov',
  ext: 'mov',
  contentType: 'video/quicktime',
  sizeBytes: 9_000_000,
  renditionBytes: 4_000_000,
  allowDownload: false,
};

function makeCtx(role: 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT', classroomId = 'class-1') {
  return {
    viewer: { userId: 'user-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId,
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { ...CLASSROOM, id: classroomId, settings: {} },
    },
  } as unknown as ToolContext;
}

const TEACHER = makeCtx('TEACHER');
const ASSISTANT = makeCtx('ASSISTANT');
const OTHER_CLASS_TEACHER = makeCtx('TEACHER', 'class-2');

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);
const call = (args: Record<string, unknown>, ctx = TEACHER) =>
  fileDownloadUrlTool.handler({ classroom: 'org/cs', ...args } as never, ctx);

function signedRepoUrl(filename: string) {
  const dl = Buffer.from(filename, 'utf8').toString('base64url');
  return `https://cdn.test/c/class-1/blob/${'a'.repeat(40)}.png?p=download&v=3&exp=${EXP}&sig=s&dl=${dl}`;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.pageFindById.mockResolvedValue(PAGE);
  mocks.slideFindById.mockResolvedValue(SLIDE);
  mocks.findMembership.mockResolvedValue(null);
  mocks.resolveRepoFileDownloadUrl.mockImplementation(
    async (_classroom: unknown, req: { path: string }) => ({
      ok: true,
      url: signedRepoUrl(req.path.split('/').pop() ?? ''),
      path: req.path,
      filename: req.path.split('/').pop(),
      sizeBytes: 2048,
      expiresAt: EXP,
    })
  );
  mocks.lookupReadyMedia.mockImplementation(async (classroomId: string, ids: string[]) => {
    const map = new Map();
    if (classroomId === 'class-1' && ids.includes(MEDIA_ID)) map.set(MEDIA_ID, MEDIA);
    return map;
  });
  mocks.mediaDownloadUrl.mockResolvedValue(
    `https://cdn.test/c/class-1/media/${MEDIA_ID}/orig.mov?p=download&v=3&exp=${EXP}&sig=s&dl=${Buffer.from('Lecture 1.mov').toString('base64url')}`
  );
});

describe('definition', () => {
  it('is a read with the read annotations, in the media tool list, under 1,500 bytes', () => {
    expect(fileDownloadUrlTool.scope).toBe('read');
    expect(fileDownloadUrlTool.roles).toEqual(['OWNER', 'TEACHER', 'ASSISTANT']);
    expect(toolAnnotations(fileDownloadUrlTool as never)).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    expect(mediaTools).toContain(fileDownloadUrlTool);
    expect(Buffer.byteLength(fileDownloadUrlTool.description, 'utf8')).toBeLessThan(1500);
    expect(fileDownloadUrlTool.description).toMatch(/file_upload_start/);
    expect(fileDownloadUrlTool.description).toMatch(/10 minutes/);
    // No VIEW row: course content, like media_list and deck_get.
    expect(fileDownloadUrlTool.auditRead).toBeUndefined();
  });
});

describe('page files', () => {
  it('signs a file in the page assets folder, from a repo path', async () => {
    const payload = parse(await call({ page_id: PAGE_ID, path: 'pages/lab-1/assets/cover.png' }));

    expect(mocks.resolveRepoFileDownloadUrl).toHaveBeenCalledWith(CLASSROOM, {
      folder: 'pages/lab-1/assets',
      path: 'pages/lab-1/assets/cover.png',
    });
    expect(payload).toMatchObject({
      download_url: signedRepoUrl('cover.png'),
      path: 'pages/lab-1/assets/cover.png',
      filename: 'cover.png',
      size_bytes: 2048,
      content_type: null,
      expires_at: new Date(EXP * 1000).toISOString(),
    });
    expect(payload.curl).toBe(`curl -fL -o 'cover.png' '${signedRepoUrl('cover.png')}'`);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('takes a path relative to the page folder', async () => {
    await call({ page_id: PAGE_ID, path: './assets//cover.png' });
    expect(mocks.resolveRepoFileDownloadUrl.mock.calls[0][1]).toEqual({
      folder: 'pages/lab-1/assets',
      path: 'pages/lab-1/assets/cover.png',
    });
  });

  it('serves a draft page’s files to its owners and teachers', async () => {
    mocks.pageFindById.mockResolvedValue({ ...PAGE, is_draft: true });
    const payload = parse(await call({ page_id: PAGE_ID, path: 'assets/draft.png' }));
    expect(payload.filename).toBe('draft.png');
  });

  it('keeps pages to owners and teachers, like page_content_get', async () => {
    await expect(
      call({ page_id: PAGE_ID, path: 'assets/cover.png' }, ASSISTANT)
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'INSUFFICIENT_ROLE' });
    expect(mocks.resolveRepoFileDownloadUrl).not.toHaveBeenCalled();
  });

  it('lets a multi-role assistant who is also a teacher through', async () => {
    mocks.findMembership.mockResolvedValue({ role: 'TEACHER' });
    await call({ page_id: PAGE_ID, path: 'assets/cover.png' }, ASSISTANT);
    expect(mocks.resolveRepoFileDownloadUrl).toHaveBeenCalled();
  });

  it('refuses a page of another classroom with the same not-found', async () => {
    mocks.pageFindById.mockResolvedValue({ ...PAGE, classroom_id: 'class-2' });
    await expect(call({ page_id: PAGE_ID, path: 'assets/cover.png' })).rejects.toMatchObject({
      kind: 'not_found',
    });
    // And a caller from class-2 holding a class-1 page id gets the same.
    mocks.pageFindById.mockResolvedValue(PAGE);
    await expect(
      call({ page_id: PAGE_ID, path: 'assets/cover.png' }, OTHER_CLASS_TEACHER)
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.resolveRepoFileDownloadUrl).not.toHaveBeenCalled();
  });

  it('refuses paths outside the assets folder and traversal of any kind', async () => {
    for (const path of [
      '../lab-2/assets/x.png',
      'assets/../../lab-2/assets/x.png',
      'pages/lab-1/assets/../content.json',
      'pages/lab-2/assets/x.png',
      'content.json',
      'pages/lab-1/content.json',
      '/pages/lab-1/assets/x.png',
      'assets\\x.png',
      'https://example.com/x.png',
      'media://44444444-4444-4444-8444-444444444444',
      'assets/x.png?raw=1',
      'assets/x\n.png',
      'assets',
      'assets/',
    ]) {
      await expect(call({ page_id: PAGE_ID, path }), path).rejects.toMatchObject({
        kind: 'invalid_params',
        code: 'BAD_PATH',
      });
    }
    expect(mocks.resolveRepoFileDownloadUrl).not.toHaveBeenCalled();
  });

  it('maps the service refusals', async () => {
    mocks.resolveRepoFileDownloadUrl.mockResolvedValue({ ok: false, reason: 'delivery_off' });
    await expect(call({ page_id: PAGE_ID, path: 'assets/x.png' })).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'DOWNLOADS_UNAVAILABLE',
    });
    mocks.resolveRepoFileDownloadUrl.mockResolvedValue({ ok: false, reason: 'not_in_map' });
    await expect(call({ page_id: PAGE_ID, path: 'assets/x.png' })).rejects.toMatchObject({
      kind: 'not_found',
    });
    mocks.resolveRepoFileDownloadUrl.mockResolvedValue({ ok: false, reason: 'bad_path' });
    await expect(call({ page_id: PAGE_ID, path: 'assets/x.png' })).rejects.toMatchObject({
      code: 'BAD_PATH',
    });
  });
});

describe('deck files', () => {
  it('signs any file under the deck folder for the teaching team, without the edit gate', async () => {
    // The assistant did not create this deck and allow_team_edit is off: a
    // read, like deck_get, still goes through.
    const payload = parse(
      await call({ slide_id: SLIDE_ID, path: 'games/minions/sprite.png' }, ASSISTANT)
    );
    expect(mocks.resolveRepoFileDownloadUrl).toHaveBeenCalledWith(CLASSROOM, {
      folder: 'slides/week-1',
      path: 'slides/week-1/games/minions/sprite.png',
    });
    expect(payload.path).toBe('slides/week-1/games/minions/sprite.png');
  });

  it('serves a draft deck’s files to the teaching team', async () => {
    mocks.slideFindById.mockResolvedValue({ ...SLIDE, is_draft: true });
    await call({ slide_id: SLIDE_ID, path: 'slides/week-1/images/a.png' }, ASSISTANT);
    expect(mocks.resolveRepoFileDownloadUrl).toHaveBeenCalled();
  });

  it('refuses a deck of another classroom, and paths outside the deck', async () => {
    mocks.slideFindById.mockResolvedValue({ ...SLIDE, classroom_id: 'class-2' });
    await expect(call({ slide_id: SLIDE_ID, path: 'images/a.png' })).rejects.toMatchObject({
      kind: 'not_found',
    });
    mocks.slideFindById.mockResolvedValue(SLIDE);
    for (const path of ['../week-2/deck.json', 'slides/week-2/images/a.png', '/etc/passwd']) {
      await expect(call({ slide_id: SLIDE_ID, path }), path).rejects.toMatchObject({
        code: 'BAD_PATH',
      });
    }
    expect(mocks.resolveRepoFileDownloadUrl).not.toHaveBeenCalled();
  });
});

describe('media files', () => {
  it('signs a READY media file of this classroom, as staff', async () => {
    const payload = parse(await call({ media_id: MEDIA_ID }, ASSISTANT));
    expect(mocks.lookupReadyMedia).toHaveBeenCalledWith('class-1', [MEDIA_ID]);
    expect(mocks.mediaDownloadUrl).toHaveBeenCalledWith(
      expect.objectContaining({ record: MEDIA, forStudent: false })
    );
    expect(mocks.mediaDownloadUrl.mock.calls[0][0].classroom.id).toBe('class-1');
    expect(payload).toMatchObject({
      media_id: MEDIA_ID,
      filename: 'Lecture 1.mov',
      content_type: 'video/quicktime',
      size_bytes: 9_000_000,
      expires_at: new Date(EXP * 1000).toISOString(),
    });
  });

  it('describes the streaming copy when that is what is downloaded', async () => {
    mocks.mediaDownloadUrl.mockResolvedValue(
      `https://cdn.test/c/class-1/media/${MEDIA_ID}/web-abcdef123456.mp4?p=download&v=3&exp=${EXP}&sig=s&dl=${Buffer.from('Lecture 1.mp4').toString('base64url')}`
    );
    const payload = parse(await call({ media_id: MEDIA_ID }));
    expect(payload).toMatchObject({
      filename: 'Lecture 1.mp4',
      content_type: 'video/mp4',
      size_bytes: 4_000_000,
    });
  });

  it('refuses another classroom’s media id with the same not-found', async () => {
    await expect(call({ media_id: MEDIA_ID }, OTHER_CLASS_TEACHER)).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mocks.lookupReadyMedia).toHaveBeenCalledWith('class-2', [MEDIA_ID]);
    // Belt and braces: a row that somehow comes back for another classroom.
    mocks.lookupReadyMedia.mockResolvedValue(
      new Map([[MEDIA_ID, { ...MEDIA, classroomId: 'class-2' }]])
    );
    await expect(call({ media_id: MEDIA_ID })).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.mediaDownloadUrl).not.toHaveBeenCalled();
  });

  it('says so when the class cannot sign downloads', async () => {
    mocks.mediaDownloadUrl.mockResolvedValue(null);
    await expect(call({ media_id: MEDIA_ID })).rejects.toMatchObject({
      code: 'DOWNLOADS_UNAVAILABLE',
    });
  });
});

describe('arguments', () => {
  it('needs exactly one target, and path only with a page or deck', async () => {
    await expect(call({})).rejects.toMatchObject({ kind: 'invalid_params' });
    await expect(
      call({ page_id: PAGE_ID, slide_id: SLIDE_ID, path: 'assets/x.png' })
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    await expect(call({ page_id: PAGE_ID, media_id: MEDIA_ID })).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    await expect(call({ page_id: PAGE_ID })).rejects.toMatchObject({ kind: 'invalid_params' });
    await expect(call({ media_id: MEDIA_ID, path: 'x.png' })).rejects.toMatchObject({
      kind: 'invalid_params',
    });
  });
});

describe('downloadPathFor', () => {
  it('normalizes into the folder and refuses everything else', () => {
    const page = (path: string) => downloadPathFor('pages/lab-1', 'pages/lab-1/assets', path);
    expect(page('assets/a.png')).toBe('pages/lab-1/assets/a.png');
    expect(page('pages/lab-1/assets/sub/a.png')).toBe('pages/lab-1/assets/sub/a.png');
    expect(page('pages/lab-1/./assets/a.png')).toBe('pages/lab-1/assets/a.png');
    expect(page('assets/sub/../a.png')).toBeNull();
    expect(page('')).toBeNull();
    expect(page('pages/lab-1/assets')).toBeNull();
    expect(page('pages/lab-10/assets/a.png')).toBeNull();
  });
});
