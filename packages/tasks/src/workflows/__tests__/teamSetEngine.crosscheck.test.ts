/**
 * Cross-check: the Python CP-SAT engine and the TypeScript scorer must agree.
 *
 * `completeRun` rescores every assignment the engine returns with
 * `scoreAssignment` and FAILS the run (`score_mismatch`) on any difference, so
 * a single term the two sides compute differently — a balance product, a
 * soft count on an empty slot, the worst-off max — would turn every run that
 * touches it into a failure in production. This test runs the real script on
 * seeded random problems and asserts, for each:
 *
 *   - the engine's reported objective === scoreAssignment(problem, teams).objective
 *   - scoreAssignment reports no violations (hard, structural, unassigned)
 *   - a two-stage (group) answer's `stages` match the scorer's `parts`
 *     (parts.first = stages.first.objective, parts.second =
 *     stages.second.objective), and a problem without a group gets no `stages`
 *
 * Generators:
 *   - COMPILED problems: synthetic forms, responses and configs through the
 *     service's own `compileProblem`, so the IR production actually produces
 *     is what the engine is checked on — rank + fairness/worst_off, fallback
 *     categories (both also at Must, with per-student `@p` srcs), owner
 *     bonuses (and the owner rule at Must, `owner_if_open`), together/apart
 *     (prefer and must, with per-pair `@p+q` srcs), match with
 *     wildcards and multiselect overlap, mix, balance, no_one_alone on a switch
 *     and on a multiselect (a person counts toward every answer they tick),
 *     a priority rule (per-person multipliers on the rank/match and together
 *     terms), pins of every kind, forced-open and closed options, per-option
 *     team sizes (IR version 2), free mode, teams_per_option 2, exact team
 *     sizes whose remainder takes the flex (size.larger / size.smaller, and
 *     the group's own group.larger / group.smaller), and non-respondents
 *     included, excluded and GROUPED (two stages, some with an exact team
 *     count). Seeds whose `runChecks`
 *     has an error are skipped exactly as `startRun` would skip them; an
 *     INFEASIBLE answer is allowed (random musts can collide) but its core must
 *     name real srcs. At least 30 must solve and agree.
 *   - PLANTED problems built directly in the IR: a valid assignment is drawn
 *     first and every hard constraint derived from it, so each is feasible by
 *     construction and must solve — covering all six hard kinds (incl. a hard
 *     team_count and owner_if_open), per-option sizes, a team one larger or
 *     one smaller than its size, and edge terms (negative place bonuses)
 *     across the seeds.
 *   - The engine's own FIXTURES (python/fixtures/*.json, synthetic), whatever
 *     they expect: solved ones must agree, infeasible ones name real srcs.
 *
 * Two stages. For every group problem, the stage-1 objective must be what
 * the engine gets solving the respondents alone: the IR with the group's
 * members removed and the team count reserved for them exactly as
 * python/README.md "Reservation" says (`stageOneProblem`). Objectives are
 * compared when both solves are proven OPTIMAL (CP-SAT with 2 workers is not
 * assignment-deterministic); whether each finds an answer must always agree.
 *
 * Plus deliberately infeasible problems whose cores must name their srcs and
 * only them — one hand-built, two compiled whose cores are per-student srcs
 * (`<rule>@p`, `<rule>@p+q`) — and a hand-computed balance case
 * (weight × |Σ c_m| per open team). Every answer must also carry the result
 * line's engine, stats and core_status.
 *
 * SKIPPED unless a Python with OR-Tools is available: `python/.venv/bin/python`
 * (see python/README.md) or `PYTHON_BIN_PATH`. With TEAM_SET_CROSSCHECK=required
 * a missing Python is a failure instead (for CI and pre-merge runs, where a
 * silent skip would read as a pass). The script is spawned through
 * child_process — this test does not import the Trigger task.
 *
 * Every person here is an invented uuid; the only labels are "Student N".
 */
import { execFile, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';

import {
  parseSolverOutput,
  TEAM_SET_SOLVER_WORKERS,
  type SolverOutput,
  type SolverStages,
} from '../../helpers/teamSetEngine.ts';
// The pure team-set modules through their one-file subpaths: the root barrel
// would pull Prisma and Octokit into a test that needs neither.
import type { FormField } from '@classmoji/services/form-contract';
import {
  TeamSetConfigSchema,
  validateConfigAgainstForm,
  type TeamSetConfigInput,
} from '@classmoji/services/team-set-config'; // eslint-disable-line import/no-unresolved
import {
  compileProblem,
  type TeamSetHard,
  type TeamSetProblem,
  type TeamSetSolveStages,
} from '@classmoji/services/team-set-problem'; // eslint-disable-line import/no-unresolved
import { runChecks } from '@classmoji/services/team-set-checks'; // eslint-disable-line import/no-unresolved
import { scoreAssignment } from '@classmoji/services/team-set-score'; // eslint-disable-line import/no-unresolved

// ─── Environment ────────────────────────────────────────────────────────────

const TASKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(TASKS_DIR, 'python', 'team_set_solver.py');
const FIXTURES_DIR = join(TASKS_DIR, 'python', 'fixtures');

function findPython(): string | null {
  const candidates = [
    join(TASKS_DIR, 'python', '.venv', 'bin', 'python'),
    process.env.PYTHON_BIN_PATH,
  ];
  for (const bin of candidates) {
    if (!bin || !existsSync(bin)) continue;
    const probe = spawnSync(bin, ['-c', 'import ortools'], { timeout: 60_000 });
    if (probe.status === 0) return bin;
  }
  return null;
}

const PYTHON = existsSync(SCRIPT) ? findPython() : null;
const REQUIRED = process.env.TEAM_SET_CROSSCHECK === 'required';
/** Small problems; the solver proves most optimal in well under a second. */
const TIME_LIMIT_S = 5;
const CONCURRENCY = 3;

const workDir = mkdtempSync(join(tmpdir(), 'team-set-crosscheck-'));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

function solve(problem: TeamSetProblem, name: string): Promise<SolverOutput> {
  const file = join(workDir, `${name}.json`);
  writeFileSync(file, JSON.stringify(problem));
  return new Promise((done, fail) => {
    execFile(
      PYTHON as string,
      [SCRIPT, file, '--workers', String(TEAM_SET_SOLVER_WORKERS)],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          fail(new Error(`solver failed on ${name}: ${error.message}\n${stderr.slice(-2000)}`));
          return;
        }
        try {
          done(parseSolverOutput(stdout, problem));
        } catch (parseError) {
          fail(parseError);
        }
      }
    );
  });
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ─── Seeded randomness ──────────────────────────────────────────────────────

/** mulberry32 — tiny, seedable, good enough for fixtures. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)]!;
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const chance = (p: number) => next() < p;
  const subset = <T>(items: readonly T[], lo: number, hi: number): T[] =>
    shuffle(items).slice(0, int(lo, Math.min(hi, items.length)));
  return { int, pick, shuffle, chance, subset };
}

type Rng = ReturnType<typeof rng>;

const solved = (output: SolverOutput | undefined): output is SolverOutput =>
  output?.status === 'OPTIMAL' || output?.status === 'FEASIBLE';

// ─── Assertions shared by every solved case ─────────────────────────────────

/** The result line's diagnostic fields, which the service records. */
function expectResultFields(problem: TeamSetProblem, output: SolverOutput) {
  expect(output.engine).toMatch(/^cpsat@\d+\.\d+/);
  expect(output.stats).toMatchObject({
    people: problem.people.length,
    slots: problem.slots.length,
  });
  expect(output.core_status).toBe(output.status === 'INFEASIBLE' ? 'complete' : 'n/a');
  // parseSolverOutput already refuses the wrong one; this keeps the test honest.
  expect(output.stages !== undefined).toBe(problem.group !== undefined);
}

/**
 * The engine's objective, and a group problem's per-stage objectives, are
 * exactly what the TypeScript scorer computes for the teams it returned.
 */
