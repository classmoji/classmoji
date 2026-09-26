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
 *
 * Two generators:
 *   - COMPILED problems: synthetic forms, responses and configs through the
 *     service's own `compileProblem`, so the IR production actually produces
 *     is what the engine is checked on — rank + fairness/worst_off, fallback
 *     categories, owner bonuses, together/apart (prefer and must), match with
 *     wildcards and multiselect overlap, mix, balance, no_one_alone, pins of
 *     every kind, forced-open and closed options, free mode, teams_per_option 2,
 *     allow_one_larger, non-respondents included and excluded. Seeds whose
 *     `runChecks` has an error are skipped exactly as `startRun` would skip them;
 *     an INFEASIBLE answer is allowed (random musts can collide) but its core
 *     must name real srcs. At least 20 must solve and agree.
 *   - PLANTED problems built directly in the IR: a valid assignment is drawn
 *     first and every hard constraint derived from it, so each is feasible by
 *     construction and must solve — covering all five hard kinds (incl. a hard
 *     team_count) and edge terms (negative place bonuses) on every seed.
 * Plus one deliberately infeasible problem whose core must name its srcs and
 * only them, and a hand-computed balance case (weight × |Σ c_m| per open team).
 * Every answer must also carry the result line's engine, stats and core_status.
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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  parseSolverOutput,
  TEAM_SET_SOLVER_WORKERS,
  type SolverOutput,
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
} from '@classmoji/services/team-set-problem'; // eslint-disable-line import/no-unresolved
import { runChecks } from '@classmoji/services/team-set-checks'; // eslint-disable-line import/no-unresolved
import { scoreAssignment } from '@classmoji/services/team-set-score'; // eslint-disable-line import/no-unresolved

// ─── Environment ────────────────────────────────────────────────────────────

const TASKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SCRIPT = join(TASKS_DIR, 'python', 'team_set_solver.py');

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
          done(parseSolverOutput(stdout));
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

// ─── Assertions shared by every solved case ─────────────────────────────────

/** The result line's diagnostic fields, which the service records. */
function expectResultFields(problem: TeamSetProblem, output: SolverOutput) {
  expect(output.engine).toMatch(/^cpsat@\d+\.\d+/);
  expect(output.stats).toMatchObject({
    people: problem.people.length,
    slots: problem.slots.length,
  });
  expect(output.core_status).toBe(output.status === 'INFEASIBLE' ? 'complete' : 'n/a');
}

function expectAgreement(problem: TeamSetProblem, output: SolverOutput) {
  expect(['OPTIMAL', 'FEASIBLE']).toContain(output.status);
  expectResultFields(problem, output);
  const score = scoreAssignment(problem, output.teams);
  expect(score.violations).toEqual([]);
  expect(output.objective).not.toBeNull();
  expect(score.objective).toBe(output.objective);
  return score;
}

/**
 * A core names only srcs the problem has: a hard constraint's src, or
 * `option:<id>` for an option forced open (the engine's own src for that).
 */
function expectCoreIsReal(problem: TeamSetProblem, output: SolverOutput) {
  expectResultFields(problem, output);
  expect(output.core.length).toBeGreaterThan(0);
  const srcs = new Set([
    ...problem.hard.map(h => h.src),
    ...problem.options.filter(o => o.open === 'open').map(o => `option:${o.id}`),
  ]);
  for (const src of output.core) expect(srcs.has(src)).toBe(true);
}

// ─── Compiled problems (synthetic form → compileProblem) ────────────────────

interface Compiled {
  problem: TeamSetProblem;
  /** Why `startRun` would refuse it (runChecks error codes); empty = solvable. */
  blocked: string[];
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

function compiledProblem(seed: number): Compiled {
  const r: Rng = rng(seed);
  const free = seed % 4 === 3;
  const perOption = !free && seed % 2 === 0 ? 2 : 1;
  const N = r.int(10, 18);
  const min = r.int(2, 3);
  const max = min + r.int(1, 2);

  const roster = Array.from({ length: N }, () => ({ user_id: randomUUID() }));
  const people = roster.map((member, i) => ({ id: member.user_id, label: `Student ${i + 1}` }));
  // Enough options that the set always fits even with one closed.
  const O = Math.max(r.int(3, 6), Math.ceil(N / (max * perOption)) + 1);
  const projects = Array.from({ length: O }, (_, i) => option(`Project ${i + 1}`));
  const categories = ['Web', 'Data', 'Games'].map(option);
  const timing = ['Mornings', 'Evenings', 'Either'].map(option);
  const languages = ['Python', 'JavaScript', 'C'].map(option);
  const roles = ['Design', 'Build', 'Test'].map(option);

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
  ];

