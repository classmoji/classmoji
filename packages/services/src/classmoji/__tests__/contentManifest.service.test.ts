/**
 * saveManifest — which documents land in `general`.
 *
 * A document is "general" when nothing PLACES it on a repository or an
 * assignment. Quiz source material shares the link tables, so a page linked
 * only to a quiz has a link row; counting rows (the old `links.length === 0`)
 * would silently drop it from the manifest. Pinned here with a mocked Prisma
 * and a captured push.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const classroomFindUnique = vi.fn();
const repositoryFindMany = vi.fn();
const pageFindMany = vi.fn();
const slideFindMany = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: (...a: unknown[]) => classroomFindUnique(...a) },
    repository: { findMany: (...a: unknown[]) => repositoryFindMany(...a) },
    page: { findMany: (...a: unknown[]) => pageFindMany(...a) },
    slide: { findMany: (...a: unknown[]) => slideFindMany(...a) },
  }),
}));

const put = vi.fn();
vi.mock('../../content/ContentService.ts', () => ({
  ContentService: { put: (...a: unknown[]) => put(...a) },
}));

const { saveManifest, isPlaced } = await import('../contentManifest.service.ts');

const link = (target: Partial<Record<'repository_id' | 'assignment_id' | 'quiz_id', string>>) => ({
  repository_id: null,
  assignment_id: null,
  quiz_id: null,
  ...target,
});

beforeEach(() => {
  vi.clearAllMocks();
  classroomFindUnique.mockResolvedValue({
    id: 'c1',
    content_repo: 'content',
    git_organization: { login: 'org' },
  });
  repositoryFindMany.mockResolvedValue([]);
  put.mockResolvedValue(undefined);
});

describe('isPlaced', () => {
  it('is true for a repository or assignment link and false for quiz-only or no links', () => {
    expect(isPlaced([link({ repository_id: 'r' })])).toBe(true);
    expect(isPlaced([link({ assignment_id: 'a' })])).toBe(true);
    expect(isPlaced([link({ quiz_id: 'q' }), link({ assignment_id: 'a' })])).toBe(true);
    expect(isPlaced([link({ quiz_id: 'q' })])).toBe(false);
    expect(isPlaced([])).toBe(false);
  });
});

describe('saveManifest general section', () => {
  it('keeps a page and a deck linked only to a quiz in general', async () => {
    pageFindMany.mockResolvedValue([
      { id: 'p-quiz', slug: 'quiz-only', links: [link({ quiz_id: 'q1' })] },
      { id: 'p-none', slug: 'unlinked', links: [] },
      { id: 'p-repo', slug: 'on-a-repo', links: [link({ repository_id: 'r1' })] },
    ]);
    slideFindMany.mockResolvedValue([
      { id: 's-quiz', slug: 'deck-quiz-only', links: [link({ quiz_id: 'q1' })] },
      { id: 's-asg', slug: 'deck-on-assignment', links: [link({ assignment_id: 'a1' })] },
    ]);

    await expect(saveManifest('c1')).resolves.toBe(true);

    const manifest = JSON.parse(put.mock.calls[0][0].content);
    expect(manifest.general).toEqual({
      pages: ['quiz-only', 'unlinked'],
      slides: ['deck-quiz-only'],
    });
  });
});
