/**
 * Unit tests for which GitLab repos the push poll reads.
 *
 * A repo stays in the poll while any of its push-mode submission rows is
 * open: no deadline, or the deadline pushed out by the row's net purchased
 * extension hours (refunds negative, never below zero) plus a two-day grace
 * is still ahead. The database query can only pre-filter (it cannot sum
 * hours), so the exact check runs in JS; a repo the pre-filter kept but the
 * check rejects is sent to the back of the queue instead of being polled.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findManyRepos: vi.fn(),
  updateRepo: vi.fn(),
  updateManyRepos: vi.fn(),
  listDefaultBranchPushes: vi.fn(),
  recordPushTime: vi.fn(),
  recordPush: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  schedules: { task: (config: unknown) => config },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepo: {
      findMany: (...a: unknown[]) => mocks.findManyRepos(...a),
      update: (...a: unknown[]) => mocks.updateRepo(...a),
      updateMany: (...a: unknown[]) => mocks.updateManyRepos(...a),
    },
  }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepo: { recordPushTime: (...a: unknown[]) => mocks.recordPushTime(...a) },
    gitRepoAssignment: { recordPush: (...a: unknown[]) => mocks.recordPush(...a) },
  },
  getGitProvider: () => ({
    listDefaultBranchPushes: (...a: unknown[]) => mocks.listDefaultBranchPushes(...a),
  }),
}));

const { isPollWindowOpen, pollGitlabPushes } = await import('../gitlabWebhooks.ts');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-10-03T12:00:00.000Z').getTime();
const ago = (ms: number) => new Date(NOW - ms);
const hours = (...h: number[]) => h.map(hours_purchased => ({ hours_purchased }));

describe('isPollWindowOpen', () => {
  it('keeps a row with no deadline', () => {
    expect(isPollWindowOpen(null, [], NOW)).toBe(true);
  });

  it('keeps a row until two days after the plain deadline', () => {
    expect(isPollWindowOpen(ago(2 * DAY - HOUR), [], NOW)).toBe(true);
    expect(isPollWindowOpen(ago(2 * DAY + HOUR), [], NOW)).toBe(false);
  });

  it('keeps a row whose bought hours extend the deadline past now', () => {
    // Deadline 5 days ago, 96 hours bought: extended deadline 1 day ago, so
    // still inside the two-day grace.
    expect(isPollWindowOpen(ago(5 * DAY), hours(96), NOW)).toBe(true);
    // Deadline 10 days ago, 240 hours bought: extended deadline is now.
    expect(isPollWindowOpen(ago(10 * DAY), hours(240), NOW)).toBe(true);
  });

  it('nets refunds out of the bought hours', () => {
    expect(isPollWindowOpen(ago(5 * DAY), hours(96, -96), NOW)).toBe(false);
    expect(isPollWindowOpen(ago(5 * DAY), hours(96, -48), NOW)).toBe(false);
    expect(isPollWindowOpen(ago(5 * DAY), hours(96, -12), NOW)).toBe(true);
  });

  it('never lets a refund pull the deadline earlier than the plain one', () => {
    expect(isPollWindowOpen(ago(DAY), hours(-48), NOW)).toBe(true);
  });
});

const repo = (
  id: string,
  rows: Array<{ deadline: Date | null; hours?: number[] }>
): Record<string, unknown> => ({
  id,
  name: `${id}-name`,
  last_push_at: null,
  assignments: rows.map(r => ({
    assignment: { student_deadline: r.deadline },
    token_transactions: hours(...(r.hours ?? [])),
  })),
  classroom: {
    git_namespace: 'school/cs1',
    git_organization: { provider: 'GITLAB', gitlab_connection: { gitlab_username: 'teacher' } },
  },
});

describe('pollGitlabPushes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.updateRepo.mockResolvedValue({});
    mocks.updateManyRepos.mockResolvedValue({ count: 0 });
    mocks.listDefaultBranchPushes.mockResolvedValue([]);
  });

  it('pre-filters on the plain window or any purchase within 30 days', async () => {
    mocks.findManyRepos.mockResolvedValue([]);

    await pollGitlabPushes();

    const where = mocks.findManyRepos.mock.calls[0][0].where;
    expect(where.assignments.some).toEqual({
      assignment: { type: 'REPO', submission_mode: 'REPO', is_published: true },
      OR: [
        { assignment: { student_deadline: null } },
        { assignment: { student_deadline: { gt: ago(2 * DAY) } } },
        {
          assignment: { student_deadline: { gt: ago(30 * DAY) } },
          token_transactions: { some: { type: 'PURCHASE' } },
        },
      ],
    });
    // The selected rows are the same subset, with every transaction (refunds too).
    const select = mocks.findManyRepos.mock.calls[0][0].select.assignments;
    expect(select.where).toEqual(where.assignments.some);
    expect(select.select.token_transactions).toEqual({ select: { hours_purchased: true } });
  });

  it('polls a repo whose only open row is open through bought hours', async () => {
    mocks.findManyRepos.mockResolvedValue([
      repo('extended', [{ deadline: ago(5 * DAY), hours: [96] }]),
    ]);
    mocks.listDefaultBranchPushes.mockResolvedValue([{ at: ago(2 * DAY), author: 'student' }]);

    const result = await pollGitlabPushes();

    expect(result).toEqual({ repos: 1, recorded: 1, failed: 0 });
    expect(mocks.recordPush).toHaveBeenCalledWith('extended', ago(2 * DAY));
    expect(mocks.updateManyRepos).not.toHaveBeenCalled();
  });

  it('skips a repo whose extension has run out, and sends it to the back of the queue', async () => {
    mocks.findManyRepos.mockResolvedValue([
      repo('refunded', [{ deadline: ago(5 * DAY), hours: [96, -96] }]),
      repo('plain', [{ deadline: ago(DAY) }]),
    ]);

    const result = await pollGitlabPushes();

    expect(result.repos).toBe(1);
    expect(mocks.listDefaultBranchPushes).toHaveBeenCalledTimes(1);
    expect(mocks.listDefaultBranchPushes.mock.calls[0][1]).toBe('plain-name');
    expect(mocks.updateManyRepos).toHaveBeenCalledWith({
      where: { id: { in: ['refunded'] } },
      data: { push_polled_at: expect.any(Date) },
    });
  });

  it('polls a repo when any one of its rows is open', async () => {
    mocks.findManyRepos.mockResolvedValue([
      repo('mixed', [{ deadline: ago(20 * DAY), hours: [1] }, { deadline: null }]),
    ]);

    const result = await pollGitlabPushes();

    expect(result.repos).toBe(1);
    expect(mocks.updateManyRepos).not.toHaveBeenCalled();
  });
});
