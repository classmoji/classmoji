/**
 * Team set config (teamSetConfig.ts): the suggestion a new set starts from,
 * the patch semantics MCP and the page share, and the check of a config
 * against the form it points at. Pure — synthetic fixtures only.
 */

import { describe, it, expect } from 'vitest';
import { parseFormDefinition } from '../formContract.ts';
import {
  TeamSetConfigError,
  TeamSetConfigPatchSchema,
  TeamSetConfigSchema,
  applyConfigPatch,
  applyConfigPatchWithNotes,
  suggestConfig,
  suggestSetName,
  teamSetRuleId,
  validateConfigAgainstForm,
  type TeamSetConfig,
} from '../teamSetConfig.ts';
import {
  F,
  PROJECT_IDS,
  TIMING_IDS,
  USER_IDS,
  WORKSHOP_TITLE,
  uuid,
  workshopConfig,
  workshopFields,
} from './helpers/teamSetFixtures.ts';

function expectConfigError(fn: () => unknown, pattern: RegExp): TeamSetConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(TeamSetConfigError);
    const e = error as TeamSetConfigError;
    expect(e.code).toBe('invalid_config');
    expect(e.message).toMatch(pattern);
    return e;
  }
  throw new Error('expected a TeamSetConfigError');
}

describe('TeamSetConfigSchema', () => {
  it('fills defaults', () => {
    const config = TeamSetConfigSchema.parse({
      version: 1,
      grouping: { mode: 'by_option', field_id: F.projects },
      team_size: { min: 2, max: 3 },
      options: { [PROJECT_IDS[0]]: {} },
      rules: [{ field_id: F.partners, job: 'together', strength: 'prefer' }],
    });
    expect(config.grouping).toEqual({
      mode: 'by_option',
      field_id: F.projects,
      teams_per_option: 1,
    });
    expect(config.team_size.allow_one_larger).toBe(false);
    expect(config.team_count).toEqual({});
    expect(config.options[PROJECT_IDS[0]]).toEqual({ open: 'auto' });
    expect(config.rules[0]).toMatchObject({ weight: 5, params: {} });
    expect(config).toMatchObject({
      non_respondents: 'include',
      fairness: 50,
      pins: [],
      team_name_template: '{set}-{n}',
      github_teams: true,
      time_limit_s: 30,
    });
  });

  it('rejects min > max, unknown keys and bad pins', () => {
    const base = { version: 1, grouping: { mode: 'free' } };
    expect(TeamSetConfigSchema.safeParse({ ...base, team_size: { min: 4, max: 2 } }).success).toBe(
      false
    );
    expect(
      TeamSetConfigSchema.safeParse({ ...base, team_size: { min: 2, max: 2 }, extra: 1 }).success
    ).toBe(false);
    expect(
      TeamSetConfigSchema.safeParse({
        ...base,
        team_size: { min: 2, max: 2 },
        pins: [{ id: 'p1', kind: 'apart', user_ids: [USER_IDS[0]] }],
      }).success
    ).toBe(false);
  });
});