function expectAgreement(problem: TeamSetProblem, output: SolverOutput) {
  expect(['OPTIMAL', 'FEASIBLE']).toContain(output.status);
  expectResultFields(problem, output);
  const score = scoreAssignment(problem, output.teams);
  expect(score.violations).toEqual([]);
  expect(output.objective).not.toBeNull();
  expect(score.objective).toBe(output.objective);
  expect(score.parts.first + score.parts.second).toBe(score.objective);
  if (problem.group) {
    const stages = output.stages!;
    expect(stages.second).not.toBeNull();
    expect(score.parts).toEqual({
      first: stages.first.objective,
      second: stages.second!.objective,
    });
  } else {
    expect(score.parts).toEqual({ first: score.objective, second: 0 });
  }
  return score;
}

/**
 * A core names only srcs the problem has: a hard constraint's src (per-student
 * `@` srcs included), `option:<id>` for an option forced open, `size:<id>` for
 * an option with its own size, or the group's src (stage 2 found no room, or
 * the team count reserved for it is what stage 1 couldn't meet). An EMPTY core
 * is allowed only where the caller says the structure itself may not fit.
 */
function expectCoreIsReal(
  problem: TeamSetProblem,
  output: SolverOutput,
  { structural = false }: { structural?: boolean } = {}
) {
  expectResultFields(problem, output);
  expect(output.status).toBe('INFEASIBLE');
  if (!structural) expect(output.core.length).toBeGreaterThan(0);
  const srcs = new Set([
    ...problem.hard.map(h => h.src),
    ...problem.options.filter(o => o.open === 'open').map(o => `option:${o.id}`),
    ...problem.options.filter(o => o.size).map(o => `size:${o.id}`),
    ...(problem.group ? [problem.group.src] : []),
  ]);
  for (const src of output.core) expect(srcs.has(src)).toBe(true);
}

// ─── Two stages: the respondents alone ──────────────────────────────────────

/**
 * [k2_min, k2_max]: how many teams the group's members need in stage 2 —
 * python/README.md "Reservation", the engine's `group_team_counts`. Eligible
 * options have a non-null option_cost; gmax / gmin = the largest max and the
 * smallest min of their sizes (own size, else the set's); L / S = the group's
 * own caps. k2_min = max(ceil(G / (gmax + 1)), ceil((G − L) / gmax)), k2_max
 * = floor((G + S) / gmin). Both 0 when the group is empty or no option is
 * eligible.
 */
function groupTeamCounts(problem: TeamSetProblem): [number, number] {
  const group = problem.group!;
  const sizes = problem.options.flatMap((option, o) =>
    group.option_cost[o] === null || group.option_cost[o] === undefined
      ? []
      : [option.size ?? problem.size]
  );
  const G = new Set(group.members).size;
  if (G === 0 || sizes.length === 0) return [0, 0];
  const gmax = Math.max(...sizes.map(size => size.max));
  const gmin = Math.min(...sizes.map(size => size.min));
  const larger = group.larger ?? 0;
  const smaller = group.smaller ?? 0;
  return [
    Math.max(Math.ceil(G / (gmax + 1)), Math.ceil((G - larger) / gmax)),
    Math.floor((G + smaller) / gmin),
  ];
}

/**
 * Stage 1 of a group problem as a problem of its own: everyone NOT in the
 * group, on every slot, with every term restricted to them (a pair or place
 * entry naming a member is dropped; a count or balance entry keeps its other
 * people; an owner_if_open keeps only pitchers outside the group, even if that
 * leaves none), the worst-off weight and the size caps (stage 1's,
 * size.larger / size.smaller) as they are, and the team count reserved for
 * stage 2: [max(0, min − k2_max), max − k2_min]. Built from
 * the README, apart from the engine's own `_stage_raw`. `null` when the
 * reserved range is empty (stage 1 must then be INFEASIBLE).
 */
function stageOneProblem(problem: TeamSetProblem): TeamSetProblem | null {
  const inGroup = new Set(problem.group!.members);
  const keep = problem.people.map((_, p) => p).filter(p => !inGroup.has(p));
  const at = new Map(keep.map((p, i) => [p, i]));
  const kept = (p: number) => at.has(p);
  const idx = (p: number) => at.get(p)!;
  const hard = problem.hard.flatMap((h): TeamSetHard[] => {
    switch (h.kind) {
      case 'forbid_place':
      case 'require_place':
        return kept(h.p) ? [{ ...h, p: idx(h.p) }] : [];
      case 'forbid_pair':
      case 'require_pair':
        return kept(h.p) && kept(h.q) ? [{ ...h, p: idx(h.p), q: idx(h.q) }] : [];
      case 'owner_if_open':
        return [{ ...h, members: h.members.filter(kept).map(idx) }];
      case 'team_count': {
        const members = h.members.filter(kept).map(idx);
        return members.length ? [{ ...h, members }] : [];
      }
    }
  });
  const [k2min, k2max] = groupTeamCounts(problem);
  const teamCount = {
    min: Math.max(0, problem.team_count.min - k2max),
    max: problem.team_count.max - k2min,
  };
  if (teamCount.max < teamCount.min) return null;
  const { group: _group, ...rest } = problem;
  return {
    ...rest,
    version: problem.options.some(option => option.size) || problem.size.smaller ? 2 : 1,
    people: keep.map(p => problem.people[p]!),
    team_count: teamCount,
    place: problem.place.filter(e => kept(e.p)).map(e => ({ ...e, p: idx(e.p) })),
    pair: problem.pair
      .filter(e => kept(e.p) && kept(e.q))
      .map(e => ({ ...e, p: idx(e.p), q: idx(e.q) })),
    hard,
    soft_counts: problem.soft_counts.flatMap(e => {
      const members = e.members.filter(kept).map(idx);
      return members.length ? [{ ...e, members }] : [];
    }),
    balance: problem.balance.map(e => ({ ...e, values: keep.map(p => e.values[p]!) })),
  };
}

interface StageOne {
  problem: TeamSetProblem | null;
  output: SolverOutput | null;
}

/** Solve stage 1 alone for a group problem the engine answered with a stage 1. */
async function solveStageOne(problem: TeamSetProblem, name: string): Promise<StageOne> {
  const alone = stageOneProblem(problem);
  return { problem: alone, output: alone ? await solve(alone, `${name}-stage1`) : null };
}

/**
 * The engine's stage 1 is the respondents solved alone: both find an answer or
 * neither does, and when both are proven OPTIMAL their objectives are equal.
 * Returns whether the objectives were compared.
 */
function expectStageOne(stages: SolverStages, alone: StageOne): boolean {
  const { first } = stages;
  if (!alone.problem || !alone.output) {
    expect(first.status).toBe('INFEASIBLE');
    return false;
  }
  expect(solved(alone.output)).toBe(first.status === 'OPTIMAL' || first.status === 'FEASIBLE');
  if (!solved(alone.output)) return false;
  expectAgreement(alone.problem, alone.output);
  if (first.status !== 'OPTIMAL' || alone.output.status !== 'OPTIMAL') return false;
  expect(alone.output.objective).toBe(first.objective);
  return true;
}

// ─── Compiled problems (synthetic form → compileProblem) ────────────────────

interface Compiled {
  problem: TeamSetProblem;
  /** Why `startRun` would refuse it (runChecks error codes); empty = solvable. */
  blocked: string[];
  /** The priority rule is on and changed at least one coefficient. */
  priorityChanged: boolean;
  /** A multiselect no_one_alone put someone in two of its groups. */
  multiselectOverlap: boolean;
  /** The config asked for an exact team count. */
  exactCount: boolean;
}

function field(type: string, extra: Record<string, unknown>): FormField {
  return {
    id: randomUUID(),
    type,
    label: `Question ${type}`,
    required: false,
    ...extra,
  } as FormField;
}

const option = (label: string) => ({ id: randomUUID(), label });

/** The coefficients and constraints the solver sees (what a priority rule may change). */
const terms = (problem: TeamSetProblem) =>
  JSON.stringify([problem.place, problem.pair, problem.hard, problem.soft_counts]);

