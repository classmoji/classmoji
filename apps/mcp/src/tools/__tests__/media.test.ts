/**
 * Media + agent-upload tools: the target gate (exactly one of page/slide, S1,
 * the page's OWNER/TEACHER tier and the deck sub-gate), the refusal mapping,
 * the audit on every mutation, the annotations, and the description budget.
 * The staging protocol itself is `mediaStaging.service.test.ts`'s.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  pageFindById: vi.fn(),
  slideFindById: vi.fn(),
  auditCreate: vi.fn(),
  findMembership: vi.fn(),
  listReadyMedia: vi.fn(),
  deleteMedia: vi.fn(),
  startStagedUpload: vi.fn(),
  finishStagedUpload: vi.fn(),
  stagedUploadStatus: vi.fn(),
  startUrlImport: vi.fn(),
}));

class FakeMediaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly usedBytes?: number,
    readonly quotaBytes?: number
  ) {
    super(message);
    this.name = 'MediaError';
  }
}

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
      isMediaError: (e: unknown) => (e as Error | null)?.name === 'MediaError',
      listReadyMedia: (...a: unknown[]) => mocks.listReadyMedia(...a),
      deleteMedia: (...a: unknown[]) => mocks.deleteMedia(...a),
      startStagedUpload: (...a: unknown[]) => mocks.startStagedUpload(...a),
      finishStagedUpload: (...a: unknown[]) => mocks.finishStagedUpload(...a),
      stagedUploadStatus: (...a: unknown[]) => mocks.stagedUploadStatus(...a),
      startUrlImport: (...a: unknown[]) => mocks.startUrlImport(...a),
    },
  },
}));

const {
  mediaTools,
  mediaListTool,
  mediaDeleteTool,
  fileUploadStartTool,
  fileUploadFinishTool,
  fileUploadStatusTool,
  fileImportUrlTool,
  auditableUrl,
} = await import('../media.ts');

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SLIDE_ID = '22222222-2222-4222-8222-222222222222';
const UPLOAD_ID = '33333333-3333-4333-8333-333333333333';

function makeCtx(role: 'OWNER' | 'TEACHER' | 'ASSISTANT', userId = 'user-1') {
  return {
    viewer: { userId, clientId: 'c', scopes: new Set(['read', 'write']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { settings: {} },
    },
  } as unknown as ToolContext;
}

const TEACHER = makeCtx('TEACHER');
const ASSISTANT = makeCtx('ASSISTANT', 'ta-1');

const CLASSROOM = {
  id: 'class-1',
  content_repo: 'content-repo',
  content_delivery_enabled: true,
  git_organization: { login: 'org', provider: 'GITHUB' },
};
const PAGE = { id: PAGE_ID, classroom_id: 'class-1', classroom: CLASSROOM };
const SLIDE = {
  id: SLIDE_ID,
  classroom_id: 'class-1',
  created_by: 'teacher-1',
  allow_team_edit: false,
  classroom: CLASSROOM,
};

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.pageFindById.mockResolvedValue(PAGE);
  mocks.slideFindById.mockResolvedValue(SLIDE);
  mocks.findMembership.mockResolvedValue(null);
  mocks.startStagedUpload.mockResolvedValue({
    uploadId: UPLOAD_ID,
    uploadUrl: 'https://r2.example/put?sig=1',
    expiresAt: '2026-09-26T12:15:00.000Z',
    destination: 'repo',
    sizeBytes: 4096,
  });
});

describe('definitions', () => {
  it('keeps every description under 1,500 bytes', () => {
    for (const tool of mediaTools) {
      expect(Buffer.byteLength(tool.description, 'utf8'), tool.name).toBeLessThan(1500);
    }
  });

  it('annotates the writes, and marks media_delete destructive', () => {
    expect(mediaListTool.scope).toBe('read');
    expect(fileUploadStatusTool.scope).toBe('read');
    expect(mediaDeleteTool.annotations).toMatchObject({ destructive: true });
    for (const tool of [fileUploadStartTool, fileUploadFinishTool, fileImportUrlTool]) {
      expect(tool.scope).toBe('write');
      expect(tool.annotations?.destructive, tool.name).toBe(false);
      expect(tool.rateLimit, tool.name).toBeDefined();
    }
    expect(fileUploadStartTool.annotations?.idempotent).toBe(false);
    expect(fileUploadFinishTool.annotations?.idempotent).toBe(true);
  });
});

describe('file_upload_start', () => {
  const start = (args: Record<string, unknown>, ctx = TEACHER) =>
    fileUploadStartTool.handler(
      { classroom: 'org/cs', filename: 'diagram.png', size: 4096, ...args } as never,
      ctx
    );

  it('opens a stage for a page and hands back the URL and a curl line, audited', async () => {
    const payload = parse(await start({ page_id: PAGE_ID }));

    expect(mocks.startStagedUpload).toHaveBeenCalledWith({
      classroom: CLASSROOM,
      userId: 'user-1',
      filename: 'diagram.png',
      sizeBytes: 4096,
      target: { type: 'page', id: PAGE_ID },
    });
    expect(payload).toMatchObject({
      upload_id: UPLOAD_ID,
      upload_url: 'https://r2.example/put?sig=1',
      destination: 'repo',
      curl: "curl -T <file> 'https://r2.example/put?sig=1'",
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ resource_type: 'MEDIA', action: 'CREATE' })
    );
  });

  it('needs exactly one of page_id and slide_id', async () => {
    await expect(start({})).rejects.toMatchObject({ kind: 'invalid_params' });
    await expect(start({ page_id: PAGE_ID, slide_id: SLIDE_ID })).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.startStagedUpload).not.toHaveBeenCalled();
  });

  it('keeps pages to owners and teachers, like page editing', async () => {
    await expect(start({ page_id: PAGE_ID }, ASSISTANT)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    expect(mocks.startStagedUpload).not.toHaveBeenCalled();
  });

  it('applies the deck sub-gate: an assistant only on decks they may edit', async () => {
    await expect(start({ slide_id: SLIDE_ID }, ASSISTANT)).rejects.toMatchObject({
      kind: 'forbidden',
    });
    mocks.slideFindById.mockResolvedValue({ ...SLIDE, created_by: 'ta-1' });
    await start({ slide_id: SLIDE_ID }, ASSISTANT);
    expect(mocks.startStagedUpload.mock.calls[0][0].target).toEqual({
      type: 'slide',
      id: SLIDE_ID,
    });
  });

  it('answers a page in another classroom as not found (S1)', async () => {
    mocks.pageFindById.mockResolvedValue({ ...PAGE, classroom_id: 'other' });
    await expect(start({ page_id: PAGE_ID })).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('maps a routing refusal to invalid_params with its code and sentence', async () => {
    mocks.startStagedUpload.mockRejectedValue(
      new FakeMediaError('STORAGE_REFUSED', 'This file is larger than the 35 MB …')
    );
    await expect(start({ page_id: PAGE_ID })).rejects.toMatchObject({
      kind: 'invalid_params',
      code: 'STORAGE_REFUSED',
      message: 'This file is larger than the 35 MB …',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('carries the full-storage sentence and the quota numbers on QUOTA_EXCEEDED', async () => {
    const full = "This class's media storage is full. Contact hello@classmoji.io to upgrade.";
    mocks.startStagedUpload.mockRejectedValue(new FakeMediaError('QUOTA_EXCEEDED', full, 9, 10));
    await expect(start({ page_id: PAGE_ID })).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
      message: full,
      data: { used_bytes: 9, quota_bytes: 10 },
    });
  });
});

describe('file_upload_finish / file_upload_status', () => {
  it('finishes for the caller and reports placing with a poll hint', async () => {
    mocks.finishStagedUpload.mockResolvedValue({
      status: 'placing',
      uploadId: UPLOAD_ID,
      filename: 'diagram.png',
      destination: 'repo',
    });
    const payload = parse(
      await fileUploadFinishTool.handler({ classroom: 'org/cs', upload_id: UPLOAD_ID }, TEACHER)
    );
    expect(mocks.finishStagedUpload).toHaveBeenCalledWith({
      classroom: { id: 'class-1' },
      userId: 'user-1',
      uploadId: UPLOAD_ID,
    });
    expect(payload).toMatchObject({ status: 'placing', upload_id: UPLOAD_ID });
    expect(payload.next).toMatch(/file_upload_status/);
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE' }));
  });

  it('returns the ref once placed, and the error once failed', async () => {
    mocks.stagedUploadStatus.mockResolvedValue({
      status: 'placed',
      uploadId: UPLOAD_ID,
      filename: 'lecture.mp4',
      destination: 'media',
      ref: `media://${UPLOAD_ID}`,
    });
    expect(
      parse(
        await fileUploadStatusTool.handler({ classroom: 'org/cs', upload_id: UPLOAD_ID }, TEACHER)
      )
    ).toMatchObject({ status: 'placed', ref: `media://${UPLOAD_ID}` });

    mocks.stagedUploadStatus.mockResolvedValue({
      status: 'failed',
      uploadId: UPLOAD_ID,
      filename: 'a.exe',
      destination: 'repo',
      error: '.exe files cannot be uploaded here.',
    });
    expect(
      parse(
        await fileUploadStatusTool.handler({ classroom: 'org/cs', upload_id: UPLOAD_ID }, TEACHER)
      )
    ).toMatchObject({ status: 'failed', error: '.exe files cannot be uploaded here.' });
  });

  it('maps another user’s upload (NOT_FOUND from the service) to not_found', async () => {
    mocks.stagedUploadStatus.mockRejectedValue(new FakeMediaError('NOT_FOUND', 'No such upload'));
    await expect(
      fileUploadStatusTool.handler({ classroom: 'org/cs', upload_id: UPLOAD_ID }, TEACHER)
    ).rejects.toMatchObject({ kind: 'not_found', code: 'NOT_FOUND' });
  });
});

describe('file_import_url', () => {
  it('queues the import for a page and returns the upload id, audited', async () => {
    mocks.startUrlImport.mockResolvedValue({
      uploadId: UPLOAD_ID,
      filename: 'lecture.mp4',
      maxBytes: 2 * 1024 ** 3,
    });
    const payload = parse(
      await fileImportUrlTool.handler(
        { classroom: 'org/cs', page_id: PAGE_ID, url: 'https://example.com/lecture.mp4' },
        TEACHER
      )
    );
    expect(mocks.startUrlImport).toHaveBeenCalledWith({
      classroom: CLASSROOM,
      userId: 'user-1',
      url: 'https://example.com/lecture.mp4',
      filename: null,
      target: { type: 'page', id: PAGE_ID },
    });
    expect(payload).toMatchObject({ upload_id: UPLOAD_ID, status: 'placing' });
    expect(mocks.auditCreate).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE' }));
  });
});

describe('file_import_url: the audit row', () => {
  it('records the URL without its query string — a signed link keeps its credential there', async () => {
    mocks.startUrlImport.mockResolvedValue({ uploadId: UPLOAD_ID, filename: 'a.mp4', maxBytes: 1 });
    const url = 'https://bucket.example.com/a.mp4?X-Amz-Signature=secret&X-Amz-Credential=k#t=5';
    await fileImportUrlTool.handler({ classroom: 'org/cs', page_id: PAGE_ID, url }, TEACHER);

    // The service still gets the whole URL; only the audit is trimmed.
    expect(mocks.startUrlImport).toHaveBeenCalledWith(expect.objectContaining({ url }));
    const audited = JSON.stringify(mocks.auditCreate.mock.calls.at(-1));
    expect(audited).toContain('https://bucket.example.com/a.mp4');
    expect(audited).not.toContain('secret');
    expect(audited).not.toContain('X-Amz');
  });

  it('auditableUrl drops query, fragment and credentials', () => {
    expect(auditableUrl('https://u:p@x.test/a/b.mp4?sig=1#f')).toBe('https://x.test/a/b.mp4');
    expect(auditableUrl('not a url?sig=1')).toBe('not a url');
  });

  it('tells the agent large files need a reasonably fast host', () => {
    expect(fileImportUrlTool.description).toMatch(/reasonably fast host/);
  });
});

describe('media_list / media_delete', () => {
  it('lists this classroom’s ready media only, by kind', async () => {
    mocks.listReadyMedia.mockResolvedValue([
      {
        id: 'm-1',
        ref: 'media://m-1',
        filename: 'a.mp4',
        kind: 'VIDEO',
        sizeBytes: 10,
        createdAt: new Date('2026-09-26T00:00:00Z'),
        processing: 'DONE',
        processingError: null,
      },
    ]);
    const payload = parse(
      await mediaListTool.handler({ classroom: 'org/cs', kind: 'VIDEO' }, TEACHER)
    );
    expect(mocks.listReadyMedia).toHaveBeenCalledWith('class-1', { kind: 'VIDEO' });
    expect(payload.media[0]).toMatchObject({
      id: 'm-1',
      ref: 'media://m-1',
      size_bytes: 10,
      processing: 'DONE',
    });
    expect(payload.media[0]).not.toHaveProperty('processing_error');
  });

  it('reports a failed optimisation with its reason, read-only', async () => {
    mocks.listReadyMedia.mockResolvedValue([
      {
        id: 'm-2',
        ref: 'media://m-2',
        filename: 'b.mov',
        kind: 'VIDEO',
        sizeBytes: 10,
        createdAt: new Date('2026-09-26T00:00:00Z'),
        processing: 'FAILED',
        processingError: 'The video could not be read.',
      },
    ]);
    const payload = parse(await mediaListTool.handler({ classroom: 'org/cs' }, TEACHER));
    expect(payload.media[0]).toMatchObject({
      processing: 'FAILED',
      processing_error: 'The video could not be read.',
    });
    // Read-only: nothing on the tool's input can change it.
    expect(Object.keys(mediaListTool.inputSchema)).toEqual(['classroom', 'kind']);
  });

  it('says size_bytes is the billed size, which the service reports', async () => {
    // `listReadyMedia` reports the billed size (the rendition once the original
    // is dropped); the tool passes it through unchanged and says what it means.
    mocks.listReadyMedia.mockResolvedValue([
      {
        id: 'm-3',
        ref: 'media://m-3',
        filename: 'c.mp4',
        kind: 'VIDEO',
        sizeBytes: 800,
        createdAt: new Date('2026-09-26T00:00:00Z'),
        processing: 'DONE',
        processingError: null,
      },
    ]);
    const payload = parse(await mediaListTool.handler({ classroom: 'org/cs' }, TEACHER));
    expect(payload.media[0].size_bytes).toBe(800);
    expect(mediaListTool.description).toMatch(/`size_bytes` is what the file costs the class/);
  });

  it('keeps its description under 1,500 bytes', () => {
    expect(Buffer.byteLength(mediaListTool.description, 'utf8')).toBeLessThan(1500);
  });

  it('deletes in this classroom and audits it', async () => {
    mocks.deleteMedia.mockResolvedValue({ mediaId: UPLOAD_ID });
    await mediaDeleteTool.handler({ classroom: 'org/cs', media_id: UPLOAD_ID }, TEACHER);
    expect(mocks.deleteMedia).toHaveBeenCalledWith({
      classroom: { id: 'class-1' },
      mediaId: UPLOAD_ID,
      userId: TEACHER.viewer.userId,
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ resource_type: 'MEDIA', action: 'DELETE' })
    );
  });
});
