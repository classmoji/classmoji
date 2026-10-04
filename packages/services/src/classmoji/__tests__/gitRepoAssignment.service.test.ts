import { describe, it, expect, vi, beforeEach } from 'vitest';

const countMock = vi.fn();
const findManyMock = vi.fn();
const upsertMock = vi.fn();
const updateManyMock = vi.fn();
const updateManyAndReturnMock = vi.fn();
const findUniqueMock = vi.fn();
const findFirstMock = vi.fn();
const updateMock = vi.fn();
const listCommitsMock = vi.fn();
// `create` checks the repo and the assignment share a classroom before linking
// them; both lookups resolve to the same classroom here so the write proceeds.
const gitRepoFindUniqueMock = vi.fn(async () => ({ classroom_id: 'cls-1' }));
const assignmentFindUniqueMock = vi.fn(async () => ({ module: { classroom_id: 'cls-1' } }));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepoAssignment: {
      count: countMock,
      findMany: findManyMock,
      upsert: upsertMock,
      updateMany: updateManyMock,
      updateManyAndReturn: updateManyAndReturnMock,
      findUnique: findUniqueMock,
      findFirst: findFirstMock,
      update: updateMock,
    },
    gitRepo: { findUnique: gitRepoFindUniqueMock },
    assignment: { findUnique: assignmentFindUniqueMock },
  }),
}));

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({ listCommits: (...a: unknown[]) => listCommitsMock(...a) }),
}));

const {
  create,
  getLateCount,
  getLatePercentage,
  isCountedLate,
  latePercentage,
  recordPush,
  recordExistingPush,
  recordPushAfterExtension,
} = await import('../gitRepoAssignment.service.ts');

type Row = {
  closed_at: Date | null;
  is_late_override: boolean;
  assignment: { student_deadline: Date | null };
  token_transactions: { hours_purchased: number | null }[];
};

const row = (partial: Partial<Row> = {}): Row => ({
  closed_at: null,
  is_late_override: false,
  assignment: { student_deadline: null },
  token_transactions: [],
  ...partial,
});

