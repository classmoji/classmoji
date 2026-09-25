/**
 * runChecks (teamSetChecks.ts): the setups refused before a run is queued,
 * and the warnings that ride along. Synthetic fixtures only.
 */

import { describe, it, expect } from 'vitest';
import { applyConfigPatch, type TeamSetConfig } from '../teamSetConfig.ts';
import {
  FREE_OPTION_ID,
  compileProblem,
  type TeamSetContext,
  type TeamSetProblem,
} from '../teamSetProblem.ts';
import { MODEL_SIZE_LIMIT, runChecks } from '../teamSetChecks.ts';
import {
  F,
  IDEA_IDS,
  MINI_USERS,
  NON_RESPONDENTS,
  PROJECT_IDS,
  USER_IDS,
  uuid,
  workshopConfig,
  workshopInput,
  miniInput,
} from './helpers/teamSetFixtures.ts';

const checks = (config: TeamSetConfig, input = workshopInput({ config })) => {
  const { problem, context } = compileProblem({ ...input, config });
  return runChecks(problem, context);
};
const errors = (config: TeamSetConfig) => checks(config).filter(issue => issue.level === 'error');

describe('runChecks', () => {
  it('passes the workshop config with a non-response warning', () => {
    const issues = checks(workshopConfig());
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    expect(issues).toEqual([
      expect.objectContaining({ level: 'warning', code: 'no_response', user_ids: NON_RESPONDENTS }),
    ]);
    expect(issues[0].message).toBe(
      '4 people have not responded; they will be placed wherever they fit.'
    );
  });

  it('flags an impossible capacity', () => {
    // 27 people, teams of exactly 2, no larger team allowed: odd count never fits.
    const odd = applyConfigPatch(workshopConfig(), {
      team_size: { min: 2, max: 2, allow_one_larger: false },
    });
    expect(errors(odd)).toEqual([expect.objectContaining({ code: 'capacity' })]);
    expect(errors(odd)[0].message).toMatch(/^27 people can't be split into teams of exactly 2/);

    // 5 teams × 2 (+1) = 11 seats for 27 people.
    const few = applyConfigPatch(workshopConfig(), { team_count: { max: 5 } });
    expect(errors(few).map(issue => issue.code)).toEqual(['capacity']);

    // Closing 8 of 20 options leaves 12 slots: 12 × 2 + 1 = 25 < 27.
    const closed = applyConfigPatch(workshopConfig(), {
      options: Object.fromEntries(
        PROJECT_IDS.slice(0, 8).map(id => [id, { open: 'closed' as const }])
      ),
    });
    expect(errors(closed).map(issue => issue.code)).toContain('capacity');
  });

  it('flags a person with every option ruled out', () => {
    const config = applyConfigPatch(workshopConfig(), {
      pins: { add: [{ kind: 'not_options', user_id: USER_IDS[5], option_ids: PROJECT_IDS }] },
    });
    const [issue] = errors(config);
    expect(issue).toMatchObject({
      code: 'all_options_forbidden',
      srcs: ['pin:p1'],
      user_ids: [USER_IDS[5]],
    });
    expect(issue!.message).toBe(
      '1 person has every option ruled out (by pin p1 (not on 20 options)).'
    );
  });

  it('flags require/forbid collisions, conflicting places, closed pins and oversized groups', () => {
    const config = applyConfigPatch(workshopConfig(), {
      options: { [PROJECT_IDS[9]]: { open: 'closed' } },
      pins: {
        add: [
          { kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1]] },
          { kind: 'apart', user_ids: [USER_IDS[0], USER_IDS[1]] },
          { kind: 'on_option', user_id: USER_IDS[2], option_id: PROJECT_IDS[0] },
          { kind: 'on_option', user_id: USER_IDS[2], option_id: PROJECT_IDS[1] },
          { kind: 'on_option', user_id: USER_IDS[3], option_id: PROJECT_IDS[9] },
          { kind: 'together', user_ids: USER_IDS.slice(10, 14) },
        ],
      },
    });
    const found = errors(config);
    const codes = found.map(issue => issue.code);
    expect(codes).toContain('required_pair_forbidden');
    expect(codes).toContain('conflicting_required_options');
    expect(codes).toContain('pinned_option_closed');
    expect(codes).toContain('together_group_too_large');
    expect(found.find(issue => issue.code === 'required_pair_forbidden')!.srcs!.sort()).toEqual([
      'pin:p1',
      'pin:p2',
    ]);
    expect(found.find(issue => issue.code === 'together_group_too_large')).toMatchObject({
      message: expect.stringMatching(/^4 people must all be on one team, but teams hold at most 3/),
      user_ids: USER_IDS.slice(10, 14),
    });
    expect(found.find(issue => issue.code === 'pinned_option_closed')!.user_ids).toEqual([
      USER_IDS[3],
    ]);
  });

  it('flags a together group whose members are required on different options', () => {
    const config = applyConfigPatch(workshopConfig(), {
      pins: {
        add: [
          { kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1]] },
          { kind: 'on_option', user_id: USER_IDS[0], option_id: PROJECT_IDS[0] },
          { kind: 'on_option', user_id: USER_IDS[1], option_id: PROJECT_IDS[1] },
        ],
      },
    });
    expect(errors(config)).toEqual([
      expect.objectContaining({
        code: 'conflicting_required_options',
        user_ids: USER_IDS.slice(0, 2),
      }),
    ]);
  });

  it('warns about forced-open options nobody ranked and pins naming people outside the set', () => {
    const input = miniInput();
    const config = applyConfigPatch(input.config, {
      options: { [IDEA_IDS[2]]: { open: 'open' } },
      pins: { add: [{ kind: 'together', user_ids: [MINI_USERS[0], uuid(19, 77)] }] },
    });
    const issues = checks(config, input);
    expect(issues.filter(issue => issue.level === 'error')).toEqual([]);
    expect(issues.map(issue => issue.code).sort()).toEqual([
      'forced_open_unranked',
      'no_response',
      'pin_people_missing',
    ]);
    expect(issues.find(issue => issue.code === 'forced_open_unranked')!.srcs).toEqual([
      `option:${IDEA_IDS[2]}`,
    ]);
    expect(issues.find(issue => issue.code === 'pin_people_missing')!.user_ids).toEqual([
      uuid(19, 77),
    ]);
  });

  it('refuses a model the engine cannot build (z = pair terms × slots)', () => {
    const { problem, context } = compileProblem(workshopInput());
    // 20 slots: 7,500 pair terms → z = 150,000 is the limit itself (allowed).
    const pairs = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ p: 0, q: 1 + (i % 26), cost: 1 }));
    const at = runChecks({ ...problem, pair: pairs(7_500) }, context);
    expect(at.some(issue => issue.code === 'model_too_large')).toBe(false);
    expect(7_500 * problem.slots.length).toBe(MODEL_SIZE_LIMIT);

    // Pair hards count too: one forbid_pair more tips it over.
    const over = runChecks(
      {
        ...problem,
        pair: pairs(7_500),
        hard: [{ kind: 'forbid_pair', src: 'pin:p1', p: 0, q: 1 }],
      },
      context
    );
    const issue = over.find(i => i.code === 'model_too_large');
    expect(issue).toMatchObject({ level: 'error', srcs: [`${F.timing}:match`] });
    expect(issue!.message).toBe(
      'This setup is too large to solve: 7501 pair terms across 20 team slots. Remove a match or mix rule (each compares every pair of people).'
    );

    // Free mode also suggests grouping by a question.
    const free = runChecks(
      {
        ...problem,
        options: [{ id: FREE_OPTION_ID, open: 'auto' }],
        slots: Array.from({ length: 30 }, () => ({ option: 0 })),
        place: [],
        pair: pairs(6_000),
      },
      context
    );
    expect(free.find(i => i.code === 'model_too_large')!.message).toMatch(
      /, or group teams by a question\.$/
    );
  });

  it('refuses a count entry that says both "nobody alone" and "at most 1"', () => {
    const { problem, context } = compileProblem(workshopInput());
    const issues = runChecks(
      {
        ...problem,
        soft_counts: [
          {
            src: `${F.timing}:no_one_alone`,
            members: [0, 1, 2],
            not_one: true,
            max: 1,
            weight: 100,
          },
        ],
      },
      context
    );
    expect(issues.filter(issue => issue.level === 'error')).toEqual([
      expect.objectContaining({ code: 'count_contradiction', srcs: [`${F.timing}:no_one_alone`] }),
    ]);
  });

  it('warns when a hard "nobody alone" group is odd and teams are exactly pairs', () => {
    const tiny = (larger: number, members: number[]): TeamSetProblem => ({
      version: 1,
      people: ['a', 'b', 'c', 'd', 'e', 'f'],
      options: [{ id: FREE_OPTION_ID, open: 'auto' }],
      slots: [{ option: 0 }, { option: 0 }, { option: 0 }],
      size: { min: 2, max: 2, larger },
      team_count: { min: 1, max: 3 },
      place: [],
      pair: [],
      hard: [{ kind: 'team_count', src: 'r:no_one_alone', members, not_one: true }],
      soft_counts: [],
      balance: [],
      worst_off_weight: 0,
      time_limit_s: 5,
      seed: 1,
    });
    const context: TeamSetContext = {
      option_ids: [FREE_OPTION_ID],
      option_categories: [null],
      people: ['a', 'b', 'c', 'd', 'e', 'f'].map(user_id => ({
        user_id,
        responded: true,
        ranked: [],
        categories: [],
        requests: [],
        avoids: [],
      })),
      rules: [{ id: 'r:no_one_alone', job: 'no_one_alone', strength: 'must', label: 'Online?' }],
      pins: [],
      note_field_ids: [],
    };
    expect(runChecks(tiny(0, [0, 1, 2]), context)).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'odd_group_in_pairs',
        srcs: ['r:no_one_alone'],
        user_ids: ['a', 'b', 'c'],
      }),
    ]);
    expect(runChecks(tiny(0, [0, 1, 2, 3]), context)).toEqual([]);
    expect(runChecks(tiny(1, [0, 1, 2]), context)).toEqual([]); // one trio allowed
  });

  it('refuses an empty population', () => {
    const input = workshopInput({ roster: [] });
    expect(checks(input.config, input)).toEqual([
      expect.objectContaining({ level: 'error', code: 'no_people' }),
    ]);
  });
});