function compiledProblem(seed: number): Compiled {
  const r: Rng = rng(seed);
  // Draws for the features added with IR version 2 come from their own stream,
  // so the rest of each seed's problem is drawn as it always was.
  const x: Rng = rng(seed + 100_000);
  const free = seed % 4 === 3;
  const perOption = !free && seed % 2 === 0 ? 2 : 1;
  const grouped = seed % 5 === 2; // non_respondents 'group': two stages
  const sized = !free && seed % 3 === 0; // per-option team sizes
  const ownerMust = !free && seed % 7 === 3; // owner rule at Must: owner_if_open
  const withPriority = seed % 6 === 5;
  const aloneMust = seed % 9 === 4; // the multiselect no_one_alone at Must
  const exactCount = grouped && seed % 2 === 1;
  const rankMust = !free && seed % 8 === 6; // per-student srcs: `<rank rule>@p`
  const fallbackMust = !free && seed % 8 === 2; // `<fallback rule>@p`
  // Exact team sizes: a count they don't divide takes the remainder flex —
  // 14 in 3s: four of 3 and one of 2 (smaller); 4s at the drawn count, one
  // or more teams of 5 (larger).
  const exact = seed % 6 === 1;
  const drawnN = r.int(10, 18);
  const drawnMin = r.int(2, 3);
  const threes = exact && seed % 12 === 1;
  const N = threes ? 14 : drawnN;
  const min = exact ? (threes ? 3 : 4) : drawnMin;
  const max = exact ? min : min + r.int(1, 2);

  const roster = Array.from({ length: N }, () => ({ user_id: randomUUID() }));
  const people = roster.map((member, i) => ({ id: member.user_id, label: `Student ${i + 1}` }));
  // Enough options that the set always fits even with one closed.
  const O = Math.max(r.int(3, 6), Math.ceil(N / (max * perOption)) + 1);
  const projects = Array.from({ length: O }, (_, i) => option(`Project ${i + 1}`));
  const categories = ['Web', 'Data', 'Games'].map(option);
  const timing = ['Mornings', 'Evenings', 'Either'].map(option);
  const languages = ['Python', 'JavaScript', 'C'].map(option);
  const roles = ['Design', 'Build', 'Test'].map(option);
  const matters = ['The project', 'The people', 'Both equally'].map(option);

  const rankF = field('ranked_choice', { options: projects, ranks: Math.min(3, O) });
  const fallbackF = field('multiselect', { options: categories });
  const ownerF = field('dropdown', { options: projects });
  const togetherF = field('roster_select', {
    optionSource: 'roster',
    multiple: true,
    options: people,
  });
  const apartF = field('roster_select', {
    optionSource: 'roster',
    multiple: false,
    options: people,
  });
  const timingF = field('dropdown', { options: timing });
  const languageF = field('multiselect', { options: languages });
  const experienceF = field('opinion_scale', { scale: { min: 1, max: 5 } });
  const switchF = field('switch', {});
  const roleF = field('dropdown', { options: roles });
  const noteF = field('short_text', {});
  const mattersF = field('dropdown', { options: matters });
  const fields = [
    rankF,
    fallbackF,
    ownerF,
    togetherF,
    apartF,
    timingF,
    languageF,
    experienceF,
    switchF,
    roleF,
    noteF,
    mattersF,
  ];

  const ids = (items: { id: string }[]) => items.map(item => item.id);
  // Grouped seeds need enough people who didn't answer to fill a team.
  const responseRate = grouped ? 0.6 : 0.85;
  const responses = roster
    .filter(() => r.chance(responseRate))
    .map(member => {
      const others = roster.filter(other => other !== member).map(other => other.user_id);
      const answers: Record<string, unknown> = {
        [rankF.id]: ids(r.subset(projects, 0, Math.min(3, O))),
        [fallbackF.id]: ids(r.subset(categories, 0, 2)),
        [togetherF.id]: r.subset(others, 0, 2),
        [timingF.id]: r.pick(timing).id,
        [languageF.id]: ids(r.subset(languages, 1, 2)),
        [experienceF.id]: r.int(1, 5),
        [switchF.id]: r.chance(0.3),
        [roleF.id]: r.pick(roles).id,
        [noteF.id]: 'invented note',
      };
      if (r.chance(0.2)) answers[ownerF.id] = r.pick(projects).id;
      if (r.chance(0.2)) answers[apartF.id] = r.pick(others);
      if (x.chance(0.8)) answers[mattersF.id] = x.pick(matters).id;
      return { response_id: randomUUID(), user_id: member.user_id, answers };
    });

  const weight = () => r.int(1, 10);
  const rules: NonNullable<TeamSetConfigInput['rules']> = [
    {
      field_id: togetherF.id,
      job: 'together',
      strength: r.chance(0.3) ? 'must' : 'prefer',
      weight: weight(),
    },
    {
      field_id: apartF.id,
      job: 'apart',
      strength: r.chance(0.5) ? 'must' : 'prefer',
      weight: weight(),
    },
    {
      field_id: timingF.id,
      job: 'match',
      strength: 'prefer',
      weight: weight(),
      params: { wildcard_option_ids: [timing[2]!.id] },
    },
    { field_id: languageF.id, job: 'match', strength: 'prefer', weight: weight() },
    { field_id: experienceF.id, job: 'balance', strength: 'prefer', weight: weight() },
    { field_id: experienceF.id, job: 'mix', strength: 'prefer', weight: weight() },
    { field_id: roleF.id, job: 'mix', strength: 'prefer', weight: weight() },
    {
      field_id: switchF.id,
      job: 'no_one_alone',
      strength: r.chance(0.3) ? 'must' : 'prefer',
      weight: weight(),
    },
    { field_id: noteF.id, job: 'note', strength: 'prefer', weight: 1 },
    // A multiselect answer counts toward every answer it ticks.
    {
      field_id: languageF.id,
      job: 'no_one_alone',
      strength: aloneMust ? 'must' : 'prefer',
      weight: x.int(1, 10),
    },
  ];
  const options: NonNullable<TeamSetConfigInput['options']> = {};
  const pins: NonNullable<TeamSetConfigInput['pins']> = [];
  const [a, b, c, d, e, f] = r.shuffle(roster.map(member => member.user_id));
  pins.push({ id: 'p1', kind: 'together', user_ids: [a!, b!] });
  pins.push({ id: 'p2', kind: 'apart', user_ids: [c!, d!] });

  if (!free) {
    rules.push(
      {
        field_id: rankF.id,
        job: 'rank',
        strength: rankMust ? 'must' : 'prefer',
        weight: r.int(5, 10),
        ...(rankMust ? { params: { must_top: x.int(2, Math.min(3, O)) } } : {}),
      },
      {
        field_id: fallbackF.id,
        job: 'fallback',
        strength: fallbackMust ? 'must' : 'prefer',
        weight: 5,
      },
      {
        field_id: ownerF.id,
        job: 'owner',
        strength: ownerMust ? 'must' : 'prefer',
        weight: r.int(5, 10),
      }
    );
    options[projects[0]!.id] = { category: 'Web' };
    options[projects[1]!.id] = { category: 'Data', open: r.chance(0.5) ? 'open' : 'auto' };
    options[projects[2]!.id] = { category: 'Games' };
    if ((O - 1) * perOption * max >= N + max && r.chance(0.5)) {
      options[projects[O - 1]!.id] = { open: 'closed' };
    }
    pins.push({ id: 'p3', kind: 'on_option', user_id: e!, option_id: projects[1]!.id });
    pins.push({ id: 'p4', kind: 'not_options', user_id: f!, option_ids: [projects[0]!.id] });
  }
  if (sized) {
    // One or two options with their own size: wider, narrower or shifted.
    const variants = [
      { max: max + 1 },
      { min: Math.max(1, min - 1) },
      { min: min + 1 },
      { min: max, max: max + 1 },
    ];
    for (const o of x.subset(
      Array.from({ length: O - 1 }, (_, i) => i),
      1,
      2
    )) {
      const id = projects[o]!.id;
      options[id] = { ...options[id], size: x.pick(variants) };
    }
  }
  if (withPriority) {
    rules.push({
      field_id: mattersF.id,
      job: 'priority',
      strength: 'prefer',
      weight: 5,
      params: {
        rule_a: free ? `${timingF.id}:match` : `${rankF.id}:rank`,
        rule_b: `${togetherF.id}:together`,
        answers: { [matters[0]!.id]: 'a', [matters[1]!.id]: 'b', [matters[2]!.id]: 'none' },
        shift: x.int(1, 9) * 10,
      },
    });
  }

  const configInput = {
    version: 1,
    grouping: free
      ? { mode: 'free' }
      : { mode: 'by_option', field_id: rankF.id, teams_per_option: perOption },
    team_size: { min, max },
    team_count: seed % 5 === 4 ? { max: Math.ceil(N / min) } : {},
    options,
    rules,
    non_respondents: grouped ? 'group' : seed % 5 === 0 ? 'exclude' : 'include',
    fairness: r.int(0, 100),
    pins,
    time_limit_s: TIME_LIMIT_S,
  } satisfies TeamSetConfigInput;
  const compile = (input: TeamSetConfigInput) => {
    const config = TeamSetConfigSchema.parse(input);
    // The generator's own contract: a config the service would accept.
    const configProblems = validateConfigAgainstForm(config, fields);
    if (configProblems.length)
      throw new Error(`seed ${seed}: invalid config: ${configProblems.join('; ')}`);
    const compiled = compileProblem({
      setName: `crosscheck-${seed}`,
      config,
      fields,
      responses,
      roster,
      seed,
    });
    return { config, ...compiled };
  };

  let { config, problem, context } = compile(configInput);
  if (exactCount && problem.group) {
    // An exact team count: teams of the set's max for the respondents, then
    // for the group — the case where stage 1 must leave teams for stage 2.
    const G = problem.group.members.length;
    const R = problem.people.length - G;
    const k1 = Math.ceil(R / max);
    const k2 = Math.ceil(G / max);
    const k = k1 + k2;
    if (k1 * min <= R && k2 * min <= G && k <= problem.slots.length) {
      ({ config, problem, context } = compile({
        ...configInput,
        team_count: { min: k, max: k },
      }));
    }
  }

  let priorityChanged = false;
  if (withPriority) {
    const off = compile({
      ...configInput,
      team_count: config.team_count,
      rules: rules.map(rule =>
        rule.job === 'priority' ? { ...rule, strength: 'off' as const } : rule
      ),
    });
    priorityChanged = terms(off.problem) !== terms(problem);
  }

  const aloneSrc = `${languageF.id}:no_one_alone`;
  const aloneGroups = [...problem.soft_counts, ...problem.hard].flatMap(entry =>
    entry.src === aloneSrc && 'members' in entry ? [entry.members] : []
  );
  const seen = new Set<number>();
  let multiselectOverlap = false;
  for (const members of aloneGroups) {
    for (const p of members) {
      if (seen.has(p)) multiselectOverlap = true;
      seen.add(p);
    }
  }

  const blocked = runChecks(problem, context, { config, fields })
    .filter(issue => issue.level === 'error')
    .map(issue => issue.code);
  return {
    problem,
    blocked,
    priorityChanged,
    multiselectOverlap,
    exactCount: config.team_count.min !== undefined,
  };
}