describe('suggestConfig', () => {
  it('suggests the expected rules for the workshop form', () => {
    const fields = workshopFields();
    const { name, config } = suggestConfig(fields, WORKSHOP_TITLE);

    expect(name).toBe('workshop-project-preferences-fall-teams');
    expect(name.length).toBeLessThanOrEqual(40);
    expect(config.grouping).toEqual({
      mode: 'by_option',
      field_id: F.projects,
      teams_per_option: 1,
    });
    expect(config.team_size).toEqual({ min: 3, max: 5, allow_one_larger: false });
    expect(config.rules.map(rule => [rule.field_id, rule.job, rule.strength, rule.weight])).toEqual(
      [
        [F.projects, 'rank', 'prefer', 8],
        [F.partners, 'together', 'prefer', 5],
        [F.notes, 'note', 'prefer', 5],
      ]
    );
    // tracks (multiselect), react (scale) and timing (unrelated dropdown) get no rule.
    expect(config.rules.some(rule => [F.tracks, F.react, F.timing].includes(rule.field_id))).toBe(
      false
    );
    expect(validateConfigAgainstForm(config, fields)).toEqual([]);
  });

  it('finds owner and apart questions, and ignores teaching-team pickers', () => {
    const ideaIds = [uuid(5, 1), uuid(5, 2), uuid(5, 3)];
    const ids = {
      ideas: uuid(6, 1),
      pitched: uuid(6, 2),
      avoid: uuid(6, 3),
      ta: uuid(6, 4),
      dont: uuid(6, 5),
    };
    const fields = parseFormDefinition([
      {
        id: ids.ideas,
        type: 'ranked_choice',
        label: 'Rank the ideas',
        ranks: 2,
        options: ideaIds.map((id, i) => ({ id, label: `Idea ${i + 1}` })),
      },
      {
        id: ids.pitched,
        type: 'dropdown',
        label: 'Which idea did you pitch?',
        options: ideaIds.slice(0, 2).map((id, i) => ({ id, label: `Idea ${i + 1}` })),
      },
      {
        id: ids.avoid,
        type: 'roster_select',
        label: 'Anyone you would rather NOT work with?',
        optionSource: 'roster',
        multiple: true,
      },
      {
        id: ids.dont,
        type: 'roster_select',
        label: "Who don't you want to work with?",
        optionSource: 'roster',
      },
      {
        id: ids.ta,
        type: 'roster_select',
        label: 'Preferred mentor',
        optionSource: 'teaching_team',
      },
    ]).fields;
    const { config } = suggestConfig(fields, 'Ideas');
    expect(config.rules.map(rule => [rule.field_id, rule.job, rule.strength, rule.weight])).toEqual(
      [
        [ids.ideas, 'rank', 'prefer', 8],
        [ids.pitched, 'owner', 'prefer', 9],
        [ids.avoid, 'apart', 'prefer', 8],
        [ids.dont, 'apart', 'prefer', 8],
      ]
    );
  });

  it('never suggests must, and reads ordinary partner questions as together', () => {
    const labels = [
      "Who would you like to work with? Leave blank if you don't have a preference",
      'Pick a partner (do not pick yourself)',
      "Anyone you'd like to pair with?",
      'Who do you want to work with?',
    ];
    const avoidLabels = [
      'Is there anyone you want to avoid?',
      "Anyone you'd rather not be paired with?",
      'Who would you prefer not to work with?',
      'Who do you not want to work with?',
    ];
    const fields = parseFormDefinition(
      [...labels, ...avoidLabels].map((label, i) => ({
        id: uuid(10, i + 1),
        type: 'roster_select',
        label,
        optionSource: 'roster',
      }))
    ).fields;
    const { config } = suggestConfig(fields, 'Partners');
    expect(config.rules.map(rule => [rule.job, rule.strength])).toEqual([
      ...labels.map(() => ['together', 'prefer']),
      ...avoidLabels.map(() => ['apart', 'prefer']),
    ]);
    const workshop = suggestConfig(workshopFields(), WORKSHOP_TITLE).config;
    expect([...config.rules, ...workshop.rules].some(rule => rule.strength === 'must')).toBe(false);
  });

  it('falls back to free grouping and a bounded name', () => {
    const fields = parseFormDefinition([
      { id: uuid(7, 1), type: 'short_text', label: 'Name' },
    ]).fields;
    const { name, config } = suggestConfig(fields, '!!!');
    expect(name).toBe('teams');
    expect(config.grouping).toEqual({ mode: 'free' });
    expect(suggestSetName('x'.repeat(80))).toHaveLength(40);
  });
});

