/**
 * `findPublishedReleasedSince`: what the nightly release cron opens in the
 * student repos that already exist (#385). It must select a PUBLISHED REPO
 * assignment released inside [since, until] on a PUBLISHED repository, and
 * nothing else: not one released before the window (or every past assignment
 * would be re-checked every night), not a future one, not a draft (the drafts
 * query's), not a quiz or form, not one on a draft repository.
 *
 * Pinned at the where-clause level against a mocked Prisma, as the other
 * assignment.service unit tests do; there is no local database in this suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ assignmentFindMany: vi.fn() }));

vi.mock('@classmoji/database', () => {
  const client = {
    assignment: { findMany: (...a: unknown[]) => mocks.assignmentFindMany(...a) },
  };
  return { default: () => client, GIT_IDENTITY: {} };
});

vi.mock('../notification.service.ts', () => ({}));
vi.mock('../entitlement.service.ts', () => ({}));
vi.mock('../quizAssignment.service.ts', () => ({}));

const { findPublishedReleasedSince } = await import('../assignment.service.ts');

const since = new Date('2026-11-02T04:01:00Z');
const until = new Date('2026-11-04T23:59:59.999Z');

type Where = Record<string, unknown> & {
  release_at: { gte: Date; lte: Date };
};

const whereOf = async (): Promise<{ where: Where; include: unknown }> => {
  await findPublishedReleasedSince(since, until);
  expect(mocks.assignmentFindMany).toHaveBeenCalledTimes(1);
  return mocks.assignmentFindMany.mock.calls[0][0] as { where: Where; include: unknown };
};

beforeEach(() => {
  mocks.assignmentFindMany.mockReset();
  mocks.assignmentFindMany.mockResolvedValue([]);
});

describe('assignment.findPublishedReleasedSince', () => {
  it('selects published REPO assignments with a repository', async () => {
    const { where } = await whereOf();
    expect(where.type).toBe('REPO');
    expect(where.repository_id).toEqual({ not: null });
    // Drafts are the drafts query's (findReadyForRelease), never this one's.
    expect(where.is_published).toBe(true);
  });

  it('bounds release_at to the window: not before since, not after until', async () => {
    const { where } = await whereOf();
    expect(where.release_at).toEqual({ gte: since, lte: until });
  });

  it('excludes assignments on a draft repository', async () => {
    const { where } = await whereOf();
    expect(where.repository).toEqual({ is_published: true });
  });

  it('has no other condition that could widen or narrow it', async () => {
    const { where } = await whereOf();
    expect(Object.keys(where).sort()).toEqual(
      ['is_published', 'release_at', 'repository', 'repository_id', 'type'].sort()
    );
  });

  it('loads the classroom and git organization the cron checks the installation with', async () => {
    const { include } = await whereOf();
    expect(include).toEqual({
      repository: { include: { classroom: { include: { git_organization: true } } } },
    });
  });

  it('returns the rows Prisma found', async () => {
    const rows = [{ id: 'asg-1' }];
    mocks.assignmentFindMany.mockResolvedValue(rows);
    await expect(findPublishedReleasedSince(since, until)).resolves.toBe(rows);
  });
});
