/**
 * Team sets copy: every sentence the pure team-set modules produce for a
 * person to read is a fact. The page shows them as they are — config
 * problems (the schema's and against the form) and patch notes
 * (teamSetConfig), check messages with the passed lines (teamSetChecks), and
 * the Can't-solve labels and summary, setup changes and Must sentences
 * (teamSetExplain). teamSetMetrics produces numbers only. The service's own
 * sentences come from teamSetServiceText (why a run is out of date, the
 * create preview's warnings, the refusals a page lists) and, for what
 * Discard left out, teamSetConfig's leftOutNotes; they are scanned too.
 *
 * This produces them from representative setups (the shared fixtures, each
 * patched many ways) and scans them for advice, narration of timing or
 * mechanics, and course names. Advice for agents lives in the MCP hints.
 */

import { describe, expect, it } from 'vitest';
import type { FormField } from '../formContract.ts';
import {
  TeamSetConfigError,
  applyConfigPatch,
  applyConfigPatchWithNotes,
  leftOutNotes,
  validateConfigAgainstForm,
  type TeamSetConfig,
  type TeamSetConfigPatchInput,
  type TeamSetJob,
} from '../teamSetConfig.ts';
import { runChecks } from '../teamSetChecks.ts';
import {
  coreItems,
  diffConfigs,
  explainLabels,
  infeasibleSummary,
  ruleMustLabel,
} from '../teamSetExplain.ts';
import { compileProblem, type CompileInput } from '../teamSetProblem.ts';
import {
  SET_BUSY_RUN_TEXT,
  SET_BUSY_TEXT,
  SET_NAME_EMPTY_TEXT,
  changedSinceRunWarning,
  nameCollisionText,
  namesNotCheckedWarning,
  noLoginWarning,
  pinPeopleOutsideText,
  retryBlockedText,
  staleReasonTexts,
  type StaleFacts,
} from '../teamSetServiceText.ts';
import {
  B,
  BID_IDENTITY_IDS,
  BID_PROJECT_IDS,
  BID_USERS,
  F,
  MATTERS_IDS,
  PROJECT_IDS,
  USER_IDS,
  biddingConfig,
  biddingFields,
  biddingInput,
  miniInput,
  workshopConfig,
  workshopFields,
  workshopInput,
  uuid,
} from './helpers/teamSetFixtures.ts';

/** Advice, narration of timing or mechanics, course names. */
const BANNED: RegExp[] = [
  /\bshould\b/i,
  /\btr(y|ies|ied|ying)\b/i,
  /\bconsider/i,
  /\binstead\b/i,
  /\bplease\b/i,
  /\brecommend/i,
  /\bsuggest/i,
  /\bloosen/i,
  /\bmake sure\b/i,
  /\byou (can|could|might|may want)\b/i,
  /\bbecause\b/i,
  /\bbest single change\b/i,
  /\babout\b/i,
  /\bserver\b/i,
  /\bbackground\b/i,
  /\bqueue/i,
  /\bworker/i,
  /\bthrottl/i,
  /\b(background|queued|running) jobs?\b/i,
  /\bseconds?\b/i,
  /\bminutes?\b/i,
  /\b\d+(\.\d+)?\s?(s|ms)\b/,
  /\bclaude\b/i,
  /\bCS\s?\d{2,3}\b/i,
  /\b\d{2}[FWSX]\b/,
  /\bdartmouth\b/i,
];

/** The problems a refused patch or config carries (TeamSetConfigError), else none. */
function problemsOf(action: () => unknown): string[] {
  try {
    const result = action();
    return Array.isArray(result) ? (result as string[]) : [];
  } catch (error) {
    if (error instanceof TeamSetConfigError) return error.problems;
    throw error;
  }
}

const P = BID_PROJECT_IDS as [string, string, string, string, string];

