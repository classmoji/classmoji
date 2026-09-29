import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect } from '@playwright/test';

import { TEAM_SET_JOB_FIELD_TYPES } from '@classmoji/services/team-set-config';

import {
  CREATE_FAILURE_REASONS,
  MEMBER_FAILURE_REASONS,
  PAGE_ERROR_CODES,
  RUN_ERROR_CODES,
  TEAM_SET_ERROR_CODES,
  allErrorSentences,
  createFailureSentence,
  memberFailureSentence,
  runErrorSentence,
  teamsErrorFrom,
  teamsErrorSentence,
  teamsErrorView,
} from '../../app/components/forms/teams/teamsErrors.ts';
import * as view from '../../app/components/forms/teams/teamsView.ts';
import type {
  CreateProgressView,
  PinView,
  PlacementFacts,
  TeamSetMetrics,
} from '../../app/components/forms/teams/types.ts';

/**
 * The Teams page's error sentences (teamsErrors.ts), and the word rules every
 * Teams string keeps.
 *
 * Pure: runs in the Playwright runner without a browser or the dev stack.
 *
 * ── The word scan ───────────────────────────────────────────────────────────
 * Tim's rules for the page: every string is data, a fixed template filled with
 * facts, or typed text. No fix suggestions ("try", "should", "consider",
 * "loosen"), no timing or mechanics ("about 10 s", "background", "throttled"),
 * no causal story ("because"), no course names, and never "Claude" (an MCP
 * change reads "over MCP"). The scan runs over three things:
 *   1. every error sentence, templated ones filled with sample details;
 *   2. the teamsView templates, rendered from sample facts;
 *   3. every string literal and JSX text in app/components/forms/teams/**
 *      and app/forms/admin/teams/** (the routes and their server half), so
 *      the components and screens added later are held to the same words.
 * Word boundaries matter: "Retry" is not "try", and `try {` in code is not a
 * string.
 */

const BANNED: RegExp[] = [
  /\bshould\b/i,
  /\btry\b/i,
  /\bconsider/i,
  /\bloosen/i,
  /\babout\b/i,
  /\bseconds?\b/i,
  /\bminutes?\b/i,
  /\bbackground\b/i,
  /\bthrottl/i,
  /\brecommend/i,
  /\bsuggest/i,
  /\bbest single change\b/i,
  /\byou (can|could|might|may want)\b/i,
  /\bmake sure\b/i,
  /\bbecause\b/i,
  /\bclaude\b/i,
  /\b\d+(\.\d+)?\s?s\b/, // "0.4 s", "12s"
  /\bCS\s?\d{2,3}\b/i,
  /\b\d{2}[FWSX]\b/, // terms: 26F, 27W
  /\bdartmouth\b/i,
];

function bannedIn(text: string): string[] {
  return BANNED.filter(pattern => pattern.test(text)).map(pattern => pattern.source);
}

// ─── Every code has a sentence ──────────────────────────────────────────────

/** The contract's list (release-2 plan §1.3): what the service can refuse with. */
const CONTRACT_SET_CODES = [
  'not_found',
  'invalid_config',
  'no_grouping_field',
  'form_not_classroom',
  'checks_failed',
  'run_not_solved',
  'run_stale',
  'already_created',
  'create_in_progress',
  'tag_conflict',
  'trigger_unavailable',
  'github_unavailable',
  'name_collision',
  'provider_unsupported',
  'set_locked',
  'run_in_progress',
  'name_taken',
  'github_teams_off_unsupported',
  'set_busy',
];

/** TEAM_SET_RUN_ERRORS, spelled out: importing it would load the service (Prisma, Trigger). */
const CONTRACT_RUN_ERRORS = [
  'trigger_unavailable',
  'engine_error',
  'score_mismatch',
  'no_solution_in_time',
  'model_invalid',
  'canceled',
  'lost',
  'queue_expired',
];

const UNKNOWN = teamsErrorSentence('unknown');

