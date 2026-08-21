/**
 * contentImport: what the page-row loop does with a FAILED insert.
 *
 * One question, two answers. Nearly every per-item failure is a warning and a
 * skip — that is what makes an import survive a single unreadable page. A
 * unique violation on the page SLUG is the exception: `createWithUniquePageSlug`
 * already absorbs every 23505 it can act on and exhausts into
 * PAGE_SLUG_UNAVAILABLE, so a raw P2002 on [classroom_id, slug] arriving at the
 * catch means the allocator's premise is broken (the likeliest cause: code
 * running against a database whose unique index predates it). Warning there
 * would drop one page per collision and still hand the caller a summary that
 * reads as success. It has to escape — through the row loop AND through the
 * orchestrator's own pages catch, which would otherwise put it right back.
 *
 * Sibling of contentImport.service.test.ts, which is pure-helpers-only by
 * convention; this one drives the exported orchestrator, so GitHub and Prisma
 * are mocked wholesale. `page.service` is only PARTIALLY mocked: the real
 * `isPageSlugConflict` must be the thing making the decision, since the trap
 * being guarded against is a bare `code === 'P2002'` test (pages carries a
 * second composite unique, on [classroom_id, title]).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const pageFindMany = vi.fn();
const pageCreate = vi.fn();
const classroomFindUnique = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: (...args: unknown[]) => classroomFindUnique(...args) },
    page: {
      findMany: (...args: unknown[]) => pageFindMany(...args),
      create: (...args: unknown[]) => pageCreate(...args),
    },
  }),
}));

const uploadBatch = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: {
    // One file, comfortably under the 1MB gate (getMeta null = size unknown,
    // which the collector treats as fine). Enough to stage a page.
    listFolder: vi.fn(async () => [{ type: 'file', path: 'pages/lab-1/index.html' }]),
    getMeta: vi.fn(async () => null),
    getContent: vi.fn(async () => ({ content: 'aGk=' })),
    uploadBatch: (...args: unknown[]) => uploadBatch(...args),
  },
}));

vi.mock('../../git/index.ts', () => ({
  // The source-repo existence gate returns early on a falsy answer, so this
  // must actually resolve true or no page is ever staged.
  getGitProvider: () => ({ repositoryExists: async () => true }),
}));

vi.mock('../contentManifest.service.ts', () => ({ saveManifest: vi.fn() }));
vi.mock('../notification.service.ts', () => ({
  runSafely: vi.fn(),
  getStudentsInClassroom: vi.fn(),
  createNotifications: vi.fn(),
}));

const ensureContentRepo = vi.fn();
const createWithUniquePageSlug = vi.fn();

vi.mock('../page.service.ts', async () => {
  const actual = await vi.importActual<typeof import('../page.service.ts')>('../page.service.ts');
  return {
    ...actual,
    ensureContentRepo: (...args: unknown[]) => ensureContentRepo(...args),
    createWithUniquePageSlug: (...args: unknown[]) => createWithUniquePageSlug(...args),
  };
});

const { importClassroomContent } = await import('../contentImport.service.ts');

const gitOrganization = { id: 'org-1', provider: 'GITHUB', login: 'test-org' };

const classroomRow = (id: string, slug: string) => ({
  id,
  slug,
  content_repo: `content-${slug}`,
  git_organization: gitOrganization,
});

const sourcePage = (id: string, title: string, contentPath: string) => ({
  id,
  title,
  content_path: contentPath,
  width: 'normal',
  show_in_student_menu: false,
  menu_order: 0,
  header_image_url: null,
  header_image_position: null,
});

/** Prisma's shape for a unique violation, as the allocator's guard reads it. */
const p2002 = (target: string[]) =>
  Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target } });

const run = () =>
  importClassroomContent('source-class', 'target-class', 'user-1', {
    pages: true,
    // Slides are a different allocator entirely (pre-scan dedupe, not the
    // P2002 walker) and would only add stubs.
    slides: false,
  });

beforeEach(() => {
  vi.clearAllMocks();

  classroomFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    where.id === 'source-class'
      ? classroomRow('source-class', 'cs52-24')
      : classroomRow('target-class', 'cs52-25')
  );

  pageFindMany.mockImplementation(({ where }: { where: { classroom_id: string } }) =>
    where.classroom_id === 'source-class'
      ? [sourcePage('src-1', 'Lab 1', 'pages/lab-1'), sourcePage('src-2', 'Lab 2', 'pages/lab-2')]
      : []
  );

  // Default: the allocator behaves, handing the write its first candidate.
  createWithUniquePageSlug.mockImplementation(
    (title: string, write: (slug: string | null) => Promise<unknown>) =>
      write(title.toLowerCase().replace(/ /g, '-'))
  );
  pageCreate.mockImplementation(async () => ({ id: 'new-page' }));
  uploadBatch.mockResolvedValue(undefined);
  ensureContentRepo.mockResolvedValue(undefined);
});

describe('contentImport page rows: a slug conflict is not a warning', () => {
  it('copies both pages when nothing collides (the baseline the rest is measured against)', async () => {
    const summary = await run();
    expect(summary.pages).toBe(2);
    expect(summary.warnings).toEqual([]);
  });

  it('throws out of importClassroomContent on a slug P2002 instead of dropping the page', async () => {
    // Injected at the allocator boundary on purpose: the real walker can never
    // let a slug P2002 through (it absorbs them per candidate and exhausts into
    // PAGE_SLUG_UNAVAILABLE, which is not a P2002). A raw one reaching the catch
    // is precisely the "index predates the code" shape being guarded.
    createWithUniquePageSlug.mockRejectedValue(p2002(['classroom_id', 'slug']));

    await expect(run()).rejects.toMatchObject({ code: 'P2002' });

    // Stopped at the first page — the second was never attempted, and no
    // summary was ever returned for a caller to mistake for success.
    expect(createWithUniquePageSlug).toHaveBeenCalledTimes(1);
  });

  it('still warns for the OTHER composite unique on pages — a duplicate title', async () => {
    // The trap a bare `code === 'P2002'` test falls into. A colliding title is
    // an ordinary per-item failure: warn, skip, keep importing.
    createWithUniquePageSlug
      .mockImplementationOnce(() => Promise.reject(p2002(['classroom_id', 'title'])))
      .mockImplementationOnce((_t: string, write: (s: string | null) => Promise<unknown>) =>
        write('lab-2')
      );

    const summary = await run();

    expect(summary.pages).toBe(1);
    expect(summary.warnings).toEqual([
      'pages: DB row failed for "Lab 1": Unique constraint failed',
    ]);
  });

  it('still warns for an insert failure that is not a unique violation at all', async () => {
    pageCreate
      .mockImplementationOnce(() => Promise.reject(new Error('connection reset')))
      .mockImplementationOnce(async () => ({ id: 'new-page-2' }));

    const summary = await run();

    expect(summary.pages).toBe(1);
    expect(summary.warnings).toEqual(['pages: DB row failed for "Lab 1": connection reset']);
  });
});