// ─── Planted problems (IR built around a known-valid assignment) ────────────

interface Planted {
  problem: TeamSetProblem;
  teams: { slot: number; members: number[] }[];
}

/**
 * Draw team sizes, slots and members FIRST, then build a problem the drawn
 * assignment satisfies. Feature flags rotate with the seed so every IR term is
 * covered across the suite, not left to chance.
 */
function plantedProblem(seed: number): Planted {
  const r: Rng = rng(seed);
  // Version-2 draws (own sizes, owner_if_open) come from their own stream, so
  // the rest of each seed's problem is drawn as it always was.
  const x: Rng = rng(seed + 100_000);
  const free = seed % 3 === 0;
  const perOption = !free && seed % 2 === 0 ? 2 : 1;
  const larger = seed % 4 === 1 ? 1 : 0;
  const sized = !free && seed % 3 === 2;
  const withOwner = !free && seed % 4 === 2;

  const min = r.int(2, 3);
  const max = min + r.int(1, 2);
  const k = r.int(3, 5);
  const sizes = Array.from({ length: k }, () => r.int(min, max));
  if (larger) sizes[r.int(0, k - 1)] = max + 1;
  // A team one under its min (never below 2); drawn from the version-2 stream.
  const smaller = seed % 4 === 3 && min - 1 >= 2 ? 1 : 0;
  if (smaller) sizes[x.int(0, k - 1)] = min - 1;
  const N = sizes.reduce((sum, size) => sum + size, 0);

  let options: TeamSetProblem['options'];
  let slots: TeamSetProblem['slots'];
  const closed = new Set<number>();
  if (free) {
    options = [{ id: '__free__', open: 'auto' }];
    slots = Array.from({ length: Math.ceil(N / min) }, () => ({ option: 0 }));
  } else {
    const closedCount = r.chance(0.5) ? 1 : 0;
    const count = Math.max(r.int(3, 5), Math.ceil(k / perOption) + closedCount);
    options = Array.from({ length: count }, () => ({ id: randomUUID(), open: 'auto' as const }));
    if (closedCount) closed.add(r.int(0, count - 1));
    for (const o of closed) options[o]!.open = 'closed';
    slots = [];
    for (let o = 0; o < count; o++) for (let t = 0; t < perOption; t++) slots.push({ option: o });
  }
  const O = options.length;
  const usable = slots.map((slot, i) => ({ ...slot, i })).filter(slot => !closed.has(slot.option));
  const chosenSlots = r
    .shuffle(usable)
    .slice(0, k)
    .map(slot => slot.i);

  const order = r.shuffle(Array.from({ length: N }, (_, p) => p));
  const teams: Planted['teams'] = [];
  let cursor = 0;
  for (let t = 0; t < k; t++) {
    const members = order.slice(cursor, cursor + sizes[t]!).sort((x, y) => x - y);
    teams.push({ slot: chosenSlots[t]!, members });
    cursor += sizes[t]!;
  }
  const teamOf = new Map<number, number>();
  const optionOf = new Map<number, number>();
  teams.forEach((team, t) =>
    team.members.forEach(p => {
      teamOf.set(p, t);
      optionOf.set(p, slots[team.slot]!.option);
    })
  );

  if (!free && r.chance(0.7)) options[slots[teams[0]!.slot]!.option]!.open = 'open';

  if (sized) {
    // Own sizes that hold every planted team on the option (so none of them
    // is "larger" under its option's bounds); options without a team get any.
    for (let o = 0; o < O; o++) {
      if (closed.has(o) || x.chance(0.4)) continue;
      const onOption = teams
        .filter(team => slots[team.slot]!.option === o)
        .map(team => team.members.length);
      const lo = onOption.length ? Math.min(...onOption) : x.int(1, 3);
      const hi = onOption.length ? Math.max(...onOption) : lo + x.int(0, 2);
      options[o]!.size = { min: x.int(1, lo), max: hi + x.int(0, 1) };
    }
  }

  const hard: TeamSetHard[] = [];
  for (const o of closed) {
    for (let p = 0; p < N; p++) {
      hard.push({ kind: 'forbid_place', src: `option:${options[o]!.id}`, p, o });
    }
  }
  const pairOf = (x: number, y: number) => ({ p: Math.min(x, y), q: Math.max(x, y) });
  if (!free) {
    const pA = r.int(0, N - 1);
    hard.push({ kind: 'require_place', src: 'pin:p1', p: pA, o: optionOf.get(pA)! });
    const pB = r.int(0, N - 1);
    const notOption = r
      .shuffle(Array.from({ length: O }, (_, o) => o))
      .find(o => o !== optionOf.get(pB));
    if (notOption !== undefined)
      hard.push({ kind: 'forbid_place', src: 'pin:p2', p: pB, o: notOption });
  }
  const bigTeam = teams.find(team => team.members.length >= 2)!;
  const otherTeam = teams.find(team => team !== bigTeam)!;
  const [q1, q2] = r.shuffle(bigTeam.members);
  hard.push({ kind: 'require_pair', src: 'pin:p3', ...pairOf(q1!, q2!) });
  hard.push({
    kind: 'forbid_pair',
    src: 'pin:p4',
    ...pairOf(r.pick(bigTeam.members), r.pick(otherTeam.members)),
  });
  const togetherRule = `${randomUUID()}:together`;
  const mate = r.pick(teams);
  const [m1, m2] = r.shuffle(mate.members);
  if (m2 !== undefined) hard.push({ kind: 'require_pair', src: togetherRule, ...pairOf(m1!, m2) });
  const apartRule = `${randomUUID()}:apart`;
  for (let i = 0; i < 4; i++) {
    const x = r.int(0, N - 1);
    const y = r.int(0, N - 1);
    if (teamOf.get(x) !== teamOf.get(y))
      hard.push({ kind: 'forbid_pair', src: apartRule, ...pairOf(x, y) });
  }
  // Hard team_count: two teammates never alone; a group capped at its planted max.
  if (seed % 2 === 1) {
    const [g1, g2] = r.shuffle(bigTeam.members);
    hard.push({
      kind: 'team_count',
      src: `${randomUUID()}:no_one_alone`,
      members: [g1!, g2!].sort((x, y) => x - y),
      not_one: true,
    });
  }
  {
    const group = r
      .subset(
        Array.from({ length: N }, (_, p) => p),
        Math.ceil(N / 2),
        Math.ceil(N / 2)
      )
      .sort((x, y) => x - y);
    const most = Math.max(...teams.map(team => team.members.filter(p => group.includes(p)).length));
    hard.push({
      kind: 'team_count',
      src: `${randomUUID()}:no_one_alone`,
      members: group,
      max: most + r.int(0, 1),
    });
  }
  if (withOwner) {
    // The option of team 0 opens with one of its pitchers on it; options no
    // team is on may have pitchers anywhere, or none (then they can't open).
    const src = `${randomUUID()}:owner`;
    const uniqSorted = (values: number[]) => [...new Set(values)].sort((x, y) => x - y);
    hard.push({
      kind: 'owner_if_open',
      src,
      o: slots[teams[0]!.slot]!.option,
      members: uniqSorted([x.pick(teams[0]!.members), x.int(0, N - 1)]),
    });
    const unopened = options
      .map((_, o) => o)
      .filter(o => !teams.some(team => slots[team.slot]!.option === o));
    for (const o of unopened.slice(0, 2)) {
      const members = x.chance(0.3) ? [] : uniqSorted([x.int(0, N - 1), x.int(0, N - 1)]);
      hard.push({ kind: 'owner_if_open', src, o, members });
    }
  }

  const place: TeamSetProblem['place'] = [];
  if (!free) {
    for (let p = 0; p < N; p++) {
      for (let o = 0; o < O; o++) {
        if (r.chance(0.35)) continue;
        const cost = r.chance(0.08) ? -100 * r.int(1, 9) : r.int(1, 100) * r.int(1, 10);
        place.push({ p, o, cost });
      }
    }
  }
  const pair: TeamSetProblem['pair'] = [];
  const seen = new Set<string>();
  for (let i = 0; i < N * 2; i++) {
    const x = r.int(0, N - 1);
    const y = r.int(0, N - 1);
    if (x === y) continue;
    const entry = pairOf(x, y);
    if (seen.has(`${entry.p}:${entry.q}`)) continue;
    seen.add(`${entry.p}:${entry.q}`);
    pair.push({ ...entry, cost: r.int(-500, 500) || 1 });
  }
  const everyone = Array.from({ length: N }, (_, p) => p);
  const soft_counts: TeamSetProblem['soft_counts'] = [
    {
      src: `${randomUUID()}:no_one_alone`,
      members: r.subset(everyone, 2, Math.floor(N / 2)).sort((x, y) => x - y),
      not_one: true,
      weight: weight100(r),
    },
    {
      src: 'non_respondents',
      members: r.subset(everyone, 2, Math.floor(N / 2)).sort((x, y) => x - y),
      max: r.int(1, 2),
      weight: 50,
    },
  ];
  // Centred c_p in [-100, 100], as compile emits them: with all-positive values
  // the term would be the same for every assignment and hide a per-team bug.
  const balance: TeamSetProblem['balance'] =
    seed % 5 === 0
      ? []
      : [
          {
            src: `${randomUUID()}:balance`,
            values: everyone.map(() => r.int(-100, 100)),
            weight: r.int(1, 10),
          },
        ];

  return {
    problem: {
      version: options.some(o => o.size) || smaller ? 2 : 1,
      people: everyone.map(() => randomUUID()),
      options,
      slots,
      size: { min, max, larger, ...(smaller ? { smaller } : {}) },
      team_count: { min: r.int(1, k), max: r.int(k, slots.length) },
      place,
      pair,
      hard,
      soft_counts,
      balance,
      worst_off_weight: free || seed % 6 === 2 ? 0 : r.int(1, 40),
      time_limit_s: TIME_LIMIT_S,
      seed,
    },
    teams,
  };
}