/** Patches the page or an agent could send, several of them refused. */
const WORKSHOP_PATCHES: TeamSetConfigPatchInput[] = [
  {},
  { team_size: { min: 3, max: 2 } },
  { team_size: { min: 0, max: 2 } },
  { team_size: { min: 2, max: 2 }, team_count: { max: 5 } },
  { team_count: { min: 9, max: 3 } },
  { fairness: 150 },
  { time_limit_s: 1 },
  { team_name_template: '' },
  { non_respondents: 'group' },
  { non_respondents: 'exclude' },
  // Group leaves the people who answered too few teams: refused when chosen,
  // spread by default.
  { non_respondents: 'group', team_count: { max: 9 } },
  { non_respondents: null, team_count: { max: 9 } },
  { rules: { upsert: [{ field_id: F.projects, job: 'rank', strength: 'must', weight: 99 }] } },
  { rules: { upsert: [{ field_id: F.projects, job: 'rank', strength: 'must' }] } },
  { rules: { upsert: [{ field_id: F.timing, job: 'rank', strength: 'prefer' }] } },
  { rules: { upsert: [{ field_id: F.timing, job: 'match', strength: 'must' }] } },
  { rules: { upsert: [{ field_id: F.partners, job: 'together', strength: 'must' }] } },
  { rules: { upsert: [{ field_id: F.partners, job: 'apart', strength: 'must' }] } },
  { rules: { upsert: [{ field_id: F.tracks, job: 'fallback', strength: 'must' }] } },
  {
    options: Object.fromEntries(
      PROJECT_IDS.slice(0, 14).map(id => [id, { open: 'closed' as const }])
    ),
  },
  { options: { [PROJECT_IDS[0]]: { open: 'open' }, [PROJECT_IDS[1]]: { size: { min: 4 } } } },
  { options: { [PROJECT_IDS[2]]: { size: { min: 3, max: 2 } } } },
  {
    pins: {
      add: [
        { kind: 'together', user_ids: [USER_IDS[0], USER_IDS[1], USER_IDS[2], USER_IDS[3]] },
        { kind: 'apart', user_ids: [USER_IDS[0], USER_IDS[1]] },
        { kind: 'on_option', user_id: USER_IDS[4], option_id: PROJECT_IDS[0] },
        { kind: 'not_options', user_id: USER_IDS[4], option_ids: [PROJECT_IDS[0]] },
        { kind: 'on_option', user_id: USER_IDS[5], option_id: PROJECT_IDS[19] },
      ],
    },
  },
  { grouping: { mode: 'free' } },
  { grouping: { mode: 'by_option', field_id: F.projects, teams_per_option: 2 } },
];

const BIDDING_PATCHES: TeamSetConfigPatchInput[] = [
  {},
  // More teams than the five usable slots: no team count fits.
  { team_count: { min: 6 } },
  { team_size: { min: 2, max: 2 }, non_respondents: null },
  { team_size: { min: 3, max: 5 }, non_respondents: 'group' },
  { team_size: { min: 4, max: 4 }, non_respondents: 'group' },
  // The one option that can open always runs with its one team.
  {
    team_size: { min: 2, max: 2 },
    non_respondents: 'group',
    options: {
      [P[0]]: { open: 'open' },
      [P[1]]: { open: 'closed' },
      [P[2]]: { open: 'closed' },
      [P[3]]: { open: 'closed' },
      [P[4]]: { open: 'closed' },
    },
  },
  // Options of different sizes for the people who didn't answer.
  {
    team_size: { min: 2, max: 3 },
    non_respondents: 'group',
    options: { [P[0]]: { size: { min: 3, max: 4 } } },
  },
  // No option can open.
  {
    non_respondents: 'group',
    options: Object.fromEntries(P.map(id => [id, { open: 'closed' as const }])),
  },
  {
    options: { [P[0]]: { open: 'closed' }, [P[1]]: { open: 'closed' }, [P[2]]: { open: 'closed' } },
  },
  { rules: { upsert: [{ field_id: B.pitched, job: 'owner', strength: 'must' }] } },
  {
    rules: { upsert: [{ field_id: B.pitched, job: 'owner', strength: 'must' }] },
    options: { [P[3]]: { open: 'open' } },
    pins: { add: [{ kind: 'on_option', user_id: BID_USERS[0], option_id: P[4] }] },
  },
  {
    rules: {
      upsert: [
        {
          field_id: B.identity,
          job: 'no_one_alone',
          strength: 'prefer',
          params: { wildcard_option_ids: [BID_IDENTITY_IDS[3]] },
        },
      ],
    },
  },
  {
    team_size: { min: 2, max: 2 },
    rules: { upsert: [{ field_id: B.identity, job: 'no_one_alone', strength: 'prefer' }] },
  },
  { rules: { upsert: [{ field_id: B.identity, job: 'match', strength: 'must' }] } },
  {
    rules: {
      upsert: [
        {
          field_id: B.matters,
          job: 'priority',
          strength: 'prefer',
          params: {
            rule_a: `${B.projects}:rank`,
            rule_b: `${B.partners}:together`,
            answers: { [MATTERS_IDS[0]]: 'a', [MATTERS_IDS[1]]: 'b', [MATTERS_IDS[2]]: 'none' },
          },
        },
        { field_id: B.partners, job: 'together', strength: 'off' },
      ],
    },
  },
  {
    rules: {
      upsert: [
        {
          field_id: B.matters,
          job: 'priority',
          strength: 'prefer',
          params: { rule_a: `${B.projects}:rank`, rule_b: `${B.projects}:rank` },
        },
      ],
    },
  },
];

