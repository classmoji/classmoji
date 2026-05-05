import { describe, it, expect, vi, beforeEach } from 'vitest';

const countMock = vi.fn();
const findManyMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    repositoryAssignment: {
      count: countMock,
      findMany: findManyMock,
    },
  }),
}));

const { getLatePercentage } = await import('../repositoryAssignment.service.ts');

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
      row({ closed_at: new Date('2026-01-09T00:00:00Z'), assignment: { student_deadline: deadline } }),
      row({ closed_at: deadline, assignment: { student_deadline: deadline } }),
    ]);
    expect(await getLatePercentage('cls')).toBe(0);
  });

  it('counts late submissions (closed_at > deadline)', async () => {
    countMock.mockResolvedValue(4);
    const deadline = new Date('2026-01-10T00:00:00Z');
    findManyMock.mockResolvedValue([
      row({ closed_at: new Date('2026-01-11T00:00:00Z'), assignment: { student_deadline: deadline } }),
      row({ closed_at: new Date('2026-01-12T00:00:00Z'), assignment: { student_deadline: deadline } }),
      row({ closed_at: new Date('2026-01-09T00:00:00Z'), assignment: { student_deadline: deadline } }),
      row({ closed_at: null, assignment: { student_deadline: deadline } }),
    ]);
    expect(await getLatePercentage('cls')).toBe(50);
  });

  it('rounds the percentage to 0 decimals', async () => {
    countMock.mockResolvedValue(3);
    const deadline = new Date('2026-01-10T00:00:00Z');
    findManyMock.mockResolvedValue([
      row({ closed_at: new Date('2026-01-11T00:00:00Z'), assignment: { student_deadline: deadline } }),
      row({ closed_at: null, assignment: { student_deadline: deadline } }),
      row({ closed_at: null, assignment: { student_deadline: deadline } }),
    ]);
    // 1/3 = 33.333...% → rounded to 0 decimals → 33
    expect(await getLatePercentage('cls')).toBe(33);
  });
});