function weight100(r: Rng) {
  return r.int(1, 10) * 100;
}

// ─── Suites ─────────────────────────────────────────────────────────────────

const COMPILED_SEEDS = Array.from({ length: 48 }, (_, i) => 1 + i);
const PLANTED_SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i);

describe('team-set engine result types', () => {
  it('SolverStages (tasks) is TeamSetSolveStages (services)', () => {
    expectTypeOf<SolverStages>().toEqualTypeOf<TeamSetSolveStages>();
  });
});

describe.skipIf(!PYTHON)('team-set engine ↔ scoreAssignment: compiled problems', () => {
  const compiled = new Map<number, Compiled>();
  const outputs = new Map<number, SolverOutput>();
  const stageOne = new Map<number, StageOne>();
  let stageOneCompared = 0;

  beforeAll(async () => {
    for (const seed of COMPILED_SEEDS) compiled.set(seed, compiledProblem(seed));
    const runnable = COMPILED_SEEDS.filter(seed => compiled.get(seed)!.blocked.length === 0);
    const results = await mapLimit(runnable, CONCURRENCY, seed =>
      solve(compiled.get(seed)!.problem, `compiled-${seed}`)
    );
    runnable.forEach((seed, i) => outputs.set(seed, results[i]!));
    // Stage 1 alone, for every group problem whose stage 1 ran.
    const grouped = runnable.filter(seed => compiled.get(seed)!.problem.group);
    const alone = await mapLimit(grouped, CONCURRENCY, seed =>
      solveStageOne(compiled.get(seed)!.problem, `compiled-${seed}`)
    );
    grouped.forEach((seed, i) => stageOne.set(seed, alone[i]!));
  }, 600_000);

  it.each(COMPILED_SEEDS)('seed %i: engine and scorer agree', seed => {
    const { problem } = compiled.get(seed)!;
    const output = outputs.get(seed);
    if (!output) return; // blocked by runChecks, as startRun would be
    if (output.status === 'INFEASIBLE') expectCoreIsReal(problem, output);
    else expectAgreement(problem, output);
    if (problem.group && expectStageOne(output.stages!, stageOne.get(seed)!)) stageOneCompared++;
  });

  it('solved and cross-checked at least 30, across every feature', () => {
    const solvedSeeds = [...outputs.entries()].filter(([, o]) => solved(o)).map(([seed]) => seed);
    expect(solvedSeeds.length).toBeGreaterThanOrEqual(30);
    const all = solvedSeeds.map(seed => compiled.get(seed)!);
    const problems = all.map(c => c.problem);
    expect(problems.some(p => p.options[0]!.id === '__free__')).toBe(true);
    expect(
      problems.some(p => p.options[0]!.id !== '__free__' && p.slots.length > p.options.length)
    ).toBe(true);
    // The remainder flex: a team one larger, one smaller, and the group's own.
    expect(
      problems.some(p => p.size.larger > 0),
      'size.larger'
    ).toBe(true);
    expect(
      problems.some(p => (p.size.smaller ?? 0) > 0),
      'size.smaller'
    ).toBe(true);
    expect(
      problems.some(p => p.group && (p.group.larger ?? 0) + (p.group.smaller ?? 0) > 0),
      'group.larger / group.smaller'
    ).toBe(true);
    expect(problems.some(p => p.worst_off_weight > 0)).toBe(true);
    expect(problems.some(p => p.balance.length > 0)).toBe(true);
    expect(problems.some(p => p.soft_counts.length > 0)).toBe(true);
    expect(problems.some(p => p.options.some(o => o.open === 'open'))).toBe(true);
    expect(problems.some(p => p.options.some(o => o.open === 'closed'))).toBe(true);
    const hardKinds = new Set(problems.flatMap(p => p.hard.map(h => h.kind)));
    for (const kind of [
      'forbid_pair',
      'require_pair',
      'require_place',
      'forbid_place',
      'owner_if_open',
    ] as const) {
      expect(hardKinds.has(kind), kind).toBe(true);
    }
    // Per-student srcs on together/apart musts; per-option owner srcs.
    expect(problems.some(p => p.hard.some(h => /@\d+\+\d+$/.test(h.src)))).toBe(true);
    expect(
      problems.some(p => p.hard.some(h => h.kind === 'owner_if_open' && /:owner#/.test(h.src))),
      'owner srcs per option'
    ).toBe(true);
    // Version 2: own sizes, and two stages in both modes.
    expect(problems.some(p => p.version === 2 && p.options.some(o => o.size))).toBe(true);
    const grouped = problems.filter(p => p.group);
    expect(grouped.length).toBeGreaterThanOrEqual(4);
    expect(grouped.some(p => p.options[0]!.id === '__free__')).toBe(true);
    expect(grouped.some(p => p.options[0]!.id !== '__free__')).toBe(true);
    expect(all.some(c => c.priorityChanged)).toBe(true);
    expect(all.some(c => c.multiselectOverlap)).toBe(true);
    // Stage 1 was compared with the respondents solved alone.
    expect(stageOneCompared).toBeGreaterThanOrEqual(3);
    // An exact team count reached the engine with a group (solved or not,
    // stage 1 ran under the reservation and was checked against it).
    expect(
      [...outputs.keys()].some(seed => {
        const c = compiled.get(seed)!;
        return c.problem.group && c.exactCount;
      })
    ).toBe(true);
  });
});

describe.skipIf(!PYTHON)('team-set engine ↔ scoreAssignment: planted problems', () => {
  const planted = new Map<number, Planted>();
  const outputs = new Map<number, SolverOutput>();

  beforeAll(async () => {
    for (const seed of PLANTED_SEEDS) planted.set(seed, plantedProblem(seed));
    const results = await mapLimit(PLANTED_SEEDS, CONCURRENCY, seed =>
      solve(planted.get(seed)!.problem, `planted-${seed}`)
    );
    PLANTED_SEEDS.forEach((seed, i) => outputs.set(seed, results[i]!));
  }, 600_000);

  it.each(PLANTED_SEEDS)('seed %i: engine and scorer agree', seed => {
    const { problem, teams } = planted.get(seed)!;
    // The generator's own contract: the planted assignment is valid.
    const baseline = scoreAssignment(problem, teams);
    expect(baseline.violations).toEqual([]);

    const score = expectAgreement(problem, outputs.get(seed)!);
    // An OPTIMAL claim can never be worse than a known feasible assignment.
    if (outputs.get(seed)!.status === 'OPTIMAL') {
      expect(score.objective).toBeLessThanOrEqual(baseline.objective);
    }
  });

  it('covers every IR feature across the seeds', () => {
    const problems = PLANTED_SEEDS.map(seed => planted.get(seed)!.problem);
    const hardKinds = new Set(problems.flatMap(p => p.hard.map(h => h.kind)));
    expect([...hardKinds].sort()).toEqual(
      [
        'forbid_pair',
        'forbid_place',
        'owner_if_open',
        'require_pair',
        'require_place',
        'team_count',
      ].sort()
    );
    expect(
      problems.some(p => p.hard.some(h => h.kind === 'owner_if_open' && h.members.length === 0))
    ).toBe(true);
    expect(problems.some(p => p.options[0]!.id === '__free__')).toBe(true);
    expect(
      problems.some(p => p.options[0]!.id !== '__free__' && p.slots.length > p.options.length)
    ).toBe(true);
    expect(problems.some(p => p.size.larger === 1)).toBe(true);
    expect(problems.some(p => p.size.smaller === 1)).toBe(true);
    expect(problems.some(p => p.version === 2 && p.options.some(o => o.size))).toBe(true);
    expect(problems.some(p => p.size.larger === 1 && p.options.some(o => o.size))).toBe(true);
    expect(problems.some(p => p.worst_off_weight > 0)).toBe(true);
    expect(problems.some(p => p.options.some(o => o.open === 'open'))).toBe(true);
    expect(problems.some(p => p.options.some(o => o.open === 'closed'))).toBe(true);
    expect(problems.some(p => p.place.some(e => e.cost < 0))).toBe(true);
  });
});

describe.skipIf(!PYTHON)("team-set engine ↔ scoreAssignment: the engine's fixtures", () => {
  const names = existsSync(FIXTURES_DIR)
    ? readdirSync(FIXTURES_DIR)
        .filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -'.json'.length))
        .sort()
    : [];
  const problems = new Map<string, TeamSetProblem>();
  const outputs = new Map<string, SolverOutput>();
  const stageOne = new Map<string, StageOne>();
  const compared = new Set<string>();

  beforeAll(async () => {
    for (const name of names) {
      const problem = JSON.parse(
        readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf8')
      ) as TeamSetProblem;
      problem.time_limit_s = Math.min(problem.time_limit_s, TIME_LIMIT_S);
      problems.set(name, problem);
    }
    const results = await mapLimit(names, CONCURRENCY, name =>
      solve(problems.get(name)!, `fixture-${name}`)
    );
    names.forEach((name, i) => outputs.set(name, results[i]!));
    const grouped = names.filter(name => problems.get(name)!.group);
    const alone = await mapLimit(grouped, CONCURRENCY, name =>
      solveStageOne(problems.get(name)!, `fixture-${name}`)
    );
    grouped.forEach((name, i) => stageOne.set(name, alone[i]!));
  }, 600_000);

  it('finds the fixtures, version 2 and two-stage ones among them', () => {
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names.filter(name => problems.get(name)!.group).length).toBeGreaterThanOrEqual(3);
    expect(names.some(name => problems.get(name)!.options.some(o => o.size))).toBe(true);
  });

  it.each(names)('%s: engine and scorer agree', name => {
    const problem = problems.get(name)!;
    const output = outputs.get(name)!;
    // capacity-structural: the structure itself can't fit, so the core is empty.
    if (output.status === 'INFEASIBLE') expectCoreIsReal(problem, output, { structural: true });
    else expectAgreement(problem, output);
    if (problem.group && expectStageOne(output.stages!, stageOne.get(name)!)) compared.add(name);
  });

  it('group-exact-count: stage 1 gets the one team the group leaves it', () => {
    const problem = problems.get('group-exact-count');
    expect(problem).toBeDefined();
    // 2 people who didn't answer, teams of 2–4 on every option with an
    // option_cost: they need exactly one team, so the respondents get one of two.
    expect(groupTeamCounts(problem!)).toEqual([1, 1]);
    expect(stageOneProblem(problem!)!.team_count).toEqual({ min: 1, max: 1 });
    expect(compared.has('group-exact-count')).toBe(true);
    expect(outputs.get('group-exact-count')!.stages!.first.objective).toBe(
      stageOne.get('group-exact-count')!.output!.objective
    );
  });
});

