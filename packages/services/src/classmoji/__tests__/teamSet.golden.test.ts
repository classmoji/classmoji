/**
 * Golden team sets on SYNTHETIC cohorts. golden/generate.ts says what each
 * cohort is and how to regenerate the fixtures. Per cohort:
 *
 *   - the generator reproduces the stored inputs exactly, so the JSON was
 *     never edited by hand, and the cohort has the shape generate.ts claims;
 *   - the fields, every response and the config pass the form and config
 *     contracts;
 *   - compile gives the stored problem (sha256 of canonical JSON; the stored
 *     shape shows where it moved), with no check errors and the stored
 *     warnings;
 *   - the stored teams (the engine's answer when the fixture was generated)
 *     reach the stored optimum, stage by stage, with nothing broken, and give
 *     the stored metrics: first choice, top 3, requests kept, must broken 0,
 *     the identity rule's held count, the non-respondent block;
 *   - the local engine proves the same optimum (and each stage's), and the
 *     scorer agrees with the teams it returns.
 *
 * Metrics are pinned on the stored teams, not the live ones: more than one
 * assignment can reach an optimum, and CP-SAT with 2 workers is not
 * assignment-deterministic, so two equally good answers may differ in, say,
 * first choices. The live answer is held to the optimum itself, which is
 * unique, and to the counts no assignment can change.
 *
 * The live part SKIPS without packages/tasks/python/.venv (see
 * packages/tasks/python/README.md); TEAM_SET_CROSSCHECK=required makes a
 * missing Python a failure, as in the tasks crosscheck.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { parseAnswers, parseFormDefinition, type FormField } from '../formContract.ts';
import {
  TeamSetConfigSchema,
  resolveNonRespondents,
  validateConfigAgainstForm,
} from '../teamSetConfig.ts';
import { scoreAssignment } from '../teamSetScore.ts';
import type { TeamSetMetrics } from '../teamSetMetrics.ts';
import {
  GOLDEN_CASES,
  GOLDEN_DIR,
  compileGolden,
  findPython,
  generateInputs,
  goldenMetrics,
  goldenWarnings,
  problemSha256,
  problemShape,
  readGolden,
  solveWithEngine,
  type EngineResult,
  type GoldenName,
} from './golden/generate.ts';

const PYTHON = findPython();
const REQUIRED = process.env.TEAM_SET_CROSSCHECK === 'required';

/**
 * What generate.ts says each cohort is. `setting`: what the config says
 * about the people who didn't answer (null = the default); `mode`: what the
 * runs use (compileProblem's non_respondents).
 */
const SHAPES: Record<
  GoldenName,
  {
    people: number;
    options: number;
    silent: number;
    size: { min: number; max: number };
    setting: 'include' | 'group' | null;
    mode: 'include' | 'group';
  }
> = {
  'projects-24': {
    people: 24,
    options: 8,
    silent: 3,
    size: { min: 4, max: 6 },
    setting: 'include',
    mode: 'include',
  },
  'pairs-27': {
    people: 27,
    options: 20,
    silent: 4,
    size: { min: 2, max: 2 },
    setting: 'include',
    mode: 'include',
  },
  'pairs-27-group': {
    people: 27,
    options: 20,
    silent: 4,
    size: { min: 2, max: 2 },
    setting: 'group',
    mode: 'group',
  },
  'pairs-27-default': {
    people: 27,
    options: 20,
    silent: 4,
    size: { min: 2, max: 2 },
    setting: null,
    mode: 'include',
  },
  'pairs-28-group': {
    people: 28,
    options: 20,
    silent: 5,
    size: { min: 2, max: 2 },
    setting: 'group',
    mode: 'group',
  },
  'free-31': {
    people: 31,
    options: 1,
    silent: 3,
    size: { min: 4, max: 4 },
    setting: 'include',
    mode: 'include',
  },
};

const field = (fields: FormField[], label: string) => fields.find(f => f.label === label)!;

