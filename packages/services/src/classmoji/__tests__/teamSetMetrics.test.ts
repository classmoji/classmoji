/**
 * computeMetrics (teamSetMetrics.ts): placements and kept requests, on the
 * mini fixture whose answers are small enough to check by eye (see
 * miniInput's docblock for who ranked and asked for what).
 */

import { describe, it, expect } from 'vitest';
import { TeamSetConfigSchema, applyConfigPatch } from '../teamSetConfig.ts';
import { compileProblem } from '../teamSetProblem.ts';
import { computeMetrics } from '../teamSetMetrics.ts';
import { IDEA_IDS, MINI_USERS, M, miniInput } from './helpers/teamSetFixtures.ts';

const [X, Y, Z] = IDEA_IDS as [string, string, string];
const [u1, u2, u3, u4, u5] = MINI_USERS as [string, string, string, string, string];

describe('computeMetrics', () => {
  it('counts placements, fallbacks and kept requests', () => {
    const { problem, context } = compileProblem(miniInput());
    // slots: 0 = X, 1 = Y, 2 = Z (teams_per_option 1)
    const { metrics, people } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] }, // u1 (X = 1st), u2 (X = 2nd)
      { slot: 1, members: [3, 4] }, // u4 (Y = 1st), u5 (no answer)
      { slot: 2, members: [2] }, //    u3 (Z unranked, Red = fallback)
    ]);
    expect(metrics).toEqual({
      people: 5,
      responded: 4,
      teams: 3,
      options_open: 3,
      options_total: 3,
      placement: { '1': 2, '2': 1, '3': 0, '4': 0, '5+': 0, fallback: 1, missed: 0, no_answer: 1 },
      first_choice: 2,
      top2: 3,
      requests: { total: 3, kept: 2, mutual_pairs: 1, mutual_pairs_kept: 1 },
      avoids: { total: 0, broken: 0 },
      must_broken: 0,
    });
    expect(people).toEqual([
      {
        user_id: u1,
        team: 0,
        option_id: X,
        placement: '1',
        requests: [{ user_id: u2, kept: true }],
      },
      {
        user_id: u2,
        team: 0,
        option_id: X,
        placement: '2',
        requests: [{ user_id: u1, kept: true }],
      },
      {
        user_id: u3,
        team: 2,
        option_id: Z,
        placement: 'fallback',
        requests: [{ user_id: u4, kept: false }],
      },
      { user_id: u4, team: 1, option_id: Y, placement: '1', requests: [] },
      { user_id: u5, team: 1, option_id: Y, placement: 'no_answer', requests: [] },
    ]);
  });

  it('reports misses, broken requests and broken musts', () => {
    const input = miniInput();
    const config = applyConfigPatch(input.config, {
      pins: { add: [{ kind: 'apart', user_ids: [u3, u4] }] },
    });
    const { problem, context } = compileProblem({ ...input, config });
    const { metrics, people } = computeMetrics(problem, context, [
      { slot: 0, members: [0] }, //       u1 X (1st)
      { slot: 1, members: [1, 2, 3] }, // u2 Y (1st), u3 Y (not ranked, Blue ∉ {Red} → missed), u4 Y (1st)
      { slot: 2, members: [4] }, //       u5
    ]);
    expect(metrics.placement).toMatchObject({ '1': 3, missed: 1, no_answer: 1, fallback: 0 });
    expect(metrics.requests).toEqual({ total: 3, kept: 1, mutual_pairs: 1, mutual_pairs_kept: 0 });
    expect(metrics.must_broken).toBe(1); // the apart pin
    expect(people[2]).toEqual({
      user_id: u3,
      team: 1,
      option_id: Y,
      placement: 'missed',
      requests: [{ user_id: u4, kept: true }],
    });
  });

  it('counts apart asks kept and broken', () => {
    const input = miniInput();
    // Read the same friends question as an avoid list: u1→u2, u2→u1, u3→u4.
    const config = applyConfigPatch(input.config, {
      rules: {
        remove: [{ field_id: M.friends, job: 'together' }],
        upsert: [{ field_id: M.friends, job: 'apart', strength: 'prefer' }],
      },
    });
    const { problem, context } = compileProblem({ ...input, config });
    const { metrics } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] }, // u1 + u2 together: both of their asks broken
      { slot: 1, members: [3, 4] },
      { slot: 2, members: [2] }, //    u3 apart from u4: kept
    ]);
    expect(metrics.avoids).toEqual({ total: 3, broken: 2 });
    expect(metrics.requests.total).toBe(0);
  });

  it('labels a pick by its submitted position when an earlier pick was deleted', () => {
    const input = miniInput();
    // u4 ranked [deleted idea, Y]: Y is still their 2nd choice.
    input.responses[3]!.answers[M.ideas] = ['00000000-0000-4000-8000-00000000dead', Y];
    const { problem, context } = compileProblem(input);
    const { people } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [3, 4] },
      { slot: 2, members: [2] },
    ]);
    expect(people[3]).toMatchObject({ user_id: u4, option_id: Y, placement: '2' });
  });

  it('puts everyone at no_answer with no option in free mode', () => {
    const config = TeamSetConfigSchema.parse({
      version: 1,
      grouping: { mode: 'free' },
      team_size: { min: 2, max: 3 },
      rules: [{ field_id: M.friends, job: 'together', strength: 'prefer' }],
    });
    const { problem, context } = compileProblem(miniInput({ config }));
    expect(problem.slots).toHaveLength(3);
    const { metrics, people } = computeMetrics(problem, context, [
      { slot: 0, members: [0, 1] },
      { slot: 1, members: [2, 3, 4] },
    ]);
    expect(metrics).toMatchObject({ teams: 2, options_open: 1, options_total: 1, first_choice: 0 });
    expect(metrics.placement.no_answer).toBe(5);
    expect(people.every(person => person.option_id === null)).toBe(true);
    expect(metrics.requests).toEqual({ total: 3, kept: 3, mutual_pairs: 1, mutual_pairs_kept: 1 });
  });
});
