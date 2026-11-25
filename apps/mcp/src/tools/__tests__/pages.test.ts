/**
 * page_create's `html`: converted on Trigger.dev (the `page-import-convert`
 * task, through the real `pageImport` service with the SDK and the run wait
 * stood in for) BEFORE anything is created.
 *
 * Pinned: without `html` nothing is converted or waited on; with it, the blocks
 * the run returned reach `createPage` (never the html); a run that fails, times
 * out or answers too large is a tool error with the conversion's sentence and
 * creates nothing (no page, no audit row); without Trigger configured `html` is
 * refused while a blank create still works; the page is created in the
 * authorized classroom; the audit row is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  createPage: vi.fn(),
  preflightCreatePage: vi.fn(),
  auditCreate: vi.fn(),
  trigger: vi.fn(),
  cancel: vi.fn(),
  wait: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  tasks: { trigger: (...a: unknown[]) => mocks.trigger(...a) },
  runs: { cancel: (...a: unknown[]) => mocks.cancel(...a) },
}));
vi.mock('../../../../../packages/services/src/helper/runWait.ts', () => ({
  waitForRunOutcome: (...a: unknown[]) => mocks.wait(...a),
}));
vi.mock('../../collab/lifecycle.ts', () => ({
  closeLiveDocBeforeDelete: vi.fn(),
  notifyLiveMetaChanged: vi.fn(),
}));
vi.mock('@classmoji/services/slides', () => ({ slideService: {} }));

vi.mock('@classmoji/services', async () => {
  const pageImport = await vi.importActual<
    typeof import('../../../../../packages/services/src/classmoji/pageImport.service.ts')
  >('../../../../../packages/services/src/classmoji/pageImport.service.ts');
  return {
    ClassmojiService: {
      page: {
        createPage: (...a: unknown[]) => mocks.createPage(...a),
        preflightCreatePage: (...a: unknown[]) => mocks.preflightCreatePage(...a),
      },
      pageImport,
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    },
  };
});

const { pageCreateTool } = await import('../pages.ts');
const { PAGE_IMPORT_MESSAGES } =
  await import('../../../../../packages/services/src/classmoji/pageImport.contract.ts');

const CTX: ToolContext = {
  viewer: { userId: 'teacher-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'TEACHER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'TEACHER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const PAGE = {
  id: 'page-1',
  title: 'Week 1',
  slug: 'week-1',
  content_path: 'pages/week-1',
  is_draft: true,
  is_public: false,
};
const BLOCKS = [{ id: 'b1', type: 'paragraph', content: [] }];

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => e as { kind?: string; message?: string; code?: string }
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  vi.stubEnv('TRIGGER_SECRET_KEY', 'tr_test_x');
  vi.stubEnv('TRIGGER_ACCESS_TOKEN', '');
  mocks.createPage.mockResolvedValue(PAGE);
  mocks.preflightCreatePage.mockResolvedValue({ contentPath: 'pages/week-1' });
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.trigger.mockResolvedValue({ id: 'run_1' });
  mocks.cancel.mockResolvedValue({});
  mocks.wait.mockResolvedValue({ outcome: 'completed', output: { ok: true, blocks: BLOCKS } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('page_create', () => {
  it('without html: a blank page, no conversion and no wait', async () => {
    await pageCreateTool.handler({ classroom: 'org/w26', title: 'Week 1' }, CTX);

    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.createPage).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      title: 'Week 1',
      blocks: undefined,
      createdBy: 'teacher-1',
    });
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('blocks from a worker that predates cleaning are cleaned, not refused', async () => {
    const run = (text: string, styles: Record<string, unknown>) => ({ type: 'text', text, styles });
    mocks.wait.mockResolvedValue({
      outcome: 'completed',
      output: {
        ok: true,
        blocks: [
          { id: 'b1', type: 'paragraph', content: [run('useFetcher', { bold: true, code: true })] },
          { id: 'b2', type: 'paragraph', content: [run('docs', { href: 'https://x.dev' })] },
        ],
      },
    });
    await pageCreateTool.handler(
      { classroom: 'org/w26', title: 'Week 1', html: '<p><b><code>useFetcher</code></b></p>' },
      CTX
    );
    expect(mocks.createPage.mock.calls[0][0].blocks).toEqual([
      { id: 'b1', type: 'paragraph', content: [run('useFetcher', { code: true })] },
      {
        id: 'b2',
        type: 'paragraph',
        content: [{ type: 'link', href: 'https://x.dev', content: [run('docs', {})] }],
      },
    ]);
  });

  it('with html: converts on Trigger first, then creates with the blocks', async () => {
    await pageCreateTool.handler(
      { classroom: 'org/w26', title: 'Week 1', html: '<h2>Setup</h2>' },
      CTX
    );

    expect(mocks.trigger).toHaveBeenCalledWith(
      'page-import-convert',
      { kind: 'html', html: '<h2>Setup</h2>', title: 'Week 1' },
      { ttl: '2m' }
    );
    // Inside the MCP request's 60 s timeout, with room for the commit.
    expect(mocks.wait).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({ timeoutMs: 30_000 })
    );
    expect(mocks.createPage).toHaveBeenCalledExactlyOnceWith({
      classroomId: 'class-1',
      title: 'Week 1',
      blocks: BLOCKS,
      createdBy: 'teacher-1',
    });
    expect(mocks.createPage.mock.calls[0][0]).not.toHaveProperty('html');
    // The audit row is the one page_create always wrote.
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      classroom_id: 'class-1',
      resource_type: 'PAGES',
      resource_id: 'page-1',
      action: 'CREATE',
      data: { tool: 'page_create', title: 'Week 1' },
    });
  });

  it.each([
    ['fails', { outcome: 'failed', status: 'CRASHED' }, 'internal', PAGE_IMPORT_MESSAGES.failed],
    [
      'times out',
      { outcome: 'timeout', status: 'QUEUED' },
      'internal',
      PAGE_IMPORT_MESSAGES.timeout,
    ],
    [
      'answers too large',
      { outcome: 'completed', output: { ok: false, code: 'too_large' } },
      'invalid_params',
      PAGE_IMPORT_MESSAGES.too_large,
    ],
  ])(
    'a conversion that %s is a tool error and creates nothing',
    async (_how, outcome, kind, message) => {
      mocks.wait.mockResolvedValue(outcome);

      const error = await failure(
        pageCreateTool.handler({ classroom: 'org/w26', title: 'Week 1', html: '<p>x</p>' }, CTX)
      );

      expect(error).toMatchObject({ name: 'ToolError', kind, message });
      expect(mocks.createPage).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      'a full classroom',
      Object.assign(new Error('Free classes can have up to 10 pages.'), {
        code: 'PLAN_CONTENT_LIMIT',
      }),
      'forbidden',
    ],
    [
      'a repeated title',
      Object.assign(new Error("A page already uses the content path 'pages/week-1'"), {
        code: 'PAGE_CONTENT_PATH_CONFLICT',
      }),
      'invalid_params',
    ],
  ])('%s is refused as createPage’s refusal is, before any run', async (_label, refusal, kind) => {
    mocks.preflightCreatePage.mockRejectedValue(refusal);

    const error = await failure(
      pageCreateTool.handler({ classroom: 'org/w26', title: 'Week 1', html: '<p>x</p>' }, CTX)
    );

    expect(error).toMatchObject({ name: 'ToolError', kind, message: refusal.message });
    expect(mocks.preflightCreatePage).toHaveBeenCalledWith({
      classroomId: 'class-1',
      title: 'Week 1',
    });
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('a run the worker does not have yet ends at once as unavailable', async () => {
    mocks.wait.mockResolvedValue({ outcome: 'failed', status: 'PENDING_VERSION' });

    const error = await failure(
      pageCreateTool.handler({ classroom: 'org/w26', title: 'Week 1', html: '<p>x</p>' }, CTX)
    );

    expect(error).toMatchObject({
      name: 'ToolError',
      code: 'PAGE_IMPORT_UNAVAILABLE',
      message: PAGE_IMPORT_MESSAGES.unavailable,
    });
    expect(mocks.wait).toHaveBeenCalledWith(
      'run_1',
      expect.objectContaining({ failFastStatuses: ['PENDING_VERSION'] })
    );
    expect(mocks.createPage).not.toHaveBeenCalled();
  });

  it('an html payload over the byte cap is refused before any run', async () => {
    const error = await failure(
      pageCreateTool.handler(
        { classroom: 'org/w26', title: 'Week 1', html: '\u0001'.repeat(500_000) },
        CTX
      )
    );
    expect(error).toMatchObject({
      kind: 'invalid_params',
      message: PAGE_IMPORT_MESSAGES.too_large,
    });
    expect(mocks.trigger).not.toHaveBeenCalled();
    expect(mocks.createPage).not.toHaveBeenCalled();
  });

  describe('without Trigger configured', () => {
    beforeEach(() => vi.stubEnv('TRIGGER_SECRET_KEY', ''));

    it('refuses html with a clear tool error, creating nothing', async () => {
      const error = await failure(
        pageCreateTool.handler({ classroom: 'org/w26', title: 'Week 1', html: '<p>x</p>' }, CTX)
      );
      expect(error).toMatchObject({ name: 'ToolError', code: 'PAGE_IMPORT_UNAVAILABLE' });
      expect(error?.message).toContain(PAGE_IMPORT_MESSAGES.unavailable);
      expect(mocks.trigger).not.toHaveBeenCalled();
      expect(mocks.createPage).not.toHaveBeenCalled();
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    });

    it('still creates a blank page', async () => {
      await pageCreateTool.handler({ classroom: 'org/w26', title: 'Week 1' }, CTX);
      expect(mocks.createPage).toHaveBeenCalledTimes(1);
      expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps its annotations and a description under 1,500 bytes', () => {
    expect(pageCreateTool.annotations).toEqual({ destructive: false, openWorld: true });
    expect(new TextEncoder().encode(pageCreateTool.description).length).toBeLessThan(1500);
  });
});
