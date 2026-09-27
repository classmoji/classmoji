/**
 * planGraderReassignment — where a departing grader's ungraded slots go.
 *
 * Pure function, so every case is deterministic: least-loaded on the
 * assignment first, a student's work on one repository kept with one grader
 * only when that grader is among the least-loaded, then classroom-wide load,
 * then login. No candidate at all falls back to unassigning.
 */
import { describe, expect, it } from 'vitest';

import { planGraderReassignment, type PlanSlot } from '../graderReassignPlan.ts';

const ANN = { id: 'u-ann', login: 'ann' };
const BOB = { id: 'u-bob', login: 'bob' };
const CAT = { id: 'u-cat', login: 'cat' };

/** A slot held by the departing grader u-gone. */
const slot = (
  id: string,
  assignmentId: string,
  gitRepoId: string,
  extra: string[] = []
): PlanSlot => ({
  gitRepoAssignmentId: id,
  assignmentId,
  gitRepoId,
  graderIds: ['u-gone', ...extra],
});

const targets = (plan: ReturnType<typeof planGraderReassignment>) =>
  Object.fromEntries(plan.moves.map(m => [m.gitRepoAssignmentId, m.toLogin]));

describe('planGraderReassignment', () => {
  it('spreads one assignment evenly, least-loaded first, ties by login', () => {
    const plan = planGraderReassignment({
      slots: ['s1', 's2', 's3', 's4', 's5', 's6'].map((id, i) => slot(id, 'a1', `repo-${i}`)),
      candidates: [CAT, BOB, ANN],
      loadRows: [],
    });

    expect(plan.fallback).toBeNull();
    const counts: Record<string, number> = {};
    for (const move of plan.moves) counts[move.toLogin!] = (counts[move.toLogin!] ?? 0) + 1;
    expect(counts).toEqual({ ann: 2, bob: 2, cat: 2 });
    // Deterministic order: ann, bob, cat, ann, bob, cat.
    expect(plan.moves.map(m => m.toLogin)).toEqual(['ann', 'bob', 'cat', 'ann', 'bob', 'cat']);
  });

  it('fills the least-loaded grader on THAT assignment first', () => {
    // ann already holds three submissions of a1, bob none.
    const plan = planGraderReassignment({
      slots: [slot('s1', 'a1', 'r1'), slot('s2', 'a1', 'r2')],
      candidates: [ANN, BOB],
      loadRows: [
        { graderId: 'u-ann', assignmentId: 'a1', gitRepoId: 'rx' },
        { graderId: 'u-ann', assignmentId: 'a1', gitRepoId: 'ry' },
        { graderId: 'u-ann', assignmentId: 'a1', gitRepoId: 'rz' },
      ],
    });
    expect(targets(plan)).toEqual({ s1: 'bob', s2: 'bob' });
  });

  it('breaks a per-assignment tie by total load in the classroom', () => {
    // Both have 0 on a2; ann carries more elsewhere in the classroom.
    const plan = planGraderReassignment({
      slots: [slot('s1', 'a2', 'r1')],
      candidates: [ANN, BOB],
      loadRows: [
        { graderId: 'u-ann', assignmentId: 'a1', gitRepoId: 'rx' },
        { graderId: 'u-ann', assignmentId: 'a1', gitRepoId: 'ry' },
        { graderId: 'u-bob', assignmentId: 'a1', gitRepoId: 'rz' },
      ],
    });
    expect(targets(plan)).toEqual({ s1: 'bob' });
  });

  it("keeps a student's assignments on one repository with one grader when balance allows", () => {
    // r1-a1 goes to ann. On a2 both are at 0 and ann now carries MORE total
    // load, so the classroom-wide tie-break alone would pick bob for r1-a2 —
    // the pairing keeps student r1 with ann. r2-a2 then balances to bob.
    const plan = planGraderReassignment({
      slots: [slot('r1-a1', 'a1', 'r1'), slot('r1-a2', 'a2', 'r1'), slot('r2-a2', 'a2', 'r2')],
      candidates: [ANN, BOB],
      loadRows: [],
    });
    expect(targets(plan)).toEqual({ 'r1-a1': 'ann', 'r1-a2': 'ann', 'r2-a2': 'bob' });
  });

  it('prefers a grader who already holds a sibling submission of that repository', () => {
    // bob grades r1's a1 already (pre-existing row), both are at 0 on a2 and
    // bob carries MORE total load — the pairing still wins among the tied.
    const plan = planGraderReassignment({
      slots: [slot('r1-a2', 'a2', 'r1')],
      candidates: [ANN, BOB],
      loadRows: [
        { graderId: 'u-bob', assignmentId: 'a1', gitRepoId: 'r1' },
        { graderId: 'u-bob', assignmentId: 'a1', gitRepoId: 'r9' },
      ],
    });
    expect(targets(plan)).toEqual({ 'r1-a2': 'bob' });
  });

  it('does not pair when it would worsen the per-assignment balance', () => {
    // bob holds r1's a1 but is already ahead on a2; ann gets it.
    const plan = planGraderReassignment({
      slots: [slot('r1-a2', 'a2', 'r1')],
      candidates: [ANN, BOB],
      loadRows: [
        { graderId: 'u-bob', assignmentId: 'a1', gitRepoId: 'r1' },
        { graderId: 'u-bob', assignmentId: 'a2', gitRepoId: 'r5' },
      ],
    });
    expect(targets(plan)).toEqual({ 'r1-a2': 'ann' });
  });

  it('never hands a slot to someone already on that submission', () => {
    const plan = planGraderReassignment({
      slots: [slot('s1', 'a1', 'r1', ['u-ann'])],
      candidates: [ANN, BOB],
      loadRows: [],
    });
    expect(targets(plan)).toEqual({ s1: 'bob' });
  });

  it('marks a slot covered when every candidate is already on it', () => {
    const plan = planGraderReassignment({
      slots: [slot('s1', 'a1', 'r1', ['u-ann'])],
      candidates: [ANN],
      loadRows: [],
    });
    expect(plan.fallback).toBeNull();
    expect(plan.moves).toEqual([
      { gitRepoAssignmentId: 's1', toGraderId: null, toLogin: null, reason: 'covered' },
    ]);
  });

  it('falls back to unassigning everything when there is no other eligible grader', () => {
    const plan = planGraderReassignment({
      slots: [slot('s2', 'a1', 'r2'), slot('s1', 'a1', 'r1')],
      candidates: [],
      loadRows: [],
    });
    expect(plan.fallback).toBe('no_eligible_graders');
    expect(plan.moves.map(m => [m.gitRepoAssignmentId, m.toGraderId, m.reason])).toEqual([
      ['s1', null, 'no_eligible_graders'],
      ['s2', null, 'no_eligible_graders'],
    ]);
  });

  it('ignores load rows of people who are not candidates', () => {
    const plan = planGraderReassignment({
      slots: [slot('s1', 'a1', 'r1')],
      candidates: [ANN, BOB],
      loadRows: [
        { graderId: 'u-gone', assignmentId: 'a1', gitRepoId: 'r1' },
        { graderId: 'u-owner', assignmentId: 'a1', gitRepoId: 'r1' },
      ],
    });
    expect(targets(plan)).toEqual({ s1: 'ann' });
  });

  it('gives the same answer regardless of input order', () => {
    const slots = [slot('s1', 'a1', 'r1'), slot('s2', 'a2', 'r1'), slot('s3', 'a1', 'r2')];
    const a = planGraderReassignment({ slots, candidates: [ANN, BOB, CAT], loadRows: [] });
    const b = planGraderReassignment({
      slots: [...slots].reverse(),
      candidates: [CAT, BOB, ANN],
      loadRows: [],
    });
    expect(targets(a)).toEqual(targets(b));
  });
});