interface Produced {
  config: string[];
  checks: string[];
  explain: string[];
  service: string[];
}

/** Every sentence teamSet.service writes itself, every branch. */
function produceService(): string[] {
  const out: string[] = [];
  const everything: StaleFacts = {
    republished: true,
    identity: true,
    edited: 2,
    added: 1,
    removed: 3,
    roster: { joined: 1, left: 2 },
  };
  for (const republished of [false, true]) {
    for (const identity of [false, true]) {
      for (const n of [0, 1, 4]) {
        for (const roster of [null, { joined: 0, left: 0 }, { joined: 1, left: 0 }]) {
          out.push(
            ...staleReasonTexts({ republished, identity, edited: n, added: n, removed: n, roster })
          );
        }
      }
    }
  }
  out.push(
    namesNotCheckedWarning(60),
    noLoginWarning(1),
    noLoginWarning(4),
    changedSinceRunWarning(3, staleReasonTexts(everything)),
    nameCollisionText(['project-teams-01']),
    nameCollisionText(['project-teams-01', 'project-teams-02']),
    pinPeopleOutsideText(1),
    pinPeopleOutsideText(3),
    retryBlockedText(1),
    retryBlockedText(2),
    SET_BUSY_TEXT,
    SET_BUSY_RUN_TEXT,
    SET_NAME_EMPTY_TEXT
  );
  const [rule] = workshopConfig().rules;
  out.push(
    ...leftOutNotes(
      3,
      {
        rules: [
          { field_id: rule!.field_id, job: rule!.job },
          { field_id: null, job: null },
          { field_id: uuid(99, 1), job: 'note' },
        ],
        pins: 2,
        options: [PROJECT_IDS[0], uuid(99, 2)],
        settings: ['fairness', 'time_limit_s', 'last_pin_number'],
      },
      workshopFields()
    ),
    ...leftOutNotes(1, { rules: [], pins: 1, options: ['x'], settings: ['rules'] })
  );
  return out;
}

function produce(): Produced {
  const out: Produced = { config: [], checks: [], explain: [], service: produceService() };
  const cases: {
    base: TeamSetConfig;
    fields: FormField[];
    input: CompileInput;
    patch: TeamSetConfigPatchInput;
  }[] = [
    ...WORKSHOP_PATCHES.map(patch => ({
      base: workshopConfig(),
      fields: workshopFields(),
      input: workshopInput(),
      patch,
    })),
    ...BIDDING_PATCHES.map(patch => ({
      base: biddingConfig(),
      fields: biddingFields(),
      input: biddingInput(),
      patch,
    })),
  ];

  for (const { base, fields, input, patch } of cases) {
    // Config: the patch's own problems, its notes, and the result against the form.
    let config: TeamSetConfig | null = null;
    out.config.push(
      ...problemsOf(() => {
        const result = applyConfigPatchWithNotes(base, patch, fields);
        out.config.push(...result.notes);
        config = result.config;
        return [];
      })
    );
    if (!config) continue;
    const fits = validateConfigAgainstForm(config, fields);
    out.config.push(...fits);

    // Explain: what changed, as the header chip and Setup list it.
    const labels = explainLabels(fields, config);
    out.explain.push(...diffConfigs(base, config, labels).map(change => change.text));
    if (fits.length > 0) continue;

    // Checks, passed lines included.
    let compiled: ReturnType<typeof compileProblem>;
    try {
      compiled = compileProblem({ ...input, config });
    } catch (error) {
      if (error instanceof TeamSetConfigError) {
        out.config.push(...error.problems);
        continue;
      }
      throw error;
    }
    const issues = runChecks(compiled.problem, compiled.context, {
      config,
      fields,
      includePassed: true,
    });
    out.checks.push(...issues.map(issue => issue.message));

    // Can't solve: every src this problem could name, labelled with and without names.
    const srcs = [
      ...compiled.problem.hard.map(h => h.src),
      ...compiled.problem.options.map(option => `option:${option.id}`),
      ...compiled.problem.options.map(option => `size:${option.id}`),
      'non_respondents',
      'pin:p99',
      'garbage',
    ];
    const run = { config, problem: compiled.problem, context: compiled.context };
    const names = new Map(compiled.problem.people.map((id, i) => [id, `Person ${i + 1}`]));
    for (const withNames of [true, false]) {
      const items = coreItems(srcs, {
        run,
        labels: explainLabels(fields, config, withNames ? names : undefined),
        fields,
      });
      out.explain.push(...items.map(item => item.label));
    }
  }

  // The Can't-solve sentence, every branch.
  const stages = (first: string, second: string | null) => ({
    first: { status: first as 'OPTIMAL', objective: 1, bound: 1 },
    second: second === null ? null : { status: second as 'INFEASIBLE', objective: null },
  });
  for (const facts of [
    { core: 3 },
    { core: 3, core_status: 'timeout' as const },
    { core: 0, core_status: 'complete' as const },
    { core: 0, core_status: 'timeout' as const },
    { core: 0 },
    { core: 1, stages: stages('OPTIMAL', 'INFEASIBLE'), group: 1 },
    { core: 1, stages: stages('OPTIMAL', 'INFEASIBLE'), group: 4 },
    { core: 1, stages: stages('OPTIMAL', 'INFEASIBLE'), group: 4, free: true },
    { core: 1, stages: stages('OPTIMAL', null), group: 1, free: true },
  ]) {
    out.explain.push(infeasibleSummary(facts));
  }

  // Must sentences for every job on every question type the fixtures have.
  const jobs: TeamSetJob[] = [
    'rank',
    'fallback',
    'owner',
    'together',
    'apart',
    'match',
    'mix',
    'balance',
    'no_one_alone',
    'note',
    'priority',
  ];
  for (const field of [...workshopFields(), ...biddingFields()]) {
    for (const job of jobs) {
      for (const params of [{}, { must_top: 2 }, { mutual_only: false }, { max_per_team: 1 }]) {
        const label = ruleMustLabel({ job, params }, field);
        if (label) out.explain.push(label);
      }
    }
  }

  // The mini fixture's plain setups.
  const mini = miniInput();
  const { problem, context } = compileProblem(mini);
  out.checks.push(
    ...runChecks(problem, context, {
      config: mini.config,
      fields: mini.fields,
      includePassed: true,
    }).map(issue => issue.message)
  );
  // A patch refused outright: an unknown setting.
  out.config.push(
    ...problemsOf(() =>
      applyConfigPatch(workshopConfig(), { nonsense: true } as unknown as TeamSetConfigPatchInput)
    )
  );
  return out;
}