/** Directed partner asks among the responses: who asked, how many asks, how many are mutual. */
function partnerAsks(
  fields: FormField[],
  responses: { user_id: string; answers: Record<string, unknown> }[]
) {
  const partners = field(fields, 'Who would you like to work with?');
  const asks = new Map(
    responses.map(response => [
      response.user_id,
      (response.answers[partners.id] as string[] | undefined) ?? [],
    ])
  );
  let total = 0;
  let mutual = 0;
  for (const [p, targets] of asks) {
    for (const q of targets) {
      total += 1;
      if ((asks.get(q) ?? []).includes(p)) mutual += 1;
    }
  }
  const askers = [...asks.values()].filter(targets => targets.length > 0).length;
  return { askers, total, mutual };
}

describe.each(GOLDEN_CASES)('golden %s (synthetic)', name => {
  const fixture = readGolden(name);
  const { expected, ...stored } = fixture;
  const compiled = compileGolden(fixture);
  const { problem, context } = compiled;

  it('is what the generator draws (regenerate with golden/generate.ts --write, never by hand)', () => {
    expect(stored).toEqual(generateInputs(name));
  });

  it('has the shape generate.ts describes', () => {
    const shape = SHAPES[name];
    expect(problem.people.length).toBe(shape.people);
    expect(problem.options.length).toBe(shape.options);
    expect(fixture.roster.length - fixture.responses.length).toBe(shape.silent);
    expect(compiled.config.team_size).toMatchObject(shape.size);
    expect(compiled.config.non_respondents ?? null).toBe(shape.setting);
    expect(compiled.non_respondents).toBe(shape.mode);
    expect(problem.group?.members.length ?? null).toBe(
      shape.mode === 'group' ? shape.silent : null
    );
    // About 30% of the people who answered ask for someone; about a quarter of the asks are mutual.
    const asks = partnerAsks(fixture.fields, fixture.responses);
    expect(asks.askers / fixture.responses.length).toBeGreaterThanOrEqual(0.25);
    expect(asks.askers / fixture.responses.length).toBeLessThanOrEqual(0.35);
    expect(asks.mutual / asks.total).toBeGreaterThanOrEqual(0.15);
    expect(asks.mutual / asks.total).toBeLessThanOrEqual(0.35);
    // Skewed popularity: the most wanted option is someone's first pick at
    // least twice as often as it would be if picks were even (grouped cohorts).
    const ranked = fixture.fields.find(f => f.type === 'ranked_choice');
    if (ranked) {
      const firsts = new Map<string, number>();
      for (const response of fixture.responses) {
        const first = (response.answers[ranked.id] as string[])[0]!;
        firsts.set(first, (firsts.get(first) ?? 0) + 1);
      }
      expect(Math.max(...firsts.values())).toBeGreaterThanOrEqual(
        (2 * fixture.responses.length) / shape.options
      );
    } else {
      expect(compiled.config.grouping.mode).toBe('free');
    }
    // Invented people only.
    for (const f of fixture.fields.filter(f => f.type === 'roster_select')) {
      for (const option of f.options as { label: string }[]) {
        expect(option.label).toMatch(/^Student \d+$/);
      }
    }
  });

  if (name === 'free-31') {
    it('free teams of exactly 4 take the remainder flex: 7 teams of 4 and 1 of 3', () => {
      expect(problem.size).toEqual({ min: 4, max: 4, larger: 0, smaller: 1 });
      expect(problem.version).toBe(2);
      expect(expected.teams.map(team => team.members.length).sort()).toEqual([
        3, 4, 4, 4, 4, 4, 4, 4,
      ]);
      expect(problem.hard.some(h => h.kind === 'forbid_pair')).toBe(true);
    });
  }

  if (name === 'pairs-27-default') {
    it('left at the default, Group would leave the others too few teams: the runs spread them', () => {
      // Pairs resolve to Group by default; grouped, the 4 who didn't answer
      // take 2 of the 9 teams and 23 people can't fit 7.
      expect(resolveNonRespondents(compiled.config)).toBe('group');
      expect(compiled.non_respondents).toBe('include');
      expect(problem).not.toHaveProperty('group');
      expect(problem.team_count).toEqual({ min: 1, max: 9 });
      expect(problem.size).toEqual({ min: 2, max: 2, larger: 9 });
      expect(problem.soft_counts.some(entry => entry.src === 'non_respondents')).toBe(true);
      expect(expected.teams.map(team => team.members.length)).toEqual(Array(9).fill(3));
    });
  }

  if (name === 'pairs-28-group') {
    it('each population takes its own team of 3', () => {
      // 23 who answered: 10 pairs and a trio; 5 who didn't: a pair and a trio.
      expect(problem.size).toEqual({ min: 2, max: 2, larger: 1 });
      expect(problem.group).toMatchObject({ larger: 1, smaller: 0 });
      const inGroup = new Set(problem.group!.members);
      const sizes = (grouped: boolean) =>
        expected.teams
          .filter(team => team.members.every(p => inGroup.has(p)) === grouped)
          .map(team => team.members.length)
          .sort();
      expect(sizes(false)).toEqual([...Array(10).fill(2), 3]);
      expect(sizes(true)).toEqual([2, 3]);
    });
  }

  if (name === 'projects-24') {
    it('carries the Project bidding and Gender rules', () => {
      // Three pitchers, three projects that run only with one of them on it.
      expect(problem.hard.filter(h => h.kind === 'owner_if_open')).toHaveLength(3);
      // "What matters more to you?" shifts rank against together per person.
      expect(context.people.some(person => (person.priority ?? []).length > 0)).toBe(true);
      expect(problem.balance).toHaveLength(1);
      // The identity rule protects a small minority, one of them the only one
      // who gave their answer (the single-answer warning).
      const identity = context.rules.find(rule => rule.identity);
      expect(identity).toMatchObject({
        job: 'no_one_alone',
        strength: 'prefer',
        single_answers: 1,
      });
      expect(expected.metrics.rules).toEqual([
        expect.objectContaining({ rule_id: identity!.id, identity: true }),
      ]);
      expect(expected.warnings).toContain('identity_single_answer');
      expect(expected.metrics.avoids.total).toBe(2);
    });
  }

  it('passes the form and config contracts', () => {
    expect(parseFormDefinition(fixture.fields).fields).toEqual(fixture.fields);
    for (const response of fixture.responses) {
      expect(() => parseAnswers(fixture.fields, response.answers)).not.toThrow();
    }
    expect(TeamSetConfigSchema.parse(fixture.config)).toEqual(fixture.config);
    expect(validateConfigAgainstForm(compiled.config, fixture.fields)).toEqual([]);
  });

  it('compiles to the stored problem', () => {
    expect(problemShape(problem)).toEqual(expected.problem_shape);
    expect(problemSha256(problem)).toBe(expected.problem_sha256);
  });

  it('has no check errors and the stored warnings', () => {
    expect(goldenWarnings(fixture, compiled)).toEqual(expected.warnings);
  });

  it('the stored teams reach the stored optimum, stage by stage, with nothing broken', () => {
    const score = scoreAssignment(problem, expected.teams);
    expect(score.violations).toEqual([]);
    expect(score.objective).toBe(expected.objective);
    expect(score.parts).toEqual(expected.stages ?? { first: expected.objective, second: 0 });
    expect(expected.stages !== null).toBe(problem.group !== undefined);
  });

  it('the stored teams give the stored metrics', () => {
    const metrics = goldenMetrics(compiled, expected.teams);
    expect(metrics).toEqual(expected.metrics);
    expect(metrics.must_broken).toBe(0);
    expect(metrics.people).toBe(problem.people.length);
    expect(expected.teams.flatMap(team => team.members)).toHaveLength(problem.people.length);
    expect(metrics.non_respondents).toMatchObject({
      mode: SHAPES[name].mode,
      people: SHAPES[name].silent,
      grouped: SHAPES[name].mode === 'group' ? SHAPES[name].silent : 0,
    });
  });
});

