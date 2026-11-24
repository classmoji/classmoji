/**
 * The import actions convert on Trigger.dev (`ClassmojiService.pageImport`,
 * the `page-import-convert` task) and create only once that answered.
 *
 * Pinned for both admin.$class.pages.new (one page) and api.pages.batch (one
 * page per request): a conversion's blocks and image placement reach
 * `createPage` (images committed where the conversion said, by upload
 * position); a conversion that fails or times out is the drawer's error / the
 * batch's per-page failure with the conversion's sentence, and creates nothing
 * (no page, no commit, no audit row); without Trigger the loader hides Import
 * and Batch Import and the actions refuse them, while Create Blank works.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertClassroomMutationAllowed: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  createPage: vi.fn(),
  freePageContentPath: vi.fn(),
  ensureContentRepo: vi.fn(),
  preflightCreatePage: vi.fn(),
  contentAllowance: vi.fn(),
  convertMarkdown: vi.fn(),
  isPageImportAvailable: vi.fn(),
}));

const MESSAGES = {
  unavailable: 'Importing pages is not available right now.',
  failed: 'This page could not be converted. Check the file and try again.',
  timeout: 'Converting this page took too long. Please try again.',
};

class FakePageImportError extends Error {
  code = 'PAGE_IMPORT_ERROR';
}

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertClassroomMutationAllowed: (...a: unknown[]) => mocks.assertClassroomMutationAllowed(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    page: {
      createPage: (...a: unknown[]) => mocks.createPage(...a),
      freePageContentPath: (...a: unknown[]) => mocks.freePageContentPath(...a),
      ensureContentRepo: (...a: unknown[]) => mocks.ensureContentRepo(...a),
      preflightCreatePage: (...a: unknown[]) => mocks.preflightCreatePage(...a),
    },
    planLimits: {
      contentAllowance: (...a: unknown[]) => mocks.contentAllowance(...a),
      contentLimitMessage: () => 'limit',
    },
    pageImport: {
      convertMarkdown: (...a: unknown[]) => mocks.convertMarkdown(...a),
      isPageImportAvailable: () => mocks.isPageImportAvailable(),
      assertImportTitle: (title?: string) => {
        if (title && title.length > 1_000)
          throw new Error('The page title is longer than 1,000 characters.');
      },
      PAGE_IMPORT_MESSAGES: MESSAGES,
    },
  },
}));

vi.mock('~/utils/classroomForClient', () => ({ classroomForClient: (c: object) => c }));
vi.mock('~/components/features/plan/ContentLimitModal', () => ({ default: () => null }));
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

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = {
  id: 'class-1',
  slug: CLASS_SLUG,
  status: 'ACTIVE',
  content_repo: 'cs52-content',
  git_organization: { login: 'cs52-org', provider: 'GITHUB' },
};

const formRequest = (url: string, body: Record<string, string | Blob | Blob[]>) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) {
    for (const item of Array.isArray(value) ? value : [value]) formData.append(key, item);
  }
  return new Request(url, { method: 'POST', body: formData });
};

const markdown = () =>
  new File(['# Week 1\n![d](img/diagram.png)'], 'week.md', { type: 'text/markdown' });
const image = (name: string, bytes: string) => new File([bytes], name, { type: 'image/png' });

const BLOCKS = [{ id: 'b1', type: 'paragraph', content: [] }];

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'OWNER' },
  });
  mocks.createPage.mockResolvedValue({ id: 'page-new', title: 'Week 1' });
  mocks.freePageContentPath.mockResolvedValue('pages/week-1');
  mocks.contentAllowance.mockResolvedValue({ limit: null, remaining: null });
  mocks.isPageImportAvailable.mockReturnValue(true);
  mocks.preflightCreatePage.mockResolvedValue({ contentPath: 'pages/week-1' });
  mocks.convertMarkdown.mockResolvedValue({
    blocks: BLOCKS,
    images: [
      {
        originalPath: 'img/diagram.png',
        index: 1,
        newPath: 'pages/week-1/assets/diagram-1.png',
        newFilename: 'diagram-1.png',
        githubUrl:
          'https://raw.githubusercontent.com/cs52-org/cs52-content/main/pages/week-1/assets/diagram-1.png',
      },
    ],
    unmatched: [0],
    missing: [],
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const singleImport = (body: Record<string, string | Blob | Blob[]> = {}) =>
  newPageRoute.action({
    params: { class: CLASS_SLUG },
    request: formRequest(`http://localhost/admin/${CLASS_SLUG}/pages/new?intent=import`, {
      intent: 'import',
      title: 'Week 1',
      markdown: markdown(),
      images: [image('extra.png', 'EXTRA'), image('diagram.png', 'DIAGRAM')],
      ...body,
    }),
  } as never) as Promise<Record<string, unknown>>;

const batchImport = async (body: Record<string, string | Blob | Blob[]> = {}) => {
  const response = (await batchRoute.action({
    request: formRequest(`http://localhost/api/pages/batch?classSlug=${CLASS_SLUG}`, {
      intent: 'batch-import-single',
      title: 'Week 1',
      markdown: markdown(),
      images: [image('extra.png', 'EXTRA'), image('diagram.png', 'DIAGRAM')],
      ...body,
    }),
  } as never)) as Response;
  return (await response.json()) as Record<string, unknown>;
};

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe.each([
  ['admin.$class.pages.new', singleImport],
  ['api.pages.batch', batchImport],
])('%s — conversion on Trigger', (_route, submit) => {
  it('converts with the images’ names, then creates with its blocks and placements', async () => {
    const result = await submit();

    expect(result).toMatchObject({ created: true });
    expect(mocks.convertMarkdown).toHaveBeenCalledExactlyOnceWith({
      markdown: '# Week 1\n![d](img/diagram.png)',
      title: 'Week 1',
      imageNames: ['extra.png', 'diagram.png'],
      options: {
        org: 'cs52-org',
        repo: 'cs52-content',
        contentPath: 'pages/week-1',
        assetsFolder: 'pages/week-1/assets',
        provider: 'GITHUB',
      },
    });
    const created = mocks.createPage.mock.calls[0][0] as {
      blocks: unknown;
      files: Array<{ path: string; content: string; encoding: string }>;
      commitMessage: string;
    };
    expect(created.blocks).toBe(BLOCKS);
    expect(created).not.toHaveProperty('html');
    expect(created.commitMessage).toBe('Import page: Week 1');
    // The matched upload where the conversion placed it, then the unmatched
    // one under assets/: each by its position, with its own bytes.
    expect(created.files[0]).toEqual({
      path: 'pages/week-1/assets/diagram-1.png',
      content: b64('DIAGRAM'),
      encoding: 'base64',
    });
    expect(created.files[1]).toMatchObject({ content: b64('EXTRA'), encoding: 'base64' });
    expect(created.files[1].path).toMatch(/^pages\/week-1\/assets\/extra-\d+\.png$/);
    expect(created.files).toHaveLength(2);
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['fails', MESSAGES.failed],
    ['times out', MESSAGES.timeout],
  ])('a conversion that %s is shown and creates nothing', async (_how, message) => {
    mocks.convertMarkdown.mockRejectedValue(new FakePageImportError(message));

    const result = await submit();

    expect(result).toEqual({ error: message });
    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a full classroom',
      Object.assign(new Error('Free classes can have up to 10 pages.'), {
        code: 'PLAN_CONTENT_LIMIT',
      }),
    ],
    [
      'a repeated title',
      Object.assign(
        new Error(
          `A page already uses the content path 'pages/week-1' (existing page: "Week 1"). Choose a title that maps to a different URL path.`
        ),
        { code: 'PAGE_CONTENT_PATH_CONFLICT' }
      ),
    ],
  ])('%s is refused with createPage’s message before any run', async (_label, refusal) => {
    mocks.preflightCreatePage.mockRejectedValue(refusal);

    const result = await submit();

    expect(result).toEqual({ error: refusal.message });
    expect(mocks.preflightCreatePage).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'class-1', title: 'Week 1' })
    );
    expect(mocks.convertMarkdown).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('a title over the conversion’s cap is refused before any run', async () => {
    const result = await submit({ title: 't'.repeat(1_001) });

    expect(result).toEqual({ error: 'The page title is longer than 1,000 characters.' });
    expect(mocks.convertMarkdown).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
  });

  it('without Trigger, refuses the import before converting or creating', async () => {
    mocks.isPageImportAvailable.mockReturnValue(false);

    const result = await submit();

    expect(result).toEqual({ error: MESSAGES.unavailable });
    expect(mocks.convertMarkdown).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('api.pages.batch — link target', () => {
  it('a repository outside the classroom is refused before any run', async () => {
    mocks.preflightCreatePage.mockRejectedValue(new Error('Repository not found'));

    const result = await batchImport({ assignmentId: 'repo-elsewhere' });

    expect(result).toEqual({ error: 'Repository not found' });
    expect(mocks.preflightCreatePage).toHaveBeenCalledWith({
      classroomId: 'class-1',
      title: 'Week 1',
      linkRepositoryId: 'repo-elsewhere',
    });
    expect(mocks.convertMarkdown).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
  });
});

describe('without Trigger', () => {
  beforeEach(() => {
    mocks.isPageImportAvailable.mockReturnValue(false);
  });

  it('the drawer’s loader hides Import and Batch Import', async () => {
    const data = await newPageRoute.loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/pages/new`),
    } as never);
    expect(data).toMatchObject({ importAvailable: false });

    mocks.isPageImportAvailable.mockReturnValue(true);
    const configured = await newPageRoute.loader({
      params: { class: CLASS_SLUG },
      request: new Request(`http://localhost/admin/${CLASS_SLUG}/pages/new`),
    } as never);
    expect(configured).toMatchObject({ importAvailable: true });
  });

  it('Create Blank still creates, with no blocks and no conversion', async () => {
    const result = (await newPageRoute.action({
      params: { class: CLASS_SLUG },
      request: formRequest(`http://localhost/admin/${CLASS_SLUG}/pages/new`, {
        intent: 'create-blank',
        title: 'Week 1',
      }),
    } as never)) as Record<string, unknown>;

    expect(result).toMatchObject({ created: true });
    expect(mocks.convertMarkdown).not.toHaveBeenCalled();
    expect(mocks.createPage.mock.calls[0][0]).toMatchObject({ blocks: undefined, files: [] });
    expect(mocks.addClassroomAuditLog.mock.calls[0][0]).toMatchObject({
      metadata: { tool: 'web:pages.create_blank' },
    });
  });

  it('the batch refuses its init too, before the content repo is touched', async () => {
    const response = (await batchRoute.action({
      request: formRequest(`http://localhost/api/pages/batch?classSlug=${CLASS_SLUG}`, {
        intent: 'batch-init',
      }),
    } as never)) as Response;

    expect(await response.json()).toEqual({ error: MESSAGES.unavailable });
    expect(mocks.ensureContentRepo).not.toHaveBeenCalled();
  });
});
