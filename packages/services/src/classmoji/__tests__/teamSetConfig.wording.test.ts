/**
 * The words a refused team-set patch is explained in (`issueWords`): one case
 * per kind of problem a teacher or an MCP client can cause. The texts are
 * ours, shown on the Teams page and returned by the form_teams tools, so they
 * are pinned exactly.
 */
import { describe, expect, it } from 'vitest';
import {
  applyConfigPatch,
  TeamSetConfigError,
  TeamSetConfigSchema,
  type TeamSetConfigPatchInput,
} from '../teamSetConfig.ts';

const base = () =>
  TeamSetConfigSchema.parse({
    version: 1,
    grouping: { mode: 'free' },
    team_size: { min: 2, max: 4 },
  });

const FIELD = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function problemsOf(patch: unknown): { problems: string[]; paths: string[] } {
  try {
    applyConfigPatch(base(), patch as TeamSetConfigPatchInput);
  } catch (error) {
    if (error instanceof TeamSetConfigError) {
      return { problems: error.problems, paths: error.paths };
    }
    throw error;
  }
  throw new Error('expected the patch to be refused');
}

describe('team-set problem wording', () => {
  it.each([
    ['Fairness: has a value of the wrong kind.', { fairness: 'high' }, 'patch.fairness'],
    ['Time limit: has a value of the wrong kind.', { time_limit_s: 5.5 }, 'patch.time_limit_s'],
    ['Fairness: must be at most 100.', { fairness: 101 }, 'patch.fairness'],
    ['Fairness: must be at least 0.', { fairness: -1 }, 'patch.fairness'],
    ['Team names: is empty.', { team_name_template: '' }, 'patch.team_name_template'],
    [
      'Team names: is longer than 60 characters.',
      { team_name_template: 'x'.repeat(61) },
      'patch.team_name_template',
    ],
    [
      'People who didn’t answer: isn’t one of the allowed values.',
      { non_respondents: 'maybe' },
      'patch.non_respondents',
    ],
    [
      'A rule: has more than 50.',
      { rules: { upsert: Array.from({ length: 51 }, () => ({ field_id: FIELD, job: 'rank' })) } },
      'patch.rules.upsert',
    ],
    [
      'A rule (question): is missing.',
      { rules: { upsert: [{ job: 'rank' }] } },
      'patch.rules.upsert.0.field_id',
    ],
    [
      'The rank rule on a question (question): isn’t in the expected format.',
      { rules: { upsert: [{ field_id: 'not-an-id', job: 'rank' }] } },
      'patch.rules.upsert.0.field_id',
    ],
    [
      'A new pin (kind): isn’t one of the allowed kinds.',
      { pins: { add: [{ kind: 'nope' }] } },
      'patch.pins.add.0.kind',
    ],
    ['The setup: has a setting that isn’t recognized.', { teamsize: 3 }, 'patch.teamsize'],
    // An enum value that is absent or not a string reads as a missing value
    // or one of the wrong kind, not as a value outside the list.
    [
      'A rule (job): is missing.',
      { rules: { upsert: [{ field_id: FIELD, strength: 'prefer' }] } },
      'patch.rules.upsert.0.job',
    ],
    [
      'A rule (job): is missing.',
      { rules: { remove: [{ field_id: FIELD }] } },
      'patch.rules.remove.0.job',
    ],
    [
      'A rule (job): has a value of the wrong kind.',
      { rules: { upsert: [{ field_id: FIELD, job: null }] } },
      'patch.rules.upsert.0.job',
    ],
    [
      'The rank rule on a question (strength): has a value of the wrong kind.',
      { rules: { upsert: [{ field_id: FIELD, job: 'rank', strength: null }] } },
      'patch.rules.upsert.0.strength',
    ],
    [
      'People who didn’t answer: has a value of the wrong kind.',
      { non_respondents: 5 },
      'patch.non_respondents',
    ],
    [
      'Settings of an option (runs): has a value of the wrong kind.',
      { options: { o1: { open: 5 } } },
      'patch.options.o1.open',
    ],
    // A record key that fails its own rule reads as that rule does.
    [
      'The priority rule on a question (what each answer favors): is empty.',
      {
        rules: { upsert: [{ field_id: FIELD, job: 'priority', params: { answers: { '': 'a' } } }] },
      },
      'patch.rules.upsert.0.params.answers.',
    ],
    [
      'The priority rule on a question (what each answer favors): is longer than 64 characters.',
      {
        rules: {
          upsert: [
            { field_id: FIELD, job: 'priority', params: { answers: { ['k'.repeat(65)]: 'a' } } },
          ],
        },
      },
      `patch.rules.upsert.0.params.answers.${'k'.repeat(65)}`,
    ],
  ])('%s', (text, patch, path) => {
    expect(problemsOf(patch)).toEqual({ problems: [text], paths: [path] });
  });
});