/** Metric counts fixed by the inputs, whichever optimal assignment the engine picks. */
const fixedCounts = (metrics: TeamSetMetrics) => ({
  people: metrics.people,
  responded: metrics.responded,
  no_answer: metrics.placement.no_answer,
  requests: metrics.requests.total,
  mutual_pairs: metrics.requests.mutual_pairs,
  avoids: metrics.avoids.total,
  must_broken: metrics.must_broken,
  non_respondents: metrics.non_respondents && {
    mode: metrics.non_respondents.mode,
    people: metrics.non_respondents.people,
    grouped: metrics.non_respondents.grouped,
  },
});

describe.skipIf(!PYTHON)('golden: the local engine proves each stored optimum', () => {
  const outputs = new Map<GoldenName, EngineResult>();

  beforeAll(async () => {
    const results = await Promise.all(
      GOLDEN_CASES.map(name => solveWithEngine(PYTHON!, compileGolden(readGolden(name)).problem))
    );
    GOLDEN_CASES.forEach((name, i) => outputs.set(name, results[i]!));
  }, 300_000);

  it.each(GOLDEN_CASES)('%s: OPTIMAL at the stored objective; the scorer agrees', name => {
    const fixture = readGolden(name);
    const { expected } = fixture;
    const compiled = compileGolden(fixture);
    const output = outputs.get(name)!;

    expect(output.status).toBe('OPTIMAL');
    expect(output.objective).toBe(expected.objective);
    const score = scoreAssignment(compiled.problem, output.teams);
    expect(score.violations).toEqual([]);
    expect(score.objective).toBe(output.objective);
    if (expected.stages) {
      expect(output.stages?.first).toMatchObject({
        status: 'OPTIMAL',
        objective: expected.stages.first,
      });
      expect(output.stages?.second).toMatchObject({
        status: 'OPTIMAL',
        objective: expected.stages.second,
      });
      expect(score.parts).toEqual(expected.stages);
    } else {
      expect(output.stages).toBeUndefined();
      expect(score.parts).toEqual({ first: expected.objective, second: 0 });
    }
    expect(fixedCounts(goldenMetrics(compiled, output.teams))).toEqual(
      fixedCounts(expected.metrics)
    );
  });
});

