/**
 * Golden team-set fixtures: SYNTHETIC cohorts from fixed seeds.
 *
 * No real student data, ever (the repo is public). Each cohort is drawn by a
 * seeded generator shaped like the classes the feature is built for — its
 * sizes, how skewed the project picks are, how many people ask for partners
 * and how many of those asks are mutual, how many never answer — but every
 * id, name, label and answer is invented here:
 *
 *   projects-24     24 people, 8 projects with skewed popularity, teams of
 *                   4–6; the Project bidding questions (pitched project with
 *                   the owner rule at Must, 3 ranks, who to work with, who
 *                   not to, "What matters more to you?" as a Shifts priority
 *                   rule), a comfort scale balanced across teams, and the
 *                   Gender questions (an identity multiselect, a small
 *                   minority protected by no_one_alone); 3 never answered,
 *                   spread over the teams.
 *   pairs-27        27 people, 20 topics, 4 ranks, fallback categories, a
 *                   meeting-time match with a wildcard, partner requests;
 *                   4 never answered, spread over the teams.
 *   pairs-27-group  the same cohort with the people who didn't answer
 *                   grouped together (two stages).
 *   pairs-27-default the same cohort with at most 9 teams and the setting
 *                   for people who didn't answer left at its default (Group
 *                   for pairs): grouped, they would take 2 of the 9 teams and
 *                   the 23 who answered can't fit the 7 left, so the runs
 *                   spread them — 9 teams of 3.
 *   pairs-28-group  28 people drawn the same way, 5 never answered, grouped:
 *                   each population takes its own team of 3 (10 pairs and a
 *                   trio for the 23 who answered, a pair and a trio for the 5
 *                   who didn't).
 *   free-31         31 people in free teams (no grouping question) of
 *                   exactly 4 — 7 teams of 4 and 1 of 3, the remainder flex;
 *                   partner requests, one "rather not" each for a few, a
 *                   meeting-time match with a wildcard, "nobody alone" on a
 *                   yes/no question; 3 never answered, spread over the teams.
 *
 * Each fixture JSON holds the generated inputs (form fields as
 * parseFormDefinition stores them, roster, responses, the parsed config, the
 * compile seed) and `expected`: what the services and the local CP-SAT engine
 * made of them — the compiled problem's hash and shape, the checks' warning
 * codes, the proven optimum (and each stage's, for the group cohort), the
 * teams the engine returned and the metrics of those teams.
 *
 * ── Regenerating ───────────────────────────────────────────────────────────
 * After an intended change to this generator, compile, the scorer, metrics,
 * checks or the identity-wildcard default (the Gender rule's wildcards come
 * from defaultIdentityWildcards over the generated answers):
 *
 *   cd packages/services
 *   node src/classmoji/__tests__/golden/generate.ts            # report what changed
 *   node src/classmoji/__tests__/golden/generate.ts --write    # rewrite the fixtures
 *
 * Needs packages/tasks/python/.venv (packages/tasks/python/README.md). Never
 * hand-edit the JSON: teamSet.golden.test.ts checks that this generator
 * reproduces the stored inputs exactly. When the new optimum equals the
 * stored one and the stored teams still reach it, --write keeps those teams,
 * so a rewrite with nothing changed leaves the files as they are.
 *
 * Runs under plain `node` (type stripping): type-only imports stay `type`.
 */

import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseAnswers, parseFormDefinition, type FormField } from '../../formContract.ts';
import {
  TeamSetConfigSchema,
  defaultIdentityWildcards,
  teamSetRuleId,
  validateConfigAgainstForm,
  type IdentityAnswerCounts,
  type TeamSetConfig,
  type TeamSetConfigInput,
  type TeamSetNonRespondents,
} from '../../teamSetConfig.ts';
import {
  compileProblem,
  type TeamSetContext,
  type TeamSetProblem,
  type TeamSetSolveStatus,
} from '../../teamSetProblem.ts';
import { runChecks } from '../../teamSetChecks.ts';
import { scoreAssignment, type TeamSetAssignment } from '../../teamSetScore.ts';
import { computeMetrics, type TeamSetMetrics } from '../../teamSetMetrics.ts';

export const GOLDEN_DIR = dirname(fileURLToPath(import.meta.url));

export const GOLDEN_CASES = [
  'projects-24',
  'pairs-27',
  'pairs-27-group',
  'pairs-27-default',
  'pairs-28-group',
  'free-31',
] as const;
export type GoldenName = (typeof GOLDEN_CASES)[number];

/** What the generator draws: everything a run is compiled from. */
export interface GoldenInputs {
  name: GoldenName;
  about: string;
  generator_seed: number;
  fields: FormField[];
  roster: { user_id: string }[];
  responses: { response_id: string; user_id: string; answers: Record<string, unknown> }[];
  /** Parsed (TeamSetConfigSchema output), as the service stores a config. */
  config: TeamSetConfig;
  /** The compile seed (problem.seed). */
  seed: number;
}

