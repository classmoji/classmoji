/**
 * The grading walk: column-major over the visible repo columns, rows in the
 * table's order, a team submission once, open regrade requests included, and
 * Next/Previous going on from where the open cell stands even once it is
 * graded.
 */
import { describe, expect, it } from 'vitest';
import {
  firstInColumn,
  freezeWalk,
  pendingByColumn,
  walkOrder,
  walkPosition,
} from '../gradingWalk';

type Row = { id: string; cells: Record<string, { id: string; todo: boolean } | undefined> };

const row = (id: string, cells: Row['cells']): Row => ({ id, cells });
const cellOf = (r: Row, assignmentId: string) => {
  const c = r.cells[assignmentId];
  return c ? { submissionId: c.id, needsGrading: c.todo } : null;
};
const ids = (order: { submissionId: string }[]) => order.map(c => c.submissionId);

const ROWS = [
  row('ada', { a1: { id: 'ada-a1', todo: true }, a2: { id: 'ada-a2', todo: false } }),
  row('bob', { a1: { id: 'bob-a1', todo: false }, a2: { id: 'bob-a2', todo: true } }),
  row('cy', { a1: { id: 'cy-a1', todo: true }, a2: undefined }),
];

describe('walkOrder', () => {
  it('runs down each column in turn, rows in the given order', () => {
    expect(ids(walkOrder(ROWS, ['a1', 'a2'], cellOf))).toEqual([
      'ada-a1',
      'bob-a1',
      'cy-a1',
      'ada-a2',
      'bob-a2',
    ]);
  });

  it('follows the rows it is given (search, filter and sort already applied)', () => {
    const filtered = [ROWS[2], ROWS[0]];
    expect(ids(walkOrder(filtered, ['a1'], cellOf))).toEqual(['cy-a1', 'ada-a1']);
  });

  it('only walks the columns it is given', () => {
    expect(ids(walkOrder(ROWS, ['a2'], cellOf))).toEqual(['ada-a2', 'bob-a2']);
  });

  it('lists a team submission once, at its first row', () => {
    const team = { id: 'team-a1', todo: true };
    const order = walkOrder([row('ada', { a1: team }), row('bob', { a1: team })], ['a1'], cellOf);
    expect(order).toEqual([
      { submissionId: 'team-a1', needsGrading: true, assignmentId: 'a1', rowId: 'ada' },
    ]);
  });
});

describe('walkPosition', () => {
  const order = walkOrder(ROWS, ['a1', 'a2'], cellOf);

  it('places a cell to grade in the queue, counting it among those left', () => {
    expect(walkPosition(order, 'cy-a1')).toMatchObject({
      index: 2,
      total: 3,
      left: 3,
      next: { submissionId: 'bob-a2' },
      previous: { submissionId: 'ada-a1' },
    });
  });

  it('goes on from a graded cell rather than from the top', () => {
    // bob-a1 is graded: Next is the cell after it, Previous the one before.
    expect(walkPosition(order, 'bob-a1')).toMatchObject({
      index: null,
      total: 3,
      left: 3,
      next: { submissionId: 'cy-a1' },
      previous: { submissionId: 'ada-a1' },
    });
  });

  it('wraps around at either end', () => {
    expect(walkPosition(order, 'bob-a2')).toMatchObject({
      next: { submissionId: 'ada-a1' },
      previous: { submissionId: 'cy-a1' },
    });
  });

  it('starts at either end of the queue for a cell outside the walk', () => {
    expect(walkPosition(order, 'elsewhere')).toMatchObject({
      index: null,
      left: 3,
      next: { submissionId: 'ada-a1' },
      previous: { submissionId: 'bob-a2' },
    });
  });

  it('has nowhere to go when the open cell is the last one to grade', () => {
    const one = walkOrder([ROWS[2]], ['a1'], cellOf);
    expect(walkPosition(one, 'cy-a1')).toMatchObject({
      index: 1,
      total: 1,
      left: 1,
      next: null,
      previous: null,
    });
  });

  it('counts an open regrade request on a graded cell as to grade', () => {
    // The table marks such a cell needsGrading; the walk takes it as given.
    const regrade = walkOrder([row('ada', { a1: { id: 'ada-a1', todo: true } })], ['a1'], cellOf);
    expect(walkPosition(regrade, null)).toMatchObject({
      total: 1,
      next: { submissionId: 'ada-a1' },
    });
  });
});

describe('column helpers', () => {
  const order = walkOrder(ROWS, ['a1', 'a2'], cellOf);

  it('finds the first cell to grade in a column', () => {
    expect(firstInColumn(order, 'a1')?.submissionId).toBe('ada-a1');
    expect(firstInColumn(order, 'a2')?.submissionId).toBe('bob-a2');
    expect(firstInColumn(order, 'a3')).toBeNull();
  });

  it('counts cells to grade per column', () => {
    expect(Object.fromEntries(pendingByColumn(order))).toEqual({ a1: 2, a2: 1 });
  });
});

describe('freezeWalk', () => {
  const snapshot = walkOrder(ROWS, ['a1', 'a2'], cellOf);

  it('keeps the frozen order and reads each cell to grade as it is now', () => {
    // ada-a1 got graded; cy's row then left the filter, but it stays in the walk.
    const now = new Map([
      ['ada-a1', false],
      ['bob-a1', false],
      ['cy-a1', true],
      ['ada-a2', false],
      ['bob-a2', true],
    ]);
    const walk = freezeWalk(snapshot, now);

    expect(walk.map(c => c.submissionId)).toEqual(snapshot.map(c => c.submissionId));
    expect(walkPosition(walk, 'ada-a1')).toMatchObject({
      // Graded, but still counted where the walk set out from.
      index: 1,
      total: 3,
      left: 2,
      next: { submissionId: 'cy-a1' },
    });
  });

  it('reads a cell gone from the gradebook as done', () => {
    const walk = freezeWalk(snapshot, new Map());
    expect(walkPosition(walk, 'ada-a1')).toMatchObject({ left: 0, next: null, total: 3 });
  });
});