// Registered only without Python, so the reason shows up among the skipped tests.
if (!PYTHON) {
  describe('golden: the local engine', () => {
    it.skipIf(!REQUIRED)(
      'SKIPPED: no python with OR-Tools at packages/tasks/python/.venv or PYTHON_BIN_PATH (see packages/tasks/python/README.md)',
      () => {
        expect.fail(
          'TEAM_SET_CROSSCHECK=required, and there is no python with OR-Tools at packages/tasks/python/.venv or PYTHON_BIN_PATH'
        );
      }
    );
  });
}

describe('golden fixtures are synthetic', () => {
  const files = readdirSync(GOLDEN_DIR).filter(file => /\.(json|ts)$/.test(file));

  it('finds every cohort file and the generator', () => {
    expect(files.sort()).toEqual(
      [...GOLDEN_CASES.map(name => `${name}.json`), 'generate.ts'].sort()
    );
  });

  it.each([
    ['a course code', /\bcs\s?\d{2,3}\b/i],
    ['a school name', /dartmouth/i],
    // Case-sensitive, so lowercase hex in the ids can't match.
    ['a term code', /\b\d{2}[FWSX]\b/],
    ['a term', /\b(fall|winter|spring|summer)\s+\d{4}\b/i],
  ])('no file names %s', (_what, pattern) => {
    for (const file of files) {
      const text = readFileSync(join(GOLDEN_DIR, file), 'utf8');
      expect(text.match(pattern)?.[0], `${file} matches ${pattern}`).toBeUndefined();
    }
  });
});
