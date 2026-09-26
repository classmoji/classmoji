/**
 * Page imports read their body only after the classroom gate, with a cap, and
 * refuse an image over the repository's per-file ceiling by name before
 * anything is committed.
 *
 * Covers both import actions: admin.$class.pages.new (one page) and
 * api.pages.batch (one page per request of a batch).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  createPage: vi.fn(),
  pageContentPath: vi.fn(),
  ensureContentRepo: vi.fn(),
  processMarkdownImport: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    page: {
      createPage: (...a: unknown[]) => mocks.createPage(...a),
      pageContentPath: (...a: unknown[]) => mocks.pageContentPath(...a),
      ensureContentRepo: (...a: unknown[]) => mocks.ensureContentRepo(...a),
    },
  },
}));

vi.mock('~/utils/markdownImporter.server', () => ({
  processMarkdownImport: (...a: unknown[]) => mocks.processMarkdownImport(...a),
}));
vi.mock('~/utils/htmlWrapper', () => ({ wrapHtmlContent: (html: string) => html }));
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/hooks', () => ({ useRouteDrawer: () => ({}) }));
vi.mock('../ImportTab', () => ({ default: () => null }));
vi.mock('../CreateBlankTab', () => ({ default: () => null }));
vi.mock('../BatchImportTab', () => ({ default: () => null }));
vi.mock('antd', () => ({
  Form: { useForm: () => [{}] },
  Button: () => null,
  Alert: () => null,
  Modal: () => null,
  Tabs: () => null,
}));
vi.mock('@ant-design/icons', () => ({
  FileTextOutlined: () => null,
  UploadOutlined: () => null,
}));
vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
  useFetcher: () => ({ submit: vi.fn() }),
  useLocation: () => ({ pathname: '/admin/cs52-26f/pages/new' }),
  data: (value: unknown, init: ResponseInit) => ({
    type: 'DataWithResponseInit',
    data: value,
    init,
  }),
}));

const newPageRoute = await import('../route.tsx');
const batchRoute = await import('../../api.pages.batch/route.ts');
const slots = await import('@classmoji/utils/upload-concurrency');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = {
  id: 'class-1',
  slug: CLASS_SLUG,
  status: 'ACTIVE',
  content_repo: 'cs52-content',
  git_organization: { login: 'cs52-org' },
};
const CAP = 35 * 1024 * 1024;

/**
 * A request whose body is a stream that records whether anyone pulled from it,
 * and would hand over 10 GB if they kept going. Declares no Content-Length, so
 * only an action that never reads the body can pass the "never pulled" check.
 */
function hugeStreamingRequest(url: string) {
  const state = { pulled: 0 };
  const chunk = new Uint8Array(1024 * 1024);
  // highWaterMark 0: the stream pulls only when someone reads, never to fill
  // its own queue up front — so `pulled` counts readers, not construction.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulled += 1;
        if (state.pulled > 10_240) controller.close();
        else controller.enqueue(chunk);
      },
    },
    { highWaterMark: 0 }
  );
  const request = new Request(url, {
    method: 'POST',
    body,
    headers: { 'content-type': 'multipart/form-data; boundary=----x' },
    // @ts-expect-error — Node's fetch needs `duplex` for a streamed body.
    duplex: 'half',
  });
  return { request, state };
}

const formRequest = (url: string, body: Record<string, string | Blob | Blob[]>) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) formData.append(key, item);
  }
  return new Request(url, { method: 'POST', body: formData });
};

const markdown = () => new File(['# hi\n![x](big.png)'], 'week.md', { type: 'text/markdown' });
const oversizedImage = () => new File([new Uint8Array(CAP + 1)], 'big.png', { type: 'image/png' });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });
  mocks.createPage.mockResolvedValue({ id: 'page-new', title: 'Week 1' });
  mocks.pageContentPath.mockReturnValue('pages/week-1');
  mocks.processMarkdownImport.mockResolvedValue({
    html: '<p>hi</p>',
    imageMap: new Map(),
    unmatchedImages: [],
  });
});

describe('admin.$class.pages.new — body after auth, with a cap', () => {
  it('refuses a caller the gate turns away without reading a byte of the body', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Unauthorized', { status: 401 }));
    const { request, state } = hugeStreamingRequest(
      `http://localhost/admin/${CLASS_SLUG}/pages/new`
    );

    await expect(
      newPageRoute.action({ params: { class: CLASS_SLUG }, request } as never)
    ).rejects.toBeInstanceOf(Response);
    expect(state.pulled).toBe(0);
  });

  it('refuses an image over the repository cap by name, before creating anything', async () => {
    const result = await newPageRoute.action({
      params: { class: CLASS_SLUG },
      request: formRequest(`http://localhost/admin/${CLASS_SLUG}/pages/new`, {
        intent: 'import',
        title: 'Week 1',
        markdown: markdown(),
        images: [new File(['ok'], 'small.png'), oversizedImage()],
      }),
    } as never);

    expect(result).toEqual({
      error: 'big.png is larger than the 35 MB your course repository accepts.',
    });
    expect(mocks.processMarkdownImport).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
  });

  it('refuses a body declared over the import cap without reading it', async () => {
    const { request, state } = hugeStreamingRequest(
      `http://localhost/admin/${CLASS_SLUG}/pages/new`
    );
    request.headers.set('content-length', String(200 * 1024 * 1024));

    const result = await newPageRoute.action({ params: { class: CLASS_SLUG }, request } as never);

    expect(result).toEqual({ error: expect.stringContaining('larger than 150 MB') });
    expect(state.pulled).toBe(0);
  });
});