describe('applyConfigPatch', () => {
  const base = (): TeamSetConfig => workshopConfig();

  it('returns a new validated config and never mutates the input', () => {
    const config = base();
    const snapshot = JSON.parse(JSON.stringify(config));
    const next = applyConfigPatch(config, { fairness: 80, team_size: { min: 3, max: 4 } });
    expect(next.fairness).toBe(80);
    expect(next.team_size).toEqual({ min: 3, max: 4, allow_one_larger: false });
    expect(config).toEqual(snapshot);
  });

  it('upserts rules: new rules need a strength, existing ones merge', () => {
    let config = base();
    config = applyConfigPatch(config, {
      rules: { upsert: [{ field_id: F.timing, job: 'no_one_alone', strength: 'prefer' }] },
    });
    expect(config.rules.find(rule => teamSetRuleId(rule) === `${F.timing}:no_one_alone`)).toEqual({
      field_id: F.timing,
      job: 'no_one_alone',
      strength: 'prefer',
      weight: 5,
      params: {},
    });

    config = applyConfigPatch(config, {
      rules: {
        upsert: [
          {
            field_id: F.projects,
            job: 'rank',
            weight: 10,
            params: { must_top: 2, unranked_cost: 90 },
          },
        ],
      },
    });
    const rank = config.rules.find(rule => rule.job === 'rank')!;
    expect(rank).toMatchObject({
      strength: 'prefer',
      weight: 10,
      params: { must_top: 2, unranked_cost: 90 },
    });

    // params merge; null deletes a key
    config = applyConfigPatch(config, {
      rules: {
        upsert: [
          { field_id: F.projects, job: 'rank', strength: 'must', params: { must_top: null } },
        ],
      },
    });
    expect(config.rules.find(rule => rule.job === 'rank')).toMatchObject({
      strength: 'must',
      weight: 10,
      params: { unranked_cost: 90 },
    });
    expect(config.rules.find(rule => rule.job === 'rank')!.params).not.toHaveProperty('must_top');

    expectConfigError(
      () => applyConfigPatch(config, { rules: { upsert: [{ field_id: F.react, job: 'mix' }] } }),
      /needs a strength/
    );
  });

  it('removes rules and refuses to remove one that is not there', () => {
    const config = applyConfigPatch(base(), {
      rules: { remove: [{ field_id: F.notes, job: 'note' }] },
    });
    expect(config.rules.some(rule => rule.job === 'note')).toBe(false);
    expectConfigError(
      () => applyConfigPatch(config, { rules: { remove: [{ field_id: F.notes, job: 'note' }] } }),
      /no note rule/
    );
  });

  it('assigns pin ids and supports add / remove / clear', () => {
    let config = applyConfigPatch(base(), {
      pins: {
        add: [
          { kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1]] },
          {
            kind: 'on_option',
            user_id: USER_IDS[2],
            option_id: PROJECT_IDS[3],
            reason: 'Synthetic reason',
          },
        ],
      },
    });
    expect(config.pins.map(pin => pin.id)).toEqual(['p1', 'p2']);
    expect(config.pins[1]).toMatchObject({ kind: 'on_option', reason: 'Synthetic reason' });

    config = applyConfigPatch(config, {
      pins: { remove: ['p1'], add: [{ kind: 'apart', user_ids: [USER_IDS[3], USER_IDS[4]] }] },
    });
    expect(config.pins.map(pin => pin.id)).toEqual(['p2', 'p3']);

    // ids continue after a clear rather than being reused
    config = applyConfigPatch(config, {
      pins: {
        clear: true,
        add: [{ kind: 'not_options', user_id: USER_IDS[5], option_ids: [PROJECT_IDS[0]] }],
      },
    });
    expect(config.pins.map(pin => pin.id)).toEqual(['p4']);

    expectConfigError(() => applyConfigPatch(config, { pins: { remove: ['p1'] } }), /no pin p1/);
    expectConfigError(
      () =>
        applyConfigPatch(config, {
          pins: { add: [{ kind: 'together', user_ids: [USER_IDS[0], USER_IDS[0]] }] },
        }),
      /same person twice/
    );
  });

  it('adds a pin only once: identical pins (any order, any reason) are no-ops', () => {
    let config = applyConfigPatch(base(), {
      pins: {
        add: [
          { kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1], USER_IDS[2]] },
          {
            kind: 'not_options',
            user_id: USER_IDS[3],
            option_ids: [PROJECT_IDS[0], PROJECT_IDS[1]],
          },
          // same batch, same people in another order
          { kind: 'together', user_ids: [USER_IDS[2], USER_IDS[0], USER_IDS[1]] },
        ],
      },
    });
    expect(config.pins.map(pin => pin.id)).toEqual(['p1', 'p2']);

    // A retry of the same call, plus one genuinely new pin: only the new one lands,
    // and no id is spent on the skipped ones.
    config = applyConfigPatch(config, {
      pins: {
        add: [
          { kind: 'together', user_ids: [USER_IDS[1], USER_IDS[2], USER_IDS[0]], reason: 'again' },
          {
            kind: 'not_options',
            user_id: USER_IDS[3],
            option_ids: [PROJECT_IDS[1], PROJECT_IDS[0]],
          },
          { kind: 'apart', user_ids: [USER_IDS[4], USER_IDS[5]] },
        ],
      },
    });
    expect(config.pins.map(pin => pin.id)).toEqual(['p1', 'p2', 'p3']);
    expect(config.pins[0]).not.toHaveProperty('reason');

    // A subset or superset of a together group is a different pin.
    config = applyConfigPatch(config, {
      pins: { add: [{ kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1]] }] },
    });
    expect(config.pins.map(pin => pin.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('merges option settings per option, clears one field on null, deletes on null', () => {
    const id = PROJECT_IDS[0];
    let config = applyConfigPatch(base(), { options: { [id]: { open: 'closed' } } });
    expect(config.options[id]).toEqual({ open: 'closed', category: 'Health' });
    config = applyConfigPatch(config, { options: { [id]: { team_name: 'alpha' } } });
    expect(config.options[id]).toEqual({ open: 'closed', category: 'Health', team_name: 'alpha' });
    // A null field clears just that field; a cleared `open` falls back to 'auto'.
    config = applyConfigPatch(config, { options: { [id]: { category: null, open: null } } });
    expect(config.options[id]).toEqual({ open: 'auto', team_name: 'alpha' });
    config = applyConfigPatch(config, { options: { [id]: null } });
    expect(config.options).not.toHaveProperty(id);
  });

  it('drops option settings when the grouping question changes, and says so', () => {
    const same = applyConfigPatchWithNotes(base(), {
      grouping: { mode: 'by_option', field_id: F.projects, teams_per_option: 2 },
    });
    expect(Object.keys(same.config.options)).toHaveLength(20);
    expect(same.notes).toEqual([]);

    const other = uuid(1, 50);
    const moved = applyConfigPatchWithNotes(base(), {
      grouping: { mode: 'by_option', field_id: other },
      options: { [uuid(2, 500)]: { open: 'open' } }, // applies to the NEW question
    });
    expect(moved.config.options).toEqual({ [uuid(2, 500)]: { open: 'open' } });
    expect(moved.notes).toEqual([
      'Dropped the settings of 20 option(s): they belonged to the previous grouping question.',
    ]);

    const free = applyConfigPatchWithNotes(base(), { grouping: { mode: 'free' } });
    expect(free.config.options).toEqual({});
    expect(free.notes).toHaveLength(1);
    // applyConfigPatch is the same patch without the notes.
    expect(applyConfigPatch(base(), { grouping: { mode: 'free' } })).toEqual(free.config);
  });

  it('replaces grouping and refuses an invalid result or an unknown key', () => {
    const free = applyConfigPatch(base(), { grouping: { mode: 'free' } });
    expect(free.grouping).toEqual({ mode: 'free' });

    const error = expectConfigError(
      () => applyConfigPatch(base(), { team_size: { min: 4, max: 2 } }),
      /team_size/
    );
    expect(error.problems.length).toBeGreaterThan(0);
    expectConfigError(() => applyConfigPatch(base(), { teamsize: 3 } as never), /Unrecognized key/);
  });

  it('exposes a strict object patch schema (what MCP takes)', () => {
    expect(TeamSetConfigPatchSchema.safeParse({}).success).toBe(true);
    expect(TeamSetConfigPatchSchema.safeParse({ rules: { upsert: [], nope: 1 } }).success).toBe(
      false
    );
  });
});