export interface GoldenExpected {
  /** sha256 of the compiled problem as canonical JSON (canonicalJson). */
  problem_sha256: string;
  problem_shape: ReturnType<typeof problemShape>;
  /** runChecks warning codes, sorted (errors must be none). */
  warnings: string[];
  status: 'OPTIMAL';
  objective: number;
  /** Two-stage cohorts only: each stage's proven optimum. */
  stages: { first: number; second: number } | null;
  /** The engine's teams at generation, by slot, members ascending. */
  teams: TeamSetAssignment[];
  /** computeMetrics of those teams (with the resolved non_respondents mode). */
  metrics: TeamSetMetrics;
}

export interface GoldenFixture extends GoldenInputs {
  expected: GoldenExpected;
}

// ─── Seeded randomness ──────────────────────────────────────────────────────

/** A valid, deterministic uuid: namespace in the first group, n in the last. */
const uuid = (ns: number, n: number) =>
  `${ns.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * mulberry32, plus the draws the generators need. Weights are integers so a
 * weighted draw is the same on every machine.
 */
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
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  /** k distinct items, each draw weighted by what is left. */
  const draw = <T>(items: readonly T[], weights: readonly number[], k: number): T[] => {
    const pool = items.map((item, i) => ({ item, weight: weights[i]! }));
    const out: T[] = [];
    while (out.length < k && pool.length > 0) {
      let x = next() * pool.reduce((sum, entry) => sum + entry.weight, 0);
      let i = 0;
      for (; i < pool.length - 1; i++) {
        x -= pool[i]!.weight;
        if (x < 0) break;
      }
      out.push(pool.splice(i, 1)[0]!.item);
    }
    return out;
  };
  const weighted = <T>(items: readonly T[], weights: readonly number[]): T =>
    draw(items, weights, 1)[0]!;
  return { int, shuffle, draw, weighted, chance: (p: number) => next() < p };
}

type Rng = ReturnType<typeof rng>;

// ─── Shared cohort pieces ───────────────────────────────────────────────────

/**
 * Every cohort's solve limit. Each proves its optimum within a few seconds
 * on two workers (pairs-27-group is the slowest); twice the default leaves
 * room for a machine busy running other suites.
 */
const TIME_LIMIT_S = 60;

const option = (id: string, label: string) => ({ id, label });

/** Everyone on the roster, as a roster_select lists them once published. */
const rosterOptions = (users: string[]) => users.map((id, i) => option(id, `Student ${i + 1}`));

/**
 * Partner requests shaped like a cohort's: about 30% of the people who
 * answered ask for someone, and about a quarter of the asks are mutual (one
 * mutual pair per eight askers, at least one). The rest ask for one or up to
 * `most` people — anyone on the roster, including people who never answered —
 * but never someone who asked for them (that would be a second mutual pair).
 */
function partnerRequests(
  r: Rng,
  respondents: string[],
  roster: string[],
  most: number
): Map<string, string[]> {
  const askers = r.shuffle(respondents).slice(0, Math.round(0.3 * respondents.length));
  const mutualPairs = Math.max(1, Math.round(askers.length / 8));
  const asks = new Map<string, string[]>();
  for (let i = 0; i < mutualPairs; i++) {
    const [p, q] = [askers[2 * i]!, askers[2 * i + 1]!];
    asks.set(p, [q]);
    asks.set(q, [p]);
  }
  for (const p of askers.slice(2 * mutualPairs)) {
    const candidates = roster.filter(q => q !== p && !(asks.get(q) ?? []).includes(p));
    asks.set(p, r.shuffle(candidates).slice(0, r.int(1, most)));
  }
  return asks;
}

/**
 * Friends rank alike. In a mutual pair one copies the other's ranking (a
 * pitcher's, if either pitched), and half of the one-way askers put their
 * partner's first pick first. A pitcher's own ranking never changes.
 */
function rankAlike(
  r: Rng,
  rankings: Map<string, string[]>,
  asks: Map<string, string[]>,
  pitchers: Set<string>
): void {
  for (const [p, targets] of asks) {
    const q = targets[0]!;
    const theirs = rankings.get(q);
    if ((asks.get(q) ?? []).includes(p)) {
      if (p > q) continue; // each mutual pair once
      if (!pitchers.has(q)) rankings.set(q, [...rankings.get(p)!]);
      else if (!pitchers.has(p)) rankings.set(p, [...theirs!]);
    } else if (theirs && !pitchers.has(p) && r.chance(0.5)) {
      const mine = rankings.get(p)!;
      rankings.set(p, [theirs[0]!, ...mine.filter(id => id !== theirs[0])].slice(0, mine.length));
    }
  }
}

/** One identity question's answer counts over the responses (as the service counts them). */
function identityCounts(
  fieldId: string,
  responses: GoldenInputs['responses']
): IdentityAnswerCounts {
  const counts: IdentityAnswerCounts = { answered: 0, byOption: {} };
  for (const response of responses) {
    const raw = response.answers[fieldId];
    const ids = Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
    if (ids.length === 0) continue;
    counts.answered += 1;
    for (const id of new Set(ids)) counts.byOption[id] = (counts.byOption[id] ?? 0) + 1;
  }
  return counts;
}

/** Drop unanswered questions, as a submitted response leaves them out. */
function answered(answers: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(answers).filter(
      ([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)
    )
  );
}

// ─── projects-24 ────────────────────────────────────────────────────────────

/** Skewed popularity: the most wanted project draws ten times the least wanted. */
const PROJECT_WEIGHTS = [30, 20, 14, 10, 8, 6, 4, 3];

function projects24(): GoldenInputs {
  const generatorSeed = 2401;
  const r = rng(generatorSeed);
  const F = {
    pitched: uuid(0x2401, 1),
    ranked: uuid(0x2401, 2),
    partners: uuid(0x2401, 3),
    avoid: uuid(0x2401, 4),
    matters: uuid(0x2401, 5),
    comfort: uuid(0x2401, 6),
    gender: uuid(0x2401, 7),
    describe: uuid(0x2401, 8),
    notes: uuid(0x2401, 9),
  };
  const projects = 'ABCDEFGH'
    .split('')
    .map((letter, i) => option(uuid(0x2402, i + 1), `Project ${letter}`));
  const [PROJECT, PEOPLE, BOTH] = [1, 2, 3].map(i => uuid(0x2403, i)) as [string, string, string];
  const [WOMAN, MAN, NON_BINARY, SELF_DESCRIBE, NOT_SAY] = [1, 2, 3, 4, 5].map(i =>
    uuid(0x2404, i)
  ) as [string, string, string, string, string];
  const users = Array.from({ length: 24 }, (_, i) => uuid(0x2409, i + 1));

  const fields = parseFormDefinition([
    {
      id: F.pitched,
      type: 'dropdown',
      label: 'Did you pitch one of these projects? If so, which one?',
      options: projects.map(project => ({ ...project })),
      options_from: F.ranked,
    },
    {
      id: F.ranked,
      type: 'ranked_choice',
      label: "Rank the projects you'd like to work on",
      required: true,
      ranks: 3,
      options: projects,
    },
    {
      id: F.partners,
      type: 'roster_select',
      label: 'Who would you like to work with?',
      optionSource: 'roster',
      multiple: true,
      options: rosterOptions(users),
    },
    {
      id: F.avoid,
      type: 'roster_select',
      label: "Anyone you'd rather not work with?",
      help: 'Only course staff see this.',
      optionSource: 'roster',
      multiple: true,
      options: rosterOptions(users),
    },
    {
      id: F.matters,
      type: 'dropdown',
      label: 'What matters more to you?',
      options: [
        option(PROJECT, 'The project'),
        option(PEOPLE, 'The people'),
        option(BOTH, 'Both equally'),
      ],
    },
    {
      id: F.comfort,
      type: 'opinion_scale',
      label: 'How comfortable are you building a full application?',
      scale: { min: 1, max: 5 },
    },
    {
      id: F.gender,
      type: 'multiselect',
      label: 'How do you describe your gender?',
      identity_question: true,
      options: [
        option(WOMAN, 'Woman'),
        option(MAN, 'Man'),
        option(NON_BINARY, 'Non-binary'),
        option(SELF_DESCRIBE, 'Prefer to self-describe'),
        { ...option(NOT_SAY, 'Prefer not to say'), exclusive: true },
      ],
    },
    {
      id: F.describe,
      type: 'short_text',
      label: "If you'd like, describe it in your own words",
      identity_question: true,
    },
    { id: F.notes, type: 'long_text', label: 'Anything else we should know?' },
  ]).fields;

  // Three never answered; everyone else did.
  const silent = new Set(r.shuffle(users).slice(0, 3));
  const respondents = users.filter(user => !silent.has(user));

  // Popularity follows a shuffled project order, so which project is the
  // favourite is drawn too.
  const byPopularity = r.shuffle(projects.map(project => project.id));
  const pickProjects = (k: number, not: string[] = []) => {
    const pool = byPopularity.filter(id => !not.includes(id));
    return r.draw(
      pool,
      pool.map(id => PROJECT_WEIGHTS[byPopularity.indexOf(id)]!),
      k
    );
  };

  // Three pitchers, three different projects; each ranks their own first.
  const pitchers = r.shuffle(respondents).slice(0, 3);
  const pitchedProjects = r.shuffle(byPopularity).slice(0, 3);
  const pitchedBy = new Map(pitchers.map((user, i) => [user, pitchedProjects[i]!]));

  const asks = partnerRequests(r, respondents, users, 2);
  // Two people each name one person to avoid, never someone they asked for.
  const avoids = new Map<string, string[]>();
  for (const p of r.shuffle(respondents).slice(0, 2)) {
    const candidates = users.filter(q => q !== p && !(asks.get(p) ?? []).includes(q));
    avoids.set(p, r.shuffle(candidates).slice(0, 1));
  }

  // Gender: a small minority. Man is the majority answer (a wildcard by
  // share), Woman and Non-binary are protected, one person ticks Woman and
  // Prefer to self-describe, one prefers not to say, two skip the question.
  const byGender = r.shuffle(respondents);
  const gender = new Map<string, string[]>();
  byGender
    .slice(0, 6)
    .forEach((user, i) => gender.set(user, i === 0 ? [WOMAN, SELF_DESCRIBE] : [WOMAN]));
  gender.set(byGender[6]!, [NON_BINARY]);
  gender.set(byGender[7]!, [NOT_SAY]);
  byGender.slice(10).forEach(user => gender.set(user, [MAN]));

  const noted = new Set(r.shuffle(respondents).slice(0, 3));
  let noteNumber = 0;

  const rankings = new Map(
    respondents.map(user => {
      const pitched = pitchedBy.get(user);
      return [user, pitched ? [pitched, ...pickProjects(2, [pitched])] : pickProjects(3)];
    })
  );
  rankAlike(r, rankings, asks, new Set(pitchers));

  const responses = respondents.map((user, i) => {
    const pitched = pitchedBy.get(user);
    const matters = r.weighted([PROJECT, PEOPLE, BOTH, null], [40, 25, 25, 10]);
    const answers = answered({
      [F.pitched]: pitched,
      [F.ranked]: rankings.get(user),
      [F.partners]: asks.get(user),
      [F.avoid]: avoids.get(user),
      [F.matters]: matters ?? undefined,
      [F.comfort]: r.weighted([1, 2, 3, 4, 5], [1, 3, 5, 4, 2]),
      [F.gender]: gender.get(user),
      [F.describe]: gender.get(user)?.includes(SELF_DESCRIBE) ? 'Invented description' : undefined,
      [F.notes]: noted.has(user) ? `Invented note ${++noteNumber}` : undefined,
    });
    return { response_id: uuid(0x2408, i + 1), user_id: user, answers };
  });

  const wildcards = defaultIdentityWildcards(
    fields.find(field => field.id === F.gender)!,
    identityCounts(F.gender, responses)
  );
  const config: TeamSetConfigInput = {
    version: 1,
    grouping: { mode: 'by_option', field_id: F.ranked, teams_per_option: 1 },
    team_size: { min: 4, max: 6 },
    non_respondents: 'include',
    fairness: 50,
    rules: [
      { field_id: F.ranked, job: 'rank', strength: 'prefer', weight: 8 },
      { field_id: F.pitched, job: 'owner', strength: 'must', weight: 9 },
      { field_id: F.partners, job: 'together', strength: 'prefer', weight: 5 },
      { field_id: F.avoid, job: 'apart', strength: 'prefer', weight: 8 },
      {
        field_id: F.matters,
        job: 'priority',
        strength: 'prefer',
        params: {
          rule_a: teamSetRuleId({ field_id: F.ranked, job: 'rank' }),
          rule_b: teamSetRuleId({ field_id: F.partners, job: 'together' }),
          answers: { [PROJECT]: 'a', [PEOPLE]: 'b', [BOTH]: 'none' },
          shift: 50,
        },
      },
      { field_id: F.comfort, job: 'balance', strength: 'prefer', weight: 3 },
      {
        field_id: F.gender,
        job: 'no_one_alone',
        strength: 'prefer',
        weight: 9,
        params: { wildcard_option_ids: wildcards },
      },
      { field_id: F.notes, job: 'note', strength: 'prefer' },
    ],
    team_name_template: '{set}-{option}',
    time_limit_s: TIME_LIMIT_S,
  };

  return {
    name: 'projects-24',
    about:
      'Synthetic: 24 people, 8 projects with skewed popularity, teams of 4-6, pitchers at Must, ' +
      'partner and avoid requests, a priority question, a balanced scale, an identity multiselect; ' +
      '3 never answered (spread).',
    generator_seed: generatorSeed,
    fields,
    roster: users.map(user_id => ({ user_id })),
    responses,
    config: TeamSetConfigSchema.parse(config),
    seed: 24,
  };
}

// ─── pairs-27 / pairs-27-group / pairs-27-default / pairs-28-group ─────────

const TOPIC_WEIGHTS = [20, 15, 12, 10, 9, 8, 7, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1];
const TRACKS = ['Health', 'Climate', 'Education', 'Games', 'Civic', 'Tools'];

type PairsName = 'pairs-27' | 'pairs-27-group' | 'pairs-27-default' | 'pairs-28-group';

/**
 * The pairs cohorts: how many people, how many never answer, the draw's seed
 * and id namespace (ids are uuid(ns + 1..9, n)), and what the config says
 * about the people who didn't answer (null: left at the default).
 */
const PAIRS: Record<
  PairsName,
  {
    people: number;
    silent: number;
    generatorSeed: number;
    ns: number;
    nonRespondents: 'include' | 'group' | null;
    teamCountMax?: number;
    seed: number;
    about: string;
  }
> = {
  'pairs-27': {
    people: 27,
    silent: 4,
    generatorSeed: 2701,
    ns: 0x2700,
    nonRespondents: 'include',
    seed: 27,
    about:
      'Synthetic: 27 people in pairs (one trio), 20 topics with skewed popularity, 4 ranks, ' +
      'fallback tracks, a meeting-time match, partner requests; 4 never answered (spread).',
  },
  'pairs-27-group': {
    people: 27,
    silent: 4,
    generatorSeed: 2701,
    ns: 0x2700,
    nonRespondents: 'group',
    seed: 27,
    about:
      'Synthetic: 27 people in pairs (one trio), 20 topics with skewed popularity, 4 ranks, ' +
      'fallback tracks, a meeting-time match, partner requests; 4 never answered (grouped, two stages).',
  },
  'pairs-27-default': {
    people: 27,
    silent: 4,
    generatorSeed: 2701,
    ns: 0x2700,
    nonRespondents: null,
    teamCountMax: 9,
    seed: 27,
    about:
      'Synthetic: the pairs-27 cohort with at most 9 teams and the setting for people who ' +
      "didn't answer left at its default; grouped, the 23 who answered can't fit the 7 teams " +
      'left, so they are spread: 9 teams of 3.',
  },
  'pairs-28-group': {
    people: 28,
    silent: 5,
    generatorSeed: 2801,
    ns: 0x2800,
    nonRespondents: 'group',
    seed: 28,
    about:
      'Synthetic: 28 people in pairs, 20 topics with skewed popularity, 4 ranks, fallback ' +
      'tracks, a meeting-time match, partner requests; 5 never answered (grouped, two stages): ' +
      'a team of 3 for each.',
  },
};

function pairsCohort(name: PairsName): GoldenInputs {
  const spec = PAIRS[name];
  const ns = (k: number) => spec.ns + k;
  const generatorSeed = spec.generatorSeed;
  const r = rng(generatorSeed);
  const F = {
    ranked: uuid(ns(1), 1),
    tracks: uuid(ns(1), 2),
    comfort: uuid(ns(1), 3),
    timing: uuid(ns(1), 4),
    partners: uuid(ns(1), 5),
    notes: uuid(ns(1), 6),
  };
  const topics = Array.from({ length: 20 }, (_, i) => option(uuid(ns(2), i + 1), `Topic ${i + 1}`));
  const tracks = TRACKS.map((label, i) => option(uuid(ns(3), i + 1), label));
  const timing = ['Mornings', 'Afternoons', 'Evenings', 'No preference'].map((label, i) =>
    option(uuid(ns(4), i + 1), label)
  );
  const users = Array.from({ length: spec.people }, (_, i) => uuid(ns(9), i + 1));
  /** Topic i belongs to track i mod 6. */
  const trackOf = (i: number) => TRACKS[i % TRACKS.length]!;

  const fields = parseFormDefinition([
    {
      id: F.ranked,
      type: 'ranked_choice',
      label: "Rank the topics you'd like to work on",
      required: true,
      ranks: 4,
      options: topics,
    },
    {
      id: F.tracks,
      type: 'multiselect',
      label: 'Which tracks interest you?',
      options: tracks,
    },
    {
      id: F.comfort,
      type: 'opinion_scale',
      label: 'How comfortable are you with the tools we will use?',
      scale: { min: 1, max: 5 },
    },
    { id: F.timing, type: 'dropdown', label: 'When can you meet?', options: timing },
    {
      id: F.partners,
      type: 'roster_select',
      label: 'Who would you like to work with?',
      optionSource: 'roster',
      multiple: true,
      options: rosterOptions(users),
    },
    { id: F.notes, type: 'long_text', label: 'Anything else we should know?' },
  ]).fields;

  const silent = new Set(r.shuffle(users).slice(0, spec.silent));
  const respondents = users.filter(user => !silent.has(user));
  const byPopularity = r.shuffle(topics.map(topic => topic.id));
  const asks = partnerRequests(r, respondents, users, 1);
  const noted = new Set(r.shuffle(respondents).slice(0, 2));
  let noteNumber = 0;

  const rankings = new Map(
    respondents.map(user => [
      user,
      r.draw(
        byPopularity,
        byPopularity.map((_, rank) => TOPIC_WEIGHTS[rank]!),
        4
      ),
    ])
  );
  rankAlike(r, rankings, asks, new Set());

  const responses = respondents.map((user, i) => {
    const answers = answered({
      [F.ranked]: rankings.get(user),
      [F.tracks]: r.shuffle(tracks.map(track => track.id)).slice(0, r.int(1, 2)),
      [F.comfort]: r.weighted([1, 2, 3, 4, 5], [2, 3, 5, 3, 2]),
      [F.timing]: r.weighted(
        timing.map(time => time.id),
        [30, 25, 25, 20]
      ),
      [F.partners]: asks.get(user),
      [F.notes]: noted.has(user) ? `Invented note ${++noteNumber}` : undefined,
    });
    return { response_id: uuid(ns(8), i + 1), user_id: user, answers };
  });

  const config: TeamSetConfigInput = {
    version: 1,
    grouping: { mode: 'by_option', field_id: F.ranked, teams_per_option: 1 },
    team_size: { min: 2, max: 2 },
    ...(spec.teamCountMax ? { team_count: { max: spec.teamCountMax } } : {}),
    ...(spec.nonRespondents ? { non_respondents: spec.nonRespondents } : {}),
    fairness: 50,
    options: Object.fromEntries(topics.map((topic, i) => [topic.id, { category: trackOf(i) }])),
    rules: [
      { field_id: F.ranked, job: 'rank', strength: 'prefer', weight: 8 },
      { field_id: F.tracks, job: 'fallback', strength: 'prefer', weight: 5 },
      { field_id: F.comfort, job: 'balance', strength: 'prefer', weight: 3 },
      {
        field_id: F.timing,
        job: 'match',
        strength: 'prefer',
        weight: 4,
        params: { wildcard_option_ids: [timing[3]!.id] },
      },
      { field_id: F.partners, job: 'together', strength: 'prefer', weight: 5 },
      { field_id: F.notes, job: 'note', strength: 'prefer' },
    ],
    team_name_template: '{set}-{option}',
    time_limit_s: TIME_LIMIT_S,
  };

  return {
    name,
    about: spec.about,
    generator_seed: generatorSeed,
    fields,
    roster: users.map(user_id => ({ user_id })),
    responses,
    config: TeamSetConfigSchema.parse(config),
    seed: spec.seed,
  };
}

// ─── free-31 ────────────────────────────────────────────────────────────────

function free31(): GoldenInputs {
  const generatorSeed = 3101;
  const r = rng(generatorSeed);
  const F = {
    partners: uuid(0x3101, 1),
    avoid: uuid(0x3101, 2),
    timing: uuid(0x3101, 3),
    remote: uuid(0x3101, 4),
  };
  const timing = ['Mornings', 'Afternoons', 'Evenings', 'No preference'].map((label, i) =>
    option(uuid(0x3104, i + 1), label)
  );
  const users = Array.from({ length: 31 }, (_, i) => uuid(0x3109, i + 1));

  const fields = parseFormDefinition([
    {
      id: F.partners,
      type: 'roster_select',
      label: 'Who would you like to work with?',
      optionSource: 'roster',
      multiple: true,
      options: rosterOptions(users),
    },
    {
      id: F.avoid,
      type: 'roster_select',
      label: 'Anyone you would rather not work with?',
      optionSource: 'roster',
      multiple: false,
      options: rosterOptions(users),
    },
    { id: F.timing, type: 'dropdown', label: 'When can you meet?', options: timing },
    { id: F.remote, type: 'switch', label: 'Are you working remotely this term?' },
  ]).fields;

  const silent = new Set(r.shuffle(users).slice(0, 3));
  const respondents = users.filter(user => !silent.has(user));
  const asks = partnerRequests(r, respondents, users, 2);
  const avoiders = new Set(r.shuffle(respondents).slice(0, 3));

  const responses = respondents.map((user, i) => {
    const mine = asks.get(user) ?? [];
    const answers = answered({
      [F.partners]: mine,
      [F.avoid]: avoiders.has(user)
        ? r.shuffle(users.filter(other => other !== user && !mine.includes(other)))[0]
        : undefined,
      [F.timing]: r.weighted(
        timing.map(time => time.id),
        [30, 25, 25, 20]
      ),
      [F.remote]: r.chance(0.15),
    });
    return { response_id: uuid(0x3108, i + 1), user_id: user, answers };
  });

  const config: TeamSetConfigInput = {
    version: 1,
    grouping: { mode: 'free' },
    team_size: { min: 4, max: 4 },
    non_respondents: 'include',
    fairness: 50,
    rules: [
      { field_id: F.partners, job: 'together', strength: 'prefer', weight: 6 },
      { field_id: F.avoid, job: 'apart', strength: 'must', weight: 5 },
      {
        field_id: F.timing,
        job: 'match',
        strength: 'prefer',
        weight: 3,
        params: { wildcard_option_ids: [timing[3]!.id] },
      },
      { field_id: F.remote, job: 'no_one_alone', strength: 'prefer', weight: 4 },
    ],
    time_limit_s: TIME_LIMIT_S,
  };

  return {
    name: 'free-31',
    about:
      'Synthetic: 31 people in free teams of 4 (7 of 4 and 1 of 3), partner requests, a few ' +
      '"rather not" asks, a meeting-time match, nobody remote alone; 3 never answered (spread).',
    generator_seed: generatorSeed,
    fields,
    roster: users.map(user_id => ({ user_id })),
    responses,
    config: TeamSetConfigSchema.parse(config),
    seed: 31,
  };
}

/** The inputs of one golden cohort, drawn afresh (JSON-clean, as stored). */
export function generateInputs(name: GoldenName): GoldenInputs {
  const inputs =
    name === 'projects-24' ? projects24() : name === 'free-31' ? free31() : pairsCohort(name);
  return JSON.parse(JSON.stringify(inputs)) as GoldenInputs;
}

// ─── Compile, hash, check ───────────────────────────────────────────────────

/** JSON with every object's keys sorted, so the hash doesn't depend on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item ?? null)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const problemSha256 = (problem: TeamSetProblem) =>
  createHash('sha256').update(canonicalJson(problem)).digest('hex');

/** Counts per term and constraint kind: a readable diff when the hash moves. */
export function problemShape(problem: TeamSetProblem) {
  const hard: Record<string, number> = {};
  for (const h of problem.hard) hard[h.kind] = (hard[h.kind] ?? 0) + 1;
  return {
    version: problem.version,
    people: problem.people.length,
    options: problem.options.length,
    slots: problem.slots.length,
    size: problem.size,
    team_count: problem.team_count,
    place: problem.place.length,
    place_total: problem.place.reduce((sum, entry) => sum + entry.cost, 0),
    pair: problem.pair.length,
    pair_total: problem.pair.reduce((sum, entry) => sum + entry.cost, 0),
    hard: Object.fromEntries(Object.entries(hard).sort(([a], [b]) => (a < b ? -1 : 1))),
    soft_counts: problem.soft_counts.length,
    balance: problem.balance.length,
    worst_off_weight: problem.worst_off_weight,
    group_members: problem.group ? problem.group.members.length : null,
    time_limit_s: problem.time_limit_s,
  };
}

export interface CompiledGolden {
  config: TeamSetConfig;
  problem: TeamSetProblem;
  context: TeamSetContext;
  /** The non_respondents mode the compile used (a default Group may be Spread). */
  non_respondents: TeamSetNonRespondents;
}

/** Compile a cohort exactly as startRun does (the config re-parsed from storage). */
export function compileGolden(inputs: GoldenInputs): CompiledGolden {
  const config = TeamSetConfigSchema.parse(inputs.config);
  const { problem, context, non_respondents } = compileProblem({
    setName: inputs.name,
    config,
    fields: inputs.fields,
    responses: inputs.responses,
    roster: inputs.roster,
    seed: inputs.seed,
  });
  return { config, problem, context, non_respondents };
}

/**
 * What would stop a run: config problems, invalid answers, check errors.
 * Returns the warning codes (sorted) when there is nothing.
 */
export function goldenWarnings(inputs: GoldenInputs, compiled: CompiledGolden): string[] {
  const configProblems = validateConfigAgainstForm(compiled.config, inputs.fields);
  if (configProblems.length) throw new Error(`${inputs.name}: ${configProblems.join('; ')}`);
  for (const response of inputs.responses) parseAnswers(inputs.fields, response.answers);
  const issues = runChecks(compiled.problem, compiled.context, {
    config: compiled.config,
    fields: inputs.fields,
  });
  const errors = issues.filter(issue => issue.level === 'error');
  if (errors.length) {
    throw new Error(`${inputs.name}: check errors ${errors.map(issue => issue.code).join(', ')}`);
  }
  return issues
    .filter(issue => issue.level === 'warning')
    .map(issue => issue.code)
    .sort();
}

/** The metrics a finished run stores for these teams. */
export function goldenMetrics(
  compiled: CompiledGolden,
  teams: TeamSetAssignment[]
): TeamSetMetrics {
  return computeMetrics(compiled.problem, compiled.context, teams, {
    nonRespondents: compiled.non_respondents,
  }).metrics;
}

// ─── The local engine ───────────────────────────────────────────────────────

const PYTHON_DIR = resolve(GOLDEN_DIR, '../../../../../tasks/python');
const SCRIPT = join(PYTHON_DIR, 'team_set_solver.py');
/** CP-SAT workers, as the Trigger task runs it (TEAM_SET_SOLVER_WORKERS in packages/tasks). */
const WORKERS = 2;

/** packages/tasks/python/.venv's python (or PYTHON_BIN_PATH) if it imports OR-Tools; else null. */
export function findPython(): string | null {
  if (!existsSync(SCRIPT)) return null;
  for (const bin of [join(PYTHON_DIR, '.venv', 'bin', 'python'), process.env.PYTHON_BIN_PATH]) {
    if (!bin || !existsSync(bin)) continue;
    if (spawnSync(bin, ['-c', 'import ortools'], { timeout: 60_000 }).status === 0) return bin;
  }
  return null;
}

/** The engine's result line (packages/tasks/python/README.md), the fields used here. */
export interface EngineResult {
  status: TeamSetSolveStatus;
  teams: TeamSetAssignment[];
  objective: number | null;
  core: string[];
  stages?: {
    first: { status: TeamSetSolveStatus; objective: number | null };
    second: { status: TeamSetSolveStatus; objective: number | null } | null;
  };
}

/** Run the engine on a problem; resolves with its `{"type":"result"}` line. */
export function solveWithEngine(python: string, problem: TeamSetProblem): Promise<EngineResult> {
  const dir = mkdtempSync(join(tmpdir(), 'team-set-golden-'));
  const file = join(dir, 'problem.json');
  writeFileSync(file, JSON.stringify(problem));
  return new Promise<EngineResult>((done, fail) => {
    execFile(
      python,
      [SCRIPT, file, '--workers', String(WORKERS)],
      { encoding: 'utf8', timeout: (problem.time_limit_s * 2 + 60) * 1000, maxBuffer: 64 << 20 },
      (error, stdout, stderr) => {
        if (error) {
          fail(new Error(`engine failed: ${error.message}\n${stderr.slice(-2000)}`));
          return;
        }
        const line = stdout
          .split('\n')
          .reverse()
          .find(text => text.startsWith('{"type":"result"'));
        if (!line) fail(new Error('engine printed no result line'));
        else done(JSON.parse(line) as EngineResult);
      }
    );
  }).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// ─── Building a fixture ─────────────────────────────────────────────────────

const byTeamSlot = (teams: TeamSetAssignment[]) =>
  teams
    .map(team => ({ slot: team.slot, members: [...team.members].sort((a, b) => a - b) }))
    .sort((a, b) => a.slot - b.slot);

/** Do these teams reach `objective` (and each stage's) with nothing broken? */
function reaches(
  problem: TeamSetProblem,
  teams: TeamSetAssignment[],
  objective: number,
  stages: GoldenExpected['stages']
): boolean {
  const score = scoreAssignment(problem, teams);
  if (score.violations.length || score.objective !== objective) return false;
  return (
    stages === null || (score.parts.first === stages.first && score.parts.second === stages.second)
  );
}

/**
 * Generate one cohort, solve it with the local engine and record what came
 * back. Refuses anything that isn't a proven optimum the scorer agrees with.
 * `previous` (the stored fixture) keeps its teams when they still reach the
 * new optimum, so regenerating an unchanged cohort changes nothing.
 */
export async function buildGolden(
  name: GoldenName,
  python: string,
  previous?: GoldenFixture
): Promise<GoldenFixture> {
  const inputs = generateInputs(name);
  const compiled = compileGolden(inputs);
  const warnings = goldenWarnings(inputs, compiled);
  const { problem } = compiled;
  const output = await solveWithEngine(python, problem);
  if (output.status !== 'OPTIMAL' || output.objective === null) {
    throw new Error(`${name}: the engine answered ${output.status}, not a proven optimum`);
  }
  let stages: GoldenExpected['stages'] = null;
  if (problem.group) {
    const first = output.stages?.first.objective ?? null;
    const second = output.stages?.second?.objective ?? null;
    if (first === null || second === null) {
      throw new Error(`${name}: a two-stage answer without both stages`);
    }
    stages = { first, second };
  }
  if (!reaches(problem, output.teams, output.objective, stages)) {
    throw new Error(`${name}: the scorer disagrees with the engine`);
  }
  const keep =
    previous !== undefined && reaches(problem, previous.expected.teams, output.objective, stages);
  const teams = byTeamSlot(keep ? previous.expected.teams : output.teams);
  const metrics = goldenMetrics(compiled, teams);
  if (metrics.must_broken !== 0) throw new Error(`${name}: ${metrics.must_broken} must broken`);
  return {
    ...inputs,
    expected: {
      problem_sha256: problemSha256(problem),
      problem_shape: problemShape(problem),
      warnings,
      status: 'OPTIMAL',
      objective: output.objective,
      stages,
      teams,
      metrics,
    },
  };
}

export const goldenPath = (name: GoldenName) => join(GOLDEN_DIR, `${name}.json`);

export function readGolden(name: GoldenName): GoldenFixture {
  return JSON.parse(readFileSync(goldenPath(name), 'utf8')) as GoldenFixture;
}

/** The fixture file's text: JSON formatted by the repo's Prettier config. */
async function fixtureText(fixture: GoldenFixture, file: string): Promise<string> {
  const prettier = await import('prettier');
  const options = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(JSON.stringify(fixture), { ...options, parser: 'json' });
}

async function main(argv: string[]) {
  const write = argv.includes('--write');
  const python = findPython();
  if (!python) {
    console.error('No python with OR-Tools; see packages/tasks/python/README.md.');
    process.exit(2);
  }
  let changed = 0;
  for (const name of GOLDEN_CASES) {
    const file = goldenPath(name);
    const previous = existsSync(file) ? readGolden(name) : undefined;
    const fixture = await buildGolden(name, python, previous);
    const text = await fixtureText(fixture, file);
    const same = existsSync(file) && readFileSync(file, 'utf8') === text;
    if (!same) changed++;
    console.log(
      `${name}: objective ${fixture.expected.objective}` +
        `${fixture.expected.stages ? ` (${fixture.expected.stages.first} + ${fixture.expected.stages.second})` : ''}` +
        `, ${same ? 'unchanged' : write ? 'written' : 'differs from the stored file'}`
    );
    if (write && !same) writeFileSync(file, text);
  }
  if (changed && !write) {
    console.log('Run again with --write to rewrite the fixtures.');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
