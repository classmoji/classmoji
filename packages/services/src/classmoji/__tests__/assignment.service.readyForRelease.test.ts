/**
 * `findReadyForRelease`: the drafts the hourly release job works through.
 *
 * It must leave out a draft the job can do nothing with (an unpublished
 * repository with nobody to make a repo for): the job only logged those and
 * moved on, so 18 of them, some six months old, came back on every run. It
 * must NOT leave out a draft on a published repository, which the job
 * publishes even with nobody enrolled.
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

const { findReadyForRelease } = await import('../assignment.service.ts');

const now = new Date('2026-11-10T12:01:00Z');

type RepositoryFilter = {
  is_published: boolean;
  OR: Record<string, unknown>[];
};

const whereOf = async (): Promise<Record<string, unknown>> => {
  await findReadyForRelease(now);
  expect(mocks.assignmentFindMany).toHaveBeenCalledTimes(1);
  return (mocks.assignmentFindMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
};

const skipped = async (): Promise<RepositoryFilter> =>
  ((await whereOf()).NOT as { repository: RepositoryFilter }).repository;

beforeEach(() => {
  mocks.assignmentFindMany.mockReset();
  mocks.assignmentFindMany.mockResolvedValue([]);
});

describe('assignment.findReadyForRelease', () => {
  it('selects draft REPO assignments due by the given time', async () => {
    const where = await whereOf();
    expect(where.type).toBe('REPO');
    expect(where.repository_id).toEqual({ not: null });
    expect(where.is_published).toBe(false);
    expect(where.release_at).toEqual({ lte: now });
  });

  it('only ever skips drafts on an UNPUBLISHED repository', async () => {
    // A draft on a published repository is published by the job even with
    // nobody enrolled; skipping it would hide it from students who join later.
    expect((await skipped()).is_published).toBe(false);
  });

  it('skips an individual repository in a classroom with no students', async () => {
    expect((await skipped()).OR).toContainEqual({
      type: 'INDIVIDUAL',
      classroom: { memberships: { none: { role: 'STUDENT' } } },
    });
  });

  it('skips a team repository with no tag', async () => {
    expect((await skipped()).OR).toContainEqual({ type: { not: 'INDIVIDUAL' }, tag_id: null });
  });

  it('has no other condition that could widen or narrow it', async () => {
    const where = await whereOf();
    expect(Object.keys(where).sort()).toEqual(
      ['NOT', 'is_published', 'release_at', 'repository_id', 'type'].sort()
    );
    expect((where.NOT as { repository: RepositoryFilter }).repository.OR).toHaveLength(2);
  });
});