describe('team-set copy: every produced sentence is a fact', () => {
  const produced = produce();
  const all = [...produced.config, ...produced.checks, ...produced.explain, ...produced.service];

  it('produces a broad sample from each module', () => {
    expect(produced.config.length).toBeGreaterThan(10);
    expect(produced.checks.length).toBeGreaterThan(60);
    expect(produced.explain.length).toBeGreaterThan(150);
    expect(produced.service.length).toBeGreaterThan(40);
    expect(produced.service).toContain('A question this run used is now an identity question.');
    expect(produced.service).toContain('Left out of run 3’s setup: 2 pins.');
    // The remainder flex is stated as a fact, not a promise.
    expect(produced.checks).toContain('27 people: 12 teams of 2 and 1 team of 3.');
    expect(produced.checks).toContain('27 people: 9 teams of 3.');
    expect(produced.checks).toContainEqual(
      expect.stringContaining("after the 2 teams for the people who didn't answer")
    );
    expect(produced.checks).toContainEqual(
      expect.stringContaining('the options that can open have no team left for them')
    );
    expect(produced.checks).toContainEqual(expect.stringContaining('and no option can open.'));
    expect(produced.checks).toContainEqual(expect.stringContaining('on the options they can take'));
    expect(produced.checks).toContainEqual(expect.stringContaining(', no team count fits)'));
  });

  it('never states a team count range that runs backwards', () => {
    const reversed = produced.checks.filter(text =>
      [...text.matchAll(/team count (\d+)–(\d+)/g)].some(([, a, b]) => Number(a) > Number(b))
    );
    expect(reversed).toEqual([]);
  });

  it.each([
    ['config problems and notes', 'config'],
    ['check messages', 'checks'],
    ['explain texts', 'explain'],
    ['the service’s own sentences', 'service'],
  ] as const)('%s: no advice, narration of timing or mechanics, or course names', (_what, key) => {
    const hits = produced[key].flatMap(text =>
      BANNED.filter(pattern => pattern.test(text)).map(pattern => `${pattern.source}: ${text}`)
    );
    expect(hits).toEqual([]);
  });

  it('never shows a config key or an internal id to a person', () => {
    const keys =
      /\b(allow_one_larger|non_respondents|team_size|teams_per_option|wildcard_option_ids|field_id|option_id|user_ids?)\b/;
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const leaks = all.filter(text => keys.test(text) || uuid.test(text));
    expect(leaks).toEqual([]);
  });
});