describe('getLatePercentage', () => {
  beforeEach(() => {
    countMock.mockReset();
    findManyMock.mockReset();
    upsertMock.mockReset();
  });

  it('returns 0 when classroom has no assignments', async () => {
    findManyMock.mockResolvedValue([]);
    expect(await getLatePercentage('empty-class')).toBe(0);
  });

  it('counts a submitted row with is_late_override=true even when on time', async () => {
    findManyMock.mockResolvedValue([
      row({ is_late_override: true, closed_at: new Date('2026-01-05T00:00:00Z') }),
    ]);
    expect(await getLatePercentage('cls')).toBe(100);
  });

  it('does not count an exempted row with nothing turned in', async () => {
    findManyMock.mockResolvedValue([row({ is_late_override: true })]);
    expect(await getLatePercentage('cls')).toBe(0);
  });

  it('does not count rows missing closed_at', async () => {
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
    findManyMock.mockResolvedValue([
      row({
        closed_at: new Date('2026-01-05T00:00:00Z'),
        assignment: { student_deadline: null },
      }),
    ]);
    expect(await getLatePercentage('cls')).toBe(0);
  });

  it('does not count on-time submissions (closed_at <= deadline)', async () => {
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

  it('reads every token transaction of each row, refunds included', async () => {
    findManyMock.mockResolvedValue([]);
    await getLatePercentage('cls');
    expect(findManyMock.mock.calls[0][0].select.token_transactions).toEqual({
      select: { hours_purchased: true },
    });
  });

  it('measures lateness from the deadline plus the hours the student bought', async () => {
    const deadline = new Date('2026-01-10T00:00:00Z');
    const hoursAfter = (h: number) => new Date(deadline.getTime() + h * 3_600_000);
    findManyMock.mockResolvedValue([
      // 3 hours late, 3 bought: on time.
      row({
        closed_at: hoursAfter(3),
        assignment: { student_deadline: deadline },
        token_transactions: [{ hours_purchased: 3 }],
      }),
      // 5 hours late, 4 bought: late.
      row({
        closed_at: hoursAfter(5),
        assignment: { student_deadline: deadline },
        token_transactions: [{ hours_purchased: 4 }],
      }),
      // 3 hours late, 3 bought then refunded: late.
      row({
        closed_at: hoursAfter(3),
        assignment: { student_deadline: deadline },
        token_transactions: [{ hours_purchased: 3 }, { hours_purchased: -3 }],
      }),
      // Under an hour late counts in whole hours, as is_late does: on time.
      row({ closed_at: hoursAfter(0.5), assignment: { student_deadline: deadline } }),
    ]);
    expect(await getLateCount('cls')).toEqual({ total: 4, late: 2 });
    expect(await getLatePercentage('cls')).toBe(50);
  });
});

describe('latePercentage', () => {
  it('derives the whole percentage from counts already read', () => {
    expect(latePercentage({ total: 0, late: 0 })).toBe(0);
    expect(latePercentage({ total: 3, late: 1 })).toBe(33);
    expect(latePercentage({ total: 4, late: 2 })).toBe(50);
  });
});

describe('isCountedLate', () => {
  const deadline = new Date('2026-01-10T00:00:00Z');

  it('counts an exempted submission and one past the extended deadline', () => {
    expect(
      isCountedLate(
        row({
          is_late_override: true,
          closed_at: new Date('2026-01-09T00:00:00Z'),
          assignment: { student_deadline: deadline },
        })
      )
    ).toBe(true);
    expect(
      isCountedLate(
        row({
          closed_at: new Date('2026-01-10T05:00:00Z'),
          assignment: { student_deadline: deadline },
          token_transactions: [{ hours_purchased: 2 }],
        })
      )
    ).toBe(true);
  });

  it('never counts a row with nothing turned in', () => {
    expect(isCountedLate(row({ assignment: { student_deadline: deadline } }))).toBe(false);
  });

  it('never counts an exempted row with nothing turned in', () => {
    expect(isCountedLate(row({ is_late_override: true }))).toBe(false);
    expect(
      isCountedLate(row({ is_late_override: true, assignment: { student_deadline: deadline } }))
    ).toBe(false);
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

  describe('a unique violation (two runs creating the same pair)', () => {
    const issueRow = {
      id: 'github-issue-id',
      assignment_id: 'assignment-1',
      git_repo_id: 'git-repo-1',
      provider: 'GITHUB',
      provider_id: 'github-issue-id',
      provider_issue_number: 12,
    };
    // What production saw: Prisma reads, misses, inserts, and the pkey trips.
    const pkeyConflict = () =>
      Object.assign(new Error('Unique constraint failed on the fields: (`id`)'), {
        code: 'P2002',
        meta: { target: ['id'] },
      });

    beforeEach(() => {
      upsertMock.mockReset();
      findUniqueMock.mockReset();
      findFirstMock.mockReset();
      updateMock.mockReset();
    });

    it('returns the row the concurrent run created instead of failing', async () => {
      upsertMock.mockRejectedValue(pkeyConflict());
      findUniqueMock.mockResolvedValue({ id: 'github-issue-id', provider_id: 'github-issue-id' });

      await expect(create(issueRow)).resolves.toEqual({
        id: 'github-issue-id',
        provider_id: 'github-issue-id',
      });
      expect(findUniqueMock).toHaveBeenCalledWith({
        where: {
          git_repo_id_assignment_id: { git_repo_id: 'git-repo-1', assignment_id: 'assignment-1' },
        },
        include: { assignment: true, git_repo: true },
      });
      // The winner's issue fields are left alone.
      expect(updateMock).not.toHaveBeenCalled();
    });

    it('fills in issue fields only when the winning row has none', async () => {
      upsertMock.mockRejectedValue(pkeyConflict());
      findUniqueMock.mockResolvedValue({ id: 'uuid-1', provider_id: null });
      updateMock.mockResolvedValue({ id: 'uuid-1', provider_id: 'github-issue-id' });

      await create(issueRow);

      expect(updateMock).toHaveBeenCalledWith({
        where: {
          git_repo_id_assignment_id: { git_repo_id: 'git-repo-1', assignment_id: 'assignment-1' },
        },
        data: { provider: 'GITHUB', provider_id: 'github-issue-id', provider_issue_number: 12 },
        include: { assignment: true, git_repo: true },
      });
    });

    it('names the other row when the issue already belongs to a different pair', async () => {
      upsertMock.mockRejectedValue(pkeyConflict());
      findUniqueMock.mockResolvedValue(null);
      findFirstMock.mockResolvedValue({
        id: 'github-issue-id',
        git_repo_id: 'git-repo-1',
        assignment_id: 'assignment-other',
      });

      await expect(create(issueRow)).rejects.toThrow(
        /already the submission row github-issue-id for repo git-repo-1 \/ assignment assignment-other/
      );
    });

    it('passes other errors straight through', async () => {
      const blip = Object.assign(new Error("Can't reach database server"), { code: 'P1001' });
      upsertMock.mockRejectedValue(blip);

      await expect(create(issueRow)).rejects.toBe(blip);
      expect(findUniqueMock).not.toHaveBeenCalled();
    });
  });
});

describe('recordPush', () => {
  beforeEach(() => {
    findManyMock.mockReset();
    updateManyMock.mockReset();
    updateManyAndReturnMock.mockReset();
  });

  const pushedAt = new Date('2026-09-20T12:00:00.000Z');

  const candidate = (
    id: string,
    deadline: Date | null,
    hours: number[] = [],
    closedAt: Date | null = null
  ) => ({
    id,
    closed_at: closedAt,
    assignment: { student_deadline: deadline },
    token_transactions: hours.map(h => ({ hours_purchased: h })),
  });

  // The candidate conditions, repeated in the write so a newer stamp or a
  // grade landing between the read and the write wins.
  const inTimeWhere = (ids: string[]) => ({
    id: { in: ids },
    OR: [{ closed_at: null }, { closed_at: { lt: pushedAt }, grades: { none: {} } }],
  });
  const lateFirstWhere = (ids: string[]) => ({ id: { in: ids }, closed_at: null });

  it('submits published REPO-mode rows: any first push, and later pushes only while ungraded', async () => {
    findManyMock.mockResolvedValue([candidate('ra-1', null), candidate('ra-2', null)]);
    updateManyAndReturnMock.mockResolvedValue([{ id: 'ra-1' }, { id: 'ra-2' }]);

    const touched = await recordPush('gitrepo-1', pushedAt);

    // A grade never freezes a row with no submission yet (a first push always
    // counts); it freezes only a submission that already exists.
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      git_repo_id: 'gitrepo-1',
      assignment: { type: 'REPO', submission_mode: 'REPO', is_published: true },
      OR: [{ closed_at: null }, { closed_at: { lt: pushedAt }, grades: { none: {} } }],
    });
    expect(updateManyAndReturnMock).toHaveBeenCalledWith({
      where: { OR: [inTimeWhere(['ra-1', 'ra-2'])] },
      data: { status: 'CLOSED', closed_at: pushedAt },
      select: { id: true },
    });
    expect(updateManyMock).not.toHaveBeenCalled();
    expect(touched).toEqual([{ id: 'ra-1' }, { id: 'ra-2' }]);
  });

  it('freezes an on-time submission at the deadline, extended by purchased hours', async () => {
    const hourBefore = new Date(pushedAt.getTime() - 3_600_000);
    const threeHoursBefore = new Date(pushedAt.getTime() - 3 * 3_600_000);
    const onTime = new Date(pushedAt.getTime() - 2 * 3_600_000);
    findManyMock.mockResolvedValue([
      candidate('past-deadline-submitted', hourBefore, [], onTime),
      candidate('within-extension', threeHoursBefore, [2, 2]),
      candidate('extension-too-short-submitted', threeHoursBefore, [1], onTime),
      candidate('no-deadline', null),
    ]);
    updateManyAndReturnMock.mockResolvedValue([{ id: 'within-extension' }, { id: 'no-deadline' }]);

    const touched = await recordPush('gitrepo-1', pushedAt);

    expect(updateManyAndReturnMock).toHaveBeenCalledWith({
      where: { OR: [inTimeWhere(['within-extension', 'no-deadline'])] },
      data: { status: 'CLOSED', closed_at: pushedAt },
      select: { id: true },
    });
    expect(touched).toEqual([{ id: 'within-extension' }, { id: 'no-deadline' }]);
  });

  it('records a first push after the deadline as a late submission, only while still unsubmitted', async () => {
    const hourBefore = new Date(pushedAt.getTime() - 3_600_000);
    findManyMock.mockResolvedValue([
      candidate('never-submitted', hourBefore),
      candidate('no-deadline', null),
    ]);
    updateManyAndReturnMock.mockResolvedValue([{ id: 'never-submitted' }, { id: 'no-deadline' }]);

    const touched = await recordPush('gitrepo-1', pushedAt);

    expect(updateManyAndReturnMock).toHaveBeenCalledWith({
      where: { OR: [inTimeWhere(['no-deadline']), lateFirstWhere(['never-submitted'])] },
      data: { status: 'CLOSED', closed_at: pushedAt },
      select: { id: true },
    });
    expect(touched).toEqual([{ id: 'never-submitted' }, { id: 'no-deadline' }]);
  });

  it('returns only the rows the write changed: an older push after a newer stamp leaves it alone', async () => {
    // Read before a newer push stamped the row; by the time this older push
    // writes, the row's closed_at is later than pushedAt, so the conditional
    // write matches nothing and reports nothing changed.
    findManyMock.mockResolvedValue([candidate('stamped-meanwhile', null)]);
    updateManyAndReturnMock.mockResolvedValue([]);

    const touched = await recordPush('gitrepo-1', pushedAt);

    const where = updateManyAndReturnMock.mock.calls[0][0].where;
    expect(where).toEqual({ OR: [inTimeWhere(['stamped-meanwhile'])] });
    // Only an empty closed_at or an earlier, ungraded one can be overwritten.
    expect(where.OR[0].OR).not.toContainEqual({});
    expect(touched).toEqual([]);
  });

  it('writes nothing when no row qualifies', async () => {
    findManyMock.mockResolvedValue([]);

    expect(await recordPush('gitrepo-1', pushedAt)).toEqual([]);
    expect(updateManyAndReturnMock).not.toHaveBeenCalled();
  });

  it('writes nothing when every candidate is past the cutoff with a submission', async () => {
    const hourBefore = new Date(pushedAt.getTime() - 3_600_000);
    const onTime = new Date(pushedAt.getTime() - 2 * 3_600_000);
    findManyMock.mockResolvedValue([candidate('submitted', hourBefore, [], onTime)]);

    expect(await recordPush('gitrepo-1', pushedAt)).toEqual([]);
    expect(updateManyAndReturnMock).not.toHaveBeenCalled();
  });
});

describe('recordExistingPush', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    updateManyMock.mockReset();
    listCommitsMock.mockReset();
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  const created = new Date('2026-09-01T10:00:00.000Z');
  const rowFor = (deadline: Date | null, mode = 'REPO', closed: Date | null = null) => ({
    id: 'ra-1',
    closed_at: closed,
    assignment: { submission_mode: mode, student_deadline: deadline },
    git_repo: {
      name: 'lab-1-alice',
      created_at: created,
      classroom: { git_organization: { login: 'acme', provider: 'GITHUB' } },
    },
  });
  const commit = (ts: string, author: string | null = 'alice', email: string | null = null) => ({
    ts,
    author_login: author,
    author_email: email,
  });

  it("stamps the student's latest push as the submission", async () => {
    findUniqueMock.mockResolvedValue(rowFor(new Date('2026-09-30T00:00:00.000Z')));
    listCommitsMock.mockResolvedValue([commit('2026-09-18T10:00:00.000Z')]);

    const at = await recordExistingPush('ra-1');

    expect(at).toEqual(new Date('2026-09-18T10:00:00.000Z'));
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'ra-1', closed_at: null },
      data: { status: 'CLOSED', closed_at: new Date('2026-09-18T10:00:00.000Z') },
    });
  });

  it("ignores bot commits, the Classmoji Bot's template commit, and the template's history", async () => {
    findUniqueMock.mockResolvedValue(rowFor(null));
    listCommitsMock.mockResolvedValue([
      commit('2026-09-18T10:00:00.000Z', 'classmoji[bot]'),
      commit('2026-09-01T10:00:30.000Z', null, 'hello@classmoji.com'),
      commit('2026-08-20T10:00:00.000Z', 'template-author'),
    ]);

    expect(await recordExistingPush('ra-1')).toBeNull();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('counts a student push made right after provisioning', async () => {
    findUniqueMock.mockResolvedValue(rowFor(null));
    listCommitsMock.mockResolvedValue([
      commit('2026-09-01T10:01:40.000Z', 'alice', 'alice@school.edu'),
      commit('2026-09-01T10:00:30.000Z', null, 'hello@classmoji.com'),
    ]);

    expect(await recordExistingPush('ra-1')).toEqual(new Date('2026-09-01T10:01:40.000Z'));
  });

  it('records a push after the deadline as a late submission, as the webhook would', async () => {
    findUniqueMock.mockResolvedValue(rowFor(new Date('2026-09-10T00:00:00.000Z')));
    listCommitsMock.mockResolvedValue([commit('2026-09-18T10:00:00.000Z')]);

    expect(await recordExistingPush('ra-1')).toEqual(new Date('2026-09-18T10:00:00.000Z'));
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: 'ra-1', closed_at: null },
      data: { status: 'CLOSED', closed_at: new Date('2026-09-18T10:00:00.000Z') },
    });
  });

  it('does nothing for an issue-mode row or one already submitted', async () => {
    findUniqueMock.mockResolvedValueOnce(rowFor(null, 'ISSUE'));
    expect(await recordExistingPush('ra-1')).toBeNull();
    findUniqueMock.mockResolvedValueOnce(rowFor(null, 'REPO', new Date()));
    expect(await recordExistingPush('ra-1')).toBeNull();
    expect(listCommitsMock).not.toHaveBeenCalled();
  });
});