describe.skipIf(!PYTHON)(
  'team-set engine: Group seats people who didn’t answer on any option that can open',
  () => {
    it('uses an option nobody ranked when the ranked ones are taken', async () => {
      // Four projects with one team each, pairs, the setting for people who
      // didn't answer left at its default (Group). Three people answered and
      // ranked Projects 1–3 only; six didn't. The three who answered take one
      // team (of 3); the six need three pairs, so one pair is on Project 4.
      const roster = Array.from({ length: 9 }, () => ({ user_id: randomUUID() }));
      const projects = ['Project 1', 'Project 2', 'Project 3', 'Project 4'].map(option);
      const rankF = field('ranked_choice', { options: projects, ranks: 3 });
      const fields = [rankF];
      const config = TeamSetConfigSchema.parse({
        version: 1,
        grouping: { mode: 'by_option', field_id: rankF.id, teams_per_option: 1 },
        team_size: { min: 2, max: 2 },
        rules: [{ field_id: rankF.id, job: 'rank', strength: 'prefer', weight: 5 }],
        time_limit_s: TIME_LIMIT_S,
      } satisfies TeamSetConfigInput);
      expect(validateConfigAgainstForm(config, fields)).toEqual([]);
      const ranked = projects.slice(0, 3).map(project => project.id);
      const { problem, context, non_respondents } = compileProblem({
        setName: 'crosscheck-group-any-option',
        config,
        fields,
        responses: roster.slice(0, 3).map((member, i) => ({
          response_id: randomUUID(),
          user_id: member.user_id,
          answers: { [rankF.id]: [...ranked.slice(i), ...ranked.slice(0, i)] },
        })),
        roster,
        seed: 9,
      });
      expect(non_respondents).toBe('group');
      expect(problem.group!.members).toHaveLength(6);
      // Projects 1–3 by demand (tied: option order), then Project 4.
      expect(problem.group!.option_cost).toEqual([0, 1, 2, 3]);
      expect(
        runChecks(problem, context, { config, fields }).filter(issue => issue.level === 'error')
      ).toEqual([]);

      const output = await solve(problem, 'group-any-option');
      expect(output.status).toBe('OPTIMAL');
      expectAgreement(problem, output);
      const group = new Set(problem.group!.members);
      const onFour = output.teams.filter(team => problem.slots[team.slot]!.option === 3);
      expect(onFour).toHaveLength(1);
      expect(onFour[0]!.members.every(p => group.has(p))).toBe(true);
    }, 120_000);
  }
);

