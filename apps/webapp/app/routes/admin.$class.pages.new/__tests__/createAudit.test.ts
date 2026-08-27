/**
 * Unit tests for page CREATION audit rows.
 *
 * Page creation reaches the database by two different routes, and both are
 * covered here so neither can regress alone:
 *
 * - admin.$class.pages.new's own action handles the single blank page and the
 *   single markdown import.
 * - api.pages.batch handles the batch flow, which posts once per page rather
 *   than through the form action above.
 *
 * All three write the same 'PAGES'/'CREATE' shape the MCP page_create tool
 * writes, differing only in `tool` — which names the flow and, because the
 * audit service dedups on it, keeps two quick creates from collapsing.
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

// The actions are what is under test; the view layer only needs to import.
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
}));

const newPageRoute = await import('../route.tsx');
const batchRoute = await import('../../api.pages.batch/route.ts');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = {
  id: 'class-1',
  slug: CLASS_SLUG,
  status: 'ACTIVE',
  content_repo: 'cs52-content',
  git_organization: { login: 'cs52-org' },
};

const formRequest = (url: string, body: Record<string, string | Blob>) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.append(key, value);
  return new Request(url, { method: 'POST', body: formData });
};

/** The single audit entry the action wrote. */
const auditEntry = () =>
  mocks.addClassroomAuditLog.mock.calls[0][0] as {
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown>;
  };

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

describe('admin.$class.pages.new — audit rows', () => {
  const submit = (body: Record<string, string | Blob>) =>
    newPageRoute.action({
      params: { class: CLASS_SLUG },
      request: formRequest(`http://localhost/admin/${CLASS_SLUG}/pages/new`, body),
    } as unknown as Parameters<typeof newPageRoute.action>[0]);

  it('audits a blank page create against the new page', async () => {
    const result = await submit({ title: 'Week 1' });

    expect(result).toMatchObject({ created: true });
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      userId: 'owner-1',
      role: 'OWNER',
      action: 'CREATE',
      resourceType: 'PAGES',
      resourceId: 'page-new',
      metadata: { tool: 'web:pages.create_blank', title: 'Week 1' },
    });
  });

  it('audits an import create under its own tool name', async () => {
    await submit({
      intent: 'import',
      title: 'Week 1',
      markdown: new File(['# hi'], 'week1.md', { type: 'text/markdown' }),
    });

    expect(auditEntry()).toMatchObject({
      action: 'CREATE',
      resourceType: 'PAGES',
      resourceId: 'page-new',
      metadata: { tool: 'web:pages.create_import', title: 'Week 1', imported_files: 0 },
    });
  });

  it('writes no row when creation fails', async () => {
    mocks.createPage.mockRejectedValue(new Error('github unavailable'));

    const result = await submit({ title: 'Week 1' });

    expect(result).toMatchObject({ error: 'github unavailable' });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes no row when the classroom has no content repo to write into', async () => {
    mocks.assertClassroomAccess.mockResolvedValue({
      userId: 'owner-1',
      classroom: { ...CLASSROOM, content_repo: null },
      membership: { role: 'OWNER' },
    });

    await submit({ title: 'Week 1' });

    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('api.pages.batch — audit rows', () => {
  const submit = (body: Record<string, string | Blob>) =>
    batchRoute.action({
      params: {},
      request: formRequest('http://localhost/api/pages/batch', body),
    } as unknown as Parameters<typeof batchRoute.action>[0]);

  it('audits each batch-imported page as its own CREATE', async () => {
    // The batch flow posts once per page, so this is where batch creation gets
    // recorded — the pages.new action never sees it.
    await submit({
      intent: 'batch-import-single',
      classSlug: CLASS_SLUG,
      title: 'Week 2',
      markdown: new File(['# hi'], 'week2.md', { type: 'text/markdown' }),
    });

    expect(auditEntry()).toMatchObject({
      action: 'CREATE',
      resourceType: 'PAGES',
      resourceId: 'page-new',
      metadata: {
        tool: 'web:pages.create_batch',
        title: 'Week 2',
        imported_files: 0,
        linked_repository_id: null,
      },
    });
  });

  it('records the repository a batch page was linked to', async () => {
    await submit({
      intent: 'batch-import-single',
      classSlug: CLASS_SLUG,
      title: 'Week 2',
      assignmentId: 'repo-7',
      markdown: new File(['# hi'], 'week2.md', { type: 'text/markdown' }),
    });

    expect(auditEntry().metadata).toMatchObject({ linked_repository_id: 'repo-7' });
  });

  it('writes no row for batch-init, which creates no page', async () => {
    mocks.ensureContentRepo.mockResolvedValue({ repoName: 'cs52-content' });

    await submit({ intent: 'batch-init', classSlug: CLASS_SLUG });

    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('writes no row when a batch page fails to import', async () => {
    mocks.createPage.mockRejectedValue(new Error('github unavailable'));

    await submit({
      intent: 'batch-import-single',
      classSlug: CLASS_SLUG,
      title: 'Week 2',
      markdown: new File(['# hi'], 'week2.md', { type: 'text/markdown' }),
    });

    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});
