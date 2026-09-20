import { describe, it, expect, vi, beforeEach } from 'vitest';

const countMock = vi.fn();
const findManyMock = vi.fn();
const upsertMock = vi.fn();
const updateManyMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepoAssignment: {
      count: countMock,
      findMany: findManyMock,
      upsert: upsertMock,
      updateMany: updateManyMock,
    },
  }),
}));

const { create, getLatePercentage, recordPush } = await import('../gitRepoAssignment.service.ts');

type Row = {
  closed_at: Date | null;
  is_late_override: boolean;
  assignment: { student_deadline: Date | null };
};

const row = (partial: Partial<Row> = {}): Row => ({
  closed_at: null,
  is_late_override: false,
  assignment: { student_deadline: null },
  ...partial,
});

describe('getLatePercentage', () => {
  beforeEach(() => {
    countMock.mockReset();
    findManyMock.mockReset();
    upsertMock.mockReset();
  });

  it('returns 0 when classroom has no assignments', async () => {
    countMock.mockResolvedValue(0);
    findManyMock.mockResolvedValue([]);
    expect(await getLatePercentage('empty-class')).toBe(0);
  });

  it('counts is_late_override=true regardless of timestamps', async () => {
    countMock.mockResolvedValue(1);
    findManyMock.mockResolvedValue([row({ is_late_override: true })]);
    expect(await getLatePercentage('cls')).toBe(100);
  });

  it('does not count rows missing closed_at', async () => {
    countMock.mockResolvedValue(2);
    findManyMock.mockResolvedValue([
      row({
        closed_at: null,
        assignment: { student_deadline: new Date('2026-01-01T00:00:00Z') },
      }),
      row({
        closed_at: new Date('2026-01-05T00:00:00Z'),
        assignment: { student_deadline: new Date('2026-01-01T00:00:00Z') },
      }),
    ]);
    expect(await getLatePercentage('cls')).toBe(50);
  });

  it('does not count rows missing student_deadline (no due date)', async () => {
    countMock.mockResolvedValue(1);
    findManyMock.mockResolvedValue([
      row({
        closed_at: new Date('2026-01-05T00:00:00Z'),
        assignment: { student_deadline: null },
      }),
    ]);
    expect(await getLatePercentage('cls')).toBe(0);
  });

  it('does not count on-time submissions (closed_at <= deadline)', async () => {
    countMock.mockResolvedValue(2);
    const deadline = new Date('2026-01-10T00:00:00Z');
    findManyMock.mockResolvedValue([
      row({
        closed_at: new Date('2026-01-09T00:00:00Z'),
        assignment: { student_deadline: deadline },
      }),
      row({ closed_at: deadline, assignment: { student_deadline: deadline } }),
    ]);
    expect(await getLatePercentage('cls')).toBe(0);
  });

  it('counts late submissions (closed_at > deadline)', async () => {
    countMock.mockResolvedValue(4);
    const deadline = new Date('2026-01-10T00:00:00Z');
    findManyMock.mockResolvedValue([
      row({
        closed_at: new Date('2026-01-11T00:00:00Z'),
        assignment: { student_deadline: deadline },
      }),
      row({
        closed_at: new Date('2026-01-12T00:00:00Z'),
        assignment: { student_deadline: deadline },
      }),
      row({
        closed_at: new Date('2026-01-09T00:00:00Z'),
        assignment: { student_deadline: deadline },
      }),
      row({ closed_at: null, assignment: { student_deadline: deadline } }),
    ]);
    expect(await getLatePercentage('cls')).toBe(50);
  });

  it('rounds the percentage to 0 decimals', async () => {
    countMock.mockResolvedValue(3);
    const deadline = new Date('2026-01-10T00:00:00Z');
    findManyMock.mockResolvedValue([
      row({
        closed_at: new Date('2026-01-11T00:00:00Z'),
        assignment: { student_deadline: deadline },
      }),
      row({ closed_at: null, assignment: { student_deadline: deadline } }),
      row({ closed_at: null, assignment: { student_deadline: deadline } }),
    ]);
    // 1/3 = 33.333...% → rounded to 0 decimals → 33
    expect(await getLatePercentage('cls')).toBe(33);
  });
});

describe('create', () => {
  it('upserts by (git repo, assignment) so retries return the existing row, adopting the issue', async () => {
    upsertMock.mockResolvedValue({ id: 'repo-assignment-1' });

    await create({
      id: 'github-issue-id',
      assignment_id: 'assignment-1',
      git_repo_id: 'git-repo-1',
      provider: 'GITHUB',
      provider_id: 'github-issue-id',
      provider_issue_number: 12,
    });

    expect(upsertMock).toHaveBeenCalledWith({
      where: {
        git_repo_id_assignment_id: {
          git_repo_id: 'git-repo-1',
          assignment_id: 'assignment-1',
        },
      },
      create: {
        id: 'github-issue-id',
        assignment_id: 'assignment-1',
        git_repo_id: 'git-repo-1',
        provider: 'GITHUB',
        provider_id: 'github-issue-id',
        provider_issue_number: 12,
      },
      // The row's id is never rewritten; only the issue fields may be adopted.
      update: {
        provider: 'GITHUB',
        provider_id: 'github-issue-id',
        provider_issue_number: 12,
      },
      include: {
        assignment: true,
        git_repo: true,
      },
    });
  });
});

describe('recordPush', () => {
  beforeEach(() => {
    findManyMock.mockReset();
    updateManyMock.mockReset();
  });

  const pushedAt = new Date('2026-09-20T12:00:00.000Z');

  it('marks only ungraded, published REPO-mode rows submitted, never moving the time backwards', async () => {
    findManyMock.mockResolvedValue([{ id: 'ra-1' }, { id: 'ra-2' }]);
    updateManyMock.mockResolvedValue({ count: 2 });

    const touched = await recordPush('gitrepo-1', pushedAt);

    expect(findManyMock).toHaveBeenCalledWith({
      where: {
        git_repo_id: 'gitrepo-1',
        assignment: { type: 'REPO', submission_mode: 'REPO', is_published: true },
        grades: { none: {} },
        OR: [{ closed_at: null }, { closed_at: { lt: pushedAt } }],
      },
      select: { id: true },
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['ra-1', 'ra-2'] } },
      data: { status: 'CLOSED', closed_at: pushedAt },
    });
    expect(touched).toEqual([{ id: 'ra-1' }, { id: 'ra-2' }]);
  });

  it('writes nothing when no row qualifies', async () => {
    findManyMock.mockResolvedValue([]);

    expect(await recordPush('gitrepo-1', pushedAt)).toEqual([]);
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});