describe('recordPushAfterExtension', () => {
  beforeEach(() => {
    findUniqueMock.mockReset();
    updateManyMock.mockReset();
    updateManyMock.mockResolvedValue({ count: 1 });
  });

  const deadline = new Date('2026-09-20T00:00:00.000Z');
  const hoursAfter = (h: number) => new Date(deadline.getTime() + h * 3_600_000);
  const onTime = new Date('2026-09-19T12:00:00.000Z');

  const rowFor = ({
    mode = 'REPO',
    published = true,
    hours = [3] as number[],
    lastPush = hoursAfter(2) as Date | null,
    closed = onTime as Date | null,
    grades = 0,
    studentDeadline = deadline as Date | null,
  } = {}) => ({
    id: 'ra-1',
    closed_at: closed,
    assignment: {
      type: 'REPO',
      submission_mode: mode,
      is_published: published,
      student_deadline: studentDeadline,
    },
    token_transactions: hours.map(h => ({ hours_purchased: h })),
    git_repo: { last_push_at: lastPush },
    _count: { grades },
  });

  it('stamps a push the bought hours now cover', async () => {
    findUniqueMock.mockResolvedValue(rowFor());

    expect(await recordPushAfterExtension('ra-1')).toEqual(hoursAfter(2));
    expect(findUniqueMock.mock.calls[0][0].select.token_transactions).toEqual({
      select: { hours_purchased: true },
    });
    // The write re-checks the frozen and never-backwards rules itself.
    expect(updateManyMock).toHaveBeenCalledWith({
      where: {
        id: 'ra-1',
        grades: { none: {} },
        OR: [{ closed_at: null }, { closed_at: { lt: hoursAfter(2) } }],
      },
      data: { status: 'CLOSED', closed_at: hoursAfter(2) },
    });
  });

  it('counts a push exactly at the new cutoff', async () => {
    findUniqueMock.mockResolvedValue(rowFor({ lastPush: hoursAfter(3) }));
    expect(await recordPushAfterExtension('ra-1')).toEqual(hoursAfter(3));
  });

  it('leaves a push after the new cutoff alone', async () => {
    findUniqueMock.mockResolvedValue(rowFor({ lastPush: hoursAfter(4) }));
    expect(await recordPushAfterExtension('ra-1')).toBeNull();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('nets refunds out of the bought hours', async () => {
    findUniqueMock.mockResolvedValue(rowFor({ hours: [3, -3] }));
    expect(await recordPushAfterExtension('ra-1')).toBeNull();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('never touches a graded row', async () => {
    findUniqueMock.mockResolvedValue(rowFor({ grades: 1 }));
    expect(await recordPushAfterExtension('ra-1')).toBeNull();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('never moves the submission time backwards', async () => {
    findUniqueMock.mockResolvedValue(rowFor({ lastPush: onTime }));
    expect(await recordPushAfterExtension('ra-1')).toBeNull();
    findUniqueMock.mockResolvedValue(rowFor({ lastPush: new Date(onTime.getTime() - 60_000) }));
    expect(await recordPushAfterExtension('ra-1')).toBeNull();
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it('reports nothing when a concurrent push or grade wins the write', async () => {
    findUniqueMock.mockResolvedValue(rowFor());
    updateManyMock.mockResolvedValue({ count: 0 });
    expect(await recordPushAfterExtension('ra-1')).toBeNull();
  });

  it('skips issue-mode, unpublished, never-pushed and deadline-free rows', async () => {
    for (const r of [
      rowFor({ mode: 'ISSUE' }),
      rowFor({ published: false }),
      rowFor({ lastPush: null }),
      rowFor({ studentDeadline: null }),
    ]) {
      findUniqueMock.mockResolvedValueOnce(r);
      expect(await recordPushAfterExtension('ra-1')).toBeNull();
    }
    findUniqueMock.mockResolvedValueOnce(null);
    expect(await recordPushAfterExtension('missing')).toBeNull();
    expect(updateManyMock).not.toHaveBeenCalled();
  });
});