describe('validateConfigAgainstForm', () => {
  const fields = workshopFields();

  it('accepts the workshop config', () => {
    expect(validateConfigAgainstForm(workshopConfig(), fields)).toEqual([]);
  });

  it('rejects jobs on the wrong question type', () => {
    const config = applyConfigPatch(workshopConfig(), {
      rules: {
        upsert: [
          { field_id: F.tracks, job: 'rank', strength: 'prefer' },
          { field_id: F.timing, job: 'together', strength: 'prefer' },
          { field_id: F.notes, job: 'balance', strength: 'prefer' },
        ],
      },
    });
    const problems = validateConfigAgainstForm(config, fields);
    expect(problems.some(p => /rank can't use "Which tracks interest you\?"/.test(p))).toBe(true);
    expect(problems.some(p => /together can't use "When can you meet\?"/.test(p))).toBe(true);
    expect(problems.some(p => /balance can't use "Anything we should know\?"/.test(p))).toBe(true);
  });

  it('rejects unknown option ids in options, wildcards and pins', () => {
    const bogus = uuid(99, 1);
    const config = applyConfigPatch(workshopConfig(), {
      options: { [bogus]: { open: 'open' } },
      rules: {
        upsert: [{ field_id: F.timing, job: 'match', params: { wildcard_option_ids: [bogus] } }],
      },
      pins: { add: [{ kind: 'on_option', user_id: USER_IDS[0], option_id: bogus }] },
    });
    const problems = validateConfigAgainstForm(config, fields);
    expect(
      problems.some(p => p.includes('Option settings name options') && p.includes(bogus))
    ).toBe(true);
    expect(problems.some(p => p.includes('Wildcard answers') && p.includes(bogus))).toBe(true);
    expect(problems.some(p => p.startsWith('Pin p1 names options') && p.includes(bogus))).toBe(
      true
    );
  });

  it('names every pin a grouping change strands, in one problem', () => {
    const pinned = applyConfigPatch(workshopConfig(), {
      pins: {
        add: [
          { kind: 'on_option', user_id: USER_IDS[0], option_id: PROJECT_IDS[0] },
          { kind: 'together', user_ids: [USER_IDS[1], USER_IDS[2]] },
          { kind: 'not_options', user_id: USER_IDS[3], option_ids: [PROJECT_IDS[1]] },
        ],
      },
    });
    // Grouping by the timing dropdown: the project pins name options it doesn't have.
    const regrouped = applyConfigPatch(pinned, {
      grouping: { mode: 'by_option', field_id: F.timing },
      rules: {
        remove: [
          { field_id: F.projects, job: 'rank' },
          { field_id: F.tracks, job: 'fallback' },
        ],
      },
    });
    const problems = validateConfigAgainstForm(regrouped, fields);
    expect(problems).toEqual([
      `Pins p1, p3 name options that are not in the grouping question: ${PROJECT_IDS[0]}, ${PROJECT_IDS[1]}. Remove them (pins.remove) and pin again with current options.`,
    ]);

    const free = applyConfigPatch(pinned, {
      grouping: { mode: 'free' },
      rules: {
        remove: [
          { field_id: F.projects, job: 'rank' },
          { field_id: F.tracks, job: 'fallback' },
        ],
      },
    });
    expect(validateConfigAgainstForm(free, fields)).toEqual([
      'Pins p1, p3 place people on options, but teams are not grouped by a question. Remove them (pins.remove) or group by a question.',
    ]);
  });

  it('needs both bounds on a number question used by balance or mix', () => {
    const count = uuid(1, 60);
    const bounded = uuid(1, 61);
    const withNumbers = [
      ...fields,
      ...parseFormDefinition([
        { id: count, type: 'number', label: 'How many repos have you made?', min: 0 },
        { id: bounded, type: 'number', label: 'Hours per week', min: 0, max: 40 },
      ]).fields,
    ];
    const config = applyConfigPatch(workshopConfig(), {
      rules: {
        upsert: [
          { field_id: count, job: 'balance', strength: 'prefer' },
          { field_id: count, job: 'mix', strength: 'prefer' },
          { field_id: bounded, job: 'balance', strength: 'prefer' },
        ],
      },
    });
    expect(validateConfigAgainstForm(config, withNumbers)).toEqual([
      'Balancing "How many repos have you made?" needs the question to have both a minimum and a maximum.',
      'Mixing on "How many repos have you made?" needs the question to have both a minimum and a maximum.',
    ]);
    // An 'off' rule is not checked.
    const off = applyConfigPatch(config, {
      rules: {
        upsert: [
          { field_id: count, job: 'balance', strength: 'off' },
          { field_id: count, job: 'mix', strength: 'off' },
        ],
      },
    });
    expect(validateConfigAgainstForm(off, withNumbers)).toEqual([]);
  });

  it('rejects params that belong to another job, must on balance, and a missing question', () => {
    const config = applyConfigPatch(workshopConfig(), {
      rules: {
        upsert: [
          { field_id: F.partners, job: 'together', params: { must_top: 2 } },
          { field_id: F.react, job: 'balance', strength: 'must' },
          { field_id: uuid(1, 99), job: 'note', strength: 'prefer' },
        ],
      },
    });
    const problems = validateConfigAgainstForm(config, fields);
    expect(problems.some(p => p.includes("'must_top'"))).toBe(true);
    expect(problems.some(p => /can only be 'prefer'/.test(p))).toBe(true);
    expect(problems.some(p => /not in the current form/.test(p))).toBe(true);
  });

  it('needs grouping for rank/owner/option pins and a rank rule for fallback', () => {
    const config = applyConfigPatch(workshopConfig(), {
      grouping: { mode: 'free' },
      options: Object.fromEntries(PROJECT_IDS.map(id => [id, null])),
    });
    const problems = validateConfigAgainstForm(config, fields);
    expect(problems.some(p => /rank rule .* needs teams grouped/.test(p))).toBe(true);

    const noRank = applyConfigPatch(workshopConfig(), {
      rules: { remove: [{ field_id: F.projects, job: 'rank' }] },
    });
    expect(validateConfigAgainstForm(noRank, fields).some(p => /needs a rank rule/.test(p))).toBe(
      true
    );
  });

  it('flags a grouping question of the wrong type and a timing dropdown owner with no shared ids', () => {
    const config = applyConfigPatch(workshopConfig(), {
      rules: { upsert: [{ field_id: F.timing, job: 'owner', strength: 'prefer' }] },
    });
    expect(validateConfigAgainstForm(config, fields).some(p => /can't name an owner/.test(p))).toBe(
      true
    );

    const wrong = TeamSetConfigSchema.parse({
      version: 1,
      grouping: { mode: 'by_option', field_id: F.tracks },
      team_size: { min: 2, max: 2 },
    });
    expect(validateConfigAgainstForm(wrong, fields)[0]).toMatch(/ranked-choice or dropdown/);
    expect(TIMING_IDS).toHaveLength(4);
  });
});