test.describe('every code has its own sentence', () => {
  test('the page knows every refusal the contract lists, plus tag_required', () => {
    for (const code of CONTRACT_SET_CODES) {
      expect(TEAM_SET_ERROR_CODES as readonly string[], code).toContain(code);
    }
    expect(PAGE_ERROR_CODES as readonly string[]).toContain('tag_required');
    // One sentence per code: a service code is never also a page code.
    for (const code of PAGE_ERROR_CODES) {
      expect(TEAM_SET_ERROR_CODES as readonly string[], code).not.toContain(code);
    }
    expect([...RUN_ERROR_CODES].sort()).toEqual([...CONTRACT_RUN_ERRORS].sort());
  });

  test('each refusal code maps to itself and a sentence other than the fallback', () => {
    for (const code of [...TEAM_SET_ERROR_CODES, ...PAGE_ERROR_CODES]) {
      const shown = teamsErrorView(code);
      expect(shown.code, code).toBe(code);
      expect(shown.message.length, code).toBeGreaterThan(0);
      if (code !== 'unknown') expect(shown.message, code).not.toBe(UNKNOWN);
    }
  });

  test('each run error has its own sentence', () => {
    const sentences = RUN_ERROR_CODES.map(code => runErrorSentence(code));
    expect(new Set(sentences).size).toBe(RUN_ERROR_CODES.length);
    expect(runErrorSentence(null, 'CANCELED')).toBe('The run was canceled.');
    expect(runErrorSentence(null, 'FAILED')).toBe('The run failed.');
    expect(runErrorSentence('something_new', 'FAILED')).toBe('The run failed.');
  });

  test('each create failure has a sentence; unknown reasons get a plain one', () => {
    for (const reason of CREATE_FAILURE_REASONS) {
      expect(createFailureSentence(reason).length, reason).toBeGreaterThan(0);
    }
    for (const reason of MEMBER_FAILURE_REASONS) {
      expect(memberFailureSentence(reason).length, reason).toBeGreaterThan(0);
    }
    expect(createFailureSentence('something_new')).toBe("The team wasn't made.");
    expect(memberFailureSentence(undefined)).toBe("The member wasn't added.");
  });

  test('an unrecognized code gets the fallback', () => {
    expect(teamsErrorView('db_timeout')).toEqual({ code: 'unknown', message: UNKNOWN, items: [] });
  });

  test('every sentence is a sentence', () => {
    for (const sentence of allErrorSentences()) {
      expect(sentence, sentence).toMatch(/^[A-Z"]/);
      expect(sentence, sentence).toMatch(/[.:]$/);
    }
  });
});

test.describe('sentences are filled from details, and lists stay lists', () => {
  test('the contract’s own examples', () => {
    expect(teamsErrorSentence('set_locked')).toBe(
      "This set's teams exist, so its setup can't change."
    );
    expect(teamsErrorSentence('run_in_progress', { run_number: 7 })).toBe("Run 7 hasn't finished.");
    expect(teamsErrorSentence('run_in_progress', {})).toBe("A run hasn't finished.");
    expect(teamsErrorSentence('run_in_progress', { run_number: 'seven' })).toBe(
      "A run hasn't finished."
    );
  });

  test('taken names and stale reasons come back as items', () => {
    expect(teamsErrorView('name_collision', { names: ['a-1', 'a-2'] })).toEqual({
      code: 'name_collision',
      message: 'These team names are already used in the GitHub organization:',
      items: ['a-1', 'a-2'],
    });
    expect(teamsErrorView('name_collision', { names: ['a-1'] }).message).toBe(
      'This team name is already used in the GitHub organization:'
    );
    expect(teamsErrorView('name_collision').message).toBe(
      'A team name is already used in the GitHub organization.'
    );
    expect(
      teamsErrorView('run_stale', { reasons: ['1 response changed since this run.', 42] }).items
    ).toEqual(['1 response changed since this run.']);
  });

  test('a save the set was too busy for says it was not saved', () => {
    expect(teamsErrorView('set_busy')).toEqual({
      code: 'set_busy',
      message: "This change wasn't saved. The set was busy.",
      items: [],
    });
    const busy = Object.assign(
      new Error('Another save or run held this set; this change was not saved.'),
      { name: 'TeamSetError', code: 'set_busy' }
    );
    expect(teamsErrorFrom(busy)?.message).toBe("This change wasn't saved. The set was busy.");
  });

  test('a run the set was too busy for says no run was started', () => {
    expect(teamsErrorView('set_busy', { action: 'run' })).toEqual({
      code: 'set_busy',
      message: 'No run was started. The set was busy.',
      items: [],
    });
    const busy = Object.assign(
      new Error('Another save or run held this set; no run was started.'),
      { name: 'TeamSetError', code: 'set_busy', details: { action: 'run' } }
    );
    expect(teamsErrorFrom(busy)?.message).toBe('No run was started. The set was busy.');
    // Any other action is a change that wasn't saved.
    expect(teamsErrorView('set_busy', { action: 'save' }).message).toBe(
      "This change wasn't saved. The set was busy."
    );
    expect(allErrorSentences()).toContain('No run was started. The set was busy.');
  });

  test('a taken set name is named when the details carry it', () => {
    expect(teamsErrorView('name_taken', { name: 'project-teams' })).toEqual({
      code: 'name_taken',
      message: 'A team set named "project-teams" is already on this form.',
      items: [],
    });
    expect(teamsErrorSentence('name_taken')).toBe(
      'A team set with that name is already on this form.'
    );
  });

  test("a refused save lists the service's config problems; other details are dropped", () => {
    const problems = [
      'Only one question can be used to rank options.',
      'The fallback rule on "Area" needs a rank rule to fall back from.',
    ];
    expect(teamsErrorView('invalid_config', { problems: [...problems, 7, null] })).toEqual({
      code: 'invalid_config',
      message: "That setting isn't valid for this set.",
      items: problems,
    });
    expect(teamsErrorView('invalid_config', { name: 'x' }).items).toEqual([]);
    expect(teamsErrorView('invalid_config').items).toEqual([]);
  });

  test('details pick the variant', () => {
    expect(teamsErrorSentence('already_created', { run_number: 3, status: 'FAILED' })).toBe(
      'Teams were partly created from run 3; only that run can be retried.'
    );
    expect(teamsErrorSentence('already_created', { run_number: 3, status: 'DONE' })).toBe(
      'Teams were already created from this set.'
    );
    expect(teamsErrorSentence('tag_conflict', { tag: 'project-teams' })).toBe(
      'The tag "project-teams" already has teams.'
    );
    expect(teamsErrorSentence('github_unavailable', { reason: 'timeout' })).toBe(
      "GitHub didn't answer."
    );
  });

  test('a run without teams is named when the details carry its number', () => {
    // compareRuns sends { run_number, status } of the first run that isn't
    // SOLVED; claimCreate sends only { status }.
    expect(teamsErrorView('run_not_solved', { run_number: 3, status: 'INFEASIBLE' })).toEqual({
      code: 'run_not_solved',
      message: 'Run 3 has no teams.',
      items: [],
    });
    expect(teamsErrorSentence('run_not_solved', { status: 'RUNNING' })).toBe(
      "This run isn't solved."
    );
    expect(teamsErrorSentence('run_not_solved', { run_number: 0 })).toBe("This run isn't solved.");
  });

  test('a thrown service refusal maps by code; its message is never used', () => {
    const serviceMessage =
      'Two team names are already used. Change team_name_template (or the set name) and run again.';
    const error = Object.assign(new Error(serviceMessage), {
      name: 'TeamSetError',
      code: 'name_collision',
      details: { names: ['x-1', 'x-2'] },
    });
    const shown = teamsErrorFrom(error);
    expect(shown?.code).toBe('name_collision');
    expect(shown?.items).toEqual(['x-1', 'x-2']);
    expect(shown?.message).not.toContain('team_name_template');

    const teamError = Object.assign(new Error('[team] a team needs a tag'), {
      name: 'TeamServiceError',
      code: 'tag_required',
    });
    expect(teamsErrorFrom(teamError)?.message).toBe('Every team needs at least one tag.');

    // A new set named like one the form has: the service's own code now, with the name.
    const taken = Object.assign(
      new Error('A team set named "project-teams" already exists on this form.'),
      { name: 'TeamSetError', code: 'name_taken', details: { name: 'project-teams' } }
    );
    expect(teamsErrorFrom(taken)).toEqual({
      code: 'name_taken',
      message: 'A team set named "project-teams" is already on this form.',
      items: [],
    });

    // Comparing a run that has no teams.
    const unsolved = Object.assign(new Error('Run 3 is INFEASIBLE, not SOLVED.'), {
      name: 'TeamSetError',
      code: 'run_not_solved',
      details: { run_number: 3, status: 'INFEASIBLE' },
    });
    expect(teamsErrorFrom(unsolved)?.message).toBe('Run 3 has no teams.');

    // Anything else is not ours to word: Prisma's P2002 has a code too.
    expect(teamsErrorFrom(Object.assign(new Error('x'), { code: 'P2002' }))).toBeNull();
    expect(teamsErrorFrom('set_locked')).toBeNull();
  });
});

// ─── The word scan ──────────────────────────────────────────────────────────

/** A broad sample of every teamsView template, filled with invented facts. */
function renderedTemplates(): string[] {
  const viewer = 'v';
  const ana = { user_id: 'a', name: 'Ana Ruiz' };
  const ben = { user_id: 'b', name: 'Ben Osei' };
  const nameless = { user_id: 'n', name: null };
  const opt = { id: 'o1', label: 'Studio' };
  const other = { id: 'o2', label: 'Canopy' };
  const statuses = [
    { status: 'closed', placed: 0, max: 0 },
    { status: 'not_running', placed: 0, max: 0 },
    { status: 'full', placed: 4, max: 4 },
    { status: 'running', placed: 3, max: 6 },
    { status: 'not_on_form', placed: 0, max: 0 },
  ] as const;
  const pins: PinView[] = (['on_option', 'not_options', 'together', 'apart'] as const).map(
    kind => ({
      id: 'p1',
      kind,
      people: [ana, ben],
      option: kind === 'on_option' ? opt : null,
      options: kind === 'not_options' ? [opt, other] : undefined,
      reason: 'Asked in office hours',
      added_by: ben,
      added_via: 'mcp',
      added_at: null,
    })
  );
  const facts: PlacementFacts = {
    user_id: 'a',
    name: 'Ana Ruiz',
    responded: false,
    non_respondents_mode: 'group',
    team: { n: 1, name: 'set-01', option: opt, mates: [ben, nameless] },
    placement: '2',
    rank: 2,
    pitched: statuses.map(status => ({ option: other, status })),
    pins,
    previous: { run_number: 3, option: other, team_n: 2 },
    higher_picks: statuses.map((status, index) => ({ rank: index + 1, option: other, status })),
    requests: [
      { user: ben, kept: true, on: { team_n: 1, option: opt } },
      { user: ben, kept: false, on: { team_n: 2, option: null } },
    ],
    notes: [{ field_label: 'Anything else?', text: 'Typed note.' }],
    priority: [
      { rule_id: 'r', question: 'Q', answer: 'A', favored: 'X', other: 'Y', up: 1.5, down: 0.5 },
      { rule_id: 'r', question: 'Q', answer: 'B', favored: null, other: null, up: 1, down: 1 },
    ],
  };
  const metrics: TeamSetMetrics = {
    people: 24,
    responded: 21,
    teams: 5,
    options_open: 5,
    options_total: 8,
    placement: { '1': 1, '2': 1, '3': 1, '4': 1, '5+': 1, fallback: 1, missed: 1, no_answer: 1 },
    first_choice: 1,
    top2: 2,
    requests: { total: 2, kept: 1, mutual_pairs: 0, mutual_pairs_kept: 0 },
    avoids: { total: 0, broken: 0 },
    must_broken: 1,
  };
  const create: CreateProgressView = {
    status: 'RUNNING',
    run_number: 4,
    attempt: 1,
    total: 2,
    done: 1,
    counts: { teams_created: 1, teams_failed: 1, members_added: 3, members_failed: 1 },
    members_total: 8,
    claimed_by: ana,
    started_at: '',
    finished_at: null,
    tag: { id: null, name: 'set' },
    teams: (['done', 'live', 'queued', 'failed'] as const).flatMap(state =>
      [true, false].map(github_team => ({
        n: 1,
        name: 'set-01',
        state,
        members_added: 1,
        size: 4,
        github_team,
        failure: 'provider_error',
      }))
    ),
    renamed: [{ n: 1, from: 'set-01', to: 'set-01-2' }],
    failures: [],
  };

  const out: string[] = [
    view.UNNAMED,
    view.GONE_OPTION,
    view.HIGHER_PICKS_HEADING,
    view.SET_FINISHED_TEXT,
    ...Object.values(view.OPTION_RUNS_LABELS),
    ...Object.values(view.SET_STATUS_LABELS),
    ...Object.values(view.RUN_STATUS_LABELS),
    ...Object.values(view.PIN_KIND_LABELS),
    ...Object.values(view.PLACEMENT_LABELS),
    ...Object.values(view.NON_RESPONDENT_MODE_LABELS),
    ...Object.values(view.NON_RESPONDENT_MODE_NOTES),
    ...Object.values(view.NON_RESPONDENT_MODE_NOTES_FREE),
    view.PAIRS_IDENTITY_NOTE,
    view.PROJECTS_FOOTNOTE,
    ...Object.values(view.NON_RESPONDENT_MODE_PHRASES),
    ...statuses.map(view.optionStatusText),
    view.optionRunsSummary([
      { label: 'A', runs: 'open' },
      { label: 'B', runs: 'closed' },
      { label: 'C', runs: 'auto' },
    ]),
    view.optionRunsSummary([{ label: 'C', runs: 'auto' }]),
    view.wantedText({ first: 1, top3: 2 }),
    view.pitchersText([]),
    view.pitchersText([{ user_id: null, name: null, on_roster: false }]),
    view.pinTargetLabel({ id: 'o', label: 'Canopy', running: false }),
    ...(['setting_up', 'creating', 'created', 'partial', 'create_failed'] as const).map(status =>
      view.setStatusChipText(status, { runCount: 2, createdOn: '12 Sep' })
    ),
    ...(['setting_up', 'creating', 'created', 'partial', 'create_failed'] as const).map(status =>
      view.setStatusChipText(status, {
        runCount: 2,
        activeRun: { number: 3, status: 'RUNNING' },
        creating: { done: 3, total: 5 },
        createRun: 2,
        createdOn: '12 Sep',
      })
    ),
    view.runActiveText({ number: 3, status: 'QUEUED' }),
    view.listEmptyText(21),
    view.pinnedHereText({ name: 'Ana Ruiz', reason: 'Asked in office hours' }),
    view.questionControlLabel('Strength', 'Who would you like to work with?', 'together'),
    view.listLatestRunText({ latest_run: null, created: null }),
    view.listLatestRunText({
      latest_run: null,
      created: { run_number: 1, teams_created: 3, finished_at: null },
    }),
    view.firstPickText(1, 2),
    view.firstPicksShort(1, 2),
    view.runlineText(1, 'SOLVED', { status: 'FEASIBLE', gap_pct: 1.2 }),
    view.runlineText(1, 'SOLVED', { status: 'FEASIBLE', gap_pct: null }),
    view.runlineText(1, 'SOLVED', { status: 'OPTIMAL', gap_pct: 0 }),
    view.runlineText(1, 'INFEASIBLE', null),
    ...[
      { tab: 'questions', field_id: 'f' },
      { tab: 'projects', option_id: 'o' },
      { tab: 'pins', pin_id: 'p' },
      { tab: 'team_shape' },
      { tab: 'non_respondents' },
    ].map(link => view.coreLinkLabel(link as Parameters<typeof view.coreLinkLabel>[0]) ?? ''),
    view.closedProvenanceText({ since_run: 2, by: ana, via: 'mcp' }, viewer),
    view.closedProvenanceText({ since_run: null, by: null, via: null }, viewer),
    ...pins.map(pin => view.pinPeopleText(pin)),
    ...pins.map(pin => view.pinDetailText(pin, viewer)),
    ...view.readinessParts({
      roster: 3,
      answered: 2,
      not_answered: 1,
      closes_at: null,
      closed: false,
    }),
    view.formCloseText(true, 'Fri 5:00 pm'),
    view.formCloseText(false, 'Fri 5:00 pm'),
    view.typeFactsText({
      options: 3,
      ranks: 2,
      min: 1,
      max: 5,
      required: false,
      source: 'teaching_team',
    }),
    view.questionCountsText({ answered: 1, skipped: 1 }),
    view.questionCountsText({ answered: 1, skipped: 0, requests: 2, mutual: 1 }),
    view.questionCountsText({ answered: 1, skipped: 0, pitchers: 2 }),
    view.questionCountsText({ answered: 1, skipped: 0, class_average: 2.5 }),
    view.answerCountText({ option_id: 'o', label: 'A', count: 3 }),
    view.studentsSeeText('Help.'),
    view.nonRespondentsCountText(3, 24),
    view.changesSinceRunText(2, 4),
    view.changesSinceThisRunText(1),
    view.changesNotRunText(2),
    view.changedSinceRunText(3, [{ text: 'x' }]),
    ...view.metricTiles(metrics, true).map(tile => tile.label),
    ...view.placementLegend(metrics).map(item => item.text),
    view.rankBadgeText({ rank: 2, responded: true }),
    view.rankBadgeText({ rank: null, responded: true }),
    view.rankBadgeText({ rank: null, responded: false }),
    view.teamCardMeta({ size: 4, signals: { wanted_first: 2 } }),
    ...view
      .teamSignalChips({
        wanted_first: 1,
        seats: { used: 1, max: 4 },
        pitcher_on_team: false,
        requests: { kept: 1, total: 2 },
        pinned: 1,
        did_not_answer: 1,
        fourth_or_lower: 1,
        balance: [{ field_id: 'f', label: 'Comfort', team_avg: null, class_avg: 3 }],
      })
      .map(chip => chip.text),
    view.identityHeldText({ rule_id: 'r', label: 'Q', teams_held: 1, teams_total: 2 }, true),
    view.missedTeamsText([{ n: 1, name: 'set-01' }]),
    view.runStartedText(ana, 2, viewer),
    ...view
      .runningSteps({ responses: 1, people: 2, pins: 3, warnings: 1 })
      .flatMap(step => [step.label, step.detail ?? '']),
    ...view.whyLines(facts, viewer).flatMap(line => [line.text, ...(line.items ?? [])]),
    view.whyTeamLine({ ...facts, responded: true, rank: null }),
    view.whyNoAnswerLine('include'),
    view.whyNoAnswerLine('exclude'),
    view.compareTitle(2, 1),
    ...(
      ['first_choice', 'top3', 'requests_kept', 'must_broken', 'options_open', 'rule_held'] as const
    ).map(key => view.compareRowLabel({ key, identity: key === 'rule_held' })),
    view.compareRowLabel({ key: 'rule_held', identity: false, rule_id: 'r' }, { r: 'Q' }),
    view.deltaText({ key: 'options_open', delta: 0, same_set: false }),
    view.deltaText({ key: 'first_choice', delta: -2 }),
    view.peopleMovedText({ moved: [], unchanged: 3 }),
    view.moverLine({
      user: ana,
      from: { option: opt, team_n: 1, rank: 1, responded: true },
      to: { option: null, team_n: 2, rank: null, responded: true },
      requests: [],
    }),
    view.moverPinLine({ pin_id: 'p', kind: 'on_option', reason: null }),
    view.moverRequestLine({ kind: 'now_kept', asker: ana, asked: ben }),
    view.moverRequestLine({ kind: 'no_longer_kept', asker: nameless, asked: ben }),
    view.unchangedText({ unchanged: 2, other_run_number: 1 }, true),
    view.unchangedText({ unchanged: 1, other_run_number: 1 }, false),
    ...view.joinedLeftText({ joined: 1, left: 2, run_number: 2, other_run_number: 1 }),
    ...(['not_solved', 'stale', 'creating', 'created', null] as const).map(
      blockedBy => view.createBlockedText({ allowed: true, blockedBy }) ?? ''
    ),
    view.createBlockedText({ allowed: false, blockedBy: null }) ?? '',
    view.createDialogTitle({ run_number: 1, teams: [] }),
    view.createButtonText(1),
    view.studentsText(1),
    view.tagStatusText({ name: 'set', exists: true }),
    view.tagStatusText({ name: 'set', exists: false }),
    view.creatingBannerText(create),
    view.createStartedText(create, viewer),
    ...create.teams.map(view.createTeamRowText),
    ...create.renamed.map(view.renamedText),
    view.createdTitle(create),
    view.createdByText(create, viewer, '26 Sep'),
    view.createDialogTitle(3, 4),
    view.createRetryText({ attempt: 2, teams_already_created: 2 }, 5),
    view.createRetryText({ attempt: 2, teams_already_created: 1 }),
    view.showRunText(4),
    view.backToRunText(4),
    view.openRunText(3),
    view.staleChipText(1),
    view.staleChipText(3),
    view.staleChipText(),
    view.cantSolveHeading(),
    view.cantSolveIntro(),
    view.corePeopleText({ people: [ana, ben], pairs: [[0, 1]] }) ?? '',
    view.corePeopleText({
      people: [ana, ben, { user_id: 'c', name: 'Cleo Park' }, { user_id: 'd', name: 'Dev Rao' }],
      pairs: [[0, 1]],
    }) ?? '',
    view.corePeopleText({ people: [ana, ben] }) ?? '',
    view.FORM_NOT_PUBLISHED_TEXT,
    view.checkLineText({ message: 'Two pins conflict.', names: ['Ana Ruiz', 'Ben Osei'] }),
    ...Object.values(view.CHECK_LEVEL_LABELS),
    ...Object.values(view.QUESTIONS_CARD_LABELS),
    ...Object.values(view.JOB_LABELS),
    ...Object.values(view.QUESTION_ROW_LABELS),
    ...Object.values(view.STRENGTH_LABELS),
    ...Object.values(view.ON_OFF_LABELS),
    ...Object.values(view.PRIORITY_ANSWER_LABELS),
    ...Object.values(view.IDENTITY_BLOCK_LABELS),
    view.priorityHintText(30),
    view.rankCostsText({}, 3, false),
    view.rankCostsText({}, 1, true),
    ...(Object.keys(view.JOB_LABELS) as (keyof typeof view.JOB_LABELS)[]).map(
      job =>
        view.jobHintText(
          { type: 'ranked_choice', type_facts: { options: 3, ranks: 2 } },
          job,
          {}
        ) ?? ''
    ),
    // Every job's line on every type it takes: plain, identity, capped; at
    // Prefer (the menu's), Must and Off, and off for teams of two.
    view.jobFactText({ type: 'dropdown', identity: false, must_labels: {} }, null),
    ...(Object.keys(TEAM_SET_JOB_FIELD_TYPES) as (keyof typeof TEAM_SET_JOB_FIELD_TYPES)[]).flatMap(
      job =>
        TEAM_SET_JOB_FIELD_TYPES[job].flatMap(type =>
          [false, true].flatMap(identity =>
            [{}, { max_per_team: 2 }].flatMap(params => {
              const field = { id: 'f', type, ranks: 3, options: [] } as never;
              const must = view.ruleMustLabel({ job, params }, field);
              const question = { type, identity, must_labels: must ? { [job]: must } : {} };
              return [
                view.jobFactText(question, job, params),
                view.jobFactText(question, job, params, 'must'),
                view.jobFactText(question, job, params, 'off'),
                view.jobFactText(question, job, params, 'prefer', true),
              ];
            })
          )
        )
    ),
    ...Object.values(view.TEAMS_LABELS),
  ];
  return out.filter(text => text !== '');
}

/**
 * The string literals and JSX text of a source file: comments skipped, quotes
 * and template literals read char by char (so an apostrophe inside a
 * double-quoted string does not open a new one).
 *
 * A '…' or "…" literal can't span lines, so a quote with no closing quote
 * before the line ends is ordinary text — an apostrophe in JSX text
 * (`<p>Didn't answer</p>`) — and the scan goes on from the next character
 * instead of reading into the code below.
 */
function sourceStrings(source: string, jsx: boolean): string[] {
  const strings: string[] = [];
  let code = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const n = source[i + 1];
    if (c === '/' && n === '/') {
      const end = source.indexOf('\n', i);
      i = end < 0 ? source.length : end;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < source.length) {
        if (source[j] === c) {
          closed = true;
          break;
        }
        if (source[j] === '\n' && c !== '`') break;
        if (source[j] === '\\') {
          value += source[j + 1] ?? '';
          j += 2;
          continue;
        }
        value += source[j];
        j += 1;
      }
      if (!closed) {
        code += c;
        i += 1;
        continue;
      }
      strings.push(value);
      code += ' ';
      i = j + 1;
      continue;
    }
    code += c;
    i += 1;
  }
  if (jsx) {
    for (const match of code.matchAll(/>([^<>{}]*[A-Za-z][^<>{}]*)</g)) strings.push(match[1]);
  }
  return strings;
}

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../app');