describe.skipIf(!PYTHON)('team-set engine: infeasibility core', () => {
  it('names every src whose constraints collide, and only real srcs', async () => {
    // Person 0 must be on option 0 (pin:p1); persons 0 and 1 must share a team
    // (pin:p2); person 1 may not be on option 0 (a rule). Each option has one
    // slot, so any two of the three are satisfiable and all three are not —
    // every sufficient core contains all three. An unrelated, satisfiable must
    // (pin:p9) is present so "every src" would not pass by accident of size.
    const blockRule = `${randomUUID()}:fallback`;
    const problem: TeamSetProblem = {
      version: 1,
      people: Array.from({ length: 6 }, () => randomUUID()),
      options: [randomUUID(), randomUUID(), randomUUID()].map(id => ({
        id,
        open: 'auto' as const,
      })),
      slots: [{ option: 0 }, { option: 1 }, { option: 2 }],
      size: { min: 2, max: 3, larger: 0 },
      team_count: { min: 2, max: 3 },
      place: [],
      pair: [],
      hard: [
        { kind: 'require_place', src: 'pin:p1', p: 0, o: 0 },
        { kind: 'require_pair', src: 'pin:p2', p: 0, q: 1 },
        { kind: 'forbid_place', src: blockRule, p: 1, o: 0 },
        { kind: 'forbid_pair', src: 'pin:p9', p: 4, q: 5 },
      ],
      soft_counts: [],
      balance: [],
      worst_off_weight: 0,
      time_limit_s: TIME_LIMIT_S,
      seed: 7,
    };
    const output = await solve(problem, 'infeasible');
    expect(output.status).toBe('INFEASIBLE');
    expect(output.teams).toEqual([]);
    expect(output.core).toEqual(expect.arrayContaining(['pin:p1', 'pin:p2', blockRule]));
    // Minimal: the satisfiable bystander is not blamed.
    expect(output.core).not.toContain('pin:p9');
    expect(output.core_status).toBe('complete');
    expectCoreIsReal(problem, output);
  }, 120_000);

  /**
   * Six people, three options with one team of exactly two each, a ranked
   * question with a rank rule at Must (their first pick only). Compiled, and
   * passing runChecks, so it is a problem startRun would hand the engine.
   */
  function rankMustProblem(
    answers: (
      projects: { id: string }[],
      roster: { user_id: string }[]
    ) => {
      rank: string[][];
      together?: string[][];
    }
  ) {
    const roster = Array.from({ length: 6 }, () => ({ user_id: randomUUID() }));
    const projects = ['Project 1', 'Project 2', 'Project 3'].map(option);
    const rankF = field('ranked_choice', { options: projects, ranks: 3 });
    const togetherF = field('roster_select', {
      optionSource: 'roster',
      multiple: true,
      options: roster.map((member, i) => ({ id: member.user_id, label: `Student ${i + 1}` })),
    });
    const fields = [rankF, togetherF];
    const { rank, together = [] } = answers(projects, roster);
    const config = TeamSetConfigSchema.parse({
      version: 1,
      grouping: { mode: 'by_option', field_id: rankF.id, teams_per_option: 1 },
      team_size: { min: 2, max: 2 },
      rules: [
        {
          field_id: rankF.id,
          job: 'rank',
          strength: 'must',
          weight: 5,
          params: { must_top: 1 },
        },
        { field_id: togetherF.id, job: 'together', strength: 'must', weight: 5 },
      ],
      non_respondents: 'include',
      time_limit_s: TIME_LIMIT_S,
    } satisfies TeamSetConfigInput);
    expect(validateConfigAgainstForm(config, fields)).toEqual([]);
    const { problem, context } = compileProblem({
      setName: 'crosscheck-core',
      config,
      fields,
      responses: roster.map((member, i) => ({
        response_id: randomUUID(),
        user_id: member.user_id,
        answers: { [rankF.id]: rank[i] ?? [], [togetherF.id]: together[i] ?? [] },
      })),
      roster,
      seed: 5,
    });
    expect(
      runChecks(problem, context, { config, fields }).filter(issue => issue.level === 'error')
    ).toEqual([]);
    /** A person's index in the compiled problem (compile orders people by id). */
    const at = (member: { user_id: string }) => problem.people.indexOf(member.user_id);
    return {
      problem,
      roster,
      rankRule: `${rankF.id}:rank`,
      togetherRule: `${togetherF.id}:together`,
      at,
    };
  }

  it("names each student whose rank Must can't be met (per-student srcs)", async () => {
    // Three people must have their first pick, Project 1, whose one team
    // seats two. The others ranked nothing, so the rule asks nothing of them.
    const { problem, roster, rankRule, at } = rankMustProblem(projects => ({
      rank: [0, 1, 2].map(() => projects.map(project => project.id)),
    }));
    const output = await solve(problem, 'core-rank-must');
    expect(output.status).toBe('INFEASIBLE');
    expect(output.core_status).toBe('complete');
    expect([...output.core].sort()).toEqual(
      roster
        .slice(0, 3)
        .map(member => `${rankRule}@${at(member)}`)
        .sort()
    );
    expectCoreIsReal(problem, output);
  }, 120_000);

  it('names the pair whose together Must collides with their rank Musts', async () => {
    // Students 1 and 2 asked for each other (a mutual request at Must), but
    // each must have a different first pick.
    const { problem, roster, rankRule, togetherRule, at } = rankMustProblem(
      (projects, members) => ({
        rank: [
          [projects[0]!.id, projects[1]!.id],
          [projects[1]!.id, projects[0]!.id],
        ],
        together: [[members[1]!.user_id], [members[0]!.user_id]],
      })
    );
    const [one, two] = [at(roster[0]!), at(roster[1]!)];
    const output = await solve(problem, 'core-together-must');
    expect(output.status).toBe('INFEASIBLE');
    expect(output.core_status).toBe('complete');
    expect([...output.core].sort()).toEqual(
      [
        `${rankRule}@${one}`,
        `${rankRule}@${two}`,
        `${togetherRule}@${Math.min(one, two)}+${Math.max(one, two)}`,
      ].sort()
    );
    expectCoreIsReal(problem, output);
  }, 120_000);
});

