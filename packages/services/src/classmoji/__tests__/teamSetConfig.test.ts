/**
 * Team set config (teamSetConfig.ts): the suggestion a new set starts from,
 * the patch semantics MCP and the page share, and the check of a config
 * against the form it points at. Pure — synthetic fixtures only.
 */

import { describe, it, expect } from 'vitest';
import { parseFormDefinition, type FormField } from '../formContract.ts';
import {
  DEFAULT_PRIORITY_SHIFT,
  PRIORITY_PRESET,
  TeamSetConfigError,
  TeamSetConfigPatchSchema,
  TeamSetConfigSchema,
  applyConfigPatch,
  applyConfigPatchWithNotes,
  defaultIdentityWildcards,
  highestPinNumber,
  isPairs,
  jobsAllowedFor,
  leftOutNotes,
  normalizeTeamSetName,
  numberedTeamSetName,
  optionSize,
  parseStoredTeamSetConfig,
  priorityShift,
  resolveNonRespondents,
  stampProvenance,
  suggestConfig,
  suggestSetName,
  teamSetRuleId,
  configProblemsAgainstForm,
  validateConfigAgainstForm,
  withoutRetiredKeys,
  type TeamSetConfig,
  type TeamSetConfigPatchInput,
  type TeamSetJob,
  type TeamSetNonRespondents,
} from '../teamSetConfig.ts';
import {
  F,
  PROJECT_IDS,
  TIMING_IDS,
  TRACK_IDS,
  USER_IDS,
  WORKSHOP_TITLE,
  miniConfigInput,
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
    // allow_one_larger is retired (the remainder flex is automatic): no default.
    expect(config.team_size).not.toHaveProperty('allow_one_larger');
    expect(config.team_count).toEqual({});
    expect(config.options[PROJECT_IDS[0]]).toEqual({ open: 'auto' });
    expect(config.rules[0]).toMatchObject({ weight: 5, params: {} });
    expect(config).toMatchObject({
      fairness: 50,
      pins: [],
      team_name_template: '{set}-{n}',
      github_teams: true,
      time_limit_s: 30,
    });
    // No parse default: unset keeps following the team size (resolveNonRespondents).
    expect(config).not.toHaveProperty('non_respondents');
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
    expect(config.team_size).toEqual({ min: 3, max: 5 });
    expect(config.team_name_template).toBe('{set}-{option}');
    expect(config).not.toHaveProperty('non_respondents');
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
    expect(config.team_name_template).toBe('{set}-{n}');
    expect(suggestSetName('x'.repeat(80))).toHaveLength(40);
  });
});