/** The Teams components, and the Teams screens with their server half. */
const TEAMS_DIRS = [join(APP_DIR, 'components/forms/teams'), join(APP_DIR, 'forms/admin/teams')];

function teamsSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return teamsSourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test.describe('no advice, no timing, no course names', () => {
  test('the scan itself: boundaries hold', () => {
    expect(bannedIn('Retry')).toEqual([]);
    expect(bannedIn('changes since run 4')).toEqual([]);
    expect(bannedIn('Try again in a minute')).toHaveLength(2);
    expect(bannedIn('Solved in 0.4 s')).toHaveLength(1);
    expect(bannedIn('Asked in office hours · Claude over MCP')).toHaveLength(1);
    expect(bannedIn('Used for the CS999 pairs')).toHaveLength(1);
    expect(sourceStrings(`const a = "isn't"; // should\ntry { b('x') } catch {}`, false)).toEqual([
      "isn't",
      'x',
    ]);
    // An apostrophe in JSX text neither swallows the code below nor hides the text.
    const tsx = [
      'export function Row() {',
      "  return <p>Didn&apos;t answer, or didn't</p>;",
      '}',
      'function f() {',
      '  try {',
      '    g();',
      '  } catch {}',
      "  return <span className='x'>Loosen a rule</span>;",
      '}',
    ].join('\n');
    const found = sourceStrings(tsx, true);
    expect(found).toContain('x');
    expect(found.some(text => text.includes('Loosen a rule'))).toBe(true);
    expect(found.flatMap(bannedIn)).toEqual(['\\bloosen']);
  });

  test('error sentences', () => {
    for (const sentence of allErrorSentences()) {
      expect(bannedIn(sentence), sentence).toEqual([]);
    }
  });

  test('error sentences say what happened, not how the system works', () => {
    const MECHANICS = [/\bserver\b/i, /\bjob\b/i, /\btime limit\b/i, /\bwhile\b/i, /\bscoring\b/i];
    for (const sentence of allErrorSentences()) {
      for (const pattern of MECHANICS) expect(sentence, sentence).not.toMatch(pattern);
    }
    expect(runErrorSentence('trigger_unavailable')).toBe("The run didn't start.");
    expect(runErrorSentence('no_solution_in_time')).toBe(
      'The solver stopped without finding teams.'
    );
    expect(runErrorSentence('score_mismatch')).toBe(
      "The solver's result was rejected. No teams were kept."
    );
    expect(teamsErrorSentence('trigger_unavailable')).toBe(
      "This didn't start. Nothing was created."
    );
  });

  test('teamsView templates, rendered', () => {
    const rendered = renderedTemplates();
    expect(rendered.length).toBeGreaterThan(100);
    for (const text of rendered) expect(bannedIn(text), text).toEqual([]);
  });

  test('every string literal in components/forms/teams and forms/admin/teams', () => {
    for (const dir of TEAMS_DIRS) expect(teamsSourceFiles(dir).length, dir).toBeGreaterThan(0);
    for (const file of TEAMS_DIRS.flatMap(dir => teamsSourceFiles(dir))) {
      const source = readFileSync(file, 'utf8');
      for (const text of sourceStrings(source, file.endsWith('.tsx'))) {
        expect(bannedIn(text), `${file}: ${text}`).toEqual([]);
      }
    }
  });
});