describe.skipIf(!PYTHON)('team-set engine ↔ scoreAssignment: balance', () => {
  // Four people into two pairs; c = [100, -100, 50, -50], weight 3. Per open
  // team the term is weight × |Σ c|, so by hand:
  //   {0,1} {2,3} → 3 × (0 + 0)       = 0
  //   {0,2} {1,3} → 3 × (150 + 150)   = 900
  //   {0,3} {1,2} → 3 × (50 + 50)     = 300
  // A pair bonus of −1000 on (0, 2) makes the lopsided split the optimum:
  // 900 − 1000 = −100 beats 0.
  const base = (): TeamSetProblem => ({
    version: 1,
    people: Array.from({ length: 4 }, () => randomUUID()),
    options: [{ id: '__free__', open: 'auto' }],
    slots: [{ option: 0 }, { option: 0 }],
    size: { min: 2, max: 2, larger: 0 },
    team_count: { min: 1, max: 2 },
    place: [],
    pair: [],
    hard: [],
    soft_counts: [],
    balance: [{ src: `${randomUUID()}:balance`, values: [100, -100, 50, -50], weight: 3 }],
    worst_off_weight: 0,
    time_limit_s: TIME_LIMIT_S,
    seed: 11,
  });
  const split = (a: number[], b: number[]) => [
    { slot: 0, members: a },
    { slot: 1, members: b },
  ];

  it('the scorer computes the hand-worked values', () => {
    const problem = base();
    expect(scoreAssignment(problem, split([0, 1], [2, 3])).objective).toBe(0);
    expect(scoreAssignment(problem, split([0, 2], [1, 3])).objective).toBe(900);
    expect(scoreAssignment(problem, split([0, 3], [1, 2])).objective).toBe(300);
  });

  it('the engine balances when nothing pulls against it', async () => {
    const problem = base();
    const output = await solve(problem, 'balance-plain');
    expect(output.status).toBe('OPTIMAL');
    expect(expectAgreement(problem, output).objective).toBe(0);
    expect(output.teams.map(team => [...team.members].sort()).sort()).toEqual([
      [0, 1],
      [2, 3],
    ]);
  }, 60_000);

  it('the engine trades balance against a pair bonus at the exact weights', async () => {
    const problem = { ...base(), pair: [{ p: 0, q: 2, cost: -1000 }] };
    const output = await solve(problem, 'balance-vs-pair');
    expect(output.status).toBe('OPTIMAL');
    expect(expectAgreement(problem, output).objective).toBe(-100);
    expect(output.teams.map(team => [...team.members].sort()).sort()).toEqual([
      [0, 2],
      [1, 3],
    ]);
  }, 60_000);
});

describe.runIf(REQUIRED)('team-set engine: availability', () => {
  it('finds a Python with OR-Tools (TEAM_SET_CROSSCHECK=required)', () => {
    expect(
      PYTHON,
      'no python/.venv/bin/python or PYTHON_BIN_PATH that can import ortools; see python/README.md'
    ).not.toBeNull();
  });
});

// ─── Golden cohorts (synthetic, from the services' golden fixtures) ─────────

/**
 * The services' golden cohorts as seeds (packages/services/src/classmoji/
 * __tests__/golden; generate.ts there says what they are — synthetic, seeded,
 * shaped like past classes — and how they are regenerated). Each is compiled
 * from its stored inputs and solved at its own time limit; it must reach its
 * stored optimum with the scorer agreeing on the objective and on each stage
 * (`parts`), and each two-stage cohort's stage 1 must be the respondents
 * solved alone. A fixture that no longer compiles to its stored problem
 * fails the services' teamSet.golden test first, which names the fix.
 */
const GOLDEN_DIR = join(TASKS_DIR, '..', 'services', 'src', 'classmoji', '__tests__', 'golden');
const GOLDEN_NAMES = [
  'projects-24',
  'pairs-27',
  'pairs-27-group',
  'pairs-27-default',
  'pairs-28-group',
  'free-31',
];
const GOLDEN_GROUPED = ['pairs-27-group', 'pairs-28-group'];

interface GoldenCohort {
  fields: FormField[];
  roster: { user_id: string }[];
  responses: { response_id: string; user_id: string; answers: Record<string, unknown> }[];
  config: TeamSetConfigInput;
  seed: number;
  expected: { objective: number; stages: { first: number; second: number } | null };
}

describe.skipIf(!PYTHON)('team-set engine ↔ scoreAssignment: golden cohorts', () => {
  const problems = new Map<string, TeamSetProblem>();
  const expected = new Map<string, GoldenCohort['expected']>();
  const outputs = new Map<string, SolverOutput>();
  const stageOne = new Map<string, StageOne>();

  beforeAll(async () => {
    for (const name of GOLDEN_NAMES) {
      const cohort = JSON.parse(
        readFileSync(join(GOLDEN_DIR, `${name}.json`), 'utf8')
      ) as GoldenCohort;
      const config = TeamSetConfigSchema.parse(cohort.config);
      const configProblems = validateConfigAgainstForm(config, cohort.fields);
      if (configProblems.length) throw new Error(`${name}: ${configProblems.join('; ')}`);
      const { problem } = compileProblem({
        setName: name,
        config,
        fields: cohort.fields,
        responses: cohort.responses,
        roster: cohort.roster,
        seed: cohort.seed,
      });
      problems.set(name, problem);
      expected.set(name, cohort.expected);
    }
    const results = await mapLimit(GOLDEN_NAMES, CONCURRENCY, name =>
      solve(problems.get(name)!, `golden-${name}`)
    );
    GOLDEN_NAMES.forEach((name, i) => outputs.set(name, results[i]!));
    const grouped = GOLDEN_NAMES.filter(name => problems.get(name)!.group);
    const alone = await mapLimit(grouped, CONCURRENCY, name =>
      solveStageOne(problems.get(name)!, `golden-${name}`)
    );
    grouped.forEach((name, i) => stageOne.set(name, alone[i]!));
  }, 600_000);

  it.each(GOLDEN_NAMES)('%s: the stored optimum, objective and parts agree', name => {
    const want = expected.get(name)!;
    const output = outputs.get(name)!;
    const score = expectAgreement(problems.get(name)!, output);
    expect(output.status).toBe('OPTIMAL');
    expect(score.objective).toBe(want.objective);
    expect(score.parts).toEqual(want.stages ?? { first: want.objective, second: 0 });
  });

  it.each(GOLDEN_GROUPED)('%s: stage 1 is the respondents solved alone', name => {
    const problem = problems.get(name)!;
    expect(problem.group?.members.length).toBeGreaterThan(0);
    expect(expectStageOne(outputs.get(name)!.stages!, stageOne.get(name)!)).toBe(true);
    expect(stageOne.get(name)!.output!.objective).toBe(expected.get(name)!.stages!.first);
  });

  it('every grouped cohort is listed as grouped', () => {
    expect(GOLDEN_NAMES.filter(name => problems.get(name)!.group)).toEqual(GOLDEN_GROUPED);
  });
});