  const ids = (items: { id: string }[]) => items.map(item => item.id);
  const responses = roster
    .filter(() => r.chance(0.85))
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
  ];
  const options: NonNullable<TeamSetConfigInput['options']> = {};
  const pins: NonNullable<TeamSetConfigInput['pins']> = [];
  const [a, b, c, d, e, f] = r.shuffle(roster.map(member => member.user_id));
  pins.push({ id: 'p1', kind: 'together', user_ids: [a!, b!] });
  pins.push({ id: 'p2', kind: 'apart', user_ids: [c!, d!] });

  if (!free) {
    rules.push(
      { field_id: rankF.id, job: 'rank', strength: 'prefer', weight: r.int(5, 10) },
      { field_id: fallbackF.id, job: 'fallback', strength: 'prefer', weight: 5 },
      { field_id: ownerF.id, job: 'owner', strength: 'prefer', weight: r.int(5, 10) }
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

  const config = TeamSetConfigSchema.parse({
    version: 1,
    grouping: free
      ? { mode: 'free' }
      : { mode: 'by_option', field_id: rankF.id, teams_per_option: perOption },
    team_size: { min, max, allow_one_larger: seed % 3 === 1 },
    team_count: seed % 5 === 4 ? { max: Math.ceil(N / min) } : {},
    options,
    rules,
    non_respondents: seed % 5 === 0 ? 'exclude' : 'include',
    fairness: r.int(0, 100),
    pins,
    time_limit_s: TIME_LIMIT_S,
  } satisfies TeamSetConfigInput);

  // The generator's own contract: a config the service would accept.
  const configProblems = validateConfigAgainstForm(config, fields);
  if (configProblems.length)
    throw new Error(`seed ${seed}: invalid config: ${configProblems.join('; ')}`);

  const { problem, context } = compileProblem({
    setName: `crosscheck-${seed}`,
    config,
    fields,
    responses,
    roster,
    seed,
  });
  const blocked = runChecks(problem, context)
    .filter(issue => issue.level === 'error')
    .map(issue => issue.code);
  return { problem, blocked };
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
  const free = seed % 3 === 0;
  const perOption = !free && seed % 2 === 0 ? 2 : 1;
  const larger = seed % 4 === 1 ? 1 : 0;

  const min = r.int(2, 3);
  const max = min + r.int(1, 2);
  const k = r.int(3, 5);
  const sizes = Array.from({ length: k }, () => r.int(min, max));
  if (larger) sizes[r.int(0, k - 1)] = max + 1;
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
      version: 1,
      people: everyone.map(() => randomUUID()),
      options,
      slots,
      size: { min, max, larger },
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

const COMPILED_SEEDS = Array.from({ length: 28 }, (_, i) => 1 + i);
const PLANTED_SEEDS = Array.from({ length: 24 }, (_, i) => 1000 + i);

describe.skipIf(!PYTHON)('team-set engine ↔ scoreAssignment: compiled problems', () => {
  const compiled = new Map<number, Compiled>();
  const outputs = new Map<number, SolverOutput>();

  beforeAll(async () => {
    for (const seed of COMPILED_SEEDS) compiled.set(seed, compiledProblem(seed));
    const runnable = COMPILED_SEEDS.filter(seed => compiled.get(seed)!.blocked.length === 0);
    const results = await mapLimit(runnable, CONCURRENCY, seed =>
      solve(compiled.get(seed)!.problem, `compiled-${seed}`)
    );
    runnable.forEach((seed, i) => outputs.set(seed, results[i]!));
  }, 600_000);

  it.each(COMPILED_SEEDS)('seed %i: engine and scorer agree', seed => {
    const { problem } = compiled.get(seed)!;
    const output = outputs.get(seed);
    if (!output) return; // blocked by runChecks, as startRun would be
    if (output.status === 'INFEASIBLE') {
      expectCoreIsReal(problem, output);
      return;
    }
    expectAgreement(problem, output);
  });

  it('solved and cross-checked at least 20, across every feature', () => {
    const solved = [...outputs.entries()].filter(
      ([, o]) => o.status === 'OPTIMAL' || o.status === 'FEASIBLE'
    );
    expect(solved.length).toBeGreaterThanOrEqual(20);
    const problems = solved.map(([seed]) => compiled.get(seed)!.problem);
    expect(problems.some(p => p.options[0]!.id === '__free__')).toBe(true);
    expect(
      problems.some(p => p.options[0]!.id !== '__free__' && p.slots.length > p.options.length)
    ).toBe(true);
    expect(problems.some(p => p.size.larger === 1)).toBe(true);
    expect(problems.some(p => p.worst_off_weight > 0)).toBe(true);
    expect(problems.some(p => p.balance.length > 0)).toBe(true);
    expect(problems.some(p => p.soft_counts.length > 0)).toBe(true);
    expect(problems.some(p => p.options.some(o => o.open === 'open'))).toBe(true);
    expect(problems.some(p => p.options.some(o => o.open === 'closed'))).toBe(true);
    const hardKinds = new Set(problems.flatMap(p => p.hard.map(h => h.kind)));
    for (const kind of ['forbid_pair', 'require_pair', 'require_place', 'forbid_place'] as const) {
      expect(hardKinds.has(kind)).toBe(true);
    }
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
      ['forbid_pair', 'forbid_place', 'require_pair', 'require_place', 'team_count'].sort()
    );
    expect(problems.some(p => p.options[0]!.id === '__free__')).toBe(true);
    expect(
      problems.some(p => p.options[0]!.id !== '__free__' && p.slots.length > p.options.length)
    ).toBe(true);
    expect(problems.some(p => p.size.larger === 1)).toBe(true);
    expect(problems.some(p => p.worst_off_weight > 0)).toBe(true);
    expect(problems.some(p => p.options.some(o => o.open === 'open'))).toBe(true);
    expect(problems.some(p => p.options.some(o => o.open === 'closed'))).toBe(true);
    expect(problems.some(p => p.place.some(e => e.cost < 0))).toBe(true);
  });
});

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
