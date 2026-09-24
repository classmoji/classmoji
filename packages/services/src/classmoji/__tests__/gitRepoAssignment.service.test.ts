import { describe, it, expect, vi, beforeEach } from 'vitest';

const countMock = vi.fn();
const findManyMock = vi.fn();
const upsertMock = vi.fn();
const updateManyMock = vi.fn();
const findUniqueMock = vi.fn();
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
      findUnique: findUniqueMock,
    },
    gitRepo: { findUnique: gitRepoFindUniqueMock },
    assignment: { findUnique: assignmentFindUniqueMock },
  }),
}));

vi.mock('../../git/index.ts', () => ({
  getGitProvider: () => ({ listCommits: (...a: unknown[]) => listCommitsMock(...a) }),
}));

const { create, getLatePercentage, recordPush, recordExistingPush } =
  await import('../gitRepoAssignment.service.ts');

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

  it('submits published REPO-mode rows: any first push, and later pushes only while ungraded', async () => {
    findManyMock.mockResolvedValue([candidate('ra-1', null), candidate('ra-2', null)]);
    updateManyMock.mockResolvedValue({ count: 2 });

    const touched = await recordPush('gitrepo-1', pushedAt);

    // A grade never freezes a row with no submission yet (a first push always
    // counts); it freezes only a submission that already exists.
    expect(findManyMock.mock.calls[0][0].where).toEqual({
      git_repo_id: 'gitrepo-1',
      assignment: { type: 'REPO', submission_mode: 'REPO', is_published: true },
      OR: [{ closed_at: null }, { closed_at: { lt: pushedAt }, grades: { none: {} } }],
    });
    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['ra-1', 'ra-2'] } },
      data: { status: 'CLOSED', closed_at: pushedAt },
    });
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
    updateManyMock.mockResolvedValue({ count: 2 });

    const touched = await recordPush('gitrepo-1', pushedAt);

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['within-extension', 'no-deadline'] } },
      data: { status: 'CLOSED', closed_at: pushedAt },
    });
    expect(touched).toEqual([{ id: 'within-extension' }, { id: 'no-deadline' }]);
  });

  it('records a first push after the deadline as a late submission', async () => {
    const hourBefore = new Date(pushedAt.getTime() - 3_600_000);
    findManyMock.mockResolvedValue([candidate('never-submitted', hourBefore)]);
    updateManyMock.mockResolvedValue({ count: 1 });

    const touched = await recordPush('gitrepo-1', pushedAt);

    expect(updateManyMock).toHaveBeenCalledWith({
      where: { id: { in: ['never-submitted'] } },
      data: { status: 'CLOSED', closed_at: pushedAt },
    });
    expect(touched).toEqual([{ id: 'never-submitted' }]);
  });

  it('writes nothing when no row qualifies', async () => {
    findManyMock.mockResolvedValue([]);

    expect(await recordPush('gitrepo-1', pushedAt)).toEqual([]);
    expect(updateManyMock).not.toHaveBeenCalled();
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
