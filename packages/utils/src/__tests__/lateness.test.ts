import { describe, expect, it } from 'vitest';
import {
  extendedDeadlineMs,
  isPastDeadlineIgnoringOverride,
  CLASSMOJI_BOT_EMAIL,
  isStudentCommit,
  netExtensionHours,
  submissionLateHours,
  submittedCommit,
} from '../lateness.ts';

const HOUR = 3_600_000;
const deadline = new Date('2026-03-01T00:00:00Z');
const tx = (...hours: (number | null)[]) => hours.map(h => ({ hours_purchased: h }));

describe('netExtensionHours', () => {
  it('sums every transaction, refunds included, never below zero', () => {
    expect(netExtensionHours(tx(3, 2))).toBe(5);
    expect(netExtensionHours(tx(3, -3))).toBe(0);
    expect(netExtensionHours(tx(-2))).toBe(0);
    expect(netExtensionHours(tx(null, 1))).toBe(1);
    expect(netExtensionHours(null)).toBe(0);
  });
});

describe('extendedDeadlineMs', () => {
  it('pushes the deadline out by the net hours bought', () => {
    expect(extendedDeadlineMs(deadline, tx(4))).toBe(deadline.getTime() + 4 * HOUR);
    expect(extendedDeadlineMs(deadline.toISOString(), tx(4, -4))).toBe(deadline.getTime());
  });

  it('is null without a valid deadline', () => {
    expect(extendedDeadlineMs(null, tx(4))).toBeNull();
    expect(extendedDeadlineMs('not a date', tx(4))).toBeNull();
  });
});

describe('isPastDeadlineIgnoringOverride', () => {
  const row = (closedAt: Date | null, hours: number[] = []) => ({
    closed_at: closedAt,
    assignment: { student_deadline: deadline },
    token_transactions: tx(...hours),
  });

  it('measures a submission from the deadline plus the hours bought, in whole hours', () => {
    const at = (h: number) => new Date(deadline.getTime() + h * HOUR);
    expect(isPastDeadlineIgnoringOverride(row(at(3), [3]))).toBe(false);
    expect(isPastDeadlineIgnoringOverride(row(at(4), [3]))).toBe(true);
    expect(isPastDeadlineIgnoringOverride(row(at(3), [3, -3]))).toBe(true);
    expect(isPastDeadlineIgnoringOverride(row(at(0.5)))).toBe(false);
  });

  it('counts an unsubmitted row late once the extended deadline has passed', () => {
    const now = new Date(deadline.getTime() + 2 * HOUR);
    expect(isPastDeadlineIgnoringOverride(row(null, [3]), now)).toBe(false);
    expect(isPastDeadlineIgnoringOverride(row(null, [1]), now)).toBe(true);
  });

  it('is never late without a deadline', () => {
    expect(
      isPastDeadlineIgnoringOverride({ closed_at: new Date(), assignment: null }, new Date())
    ).toBe(false);
  });
});

describe('submittedCommit', () => {
  const commit = (sha: string, at: Date, extra: Record<string, string> = {}) => ({
    sha,
    ts: at.toISOString(),
    message: `msg ${sha}`,
    author_login: 'ada',
    author_email: 'ada@school.test',
    ...extra,
  });
  const repoCreated = new Date(deadline.getTime() - 48 * HOUR);
  const template = commit('tpl', new Date(repoCreated.getTime() - HOUR), {
    author_login: 'classmoji-bot',
    author_email: CLASSMOJI_BOT_EMAIL,
  });
  const before = new Date(deadline.getTime() - HOUR);
  const after = new Date(deadline.getTime() + 2 * HOUR);
  const open = (extra: Partial<Parameters<typeof submittedCommit>[1]> = {}) => ({
    closed_at: null,
    student_deadline: deadline,
    token_transactions: [],
    repo_created_at: repoCreated,
    ...extra,
  });

  it('reads at the submission time when there is one: a late first push is the submission', () => {
    // recordPush made the late push the submission (closed_at = its time).
    const list = [template, commit('late', after)];
    expect(submittedCommit(list, open({ closed_at: after }))).toEqual({
      sha: 'late',
      message: 'msg late',
      ts: after.toISOString(),
    });
  });

  it('keeps a graded submission frozen at its time, past later pushes', () => {
    const list = [commit('graded', before), commit('later', after)];
    expect(submittedCommit(list, open({ closed_at: before }))?.sha).toBe('graded');
  });

  it('falls back to the deadline plus extension hours when nothing was submitted', () => {
    const list = [commit('a', before), commit('b', deadline), commit('c', after)];
    expect(submittedCommit(list, open())?.sha).toBe('b');
    expect(submittedCommit(list, open({ token_transactions: tx(3) }))?.sha).toBe('c');
    expect(submittedCommit(list, open({ token_transactions: tx(3, -3) }))?.sha).toBe('b');
  });

  it('never takes a bot or template commit', () => {
    const app = commit('ci', before, { author_login: 'github-actions[bot]' });
    const bot = commit('bot', before, { author_login: 'x', author_email: 'Hello@Classmoji.com' });
    expect(submittedCommit([template, app, bot], open())).toBeNull();
    expect(submittedCommit([template, app, bot, commit('own', before)], open())?.sha).toBe('own');
  });

  it('takes the newest commit when there is no cutoff', () => {
    const list = [commit('c', after), commit('a', before)];
    expect(submittedCommit(list, open({ student_deadline: null }))?.sha).toBe('c');
  });

  it('is null without a commit in time, and skips malformed entries', () => {
    expect(submittedCommit([commit('c', after)], open())).toBeNull();
    const malformed = [{ sha: 1 }, { sha: 'x', ts: 'nope' }, null];
    expect(submittedCommit(malformed, open({ student_deadline: null }))).toBeNull();
    expect(submittedCommit('not a list', open())).toBeNull();
  });
});

describe('isStudentCommit', () => {
  it('follows the existing-push rule: no apps, no Classmoji Bot, nothing before the repo', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const at = (iso: string) => ({ author_login: 'ada', author_email: 'a@x.test', ts: iso });
    expect(isStudentCommit(at('2026-01-02T00:00:00Z'), created)).toBe(true);
    expect(isStudentCommit(at('2025-12-31T00:00:00Z'), created)).toBe(false);
    expect(isStudentCommit({ ...at('2026-01-02T00:00:00Z'), author_login: 'x[bot]' })).toBe(false);
    expect(
      isStudentCommit({ ...at('2026-01-02T00:00:00Z'), author_email: CLASSMOJI_BOT_EMAIL })
    ).toBe(false);
  });
});

describe('submissionLateHours', () => {
  const row = (closed: Date | null, hours: (number | null)[] = []) => ({
    closed_at: closed,
    assignment: { student_deadline: deadline },
    token_transactions: tx(...hours),
  });

  it('counts whole hours past the deadline, less extension hours, for submitted work', () => {
    expect(submissionLateHours(row(new Date(deadline.getTime() + 5.5 * HOUR)))).toBe(5);
    expect(submissionLateHours(row(new Date(deadline.getTime() + 5.5 * HOUR), [3]))).toBe(2);
    expect(submissionLateHours(row(new Date(deadline.getTime() + HOUR), [3]))).toBe(0);
    expect(submissionLateHours(row(new Date(deadline.getTime() - HOUR)))).toBe(0);
  });

  it('is 0 for work not submitted', () => {
    expect(submissionLateHours(row(null))).toBe(0);
  });
});