describe('api.pages.batch — body after auth, with a cap', () => {
  const url = `http://localhost/api/pages/batch?classSlug=${CLASS_SLUG}`;

  it('names the classroom in the URL and refuses without one before reading', async () => {
    const { request, state } = hugeStreamingRequest('http://localhost/api/pages/batch');

    const response = (await batchRoute.action({ request } as never)) as Response;

    expect(response.status).toBe(400);
    expect(mocks.assertClassroomAccess).not.toHaveBeenCalled();
    expect(state.pulled).toBe(0);
  });

  it('refuses a caller the gate turns away without reading a byte of the body', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Unauthorized', { status: 401 }));
    const { request, state } = hugeStreamingRequest(url);

    await expect(batchRoute.action({ request } as never)).rejects.toBeInstanceOf(Response);
    expect(mocks.assertClassroomAccess).toHaveBeenCalledWith(
      expect.objectContaining({ classroomSlug: CLASS_SLUG })
    );
    expect(state.pulled).toBe(0);
  });

  it('refuses an image over the repository cap by name, before creating anything', async () => {
    const response = (await batchRoute.action({
      request: formRequest(url, {
        intent: 'batch-import-single',
        title: 'Week 2',
        markdown: markdown(),
        images: oversizedImage(),
      }),
    } as never)) as Response;

    expect(await response.json()).toEqual({
      error: 'big.png is larger than the 35 MB your course repository accepts.',
    });
    expect(mocks.createPage).not.toHaveBeenCalled();
  });
});

describe('page imports take an upload slot', () => {
  const batchUrl = `http://localhost/api/pages/batch?classSlug=${CLASS_SLUG}`;

  /** Hold every slot, run `fn`, and give them back. */
  async function withAllSlotsTaken(fn: () => Promise<void>) {
    for (let i = 0; i < slots.MAX_CONCURRENT_UPLOADS; i += 1) slots.acquireUploadSlot();
    try {
      await fn();
    } finally {
      for (let i = 0; i < slots.MAX_CONCURRENT_UPLOADS; i += 1) slots.releaseUploadSlot();
    }
  }

  it('the single import answers 503 with a retry when none is free, unread', async () => {
    await withAllSlotsTaken(async () => {
      const { request, state } = hugeStreamingRequest(
        `http://localhost/admin/${CLASS_SLUG}/pages/new`
      );
      const result = (await newPageRoute.action({
        params: { class: CLASS_SLUG },
        request,
      } as never)) as unknown as { data: { error: string }; init: ResponseInit };

      expect(result.init.status).toBe(503);
      expect(result.init.headers).toEqual({ 'Retry-After': '30' });
      expect(result.data.error).toBe(slots.UPLOAD_BUSY_MESSAGE);
      expect(state.pulled).toBe(0);
    });
  });

  it('the batch import answers 503 with a retry when none is free, unread', async () => {
    await withAllSlotsTaken(async () => {
      const { request, state } = hugeStreamingRequest(batchUrl);
      const response = (await batchRoute.action({ request } as never)) as Response;

      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('30');
      expect(await response.json()).toEqual({ error: slots.UPLOAD_BUSY_MESSAGE });
      expect(state.pulled).toBe(0);
    });
  });

  it('gives the slot back whether the import succeeds, is refused, or throws', async () => {
    await newPageRoute.action({
      params: { class: CLASS_SLUG },
      request: formRequest(`http://localhost/admin/${CLASS_SLUG}/pages/new`, {
        intent: 'import',
        title: 'Week 1',
        markdown: markdown(),
        images: oversizedImage(),
      }),
    } as never);
    expect(slots.uploadsInFlight()).toBe(0);

    mocks.createPage.mockRejectedValue(new Error('GitHub is down'));
    await batchRoute.action({
      request: formRequest(batchUrl, {
        intent: 'batch-import-single',
        title: 'Week 2',
        markdown: markdown(),
      }),
    } as never);
    expect(slots.uploadsInFlight()).toBe(0);
  });

  it('is not taken by a caller the gate turns away', async () => {
    mocks.assertClassroomAccess.mockRejectedValue(new Response('Unauthorized', { status: 401 }));
    const { request } = hugeStreamingRequest(batchUrl);
    await expect(batchRoute.action({ request } as never)).rejects.toBeInstanceOf(Response);
    expect(slots.uploadsInFlight()).toBe(0);
  });
});