describe('normalizeTeamSetName', () => {
  it('keeps letters and digits of any script, and hyphens', () => {
    expect(normalizeTeamSetName('日本')).toBe('日本');
    expect(normalizeTeamSetName('ü')).toBe('ü');
    expect(normalizeTeamSetName('Équipe 3')).toBe('équipe-3');
    expect(normalizeTeamSetName('группа')).toBe('группа');
    expect(normalizeTeamSetName('٣')).toBe('٣');
    expect(normalizeTeamSetName('  Project  Teams -- 2! ')).toBe('project-teams-2');
  });

  it('keeps the vowel signs of scripts that write them as combining marks', () => {
    expect(normalizeTeamSetName('हिंदी टीम')).toBe('हिंदी-टीम');
    expect(normalizeTeamSetName('தமிழ்')).toBe('தமிழ்');
  });

  it('drops a mark that follows no letter, such as an emoji’s variation selector', () => {
    expect(normalizeTeamSetName('team ❤️')).toBe('team');
    expect(normalizeTeamSetName('❤️')).toBe('');
    expect(normalizeTeamSetName('́')).toBe('');
  });

  it('drops an emoji’s variation selector and keycap mark after a letter or digit too', () => {
    expect(normalizeTeamSetName('team❤️')).toBe('team');
    expect(normalizeTeamSetName('team\u2764\uFE0F')).toBe('team');
    expect(normalizeTeamSetName('a😀️b')).toBe('ab');
    expect(normalizeTeamSetName('a\u{1F600}\uFE0Fb')).toBe('ab');
    expect(normalizeTeamSetName('1️⃣')).toBe('1');
    expect(normalizeTeamSetName('1\uFE0F\u20E3')).toBe('1');
    expect(normalizeTeamSetName('x\u{E0100}')).toBe('x');
  });

  it('is NFC after a dropped character brings a letter and its accent together', () => {
    const name = normalizeTeamSetName('a!\u0301');
    expect(name).toBe('\u00e1');
    expect(name).toBe(name.normalize('NFC'));
    expect(name).toBe(normalizeTeamSetName('\u00e1'));
    for (const typed of ['team❤️', 'a😀️b', '1️⃣', 'हिंदी टीम', 'தமிழ்', 'E\u0301quipe 2']) {
      const stored = normalizeTeamSetName(typed);
      expect(stored).toBe(stored.normalize('NFC'));
      expect(normalizeTeamSetName(stored)).toBe(stored);
    }
  });

  it('leaves nothing of a name without a letter or digit', () => {
    expect(normalizeTeamSetName('!!!')).toBe('');
    expect(normalizeTeamSetName('🙂🙂')).toBe('');
    expect(normalizeTeamSetName('#%&')).toBe('');
    expect(normalizeTeamSetName(' - ')).toBe('');
  });

  it('caps the name at 40 characters without a trailing hyphen', () => {
    expect(normalizeTeamSetName('x'.repeat(80))).toHaveLength(40);
    expect(normalizeTeamSetName(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });

  it('reads a letter typed as one character or as letter plus accent as the same name', () => {
    const composed = '\u00e9quipe'; // é as one code point
    const decomposed = 'e\u0301quipe'; // e, then the combining accent
    expect(composed).not.toBe(decomposed);
    expect(normalizeTeamSetName(decomposed)).toBe(normalizeTeamSetName(composed));
    expect(normalizeTeamSetName(decomposed)).toBe('\u00e9quipe');
    expect(normalizeTeamSetName('E\u0301quipe 2')).toBe('\u00e9quipe-2');
  });

  it('counts 40 characters by code point, never splitting a letter outside the BMP', () => {
    // 𐐨 (Deseret) and 𠀀 (CJK Extension B) are letters of two UTF-16 units each.
    const lone = /\p{Cs}/u;
    const deseret = normalizeTeamSetName(`${'a'.repeat(39)}\u{10428}\u{10428}`);
    expect(deseret).toBe(`${'a'.repeat(39)}\u{10428}`);
    expect(Array.from(deseret)).toHaveLength(40);
    expect(deseret).not.toMatch(lone);
    const han = normalizeTeamSetName('\u{20000}'.repeat(45));
    expect(Array.from(han)).toHaveLength(40);
    expect(han).toBe('\u{20000}'.repeat(40));
    expect(han).not.toMatch(lone);
    // A capital outside the BMP is lower-cased like any other.
    expect(normalizeTeamSetName('\u{10400}')).toBe('\u{10428}');
  });
});

describe('numberedTeamSetName', () => {
  it('numbers a name within 40 characters, cutting the name by code point', () => {
    expect(numberedTeamSetName('project-teams', 2)).toBe('project-teams-2');
    expect(numberedTeamSetName('x'.repeat(40), 12)).toBe(`${'x'.repeat(37)}-12`);
    // No hyphen is left before the number.
    expect(numberedTeamSetName(`${'a'.repeat(37)}-bc`, 2)).toBe(`${'a'.repeat(37)}-2`);
    const numbered = numberedTeamSetName('\u{20000}'.repeat(40), 3);
    expect(numbered).toBe(`${'\u{20000}'.repeat(38)}-3`);
    expect(Array.from(numbered)).toHaveLength(40);
    expect(numbered).not.toMatch(/\p{Cs}/u);
  });
});

describe('applyConfigPatch', () => {
  const base = (): TeamSetConfig => workshopConfig();

  it('returns a new validated config and never mutates the input', () => {
    const config = base();
    const snapshot = JSON.parse(JSON.stringify(config));
    const next = applyConfigPatch(config, { fairness: 80, team_size: { min: 3, max: 4 } });
    expect(next.fairness).toBe(80);
    expect(next.team_size).toEqual({ min: 3, max: 4 });
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
      /There is no note rule on a question in this setup/
    );
    // With the form's fields, the question is named by its label (never its id).
    const error = expectConfigError(
      () =>
        applyConfigPatchWithNotes(
          config,
          { rules: { remove: [{ field_id: F.notes, job: 'note' }] } },
          workshopFields()
        ),
      /note/
    );
    expect(error.problems).toEqual([
      'There is no note rule on "Anything we should know?" in this setup.',
    ]);
    expect(error.paths).toEqual([`patch.rules.remove.${F.notes}:note`]);
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

    const gone = expectConfigError(
      () => applyConfigPatch(config, { pins: { remove: ['p1'] } }),
      /patch\.pins\.remove\.p1/
    );
    expect(gone.problems).toEqual(['A pin the patch drops isn’t in this setup.']);
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

  it('never gives a removed pin’s id to a later pin (last_pin_number)', () => {
    const apart = (a: number, b: number) => ({
      kind: 'apart' as const,
      user_ids: [USER_IDS[a], USER_IDS[b]],
    });
    const ids = (config: TeamSetConfig) => config.pins.map(pin => pin.id);
    let config = applyConfigPatch(base(), { pins: { add: [apart(0, 1), apart(2, 3)] } });
    expect(ids(config)).toEqual(['p1', 'p2']);
    expect(config.last_pin_number).toBe(2);
    // Removing the highest pin in one save and adding in the next: a new id.
    config = applyConfigPatch(config, { pins: { remove: ['p2'] } });
    expect(ids(config)).toEqual(['p1']);
    expect(config.last_pin_number).toBe(2);
    config = applyConfigPatch(config, { pins: { add: [apart(4, 5)] } });
    expect(ids(config)).toEqual(['p1', 'p3']);
    // A patch without pins leaves the counter alone.
    expect(applyConfigPatch(config, { fairness: 70 }).last_pin_number).toBe(3);

    // A config saved before the counter: its highest id counts, and a remove records it.
    const legacy = TeamSetConfigSchema.parse({ ...base(), pins: [{ id: 'p5', ...apart(0, 1) }] });
    expect(legacy.last_pin_number).toBeUndefined();
    const removed = applyConfigPatch(legacy, { pins: { remove: ['p5'] } });
    expect(removed.last_pin_number).toBe(5);
    expect(ids(applyConfigPatch(removed, { pins: { add: [apart(2, 3)] } }))).toEqual(['p6']);

    // The server's counter: a patch can't set it.
    expect(TeamSetConfigPatchSchema.safeParse({ last_pin_number: 1 }).success).toBe(false);
    expect(highestPinNumber({ pins: [], last_pin_number: 7 })).toBe(7);
    expect(highestPinNumber({ pins: [{ id: 'p9' }, { id: 'custom' }] } as never)).toBe(9);
    expect(highestPinNumber({ pins: [] })).toBe(0);
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
    expect(error.problems).toEqual(['Team size: the smallest is above the largest.']);
    expect(error.paths).toEqual(['patch.team_size.min']);
    const unknown = expectConfigError(
      () => applyConfigPatch(base(), { teamsize: 3 } as never),
      /isn’t recognized/
    );
    // The key itself is only in the path, never in the text.
    expect(unknown.problems).toEqual(['The setup: has a setting that isn’t recognized.']);
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
    expect(problems).toContain(
      `The rank rule can't use "Which tracks interest you?" (a multiselect question); it needs a ranked choice or dropdown question.`
    );
    expect(problems.some(p => /together rule can't use "When can you meet\?"/.test(p))).toBe(true);
    expect(problems.some(p => /balance rule can't use "Anything we should know\?"/.test(p))).toBe(
      true
    );
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
    // Unknown ids are counted, never printed.
    expect(problems).toContain(
      'Option settings name options that are not in the grouping question: an option no longer on the form.'
    );
    expect(problems).toContain(
      'Answers set to match anyone that are not options of "When can you meet?": an option no longer on the form.'
    );
    expect(problems).toContain(
      'A pin names options that are not in the grouping question: an option no longer on the form.'
    );
    expect(problems.some(p => p.includes(bogus))).toBe(false);
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
      '2 pins name options that are not in the grouping question: "Project 1", "Project 2".',
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
      '2 pins place people on options, but teams are not grouped by a question.',
    ]);

    const one = applyConfigPatch(free, { pins: { remove: ['p3'] } });
    expect(validateConfigAgainstForm(one, fields)).toEqual([
      'A pin places people on options, but teams are not grouped by a question.',
    ]);
    // The pins' ids are in the path, for machines.
    expect(configProblemsAgainstForm(free, fields)).toEqual([
      {
        path: 'pins.p1,p3',
        text: '2 pins place people on options, but teams are not grouped by a question.',
      },
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
    expect(problems).toContain(
      'The together rule on "Who would you like to work with?" has a setting (top picks Must counts) that only applies to other rules.'
    );
    expect(problems.some(p => /can only be Prefer/.test(p))).toBe(true);
    expect(problems).toContain('A note rule points at a question that is not in the current form.');
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

// ─── Release 2: stored configs, option size/note, stamps, identity, priority ──

type RuleUpsert = NonNullable<NonNullable<TeamSetConfigPatchInput['rules']>['upsert']>[number];

const P0 = PROJECT_IDS[0]; // "Project 1", category Health
const P1 = PROJECT_IDS[1]; // "Project 2", category Climate
const OWNER = uuid(40, 1);
const TEACHER = uuid(40, 2);
const T1 = '2026-09-26T10:00:00.000Z';
const T2 = '2026-09-27T09:30:00.000Z';

/** Words that would make a problem string advice instead of a fact. */
const ADVICE = /\b(remove|try|consider|should|instead|recommend|suggest|fix|please)\b/i;

/**
 * A config as the Phase 1 schema stored it: every default filled in,
 * non_respondents explicit (it had a default of 'include'), no size, note or
 * stamps anywhere.
 */
const phase1Stored = () => ({
  version: 1,
  grouping: { mode: 'by_option', field_id: F.projects, teams_per_option: 1 },
  team_size: { min: 2, max: 2, allow_one_larger: true },
  team_count: {},
  options: {
    [P0]: { open: 'closed', category: 'Health' },
    [P1]: { open: 'auto', category: 'Climate', team_name: 'beta' },
  },
  rules: [
    { field_id: F.projects, job: 'rank', strength: 'must', weight: 8, params: { must_top: 3 } },
    {
      field_id: F.timing,
      job: 'match',
      strength: 'prefer',
      weight: 4,
      params: { wildcard_option_ids: [TIMING_IDS[3]] },
    },
    {
      field_id: F.timing,
      job: 'no_one_alone',
      strength: 'prefer',
      weight: 5,
      params: { max_per_team: 2 },
    },
    { field_id: F.partners, job: 'together', strength: 'prefer', weight: 5, params: {} },
    { field_id: F.notes, job: 'note', strength: 'prefer', weight: 5, params: {} },
  ],
  non_respondents: 'include',
  fairness: 50,
  pins: [
    { id: 'p1', kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1]] },
    {
      id: 'p2',
      kind: 'on_option',
      user_id: USER_IDS[2],
      option_id: P1,
      reason: 'Synthetic reason',
    },
  ],
  team_name_template: '{set}-{n}',
  github_teams: true,
  time_limit_s: 30,
});

function expectConfigErrorOn(patch: unknown, pattern: RegExp, config = workshopConfig()) {
  return expectConfigError(
    () => applyConfigPatch(config, patch as TeamSetConfigPatchInput),
    pattern
  );
}

describe('stored configs from Phase 1', () => {
  it('parse unchanged and still fit their form', () => {
    const stored = phase1Stored();
    expect(TeamSetConfigSchema.parse(stored)).toEqual(stored);
    const exclude = { ...phase1Stored(), non_respondents: 'exclude' };
    expect(TeamSetConfigSchema.parse(exclude)).toEqual(exclude);
    // team_size.allow_one_larger (retired, ignored) still parses as stored, and a
    // patch may still send it (the value is kept; nothing reads it).
    expect(TeamSetConfigSchema.parse(stored).team_size).toEqual({
      min: 2,
      max: 2,
      allow_one_larger: true,
    });
    expect(
      applyConfigPatch(TeamSetConfigSchema.parse(stored), {
        team_size: { min: 2, max: 3, allow_one_larger: false },
      }).team_size
    ).toEqual({ min: 2, max: 3, allow_one_larger: false });
    expect(validateConfigAgainstForm(TeamSetConfigSchema.parse(stored), workshopFields())).toEqual(
      []
    );
    // The shared fixtures parse too.
    expect(() => workshopConfig()).not.toThrow();
    expect(() => TeamSetConfigSchema.parse(miniConfigInput())).not.toThrow();
  });

  it("keep their explicit 'include' even for teams of two, through any patch", () => {
    const stored = TeamSetConfigSchema.parse(phase1Stored());
    expect(isPairs(stored)).toBe(true);
    expect(resolveNonRespondents(stored)).toBe('include');
    const patched = applyConfigPatch(stored, { fairness: 60 });
    expect(patched).toEqual({ ...stored, fairness: 60 });
    // No stamps appear on the old pin or the old closed option by themselves.
    expect(patched.pins[0]).not.toHaveProperty('added_by');
    expect(patched.options[P0]).not.toHaveProperty('closed_by');
  });
});

describe('derived settings', () => {
  it('isPairs and resolveNonRespondents: Group for teams of two, Spread otherwise, unless set', () => {
    const size = (min: number, max: number, allow_one_larger = false) => ({
      min,
      max,
      allow_one_larger,
    });
    const cases: [ReturnType<typeof size>, TeamSetNonRespondents | undefined, boolean, string][] = [
      [size(2, 2), undefined, true, 'group'],
      [size(1, 2), undefined, true, 'group'],
      [size(2, 2, true), undefined, true, 'group'],
      [size(2, 3), undefined, false, 'include'],
      [size(3, 5), undefined, false, 'include'],
      [size(2, 2), 'include', true, 'include'],
      [size(2, 2), 'exclude', true, 'exclude'],
      [size(3, 5), 'group', false, 'group'],
    ];
    for (const [team_size, non_respondents, pairs, resolved] of cases) {
      const config = { team_size, ...(non_respondents ? { non_respondents } : {}) };
      expect(isPairs(config)).toBe(pairs);
      expect(resolveNonRespondents(config)).toBe(resolved);
    }
    // The shared workshop fixture is a Phase 1 stored config: pairs, with 'include' set explicitly.
    expect(resolveNonRespondents(workshopConfig())).toBe('include');
  });

  it('optionSize takes each bound from the option, else team_size', () => {
    const config = applyConfigPatch(workshopConfig(), {
      team_size: { min: 3, max: 4 },
      options: { [P0]: { size: { max: 6 } }, [P1]: { size: { min: 2, max: 2 } } },
    });
    expect(optionSize(config, P0)).toEqual({ min: 3, max: 6 });
    expect(optionSize(config, P1)).toEqual({ min: 2, max: 2 });
    expect(optionSize(config, PROJECT_IDS[2])).toEqual({ min: 3, max: 4 });
    expect(optionSize(config, uuid(99, 9))).toEqual({ min: 3, max: 4 });
  });

  it('jobsAllowedFor: by type, and only no_one_alone for an identity question', () => {
    const fields = identityForm();
    const byId = (id: string) => fields.find(field => field.id === id)!;
    expect(jobsAllowedFor(byId(F.timing))).toEqual<TeamSetJob[]>([
      'rank',
      'owner',
      'match',
      'mix',
      'no_one_alone',
      'priority',
    ]);
    expect(jobsAllowedFor(byId(F.tracks))).toEqual<TeamSetJob[]>([
      'fallback',
      'match',
      'no_one_alone',
    ]);
    expect(jobsAllowedFor(byId(ID.gender))).toEqual(['no_one_alone']);
    expect(jobsAllowedFor(byId(ID.status))).toEqual(['no_one_alone']);
    expect(jobsAllowedFor(byId(ID.firstGen))).toEqual(['no_one_alone']);
    expect(jobsAllowedFor(byId(ID.describe))).toEqual([]);
  });
});

describe('option size and note', () => {
  it('sets a size, replaces it whole, clears it on null', () => {
    let config = applyConfigPatch(workshopConfig(), {
      options: { [P0]: { size: { min: 3, max: 4 } } },
    });
    expect(config.options[P0]).toEqual({
      open: 'auto',
      category: 'Health',
      size: { min: 3, max: 4 },
    });
    config = applyConfigPatch(config, { options: { [P0]: { size: { max: 3 } } } });
    expect(config.options[P0].size).toEqual({ max: 3 });
    config = applyConfigPatch(config, { options: { [P0]: { size: null } } });
    expect(config.options[P0]).toEqual({ open: 'auto', category: 'Health' });
  });

  it.each<[Record<string, unknown>, RegExp]>([
    [{}, /the team size needs a smallest, a largest or both/],
    [{ min: 5, max: 4 }, /the smallest team size is above the largest/],
    [{ min: 0 }, /size\.min/],
    [{ max: 51 }, /size\.max/],
    [{ min: 2.5 }, /size\.min/],
    [{ min: 2, most: 3 }, /isn’t recognized/],
  ])('refuses the size %j', (size, pattern) => {
    expectConfigErrorOn({ options: { [P0]: { size } } }, pattern);
    expect(
      TeamSetConfigSchema.safeParse({ ...phase1Stored(), options: { [P0]: { size } } }).success
    ).toBe(false);
  });

  it('checks each effective size against the set’s team_size', () => {
    const fields = workshopFields();
    // team_size 2–2: an own max of 3 is fine, and so is 1–1.
    const ok = applyConfigPatch(workshopConfig(), {
      options: { [P0]: { size: { max: 3 } }, [P1]: { size: { min: 1, max: 1 } } },
    });
    expect(validateConfigAgainstForm(ok, fields)).toEqual([]);
    // An own max of 1 under the set's min of 2.
    const low = applyConfigPatch(workshopConfig(), { options: { [P0]: { size: { max: 1 } } } });
    expect(validateConfigAgainstForm(low, fields)).toEqual([
      'Team size for "Project 1": the smallest (2) is above the largest (1).',
    ]);
    // A team_size change strands an own bound too.
    const moved = applyConfigPatch(ok, { team_size: { min: 4, max: 5 } });
    expect(validateConfigAgainstForm(moved, fields)).toEqual([
      'Team size for "Project 1": the smallest (4) is above the largest (3).',
    ]);
    // An option no longer on the form is counted, never named by its id.
    const gone = uuid(99, 2);
    const stale = TeamSetConfigSchema.parse({
      ...workshopConfig(),
      options: { ...workshopConfig().options, [gone]: { size: { max: 1 } } },
    });
    expect(validateConfigAgainstForm(stale, fields)).toEqual([
      'Option settings name options that are not in the grouping question: an option no longer on the form.',
      'Team size for an option no longer on the form: the smallest (2) is above the largest (1).',
    ]);
  });

  it('keeps a typed note, clears it when blank or null, and caps it at 500 characters', () => {
    let config = applyConfigPatch(workshopConfig(), {
      options: { [P0]: { note: 'Needs the lab machines' } },
    });
    expect(config.options[P0].note).toBe('Needs the lab machines');
    config = applyConfigPatch(config, { options: { [P0]: { note: '   ' } } });
    expect(config.options[P0]).not.toHaveProperty('note');
    config = applyConfigPatch(config, { options: { [P0]: { note: 'x'.repeat(500) } } });
    expect(config.options[P0].note).toHaveLength(500);
    config = applyConfigPatch(config, { options: { [P0]: { note: null } } });
    expect(config.options[P0]).toEqual({ open: 'auto', category: 'Health' });
    expectConfigErrorOn({ options: { [P0]: { note: 'x'.repeat(501) } } }, /note/);
    // Notes are option settings: free mode has none.
    const free = applyConfigPatch(workshopConfig(), { grouping: { mode: 'free' } });
    expect(
      validateConfigAgainstForm(
        TeamSetConfigSchema.parse({ ...free, options: { [P0]: { note: 'A note' } } }),
        workshopFields()
      )
    ).toContain('Option settings only apply when teams are grouped by a question.');
  });
});

describe('non_respondents and github_teams in a patch', () => {
  it("takes 'include', 'group' and 'exclude'; null goes back to the default", () => {
    const base = workshopConfig();
    for (const mode of ['include', 'group', 'exclude'] as const) {
      expect(applyConfigPatch(base, { non_respondents: mode }).non_respondents).toBe(mode);
    }
    const set = applyConfigPatch(base, { non_respondents: 'exclude' });
    const unset = applyConfigPatch(set, { non_respondents: null });
    expect(unset).not.toHaveProperty('non_respondents');
    expect(resolveNonRespondents(unset)).toBe('group');
    expect(resolveNonRespondents(applyConfigPatch(unset, { team_size: { min: 3, max: 4 } }))).toBe(
      'include'
    );
    expectConfigErrorOn({ non_respondents: 'spread' }, /non_respondents/);
  });

  it('accepts github_teams false', () => {
    const config = applyConfigPatch(workshopConfig(), { github_teams: false });
    expect(config.github_teams).toBe(false);
    expect(validateConfigAgainstForm(config, workshopFields())).toEqual([]);
  });
});

describe('provenance stamps', () => {
  it('are stored, but no patch can set them', () => {
    const stamped = {
      ...phase1Stored(),
      options: {
        [P0]: {
          open: 'closed',
          category: 'Health',
          closed_by: OWNER,
          closed_via: 'mcp',
          closed_at: T1,
        },
      },
      pins: [
        {
          id: 'p1',
          kind: 'together',
          user_ids: [USER_IDS[0], USER_IDS[1]],
          added_by: TEACHER,
          added_via: 'page',
          added_at: T2,
        },
      ],
    };
    expect(TeamSetConfigSchema.parse(stamped)).toEqual(stamped);

    const closed = { closed_by: OWNER, closed_via: 'page', closed_at: T1 };
    for (const [key, value] of Object.entries(closed)) {
      expectConfigErrorOn(
        { options: { [P0]: { open: 'closed', [key]: value } } },
        /isn’t recognized/
      );
    }
    const added = { added_by: OWNER, added_via: 'page', added_at: T1 };
    for (const [key, value] of Object.entries(added)) {
      expectConfigErrorOn(
        { pins: { add: [{ kind: 'apart', user_ids: [USER_IDS[0], USER_IDS[1]], [key]: value }] } },
        new RegExp(key)
      );
      expect(
        TeamSetConfigPatchSchema.safeParse({
          pins: { add: [{ kind: 'on_option', user_id: USER_IDS[0], option_id: P0, [key]: value }] },
        }).success
      ).toBe(false);
    }
  });

  it.each([
    ['closed_by', 'someone'],
    ['closed_via', 'email'],
    ['closed_at', 'yesterday'],
  ])('refuse a stored %s of %j', (key, value) => {
    const stored = { ...phase1Stored(), options: { [P0]: { open: 'closed', [key]: value } } };
    expect(TeamSetConfigSchema.safeParse(stored).success).toBe(false);
  });

  it('stampProvenance stamps new pins and newly closed options, and keeps older stamps', () => {
    const base = workshopConfig();
    const first = applyConfigPatch(base, {
      options: { [P0]: { open: 'closed' } },
      pins: { add: [{ kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1]] }] },
    });
    expect(first.pins[0]).not.toHaveProperty('added_by');
    expect(first.options[P0]).not.toHaveProperty('closed_by');

    const saved = stampProvenance(base, first, { user_id: OWNER, via: 'page', at: T1 });
    expect(saved.pins[0]).toMatchObject({
      id: 'p1',
      added_by: OWNER,
      added_via: 'page',
      added_at: T1,
    });
    expect(saved.options[P0]).toEqual({
      open: 'closed',
      category: 'Health',
      closed_by: OWNER,
      closed_via: 'page',
      closed_at: T1,
    });
    expect(saved.options[P1]).toEqual({ open: 'auto', category: 'Climate' });
    expect(first.pins[0]).not.toHaveProperty('added_by'); // pure

    // A later save by someone else: the old pin and the still-closed option
    // keep their stamps; the new pin and the newly closed option get the new one.
    const second = applyConfigPatch(saved, {
      options: { [P0]: { open: 'closed' }, [P1]: { open: 'closed' } },
      pins: { add: [{ kind: 'apart', user_ids: [USER_IDS[2], USER_IDS[3]] }] },
    });
    const saved2 = stampProvenance(saved, second, { user_id: TEACHER, via: 'mcp', at: T2 });
    expect(saved2.pins.map(pin => [pin.id, pin.added_by, pin.added_via, pin.added_at])).toEqual([
      ['p1', OWNER, 'page', T1],
      ['p2', TEACHER, 'mcp', T2],
    ]);
    expect(saved2.options[P0]).toMatchObject({
      closed_by: OWNER,
      closed_via: 'page',
      closed_at: T1,
    });
    expect(saved2.options[P1]).toMatchObject({
      closed_by: TEACHER,
      closed_via: 'mcp',
      closed_at: T2,
    });

    // Reopened (by value or by null): the stamps go with the Closed setting.
    const reopened = applyConfigPatch(saved2, {
      options: { [P0]: { open: 'auto' }, [P1]: { open: null } },
    });
    expect(reopened.options[P0]).toEqual({ open: 'auto', category: 'Health' });
    expect(reopened.options[P1]).toEqual({ open: 'auto', category: 'Climate' });
    // Forced open is not closed either.
    const forced = applyConfigPatch(saved2, { options: { [P0]: { open: 'open' } } });
    expect(forced.options[P0]).toEqual({ open: 'open', category: 'Health' });
    // Closed again: a new stamp.
    const reclosed = stampProvenance(
      reopened,
      applyConfigPatch(reopened, { options: { [P0]: { open: 'closed' } } }),
      { user_id: TEACHER, via: 'page', at: T2 }
    );
    expect(reclosed.options[P0]).toMatchObject({ closed_by: TEACHER, closed_via: 'page' });
  });

  it('stampProvenance keeps stamps copied back from a run, and before=null stamps everything', () => {
    const run = stampProvenance(
      workshopConfig(),
      applyConfigPatch(workshopConfig(), {
        options: { [P0]: { open: 'closed' } },
        pins: { add: [{ kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1]] }] },
      }),
      { user_id: OWNER, via: 'page', at: T1 }
    );
    // Since that run the option was reopened and the pin removed; going back
    // to the run's setup brings the run's stamps with it.
    const current = applyConfigPatch(run, {
      options: { [P0]: { open: 'auto' } },
      pins: { remove: ['p1'] },
    });
    const reverted = stampProvenance(current, run, { user_id: TEACHER, via: 'page', at: T2 });
    expect(reverted.pins[0]).toMatchObject({ added_by: OWNER, added_at: T1 });
    expect(reverted.options[P0]).toMatchObject({ closed_by: OWNER, closed_at: T1 });

    // No before: a copied set starts as the copier's.
    const copied = stampProvenance(null, run, { user_id: TEACHER, via: 'mcp', at: T2 });
    expect(copied.pins[0]).toMatchObject({ added_by: TEACHER, added_via: 'mcp', added_at: T2 });
    expect(copied.options[P0]).toMatchObject({
      closed_by: TEACHER,
      closed_via: 'mcp',
      closed_at: T2,
    });
    expect(run.pins[0]).toMatchObject({ added_by: OWNER }); // pure
  });

  it('stampProvenance refuses a malformed stamp', () => {
    const withPin = applyConfigPatch(workshopConfig(), {
      pins: { add: [{ kind: 'apart', user_ids: [USER_IDS[0], USER_IDS[1]] }] },
    });
    expectConfigError(
      () => stampProvenance(null, withPin, { user_id: 'someone', via: 'page', at: T1 }),
      /added_by/
    );
    expectConfigError(
      () => stampProvenance(null, withPin, { user_id: OWNER, via: 'page', at: 'yesterday' }),
      /added_at/
    );
    expectConfigError(
      () => stampProvenance(null, withPin, { user_id: OWNER, via: 'email' as 'page', at: T1 }),
      /added_via/
    );
  });
});

// ─── Identity questions ─────────────────────────────────────────────────────

const ID = {
  gender: uuid(30, 1),
  describe: uuid(30, 2),
  status: uuid(30, 3),
  firstGen: uuid(30, 4),
  age: uuid(30, 5),
};
const GENDER_LABELS = [
  'Woman',
  'Man',
  'Non-binary',
  'Prefer to self-describe',
  'Prefer not to say',
];
const GENDER_IDS = GENDER_LABELS.map((_, i) => uuid(31, i + 1));
const [WOMAN, MAN, NON_BINARY, SELF_DESCRIBE, NOT_SAY] = GENDER_IDS;
const STATUS_IDS = [uuid(32, 1), uuid(32, 2), uuid(32, 3)];

/** The workshop form plus identity questions of every kind a rule could touch. */
function identityForm(): FormField[] {
  return [
    ...workshopFields(),
    ...parseFormDefinition([
      {
        id: ID.gender,
        type: 'multiselect',
        label: 'How do you describe your gender?',
        identity_question: true,
        options: GENDER_LABELS.map((label, i) => ({
          id: GENDER_IDS[i],
          label,
          ...(label === 'Prefer not to say' ? { exclusive: true } : {}),
        })),
      },
      {
        id: ID.describe,
        type: 'short_text',
        label: "If you'd like, describe it in your own words",
        identity_question: true,
      },
      {
        id: ID.status,
        type: 'dropdown',
        label: 'Which group are you in?',
        identity_question: true,
        options: ['Group A', 'Group B', 'Decline to state'].map((label, i) => ({
          id: STATUS_IDS[i],
          label,
        })),
      },
      {
        id: ID.firstGen,
        type: 'switch',
        label: 'First in your family at college?',
        identity_question: true,
      },
      { id: ID.age, type: 'number', label: 'Age', min: 16, max: 99, identity_question: true },
    ]).fields,
  ];
}

describe('identity questions (validateConfigAgainstForm)', () => {
  const fields = identityForm();
  const withRules = (...upsert: RuleUpsert[]) =>
    applyConfigPatch(workshopConfig(), { rules: { upsert } });
  const G = '"How do you describe your gender?"';
  const S = '"Which group are you in?"';
  const D = `"If you'd like, describe it in your own words"`;
  const onlyNoOneAlone = (question: string, job: string) =>
    `${question} is an identity question: the only rule it takes is no one alone, not ${job}.`;

  it('accept no_one_alone at off or prefer, with or without wildcards', () => {
    const config = withRules(
      {
        field_id: ID.gender,
        job: 'no_one_alone',
        strength: 'prefer',
        weight: 9,
        params: { wildcard_option_ids: [MAN, SELF_DESCRIBE, NOT_SAY] },
      },
      { field_id: ID.status, job: 'no_one_alone', strength: 'off' },
      { field_id: ID.firstGen, job: 'no_one_alone', strength: 'prefer' }
    );
    expect(validateConfigAgainstForm(config, fields)).toEqual([]);
  });

  // Any job but no_one_alone is refused whatever its strength, Off included.
  it.each<{
    field_id: string;
    job: TeamSetJob;
    strength: 'off' | 'prefer' | 'must';
    message: string;
  }>([
    { field_id: ID.gender, job: 'match', strength: 'prefer', message: onlyNoOneAlone(G, 'match') },
    {
      field_id: ID.gender,
      job: 'fallback',
      strength: 'off',
      message: onlyNoOneAlone(G, 'fallback'),
    },
    { field_id: ID.status, job: 'mix', strength: 'prefer', message: onlyNoOneAlone(S, 'mix') },
    { field_id: ID.status, job: 'owner', strength: 'prefer', message: onlyNoOneAlone(S, 'owner') },
    { field_id: ID.status, job: 'rank', strength: 'off', message: onlyNoOneAlone(S, 'rank') },
    {
      field_id: ID.status,
      job: 'priority',
      strength: 'off',
      message: onlyNoOneAlone(S, 'priority'),
    },
    { field_id: ID.describe, job: 'note', strength: 'prefer', message: onlyNoOneAlone(D, 'note') },
    {
      field_id: ID.age,
      job: 'balance',
      strength: 'prefer',
      message: onlyNoOneAlone('"Age"', 'balance'),
    },
    {
      field_id: ID.gender,
      job: 'no_one_alone',
      strength: 'must',
      message: `${G} is an identity question: its no one alone rule can be Off or Prefer, not Must.`,
    },
  ])('refuse $job at $strength', ({ field_id, job, strength, message }) => {
    const config = withRules({ field_id, job, strength });
    expect(validateConfigAgainstForm(config, fields)).toEqual([message]);
  });

  it('refuse max_per_team, and grouping by an identity question', () => {
    const spread = withRules({
      field_id: ID.gender,
      job: 'no_one_alone',
      strength: 'prefer',
      params: { max_per_team: 1 },
    });
    expect(validateConfigAgainstForm(spread, fields)).toEqual([
      `${G} is an identity question: its no one alone rule has no limit per team.`,
    ]);

    const grouped = applyConfigPatch(workshopConfig(), {
      grouping: { mode: 'by_option', field_id: ID.status },
      rules: {
        remove: [
          { field_id: F.projects, job: 'rank' },
          { field_id: F.tracks, job: 'fallback' },
        ],
      },
    });
    expect(validateConfigAgainstForm(grouped, fields)).toEqual([
      `Teams can't be grouped by ${S}: it is an identity question.`,
    ]);
  });

  it('a no_one_alone rule on an identity question of a type the job can’t use is a type problem', () => {
    const config = withRules({ field_id: ID.age, job: 'no_one_alone', strength: 'prefer' });
    expect(validateConfigAgainstForm(config, fields)).toEqual([
      `The no one alone rule can't use "Age" (a number question); it needs a dropdown or multiselect or switch question.`,
    ]);
  });

  it('no_one_alone takes a multiselect question that is not an identity question too', () => {
    const config = withRules({
      field_id: F.tracks,
      job: 'no_one_alone',
      strength: 'must',
      params: { wildcard_option_ids: [TRACK_IDS[5]] },
    });
    expect(validateConfigAgainstForm(config, workshopFields())).toEqual([]);
  });
});

describe('defaultIdentityWildcards', () => {
  const gender = identityForm().find(field => field.id === ID.gender)!;

  it('leaves the minority answers ticked: the mockup counts', () => {
    // Woman 3, Man 13, Non-binary 1, self-describe 0, Prefer not to say 2 — of 19.
    const counts = {
      answered: 19,
      byOption: { [WOMAN]: 3, [MAN]: 13, [NON_BINARY]: 1, [SELF_DESCRIBE]: 0, [NOT_SAY]: 2 },
    };
    expect(defaultIdentityWildcards(gender, counts)).toEqual([MAN, SELF_DESCRIBE, NOT_SAY]);
  });

  it('without counts (or answers), only exclusive and opt-out answers are wildcards', () => {
    expect(defaultIdentityWildcards(gender)).toEqual([SELF_DESCRIBE, NOT_SAY]);
    expect(defaultIdentityWildcards(gender, { answered: 0, byOption: {} })).toEqual([
      SELF_DESCRIBE,
      NOT_SAY,
    ]);
    const status = identityForm().find(field => field.id === ID.status)!;
    expect(defaultIdentityWildcards(status)).toEqual([STATUS_IDS[2]]); // "Decline to state"
  });

  it('counts an answer given by exactly half as not a minority', () => {
    const counts = { answered: 10, byOption: { [WOMAN]: 5, [MAN]: 4 } };
    expect(defaultIdentityWildcards(gender, counts)).toEqual([WOMAN, SELF_DESCRIBE, NOT_SAY]);
  });
});

describe('suggestConfig for identity questions', () => {
  it('suggests no_one_alone prefer 9 with the minority answers protected, and nothing else', () => {
    const fields = identityForm();
    const counts = {
      [ID.gender]: {
        answered: 19,
        byOption: { [WOMAN]: 3, [MAN]: 13, [NON_BINARY]: 1, [SELF_DESCRIBE]: 0, [NOT_SAY]: 2 },
      },
    };
    const { config } = suggestConfig(fields, WORKSHOP_TITLE, { identityCounts: counts });
    const identityIds = new Set(Object.values(ID));
    expect(config.rules.filter(rule => identityIds.has(rule.field_id))).toEqual([
      {
        field_id: ID.gender,
        job: 'no_one_alone',
        strength: 'prefer',
        weight: 9,
        params: { wildcard_option_ids: [MAN, SELF_DESCRIBE, NOT_SAY] },
      },
      {
        field_id: ID.status,
        job: 'no_one_alone',
        strength: 'prefer',
        weight: 9,
        params: { wildcard_option_ids: [STATUS_IDS[2]] },
      },
    ]);
    // The self-description short_text gets no note; the switch and number get nothing.
    expect(config.rules.some(rule => rule.field_id === ID.describe)).toBe(false);
    expect(validateConfigAgainstForm(config, fields)).toEqual([]);

    // Without counts the majority answer is protected too.
    const blind = suggestConfig(fields, WORKSHOP_TITLE).config;
    expect(blind.rules.find(rule => rule.field_id === ID.gender)?.params).toEqual({
      wildcard_option_ids: [SELF_DESCRIBE, NOT_SAY],
    });
  });

  it('suggests no rule when every answer is a wildcard or there are more than 20', () => {
    const fields = parseFormDefinition([
      {
        id: uuid(33, 1),
        type: 'dropdown',
        label: 'Group',
        identity_question: true,
        options: [
          { id: uuid(34, 1), label: 'Prefer not to say' },
          { id: uuid(34, 2), label: 'Decline' },
        ],
      },
      {
        id: uuid(33, 2),
        type: 'multiselect',
        label: 'Background',
        identity_question: true,
        options: [
          ...Array.from({ length: 21 }, (_, i) => ({
            id: uuid(35, i + 1),
            label: `Rather not say ${i + 1}`,
          })),
          { id: uuid(35, 99), label: 'Listed' },
        ],
      },
    ]).fields;
    expect(defaultIdentityWildcards(fields[0])).toHaveLength(2);
    expect(defaultIdentityWildcards(fields[1])).toHaveLength(21);
    expect(suggestConfig(fields, 'Form').config.rules).toEqual([]);
  });

  it('never groups by, owns or notes an identity question', () => {
    const ranked = uuid(36, 1);
    const pitched = uuid(36, 2);
    const ideas = [uuid(37, 1), uuid(37, 2)];
    const fields = parseFormDefinition([
      {
        id: ranked,
        type: 'ranked_choice',
        label: 'Rank the ideas',
        ranks: 2,
        options: ideas.map((id, i) => ({ id, label: `Idea ${i + 1}` })),
      },
      // Same ids as the ranked options, but an identity question: no owner rule.
      {
        id: pitched,
        type: 'dropdown',
        label: 'Which one?',
        identity_question: true,
        options_from: ranked,
      },
      { id: uuid(36, 3), type: 'long_text', label: 'About you', identity_question: true },
    ]).fields;
    const { config } = suggestConfig(fields, 'Ideas');
    expect(config.grouping).toMatchObject({ mode: 'by_option', field_id: ranked });
    expect(config.rules.map(rule => [rule.field_id, rule.job])).toEqual([
      [ranked, 'rank'],
      [pitched, 'no_one_alone'],
    ]);
  });
});

// ─── Priority ───────────────────────────────────────────────────────────────

const Q = { what: uuid(50, 1), flag: uuid(50, 2), extra: uuid(50, 3) };
const CHOICE_IDS = [uuid(51, 1), uuid(51, 2), uuid(51, 3)];
const [PROJECT, PEOPLE, BOTH] = CHOICE_IDS;
const RANK = `${F.projects}:rank`;
const TOGETHER = `${F.partners}:together`;
const RANK_NAME = 'the rank rule on "Rank the projects you want to work on"';

/** The workshop form plus a "what matters more" dropdown, a switch and a multiselect. */
function priorityForm(): FormField[] {
  return [
    ...workshopFields(),
    ...parseFormDefinition([
      {
        id: Q.what,
        type: 'dropdown',
        label: PRIORITY_PRESET.label,
        options: ['The project', 'The people', 'Both equally'].map((label, i) => ({
          id: CHOICE_IDS[i],
          label,
        })),
      },
      { id: Q.flag, type: 'switch', label: 'Is the project what matters most?' },
      {
        id: Q.extra,
        type: 'multiselect',
        label: 'Pick any',
        options: [{ id: uuid(52, 1), label: 'One' }],
      },
    ]).fields,
  ];
}

describe('priority rules', () => {
  const fields = priorityForm();
  const W = `"${PRIORITY_PRESET.label}"`;
  const LIST = 'rank, fallback, owner, together, apart, match, mix';
  const withPriority = (rule: Partial<RuleUpsert> = {}, base = workshopConfig()) =>
    applyConfigPatch(base, {
      rules: {
        upsert: [
          {
            field_id: Q.what,
            job: 'priority',
            strength: 'prefer',
            params: {
              rule_a: RANK,
              rule_b: TOGETHER,
              answers: { [PROJECT]: 'a', [PEOPLE]: 'b', [BOTH]: 'none' },
              shift: 50,
            },
            ...rule,
          },
        ],
      },
    });

  it('accepts a dropdown or switch priority rule with two targets, and defaults the shift', () => {
    const config = withPriority();
    expect(validateConfigAgainstForm(config, fields)).toEqual([]);
    expect(priorityShift(config.rules.find(r => r.job === 'priority')!)).toBe(50);
    const unshifted = withPriority({ params: { rule_a: RANK, rule_b: TOGETHER } });
    expect(priorityShift(unshifted.rules.find(r => r.job === 'priority')!)).toBe(
      DEFAULT_PRIORITY_SHIFT
    );
    expect(validateConfigAgainstForm(unshifted, fields)).toEqual([]);

    const onSwitch = withPriority({
      field_id: Q.flag,
      params: {
        rule_a: `${F.timing}:match`,
        rule_b: `${F.tracks}:fallback`,
        answers: { true: 'a', false: 'b' },
        shift: 90,
      },
    });
    expect(validateConfigAgainstForm(onSwitch, fields)).toEqual([]);
  });

  it('merges params on upsert: answers are replaced whole, null clears a param', () => {
    let config = withPriority();
    config = applyConfigPatch(config, {
      rules: {
        upsert: [
          { field_id: Q.what, job: 'priority', params: { answers: { [PEOPLE]: 'a' }, shift: 70 } },
        ],
      },
    });
    expect(config.rules.find(r => r.job === 'priority')!.params).toEqual({
      rule_a: RANK,
      rule_b: TOGETHER,
      answers: { [PEOPLE]: 'a' },
      shift: 70,
    });
    config = applyConfigPatch(config, {
      rules: { upsert: [{ field_id: Q.what, job: 'priority', params: { shift: null } }] },
    });
    expect(config.rules.find(r => r.job === 'priority')!.params).not.toHaveProperty('shift');
  });

  it.each<[string, unknown, RegExp]>([
    ['shift 55', { shift: 55 }, /shift/],
    ['shift 5', { shift: 5 }, /shift/],
    ['shift 100', { shift: 100 }, /shift/],
    ['a rule_a that is not a rule id', { rule_a: 'rank' }, /is not a rule of a question/],
    [
      'a rule_b with an unknown job',
      { rule_b: `${F.partners}:friends` },
      /is not a rule of a question/,
    ],
    ['an answer that is not a, b or none', { answers: { [PROJECT]: 'both' } }, /answers/],
    [
      'too many answers',
      { answers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`k${i}`, 'none'])) },
      /lists more than 32 answers/,
    ],
  ])('refuses %s in the params', (_, params, pattern) => {
    expectConfigErrorOn(
      { rules: { upsert: [{ field_id: Q.what, job: 'priority', strength: 'prefer', params }] } },
      pattern
    );
  });

  it('refuses must, missing or equal targets, targets not in the setup, and other jobs as targets', () => {
    expect(validateConfigAgainstForm(withPriority({ strength: 'must' }), fields)).toEqual([
      `The priority rule on ${W} can be Off or Prefer, not Must.`,
    ]);
    expect(validateConfigAgainstForm(withPriority({ params: { rule_a: RANK } }), fields)).toEqual([
      `The priority rule on ${W} needs two rules to weigh.`,
    ]);
    expect(
      validateConfigAgainstForm(withPriority({ params: { rule_a: RANK, rule_b: RANK } }), fields)
    ).toEqual([`The priority rule on ${W} weighs the same rule twice (${RANK_NAME}).`]);

    // A rule the setup doesn't have: on a question of the form, and on none.
    const ghost = `${uuid(99, 3)}:rank`;
    expect(
      validateConfigAgainstForm(
        withPriority({ params: { rule_a: `${F.timing}:mix`, rule_b: ghost } }),
        fields
      )
    ).toEqual([
      `The first rule the priority rule on ${W} weighs (the mix rule on "When can you meet?") is not in this setup.`,
      `The second rule the priority rule on ${W} weighs (a rule on a question no longer on the form) is not in this setup.`,
    ]);

    // balance, note and another priority rule can't be targets.
    const two = withPriority(
      { field_id: Q.flag, params: { rule_a: RANK, rule_b: TOGETHER } },
      withPriority()
    );
    const targets = applyConfigPatch(two, {
      rules: {
        upsert: [
          {
            field_id: Q.what,
            job: 'priority',
            params: { rule_a: `${F.react}:balance`, rule_b: `${Q.flag}:priority` },
          },
        ],
      },
    });
    expect(validateConfigAgainstForm(targets, fields)).toEqual([
      `The first rule the priority rule on ${W} weighs is a balance rule; a priority rule can weigh only ${LIST} rules.`,
      `The second rule the priority rule on ${W} weighs is a priority rule; a priority rule can weigh only ${LIST} rules.`,
    ]);
    const note = withPriority({ params: { rule_a: `${F.notes}:note`, rule_b: TOGETHER } });
    expect(validateConfigAgainstForm(note, fields)).toEqual([
      `The first rule the priority rule on ${W} weighs is a note rule; a priority rule can weigh only ${LIST} rules.`,
    ]);
  });

  it('refuses answers that are not the question’s', () => {
    const stray = uuid(99, 4);
    expect(
      validateConfigAgainstForm(
        withPriority({ params: { rule_a: RANK, rule_b: TOGETHER, answers: { [stray]: 'a' } } }),
        fields
      )
    ).toEqual([
      `The priority rule on ${W} lists answers that are not options of ${W}: an option no longer on the form.`,
    ]);
    expect(
      validateConfigAgainstForm(
        withPriority({
          field_id: Q.flag,
          params: { rule_a: RANK, rule_b: TOGETHER, answers: { yes: 'a', true: 'b' } },
        }),
        fields
      )
    ).toEqual([
      'The priority rule on "Is the project what matters most?" lists an answer other than Yes and No.',
    ]);
  });

  it('while Off, its targets may be gone; its answers and equal targets are still checked', () => {
    const off = withPriority({
      strength: 'off',
      params: { rule_a: `${F.timing}:mix`, rule_b: `${uuid(99, 5)}:rank` },
    });
    expect(validateConfigAgainstForm(off, fields)).toEqual([]);
    // Removing a target while the priority rule is on is refused by validation…
    const on = withPriority();
    const removed = applyConfigPatch(on, {
      rules: { remove: [{ field_id: F.partners, job: 'together' }] },
    });
    expect(validateConfigAgainstForm(removed, fields)).toEqual([
      `The second rule the priority rule on ${W} weighs (the together rule on "Who would you like to work with?") is not in this setup.`,
    ]);
    // …and accepted while it is off.
    const offFirst = applyConfigPatch(on, {
      rules: {
        upsert: [{ field_id: Q.what, job: 'priority', strength: 'off' }],
        remove: [{ field_id: F.partners, job: 'together' }],
      },
    });
    expect(validateConfigAgainstForm(offFirst, fields)).toEqual([]);
    expect(
      validateConfigAgainstForm(
        withPriority({
          strength: 'off',
          params: { rule_a: RANK, rule_b: RANK, answers: { x: 'a' } },
        }),
        fields
      )
    ).toEqual([
      `The priority rule on ${W} weighs the same rule twice (${RANK_NAME}).`,
      `The priority rule on ${W} lists answers that are not options of ${W}: an option no longer on the form.`,
    ]);
  });

  it('only a dropdown or switch takes it, and its params belong to it alone', () => {
    const wrongType = withPriority({ field_id: Q.extra, params: {} });
    expect(validateConfigAgainstForm(wrongType, fields)).toEqual([
      `The priority rule can't use "Pick any" (a multiselect question); it needs a dropdown or switch question.`,
    ]);
    const borrowed = applyConfigPatch(workshopConfig(), {
      rules: { upsert: [{ field_id: F.projects, job: 'rank', params: { shift: 50 } }] },
    });
    expect(validateConfigAgainstForm(borrowed, fields)).toEqual([
      `The rank rule on "Rank the projects you want to work on" has a setting (how much it shifts) that only applies to other rules.`,
    ]);
  });
});

describe('suggestConfig for the Project bidding preset', () => {
  const ids = {
    pitched: uuid(60, 1),
    ranked: uuid(60, 2),
    with: uuid(60, 3),
    avoid: uuid(60, 4),
    what: uuid(60, 5),
    else: uuid(60, 6),
  };
  const projects = ['Project A', 'Project B', 'Project C', 'Project D'].map((label, i) => ({
    id: uuid(61, i + 1),
    label,
  }));
  const choices = (labels: string[]) => labels.map((label, i) => ({ id: uuid(62, i + 1), label }));
  const presetShaped = (whatOptions = choices(['The project', 'The people', 'Both equally'])) =>
    parseFormDefinition([
      {
        id: ids.pitched,
        type: 'dropdown',
        label: 'Did you pitch one of these projects? If so, which one?',
        options_from: ids.ranked,
      },
      {
        id: ids.ranked,
        type: 'ranked_choice',
        label: "Rank the projects you'd like to work on",
        ranks: 3,
        options: projects,
      },
      {
        id: ids.with,
        type: 'roster_select',
        label: 'Who would you like to work with?',
        optionSource: 'roster',
        multiple: true,
      },
      {
        id: ids.avoid,
        type: 'roster_select',
        label: "Anyone you'd rather not work with?",
        optionSource: 'roster',
        multiple: true,
      },
      { id: ids.what, type: 'dropdown', label: 'What matters more to you?', options: whatOptions },
      { id: ids.else, type: 'long_text', label: 'Anything else we should know?' },
    ]).fields;

  it('pre-sets the priority rule: project → rank, people → together, both → no change, 50%', () => {
    const fields = presetShaped();
    const { config } = suggestConfig(fields, 'Project Bidding');
    expect(config.rules.map(rule => [rule.field_id, rule.job, rule.strength])).toEqual([
      [ids.ranked, 'rank', 'prefer'],
      [ids.pitched, 'owner', 'prefer'],
      [ids.with, 'together', 'prefer'],
      [ids.avoid, 'apart', 'prefer'],
      [ids.else, 'note', 'prefer'],
      [ids.what, 'priority', 'prefer'],
    ]);
    const [project, people, both] = choices(['The project', 'The people', 'Both equally']);
    expect(config.rules.find(rule => rule.job === 'priority')!.params).toEqual({
      rule_a: teamSetRuleId({ field_id: ids.ranked, job: 'rank' }),
      rule_b: teamSetRuleId({ field_id: ids.with, job: 'together' }),
      answers: { [project.id]: 'a', [people.id]: 'b', [both.id]: 'none' },
      shift: 50,
    });
    expect(config.team_name_template).toBe('{set}-{option}');
    expect(fields[0].options).toEqual(projects); // the pitched dropdown shares the ranked ids
    expect(validateConfigAgainstForm(config, fields)).toEqual([]);
  });

  it('recognizes the labels in any order, whatever the question says', () => {
    const shuffled = choices(['Both equally', 'The people', 'The project']);
    const fields = presetShaped(shuffled).map(field =>
      field.id === ids.what ? { ...field, label: 'Project or people?' } : field
    );
    const priority = suggestConfig(fields, 'Bids').config.rules.find(r => r.job === 'priority');
    expect(priority?.params.answers).toEqual({
      [shuffled[0].id]: 'none',
      [shuffled[1].id]: 'b',
      [shuffled[2].id]: 'a',
    });
  });

  it.each([
    ['other labels', ['The project', 'The people', 'Both']],
    ['a fourth option', ['The project', 'The people', 'Both equally', 'Neither']],
    ['a repeated label', ['The project', 'The project', 'Both equally']],
    ['different case', ['The Project', 'The people', 'Both equally']],
  ])('suggests no priority rule for %s', (_, labels) => {
    const { config } = suggestConfig(presetShaped(choices(labels)), 'Bids');
    expect(config.rules.some(rule => rule.job === 'priority')).toBe(false);
  });

  it('suggests no priority rule without a rank rule or a together rule to shift between', () => {
    const noTogether = presetShaped().filter(field => field.id !== ids.with);
    expect(suggestConfig(noTogether, 'Bids').config.rules.some(r => r.job === 'priority')).toBe(
      false
    );
    const noRank = presetShaped().filter(
      field => field.id !== ids.ranked && field.id !== ids.pitched
    );
    const free = suggestConfig(noRank, 'Bids').config;
    expect(free.grouping).toEqual({ mode: 'free' });
    expect(free.rules.some(r => r.job === 'priority')).toBe(false);
  });

  it('an identity question with the preset labels gets the identity rule, not a priority one', () => {
    const fields = presetShaped().map(field =>
      field.id === ids.what ? { ...field, identity_question: true } : field
    );
    const rules = suggestConfig(fields, 'Bids').config.rules;
    expect(rules.find(rule => rule.field_id === ids.what)?.job).toBe('no_one_alone');
    expect(rules.some(rule => rule.job === 'priority')).toBe(false);
  });

  it('never suggests must', () => {
    const suggested = [
      suggestConfig(presetShaped(), 'Bids').config,
      suggestConfig(identityForm(), 'Identity').config,
    ];
    expect(suggested.flatMap(c => c.rules).some(rule => rule.strength === 'must')).toBe(false);
  });
});

describe('problem strings', () => {
  it('state facts, never advice', () => {
    const fields = [...identityForm(), ...priorityForm().slice(workshopFields().length)];
    const broken = applyConfigPatch(workshopConfig(), {
      options: { [P0]: { size: { max: 1 } }, [uuid(99, 6)]: { open: 'open' } },
      rules: {
        upsert: [
          { field_id: ID.gender, job: 'match', strength: 'prefer' },
          {
            field_id: ID.status,
            job: 'no_one_alone',
            strength: 'must',
            params: { max_per_team: 1 },
          },
          { field_id: Q.what, job: 'priority', strength: 'must', params: { answers: { z: 'a' } } },
          { field_id: F.tracks, job: 'rank', strength: 'prefer' },
          { field_id: uuid(99, 7), job: 'note', strength: 'prefer' },
        ],
      },
      pins: { add: [{ kind: 'on_option', user_id: USER_IDS[0], option_id: uuid(99, 8) }] },
    });
    const problems = [
      ...validateConfigAgainstForm(broken, fields),
      ...validateConfigAgainstForm(
        applyConfigPatch(broken, {
          grouping: { mode: 'free' },
          rules: { remove: [{ field_id: F.projects, job: 'rank' }] },
        }),
        fields
      ),
    ];
    expect(problems.length).toBeGreaterThan(8);
    for (const problem of problems) expect(problem).not.toMatch(ADVICE);
  });

  it('name questions and options by their labels, never by a config key or an id', () => {
    const fields = [...identityForm(), ...priorityForm().slice(workshopFields().length)];
    const broken = applyConfigPatch(workshopConfig(), {
      options: { [P0]: { size: { max: 1 } }, [uuid(99, 6)]: { open: 'open' } },
      rules: {
        upsert: [
          { field_id: ID.gender, job: 'match', strength: 'prefer' },
          {
            field_id: ID.status,
            job: 'no_one_alone',
            strength: 'must',
            params: { max_per_team: 1, wildcard_option_ids: [uuid(99, 9)] },
          },
          {
            field_id: Q.what,
            job: 'priority',
            strength: 'must',
            params: { rule_a: `${uuid(99, 10)}:rank`, answers: { z: 'a' } },
          },
          { field_id: F.partners, job: 'together', params: { must_top: 2 } },
          { field_id: uuid(99, 7), job: 'note', strength: 'prefer' },
        ],
      },
      pins: { add: [{ kind: 'on_option', user_id: USER_IDS[0], option_id: uuid(99, 8) }] },
    });
    const refused = (patch: unknown): string[] => {
      try {
        applyConfigPatchWithNotes(workshopConfig(), patch as TeamSetConfigPatchInput, fields);
      } catch (error) {
        return (error as TeamSetConfigError).problems;
      }
      return [];
    };
    const problems = [
      ...validateConfigAgainstForm(broken, fields),
      ...refused({ rules: { remove: [{ field_id: uuid(99, 11), job: 'rank' }] } }),
      ...refused({ rules: { upsert: [{ field_id: F.react, job: 'mix' }] } }),
      ...refused({ pins: { remove: ['p9'] } }),
      ...refused({ team_size: { min: 3, max: 2, allow_one_larger: false } }),
      ...refused({ options: { [P0]: { size: { min: 60 } } } }),
      ...refused({ time_limit_s: 3, fairness: 'x', github_team: true }),
    ];
    expect(problems.length).toBeGreaterThan(12);
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/i;
    const KEY = /\b[a-z]+_[a-z_]+\b|\bp\d+\b/;
    for (const problem of problems) {
      expect(problem).not.toMatch(UUID);
      expect(problem).not.toMatch(KEY);
    }
  });
});

describe('stored configs: retired settings, a strict parse, and what a restore left out', () => {
  const stored = () => JSON.parse(JSON.stringify(workshopConfig())) as Record<string, unknown>;

  it('drops a retired setting on read, and nothing else', () => {
    const raw = { ...stored(), team_size: { min: 2, max: 2, allow_one_larger: true } };
    const parsed = parseStoredTeamSetConfig(raw);
    expect(parsed!.config.team_size).toEqual({ min: 2, max: 2 });
    expect(parsed!.left_out).toEqual({ rules: [], pins: 0, options: [], settings: [] });
    // The input is not changed.
    expect(raw.team_size).toEqual({ min: 2, max: 2, allow_one_larger: true });
    expect(withoutRetiredKeys({ team_size: { min: 1, max: 2, allow_one_larger: false } })).toEqual({
      team_size: { min: 1, max: 2 },
    });
    expect(withoutRetiredKeys(null)).toBeNull();
    expect(withoutRetiredKeys({ team_size: 3 })).toEqual({ team_size: 3 });
  });

  it('refuses any key it doesn’t know, at any depth, instead of dropping it', () => {
    expect(parseStoredTeamSetConfig({ ...stored(), newer_setting: 1 })).toBeNull();
    expect(
      parseStoredTeamSetConfig({ ...stored(), team_size: { min: 2, max: 2, newer: true } })
    ).toBeNull();
    const withRule = stored();
    (withRule.rules as Record<string, unknown>[])[0]!.newer = 1;
    expect(parseStoredTeamSetConfig(withRule)).toBeNull();
    // A restore still refuses a key it doesn't know at the top level.
    expect(
      parseStoredTeamSetConfig({ ...stored(), newer_setting: 1 }, { entries: true })
    ).toBeNull();
  });

  it('restores a run setup leaving out what no longer parses, and says what', () => {
    const raw = stored();
    const rules = raw.rules as Record<string, unknown>[];
    rules[0] = { ...rules[0]!, strength: 'always' };
    raw.pins = [
      { id: 'p1', kind: 'apart', user_ids: [USER_IDS[0], USER_IDS[1]] },
      { id: 'p2', kind: 'together', user_ids: [USER_IDS[2]] },
    ];
    (raw.options as Record<string, Record<string, unknown>>)[PROJECT_IDS[0]] = { open: 'maybe' };
    raw.fairness = 400;
    const restored = parseStoredTeamSetConfig(raw, { entries: true })!;
    expect(restored.config.rules).toHaveLength(rules.length - 1);
    expect(restored.config.pins.map(pin => pin.id)).toEqual(['p1']);
    expect(restored.config.options).not.toHaveProperty(PROJECT_IDS[0]);
    expect(restored.config.fairness).toBe(50);
    expect(restored.left_out).toEqual({
      rules: [{ field_id: rules[0]!.field_id, job: rules[0]!.job }],
      pins: 1,
      options: [PROJECT_IDS[0]],
      settings: ['fairness'],
    });
    // Without `entries` the same config is refused whole.
    expect(parseStoredTeamSetConfig(raw)).toBeNull();

    const notes = leftOutNotes(4, restored.left_out, workshopFields());
    expect(notes).toEqual([
      'Left out of run 4’s setup: the rank rule on "Rank the projects you want to work on".',
      'Left out of run 4’s setup: 1 pin.',
      expect.stringMatching(/^Left out of run 4’s setup: the settings of "[^"]+"\.$/),
      'Back to the default, not the value in run 4’s setup: Fairness.',
    ]);
    expect(leftOutNotes(4, { rules: [], pins: 0, options: [], settings: [] })).toEqual([]);
    // Without the form: no label, still a fact.
    expect(
      leftOutNotes(2, {
        rules: [{ field_id: null, job: null }],
        pins: 2,
        options: [],
        settings: [],
      })
    ).toEqual(['Left out of run 2’s setup: a rule.', 'Left out of run 2’s setup: 2 pins.']);
  });
});
