import { test, expect } from '@playwright/test';

import type {
  ClosedProvenanceView,
  CompareMetricRow,
  CreatePollView,
  CreateProgressView,
  CreateTeamProgress,
  PersonRef,
  PinView,
  PlacementFacts,
  PriorityFact,
  RunMover,
  SetupOption,
  TeamSetMetrics,
  TeamSignals,
} from '../../app/components/forms/teams/types.ts';
import {
  CHECK_LEVEL_LABELS,
  GONE_OPTION,
  JOB_LABELS,
  NON_RESPONDENT_MODE_NOTES,
  NON_RESPONDENT_MODE_NOTES_FREE,
  PAIRS_IDENTITY_NOTE,
  PROJECTS_FOOTNOTE,
  TEAMS_LABELS,
  UNNAMED,
  backToRunText,
  cantSolveHeading,
  cantSolveIntro,
  createRetryText,
  listEmptyText,
  openRunText,
  pinnedHereText,
  questionControlLabel,
  runActiveText,
  showRunText,
  staleChipText,
  changedSinceRunText,
  changesNotRunText,
  changesSinceRunText,
  changesSinceThisRunText,
  checkLineText,
  closedProvenanceText,
  compareRowLabel,
  compareTitle,
  compareValueText,
  comparePath,
  coreLinkHash,
  coreLinkLabel,
  corePeopleText,
  createBlockedText,
  createButtonText,
  createDialogTitle,
  createLeadsSet,
  createStartedText,
  createTeamRowText,
  createdByText,
  createdTitle,
  creatingBannerText,
  deltaText,
  deltaTone,
  firstPickText,
  firstPicksShort,
  formatFactor,
  gapText,
  higherPickLine,
  identityHeldText,
  isRunActive,
  jobHintText,
  joinedLeftText,
  layoutPollActive,
  listJoin,
  liveCreate,
  listLatestRunText,
  metricTiles,
  missedTeamsText,
  moverLine,
  moverPinLine,
  moverRequestLine,
  mustLabelFor,
  nonRespondentChoices,
  nonRespondentModeNotes,
  optionRunsSummary,
  optionStatusText,
  ordinal,
  peopleMovedText,
  pinAttribution,
  pinDetailText,
  pinPeopleText,
  pinTargetLabel,
  pitchersText,
  placementLegend,
  priorityHintText,
  priorityLine,
  questionCountsText,
  rankBadgeText,
  rankCostsText,
  readinessParts,
  renamedText,
  ruleMustLabel,
  runPath,
  runStartedText,
  runlineText,
  runningSteps,
  setStatusChipText,
  setupRowId,
  solverLabel,
  statusSettled,
  studentsSeeText,
  teamCardMeta,
  teamNamesExample,
  teamSetPaths,
  teamSignalChips,
  top3Count,
  typeFactsText,
  unchangedText,
  wantedFirstText,
  whyLines,
  whyNoAnswerLine,
  whyPinLine,
  whyPreviousLine,
  whyRequestLine,
  whyTeamLine,
  compareRowsShown,
  showsPicks,
  shownSetStatus,
  type ShownMetrics,
} from '../../app/components/forms/teams/teamsView.ts';

/**
 * The Teams page's fixed templates (app/components/forms/teams/teamsView.ts).
 *
 * Pure: runs in the Playwright runner without a browser or the dev stack.
 * Every name, project and number here is invented. The word scan over these
 * templates (no advice, no timing, no course names) is in teams-errors.spec.ts,
 * next to the one over the error sentences.
 */

const VIEWER = 'viewer-1';
const person = (user_id: string, name: string | null): PersonRef => ({ user_id, name });
const ana = person('u-ana', 'Ana Ruiz');
const ben = person('u-ben', 'Ben Osei');
const cleo = person('u-cleo', 'Cleo Park');
const you = person(VIEWER, 'Dana Staff');
const nameless = person('u-x', null);

const trailhead = { id: 'o-trail', label: 'Trailhead' };
const studio = { id: 'o-studio', label: 'Studio' };
const canopy = { id: 'o-canopy', label: 'Canopy' };

const pin = (patch: Partial<PinView>): PinView => ({
  id: 'p1',
  kind: 'on_option',
  people: [ana],
  option: studio,
  reason: null,
  added_by: null,
  added_via: null,
  added_at: null,
  ...patch,
});

test.describe('words and numbers', () => {
  test('ordinals', () => {
    const table: [number, string][] = [
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
      [10, '10th'],
      [11, '11th'],
      [12, '12th'],
      [13, '13th'],
      [21, '21st'],
      [22, '22nd'],
      [23, '23rd'],
      [102, '102nd'],
      [111, '111th'],
    ];
    for (const [n, text] of table) expect(ordinal(n), String(n)).toBe(text);
  });

  test('lists join with commas and a final "and"', () => {
    expect(listJoin([])).toBe('');
    expect(listJoin(['A'])).toBe('A');
    expect(listJoin(['A', 'B'])).toBe('A and B');
    expect(listJoin(['A', 'B', 'C'])).toBe('A, B and C');
  });

  test('factors print at most two places, without float noise', () => {
    expect(formatFactor(1.5)).toBe('1.5');
    expect(formatFactor(0.5)).toBe('0.5');
    expect(formatFactor(1 + 0.7)).toBe('1.7');
    expect(formatFactor(1 - 0.7)).toBe('0.3');
    expect(formatFactor(1 - 0.9)).toBe('0.1');
    expect(formatFactor(1)).toBe('1');
  });

  test('a gap rounds UP to one place, so "within" stays true', () => {
    expect(gapText(0.04)).toBe('0.1');
    expect(gapText(2.4)).toBe('2.4');
    expect(gapText(2.41)).toBe('2.5');
    expect(gapText(3)).toBe('3');
  });
});

test.describe('the priority line', () => {
  const base: PriorityFact = {
    rule_id: 'f-prio:priority',
    question: 'What matters more to you?',
    answer: 'The project',
    favored: "Rank the projects you'd like to work on",
    other: 'Who would you like to work with?',
    up: 1.5,
    down: 0.5,
  };

  test('a 50% shift', () => {
    expect(priorityLine(base)).toBe(
      'Answered "The project" to "What matters more to you?": "Rank the projects you\'d like to work on" counts ×1.5 and "Who would you like to work with?" ×0.5 for this student.'
    );
  });

  test('a 70% shift prints clean factors', () => {
    expect(
      priorityLine({
        ...base,
        answer: 'The people',
        favored: 'Who would you like to work with?',
        other: "Rank the projects you'd like to work on",
        up: 1 + 0.7,
        down: 1 - 0.7,
      })
    ).toBe(
      'Answered "The people" to "What matters more to you?": "Who would you like to work with?" counts ×1.7 and "Rank the projects you\'d like to work on" ×0.3 for this student.'
    );
  });

  test('an answer that changes nothing says so', () => {
    expect(
      priorityLine({ ...base, answer: 'Both equally', favored: null, other: null, up: 1, down: 1 })
    ).toBe('Answered "Both equally" to "What matters more to you?": no change to the weights.');
  });
});

test.describe('option status', () => {
  test('every state', () => {
    expect(optionStatusText({ status: 'closed', placed: 0, max: 0 })).toBe('closed');
    expect(optionStatusText({ status: 'not_running', placed: 0, max: 0 })).toBe('not running');
    expect(optionStatusText({ status: 'full', placed: 4, max: 4 })).toBe('full, 4 of 4');
    expect(optionStatusText({ status: 'running', placed: 5, max: 6 })).toBe('running, 5 of 6');
    expect(optionStatusText({ status: 'not_on_form', placed: 0, max: 0 })).toBe(
      'no longer on the form'
    );
  });

  test('a view that leaves out how options ran: no counts, no "undefined"', () => {
    // A run grouped by a question flagged as an identity question since sends
    // no per-option counts, or no status at all.
    expect(optionStatusText({ status: 'full' })).toBe('full');
    expect(optionStatusText({ status: 'running', placed: 5, max: null as unknown as number })).toBe(
      'running'
    );
    expect(optionStatusText(null)).toBe('');
    expect(optionStatusText(undefined)).toBe('');
    expect(optionStatusText({} as never)).toBe('');
  });

  test('pin targets say when nothing runs on them', () => {
    expect(pinTargetLabel({ id: 'o', label: 'Canopy', running: false })).toBe(
      'Canopy (not running)'
    );
    expect(pinTargetLabel({ id: 'o', label: 'Studio', running: true })).toBe('Studio');
  });
});

test.describe('closed provenance', () => {
  const closed = (patch: Partial<ClosedProvenanceView>): ClosedProvenanceView => ({
    since_run: 6,
    by: you,
    via: 'page',
    ...patch,
  });

  test('the viewer closed it', () => {
    expect(closedProvenanceText(closed({}), VIEWER)).toBe('You closed it before run 6');
  });

  test('someone else closed it, over MCP', () => {
    expect(closedProvenanceText(closed({ by: ana, via: 'mcp', since_run: 1 }), VIEWER)).toBe(
      'Ana Ruiz closed it before run 1 · over MCP'
    );
  });

  test('no one recorded, and closed after the last run', () => {
    expect(closedProvenanceText(closed({ by: null, via: null, since_run: 3 }), VIEWER)).toBe(
      'Closed before run 3'
    );
    expect(closedProvenanceText(closed({ since_run: null }), VIEWER)).toBe(
      'You closed it after the last run'
    );
  });

  test('a person without a name', () => {
    expect(closedProvenanceText(closed({ by: nameless }), VIEWER)).toBe(
      `${UNNAMED} closed it before run 6`
    );
  });
});

test.describe('pins', () => {
  test('attribution: you or a name, plus over MCP', () => {
    expect(pinAttribution({ added_by: you, added_via: 'page' }, VIEWER)).toBe('you');
    expect(pinAttribution({ added_by: you, added_via: 'mcp' }, VIEWER)).toBe('you · over MCP');
    expect(pinAttribution({ added_by: ana, added_via: 'mcp' }, VIEWER)).toBe('Ana Ruiz · over MCP');
    expect(pinAttribution({ added_by: ana, added_via: 'page' }, VIEWER)).toBe('Ana Ruiz');
    expect(pinAttribution({ added_by: null, added_via: 'mcp' }, VIEWER)).toBe('over MCP');
    expect(pinAttribution({ added_by: null, added_via: null }, VIEWER)).toBeNull();
  });

  test('the Pins card', () => {
    expect(pinPeopleText(pin({}))).toBe('Ana Ruiz → Studio');
    expect(
      pinPeopleText(pin({ kind: 'not_options', option: null, options: [canopy, studio] }))
    ).toBe('Ana Ruiz · Canopy, Studio');
    expect(pinPeopleText(pin({ kind: 'together', option: null, people: [ana, ben] }))).toBe(
      'Ana Ruiz + Ben Osei'
    );
    expect(pinDetailText(pin({ reason: 'Has a makerspace badge', added_by: you }), VIEWER)).toBe(
      'Has a makerspace badge · you'
    );
    expect(pinDetailText(pin({}), VIEWER)).toBe('');
  });

  test('why lines name the other people and never add punctuation after the reason', () => {
    expect(
      whyPinLine(pin({ reason: 'Has a makerspace badge.', added_by: you }), ana.user_id, VIEWER)
    ).toBe('Pinned to Studio: Has a makerspace badge. · you');
    expect(
      whyPinLine(
        pin({
          kind: 'together',
          option: null,
          people: [ana, ben],
          added_by: cleo,
          added_via: 'mcp',
        }),
        ana.user_id,
        VIEWER
      )
    ).toBe('Pinned together with Ben Osei · Cleo Park · over MCP');
    expect(
      whyPinLine(pin({ kind: 'apart', option: null, people: [ana, ben] }), ben.user_id, VIEWER)
    ).toBe('Pinned apart from Ana Ruiz');
    expect(
      whyPinLine(
        pin({
          kind: 'not_options',
          option: null,
          options: [canopy, { id: 'o-gone', label: null }],
        }),
        ana.user_id,
        VIEWER
      )
    ).toBe(`Pinned off Canopy and ${GONE_OPTION}`);
  });
});

test.describe('changes', () => {
  test('chip and tray counts', () => {
    expect(changesSinceRunText(1, 4)).toBe('1 change since run 4');
    expect(changesSinceRunText(2, 4)).toBe('2 changes since run 4');
    expect(changesSinceThisRunText(3)).toBe('3 changes since this run');
    expect(changesNotRunText(1)).toBe('1 change not run yet');
  });

  test("Can't solve's runline lists the change texts", () => {
    expect(
      changedSinceRunText(5, [
        { text: "'Canopy': Solver decides → Closed" },
        { text: 'Pin added: Ana Ruiz → Studio' },
      ])
    ).toBe("Changed since run 5: 'Canopy': Solver decides → Closed; Pin added: Ana Ruiz → Studio");
  });
});

test.describe('why this placement', () => {
  const facts = (patch: Partial<PlacementFacts> = {}): PlacementFacts => ({
    user_id: ana.user_id,
    name: ana.name,
    responded: true,
    team: { n: 1, name: 'project-teams-trailhead', option: trailhead, mates: [ben, cleo] },
    placement: '2',
    rank: 2,
    pitched: [],
    pins: [],
    previous: null,
    higher_picks: [],
    requests: [],
    notes: [],
    ...patch,
  });

  test('team line: rank, not ranked, free mode, alone', () => {
    expect(whyTeamLine(facts())).toBe('On Trailhead (2nd pick) with Ben Osei and Cleo Park.');
    expect(whyTeamLine(facts({ rank: null }))).toBe(
      'On Trailhead (not ranked) with Ben Osei and Cleo Park.'
    );
    expect(
      whyTeamLine(facts({ team: { n: 3, name: 'set-03', option: null, mates: [ben] }, rank: null }))
    ).toBe('On team 3 with Ben Osei.');
    expect(whyTeamLine(facts({ responded: false, team: { ...facts().team, mates: [] } }))).toBe(
      'On Trailhead.'
    );
  });

  test('previous run, requests, no answer, higher picks', () => {
    expect(whyPreviousLine({ run_number: 3, option: studio, team_n: 2 })).toBe('In run 3: Studio.');
    expect(whyPreviousLine({ run_number: 3, option: null, team_n: 2 })).toBe('In run 3: team 2.');
    expect(whyRequestLine({ user: ben, kept: true, on: { team_n: 1, option: trailhead } })).toBe(
      'Asked for Ben Osei: kept.'
    );
    expect(whyRequestLine({ user: ben, kept: false, on: { team_n: 2, option: studio } })).toBe(
      'Asked for Ben Osei: not kept (Ben Osei is on Studio).'
    );
    expect(whyRequestLine({ user: nameless, kept: false, on: { team_n: 4, option: null } })).toBe(
      `Asked for ${UNNAMED}: not kept (${UNNAMED} is on team 4).`
    );
    expect(whyNoAnswerLine('include')).toBe(
      "Didn't answer the form. People who didn't answer: spread out."
    );
    expect(whyNoAnswerLine('group')).toBe(
      "Didn't answer the form. People who didn't answer: grouped together."
    );
    expect(
      higherPickLine({ rank: 1, option: studio, status: { status: 'full', placed: 4, max: 4 } })
    ).toBe('Studio (1st): full, 4 of 4');
    // No status in the view: the pick alone.
    expect(higherPickLine({ rank: 2, option: canopy, status: null as never })).toBe('Canopy (2nd)');
  });

  test('the panel, in reading order', () => {
    const lines = whyLines(
      facts({
        pitched: [{ option: canopy, status: { status: 'not_running', placed: 0, max: 0 } }],
        pins: [pin({ reason: 'Co-pitched', added_by: you, option: trailhead })],
        previous: { run_number: 3, option: studio, team_n: 2 },
        priority: [
          {
            rule_id: 'f:priority',
            question: 'What matters more to you?',
            answer: 'Both equally',
            favored: null,
            other: null,
            up: 1,
            down: 1,
          },
        ],
        higher_picks: [
          { rank: 1, option: canopy, status: { status: 'not_running', placed: 0, max: 0 } },
        ],
        requests: [{ user: ben, kept: true, on: { team_n: 1, option: trailhead } }],
        notes: [{ field_label: 'Anything else?', text: 'Happy to do the booking side.' }],
      }),
      VIEWER
    );
    expect(lines.map(line => [line.kind, line.text, line.items ?? null])).toEqual([
      ['team', 'On Trailhead (2nd pick) with Ben Osei and Cleo Park.', null],
      ['pitched', 'Pitched Canopy (not running).', null],
      ['pin', 'Pinned to Trailhead: Co-pitched · you', null],
      ['previous', 'In run 3: Studio.', null],
      [
        'priority',
        'Answered "Both equally" to "What matters more to you?": no change to the weights.',
        null,
      ],
      ['higher_picks', 'Higher picks', ['Canopy (1st): not running']],
      ['request', 'Asked for Ben Osei: kept.', null],
      ['note', '"Happy to do the booking side."', ['Anything else?']],
    ]);
  });

  test('a pitch on the team it is on', () => {
    const lines = whyLines(
      facts({ pitched: [{ option: trailhead, status: { status: 'running', placed: 3, max: 6 } }] }),
      VIEWER
    );
    expect(lines[1].text).toBe('Pitched Trailhead.');
  });

  test('a pitch whose option status the view leaves out', () => {
    const lines = whyLines(facts({ pitched: [{ option: canopy, status: null as never }] }), VIEWER);
    expect(lines[1].text).toBe('Pitched Canopy.');
    expect(lines.map(line => line.text).join(' ')).not.toContain('undefined');
  });

  test('a placement the view does not show: no line for it, no answer, no option', () => {
    // A run grouped by a question that is an identity question now: the
    // service nulls the option, rank and placement, and sends no higher picks.
    const hidden = facts({
      team: { n: 3, name: 'project-teams-03', option: null, mates: [ben, cleo] },
      placement: null,
      rank: null,
      higher_picks: [],
      requests: [{ user: ben, kept: true, on: { team_n: 3, option: null } }],
    });
    const lines = whyLines(hidden, VIEWER);
    expect(lines.map(line => [line.kind, line.text])).toEqual([
      ['team', 'On team 3 with Ben Osei and Cleo Park.'],
      ['request', 'Asked for Ben Osei: kept.'],
    ]);
    const text = lines.flatMap(line => [line.text, ...(line.items ?? [])]).join(' ');
    expect(text).not.toMatch(/answer|ranked|pick/i);
    expect(text).not.toContain(trailhead.label);
  });

  test('someone who did not answer', () => {
    const lines = whyLines(
      facts({
        responded: false,
        rank: null,
        placement: 'no_answer',
        non_respondents_mode: 'include',
      }),
      VIEWER
    );
    expect(lines.map(line => line.text)).toEqual([
      'On Trailhead with Ben Osei and Cleo Park.',
      "Didn't answer the form. People who didn't answer: spread out.",
    ]);
  });
});

test.describe('compare', () => {
  const row = (patch: Partial<CompareMetricRow>): CompareMetricRow => ({
    key: 'first_choice',
    run: 16,
    other: 19,
    delta: -3,
    ...patch,
  });

  test('row labels, values and deltas', () => {
    expect(compareTitle(4, 3)).toBe('Run 4 compared with run 3');
    expect(compareRowLabel(row({}))).toBe('Got their 1st pick');
    expect(compareRowLabel(row({ key: 'top3' }))).toBe('Got a top-3 pick');
    expect(compareRowLabel(row({ key: 'rule_held', identity: true, rule_id: 'r' }))).toBe(
      'Identity rule held'
    );
    expect(
      compareRowLabel(row({ key: 'rule_held', identity: false, rule_id: 'r' }), { r: 'Team role' })
    ).toBe('Rule on "Team role" held');
    expect(compareValueText(row({}), 'run')).toBe('16');
    expect(
      compareValueText(
        row({ key: 'requests_kept', run: 11, other: 8, of: { run: 12, other: 12 } }),
        'other'
      )
    ).toBe('8 of 12');
    expect(compareValueText(row({ other: null }), 'other')).toBe('—');
    expect(deltaText(row({}))).toBe('−3');
    expect(deltaText(row({ delta: 3 }))).toBe('+3');
    expect(deltaText(row({ delta: 0 }))).toBe('same');
    expect(deltaText(row({ delta: null }))).toBe('');
    expect(deltaText(row({ key: 'options_open', delta: 0, same_set: false }))).toBe(
      'same count, different projects'
    );
    expect(deltaText(row({ key: 'options_open', delta: 0, same_set: true }))).toBe('same');
    // Projects running against a free run: that side has no count and there is no change.
    const mixed = row({
      key: 'options_open',
      run: 5,
      other: null,
      delta: null,
      of: { run: 8, other: null },
    });
    expect(compareValueText(mixed, 'run')).toBe('5 of 8');
    expect(compareValueText(mixed, 'other')).toBe('—');
    expect(deltaText(mixed)).toBe('');
    expect(deltaTone(mixed)).toBeNull();
  });

  test('pick rows show only when both runs are grouped', () => {
    const rows = [
      row({}),
      row({ key: 'top3' }),
      row({ key: 'requests_kept', of: { run: 12, other: 12 } }),
      row({ key: 'must_broken' }),
    ];
    expect(compareRowsShown(rows, true).map(r => r.key)).toEqual([
      'first_choice',
      'top3',
      'requests_kept',
      'must_broken',
    ]);
    expect(compareRowsShown(rows, false).map(r => r.key)).toEqual(['requests_kept', 'must_broken']);
    // A side the service sent no number for reads as a dash, never "undefined".
    expect(compareValueText(row({ run: undefined as never }), 'run')).toBe('—');
  });

  test('which way is better', () => {
    expect(deltaTone(row({}))).toBe('worse');
    expect(deltaTone(row({ delta: 3 }))).toBe('better');
    expect(deltaTone(row({ key: 'must_broken', delta: 1 }))).toBe('worse');
    expect(deltaTone(row({ key: 'must_broken', delta: -1 }))).toBe('better');
    expect(deltaTone(row({ key: 'options_open', delta: 1 }))).toBe('neutral');
    expect(deltaTone(row({ delta: 0 }))).toBe('same');
    expect(deltaTone(row({ delta: null }))).toBeNull();
  });

  const mover: RunMover = {
    user: ana,
    from: { option: { id: 'o-ledger', label: 'Ledger' }, team_n: 5, rank: 1 },
    to: { option: studio, team_n: 3, rank: 2 },
    pin: { pin_id: 'p2', kind: 'on_option', reason: 'has a makerspace badge' },
    requests: [
      { kind: 'now_kept', asker: ben, asked: cleo },
      { kind: 'no_longer_kept', asker: nameless, asked: ana },
    ],
  };

  test('movers, their pin and their requests', () => {
    expect(moverLine(mover)).toBe('Ana Ruiz · Ledger (1st) → Studio (2nd)');
    expect(moverLine({ ...mover, to: { option: canopy, team_n: 4, rank: null } })).toBe(
      'Ana Ruiz · Ledger (1st) → Canopy (not ranked)'
    );
    expect(
      moverLine({
        ...mover,
        from: { option: null, team_n: 2, rank: null },
        to: { option: null, team_n: 4, rank: null },
      })
    ).toBe('Ana Ruiz · team 2 → team 4');
    expect(moverPinLine(mover.pin!)).toBe('Pinned: has a makerspace badge');
    expect(moverPinLine({ ...mover.pin!, reason: null })).toBe('Pinned');
    expect(moverRequestLine(mover.requests[0])).toBe("Now kept: Ben Osei's request for Cleo Park.");
    expect(moverRequestLine(mover.requests[1])).toBe(
      `No longer kept: ${UNNAMED}'s request for Ana Ruiz.`
    );
  });

  test('the footer and the people-moved row', () => {
    const comparison = { moved: [mover, mover, mover], unchanged: 21, other_run_number: 3 };
    expect(peopleMovedText(comparison)).toBe('3 of 24');
    expect(unchangedText(comparison, true)).toBe(
      'The other 21 people are on the same project as in run 3.'
    );
    expect(unchangedText({ unchanged: 1, other_run_number: 3 }, true)).toBe(
      'The other 1 person is on the same project as in run 3.'
    );
    expect(unchangedText(comparison, false)).toBe(
      'The other 21 people have the same teammates as in run 3.'
    );
    expect(joinedLeftText({ joined: 2, left: 1, run_number: 4, other_run_number: 3 })).toEqual([
      '2 people only in run 4',
      '1 person only in run 3',
    ]);
    expect(joinedLeftText({ joined: 0, left: 0, run_number: 4, other_run_number: 3 })).toEqual([]);
  });
});

test.describe('status, runs and results', () => {
  test('set status chip', () => {
    expect(setStatusChipText('setting_up', { runCount: 4 })).toBe('Setting up · 4 runs');
    expect(setStatusChipText('setting_up', { runCount: 1 })).toBe('Setting up · 1 run');
    expect(setStatusChipText('setting_up', { runCount: 0 })).toBe('Setting up');
    expect(setStatusChipText('created', { runCount: 2, createdOn: '12 Sep' })).toBe(
      'Created 12 Sep'
    );
    expect(setStatusChipText('creating', { runCount: 2 })).toBe('Creating teams');
  });

  test('set status chip: the facts it is filled with', () => {
    // A run that hasn't finished takes the run count's place.
    expect(
      setStatusChipText('setting_up', {
        runCount: 5,
        activeRun: { number: 5, status: 'RUNNING' },
      })
    ).toBe('Setting up · Run 5 running');
    expect(
      setStatusChipText('setting_up', { runCount: 1, activeRun: { number: 1, status: 'QUEUED' } })
    ).toBe('Setting up · Run 1 queued');
    expect(runActiveText({ number: 5, status: 'RUNNING' })).toBe('Run 5 running');
    // Creating: teams finished of teams in the create.
    expect(
      setStatusChipText('creating', { runCount: 4, creating: { done: 3, total: 5 }, createRun: 4 })
    ).toBe('Creating teams · 3 of 5');
    expect(setStatusChipText('creating', { runCount: 4, creating: { done: 0, total: 0 } })).toBe(
      'Creating teams'
    );
    // Created: the date (formatted by the caller), then the run.
    expect(setStatusChipText('created', { runCount: 4, createdOn: '12 Sep', createRun: 4 })).toBe(
      'Created 12 Sep · from run 4'
    );
    expect(setStatusChipText('created', { runCount: 4, createRun: 4 })).toBe(
      'Created · from run 4'
    );
    expect(setStatusChipText('partial', { runCount: 4, createdOn: '12 Sep', createRun: 2 })).toBe(
      'Created in part 12 Sep · from run 2'
    );
    expect(setStatusChipText('create_failed', { runCount: 4, createRun: 3 })).toBe(
      'Create failed · from run 3'
    );
    expect(setStatusChipText('create_failed', { runCount: 4 })).toBe('Create failed');
  });

  test('set status chip: a run going after a failed create that made no team', () => {
    const running = { number: 5, status: 'RUNNING' as const };
    // Unlocked (no team made): the running run is what the chip shows.
    const shown = shownSetStatus('create_failed', { locked: false, activeRun: running });
    expect(shown).toBe('setting_up');
    expect(setStatusChipText(shown, { runCount: 5, activeRun: running, createRun: 4 })).toBe(
      'Setting up · Run 5 running'
    );
    // Nothing running: the failure stays the set's status.
    expect(shownSetStatus('create_failed', { locked: false, activeRun: null })).toBe(
      'create_failed'
    );
    // Teams were made (locked): the failure stays, Retry is the way on.
    expect(shownSetStatus('create_failed', { locked: true, activeRun: running })).toBe(
      'create_failed'
    );
    for (const status of ['setting_up', 'creating', 'created', 'partial'] as const) {
      expect(shownSetStatus(status, { locked: false, activeRun: running }), status).toBe(status);
    }
  });

  test('list empty state, pinned-here chips, control names', () => {
    expect(listEmptyText(21)).toBe('This form has 21 submitted responses.');
    expect(listEmptyText(1)).toBe('This form has 1 submitted response.');
    expect(pinnedHereText({ name: 'Ana Ruiz', reason: 'Has a badge' })).toBe(
      'Ana Ruiz: Has a badge'
    );
    expect(pinnedHereText({ name: null, reason: null })).toBe(UNNAMED);
    expect(questionControlLabel('Job', 'Who would you like to work with?')).toBe(
      'Job: Who would you like to work with?'
    );
    expect(questionControlLabel('Strength', 'Who would you like to work with?', 'together')).toBe(
      'Strength · Together: Who would you like to work with?'
    );
  });

  test('list row headline', () => {
    const latest = {
      number: 4,
      status: 'SOLVED' as const,
      solver_status: 'OPTIMAL' as const,
      first_choice: 16 as number | null,
      responded: 21 as number | null,
      grouped: true,
    };
    expect(listLatestRunText({ latest_run: latest, created: null })).toBe(
      'Run 4 · 16 of 21 got their 1st pick'
    );
    expect(
      listLatestRunText({
        latest_run: latest,
        created: { run_number: 2, teams_created: 12, finished_at: null },
      })
    ).toBe('Run 2 · 12 teams created');
    expect(
      listLatestRunText({
        latest_run: { ...latest, status: 'INFEASIBLE', first_choice: null, responded: null },
        created: null,
      })
    ).toBe('Run 4 · Not solved');
    expect(listLatestRunText({ latest_run: null, created: null })).toBe('No runs yet');
    // A run with no grouping question has no picks, whatever its metrics hold.
    expect(
      listLatestRunText({
        latest_run: { ...latest, first_choice: 0, grouped: false },
        created: null,
      })
    ).toBe('Run 4 · Solved');
    // A grouped run whose counts didn't come: its status.
    expect(
      listLatestRunText({ latest_run: { ...latest, first_choice: null }, created: null })
    ).toBe('Run 4 · Solved');
    expect(firstPickText(16, 21)).toBe('16 of 21 got their 1st pick');
    expect(firstPicksShort(16, 21)).toBe('16/21 1st picks');
  });

  test('runline', () => {
    expect(solverLabel({ status: 'OPTIMAL', gap_pct: 0 })).toBe('proven best');
    expect(solverLabel({ status: 'FEASIBLE', gap_pct: 2.4 })).toBe('within 2.4% of best');
    expect(solverLabel({ status: 'FEASIBLE', gap_pct: null })).toBe('not proven best');
    expect(solverLabel({ status: 'INFEASIBLE', gap_pct: null })).toBeNull();
    expect(runlineText(4, 'SOLVED', { status: 'OPTIMAL', gap_pct: 0 })).toBe('Run 4 · proven best');
    expect(runlineText(6, 'INFEASIBLE', null)).toBe('Run 6 · not solved');
    expect(runlineText(5, 'RUNNING', null)).toBe('Run 5');
  });

  const metrics = (patch: Partial<TeamSetMetrics> = {}): TeamSetMetrics => ({
    people: 24,
    responded: 21,
    teams: 5,
    options_open: 5,
    options_total: 8,
    placement: { '1': 16, '2': 3, '3': 1, '4': 1, '5+': 0, fallback: 0, missed: 0, no_answer: 3 },
    first_choice: 16,
    top2: 19,
    requests: { total: 12, kept: 11, mutual_pairs: 4, mutual_pairs_kept: 4 },
    avoids: { total: 2, broken: 0 },
    must_broken: 0,
    ...patch,
  });

  test('tiles; top 3 derives on runs scored before it existed', () => {
    expect(top3Count(metrics())).toBe(20);
    expect(top3Count(metrics({ top3: 18 }))).toBe(18);
    expect(metricTiles(metrics(), true).map(tile => [tile.value, tile.of, tile.label])).toEqual([
      [16, 21, 'got their 1st pick'],
      [20, 21, 'got a top-3 pick'],
      [11, 12, 'requests kept'],
      [0, null, 'Must rules broken'],
      [5, 8, 'projects running'],
    ]);
    // No grouping question: nobody ranked anything, so no pick tiles and no projects.
    const free = metricTiles(
      metrics({
        first_choice: 0,
        placement: {
          '1': 0,
          '2': 0,
          '3': 0,
          '4': 0,
          '5+': 0,
          fallback: 0,
          missed: 0,
          no_answer: 24,
        },
        must_broken: 1,
        requests: { total: 1, kept: 1, mutual_pairs: 0, mutual_pairs_kept: 0 },
      }),
      false
    );
    expect(free.map(tile => tile.label)).toEqual(['request kept', 'Must rule broken']);
    // Grouped, but the view doesn't show the options: picks yes, projects no.
    expect(metricTiles(metrics(), true, false).map(tile => tile.key)).toEqual([
      'first_choice',
      'top3',
      'requests_kept',
      'must_broken',
    ]);
  });

  test('tiles, bar and top 3 skip counts that are null', () => {
    const blank: ShownMetrics = {
      ...metrics(),
      first_choice: null,
      top3: null,
      placement: null,
      responded: null,
    };
    expect(top3Count(blank)).toBeNull();
    expect(metricTiles(blank, true).map(tile => tile.key)).toEqual([
      'requests_kept',
      'must_broken',
      'options_open',
    ]);
    expect(placementLegend(blank)).toEqual([]);
    // A count without its total: the count alone.
    const noTotal = metricTiles({ ...metrics(), responded: null } as ShownMetrics, true);
    expect(noTotal[0]).toMatchObject({ key: 'first_choice', value: 16, of: null });
  });

  test('which runs show picks', () => {
    const run = {
      status: 'SOLVED' as const,
      grouped: true,
      first_choice: 16 as number | null,
      responded: 21 as number | null,
    };
    expect(showsPicks(run)).toBe(true);
    expect(showsPicks({ ...run, grouped: false })).toBe(false);
    expect(showsPicks({ ...run, status: 'RUNNING' })).toBe(false);
    expect(showsPicks({ ...run, first_choice: null })).toBe(false);
    expect(showsPicks({ ...run, responded: null })).toBe(false);
  });

  test('placement legend leaves out zeros', () => {
    expect(placementLegend(metrics()).map(item => item.text)).toEqual([
      '1st · 16',
      '2nd · 3',
      '3rd · 1',
      '4th · 1',
      "Didn't answer · 3",
    ]);
  });

  const signals = (patch: Partial<TeamSignals> = {}): TeamSignals => ({
    wanted_first: 7,
    seats: { used: 6, max: 6 },
    pitcher_on_team: true,
    requests: { kept: 2, total: 3 },
    pinned: 1,
    did_not_answer: 0,
    fourth_or_lower: 0,
    balance: [],
    ...patch,
  });

  test('team cards', () => {
    expect(wantedFirstText(7)).toBe('wanted 1st by 7');
    expect(teamCardMeta({ size: 6, signals: signals() })).toBe('6 people · wanted 1st by 7');
    expect(teamCardMeta({ size: 1, signals: signals({ wanted_first: null }) })).toBe('1 person');
    expect(teamSignalChips(signals()).map(chip => [chip.kind, chip.tone, chip.text])).toEqual([
      ['pitcher', 'good', 'pitcher on team'],
      ['requests', 'warn', '2 of 3 requests kept'],
      ['pinned', 'plain', 'pinned 1'],
      ['seats', 'plain', '6 of 6 seats'],
    ]);
    expect(
      teamSignalChips(
        signals({
          pitcher_on_team: null,
          requests: { kept: 1, total: 1 },
          pinned: 0,
          did_not_answer: 1,
          fourth_or_lower: 1,
          balance: [{ field_id: 'f', label: 'Backend comfort', team_avg: 3.25, class_avg: 3.2 }],
        })
      ).map(chip => chip.text)
    ).toEqual([
      '1 of 1 request kept',
      "1 didn't answer",
      '1 on a 4th pick or lower',
      '6 of 6 seats',
      'Backend comfort: 3.3 · class 3.2',
    ]);
    expect(rankBadgeText({ rank: 1, responded: true })).toBe('1st');
    expect(rankBadgeText({ rank: null, responded: true })).toBe('not ranked');
    expect(rankBadgeText({ rank: null, responded: false })).toBe('no answer');
    // A placement the view doesn't show: no badge, rather than "not ranked".
    expect(rankBadgeText({ rank: null, responded: true, placement: null })).toBe('');
    expect(rankBadgeText({ rank: null, responded: false, placement: null })).toBe('no answer');
    expect(rankBadgeText({ rank: 2, responded: true, placement: '2' })).toBe('2nd');
    expect(rankBadgeText({ rank: null, responded: true, placement: 'missed' })).toBe('not ranked');
    // A run with no grouping question: no rank badge for anyone who answered.
    expect(rankBadgeText({ rank: null, responded: true, placement: 'no_answer' }, false)).toBe('');
    expect(rankBadgeText({ rank: 1, responded: true, placement: '1' }, false)).toBe('');
    expect(rankBadgeText({ rank: null, responded: false, placement: 'no_answer' }, false)).toBe(
      'no answer'
    );
  });

  test('team cards of a run grouped by a question flagged as identity since: what is left out', () => {
    // No per-option seats, no pitcher fact, no "wanted 1st": the card shows
    // the rest and no chip reads "undefined" or "null".
    const masked = {
      ...signals(),
      wanted_first: null,
      seats: null,
      pitcher_on_team: null,
    };
    const chips = teamSignalChips(masked);
    expect(chips.map(chip => chip.kind)).toEqual(['requests', 'pinned']);
    expect(teamSignalChips({ ...masked, seats: { used: 6, max: null } }).map(c => c.kind)).toEqual([
      'requests',
      'pinned',
    ]);
    expect(chips.map(chip => chip.text).join(' ')).not.toMatch(/undefined|null|NaN/);
    expect(teamCardMeta({ size: 5, signals: masked })).toBe('5 people');
    expect(teamCardMeta({ size: 5, signals: {} })).toBe('5 people');
  });

  test('team cards of a free run: no pick chip', () => {
    const kinds = teamSignalChips(
      signals({ pitcher_on_team: null, fourth_or_lower: 2 }),
      false
    ).map(chip => chip.kind);
    expect(kinds).not.toContain('fourth_or_lower');
    expect(kinds).toContain('seats');
  });

  test('identity aggregate: counts and, on request, team names only', () => {
    const rule = {
      rule_id: 'r',
      label: 'How do you describe yourself?',
      teams_held: 4,
      teams_total: 5,
    };
    expect(identityHeldText(rule, false)).toBe('Identity rule held on 4 of 5 teams.');
    expect(identityHeldText(rule, true)).toBe(
      'Identity rule on "How do you describe yourself?" held on 4 of 5 teams.'
    );
    expect(missedTeamsText([{ n: 2, name: 'project-teams-pantry' }])).toBe(
      'Missed on project-teams-pantry.'
    );
  });

  test('running card', () => {
    expect(runStartedText(you, 6, VIEWER)).toBe('Started by you · 6 pins');
    expect(runStartedText(ana, 1, VIEWER)).toBe('Started by Ana Ruiz · 1 pin');
    expect(
      runningSteps({ responses: 21, people: 24, pins: 6, warnings: 0 }).map(step => [
        step.label,
        step.detail,
      ])
    ).toEqual([
      ['Read answers', '21 responses, 24 people, 6 pins'],
      ['Checked the Must rules', 'Nothing conflicts'],
      ['Solving', null],
      ['Score and save', null],
    ]);
    expect(runningSteps({ responses: 1, people: 1, pins: 0, warnings: 2 })[1].detail).toBe(
      '2 warnings'
    );
  });
});

test.describe('poll predicates', () => {
  test('a run is active until it ends', () => {
    expect(isRunActive('QUEUED')).toBe(true);
    expect(isRunActive('RUNNING')).toBe(true);
    for (const status of ['SOLVED', 'INFEASIBLE', 'FAILED', 'CANCELED'] as const) {
      expect(isRunActive(status), status).toBe(false);
    }
  });

  test('settled = no unfinished run and no running create', () => {
    expect(statusSettled({ latest_run: null, create: null })).toBe(true);
    expect(statusSettled({ latest_run: { number: 2, status: 'RUNNING' }, create: null })).toBe(
      false
    );
    expect(statusSettled({ latest_run: { number: 2, status: 'SOLVED' }, create: null })).toBe(true);
    const create = { status: 'RUNNING' } as CreateProgressView;
    expect(statusSettled({ latest_run: { number: 2, status: 'SOLVED' }, create })).toBe(false);
    expect(
      statusSettled({
        latest_run: { number: 2, status: 'SOLVED' },
        create: { ...create, status: 'PARTIAL' },
      })
    ).toBe(true);
  });

  test('the layout polls while a run or a create moves', () => {
    const idle = {
      activeRun: null,
      latestRun: { number: 3, status: 'SOLVED' as const },
      create: null,
    };
    expect(layoutPollActive(idle)).toBe(false);
    expect(layoutPollActive({ ...idle, activeRun: { number: 4, status: 'QUEUED' } })).toBe(true);
    expect(layoutPollActive({ ...idle, create: { status: 'RUNNING' } as CreateProgressView })).toBe(
      true
    );
  });

  test('a failed create leads the set while locked, or until a run is solved after it', () => {
    const FAILED_AT = '2026-09-26T12:00:00.000Z';
    const BEFORE = '2026-09-26T11:59:00.000Z';
    const AFTER = '2026-09-26T12:01:00.000Z';
    const create = (
      status: CreateProgressView['status'],
      finished_at: string | null = status === 'RUNNING' ? null : FAILED_AT
    ) => ({ status, started_at: '2026-09-26T11:58:00.000Z', finished_at });
    expect(createLeadsSet(null, { locked: false, latestSolvedAt: AFTER })).toBe(false);
    // Running and finished creates always lead.
    for (const status of ['RUNNING', 'DONE', 'PARTIAL'] as const) {
      expect(createLeadsSet(create(status), { locked: false, latestSolvedAt: AFTER }), status).toBe(
        true
      );
    }
    // Failed without a team: leads until a run is solved AFTER it finished —
    // a run solved before the failure doesn't count, whatever its number.
    expect(createLeadsSet(create('FAILED'), { locked: false, latestSolvedAt: BEFORE })).toBe(true);
    expect(createLeadsSet(create('FAILED'), { locked: false, latestSolvedAt: FAILED_AT })).toBe(
      true
    );
    expect(createLeadsSet(create('FAILED'), { locked: false, latestSolvedAt: null })).toBe(true);
    expect(createLeadsSet(create('FAILED'), { locked: false, latestSolvedAt: AFTER })).toBe(false);
    // No finish time on the failure: its start is the mark.
    expect(createLeadsSet(create('FAILED', null), { locked: false, latestSolvedAt: BEFORE })).toBe(
      false
    );
    // Failed after making teams (locked): Retry is the way on, whatever was solved after.
    expect(createLeadsSet(create('FAILED'), { locked: true, latestSolvedAt: AFTER })).toBe(true);
  });
});

test.describe('paths and Setup row ids', () => {
  test('a set’s paths, with the typed name encoded', () => {
    const paths = teamSetPaths({
      classroomSlug: 'product-studio',
      formSlug: 'project-bidding',
      setName: 'project teams',
    });
    expect(paths).toEqual({
      list: '/product-studio/forms/project-bidding/teams',
      set: '/product-studio/forms/project-bidding/teams/project%20teams',
      runs: '/product-studio/forms/project-bidding/teams/project%20teams/runs',
      status: '/product-studio/forms/project-bidding/teams/project%20teams/status',
    });
    expect(runPath(paths, 4)).toBe(`${paths.runs}/4`);
    expect(comparePath(paths, 4, 3)).toBe(`${paths.runs}/4/compare/3`);
  });

  test("Can't-solve links land on Setup's rows", () => {
    expect(setupRowId({ tab: 'questions', field_id: 'f1' })).toBe('q-f1');
    expect(setupRowId({ tab: 'projects', option_id: 'o1' })).toBe('opt-o1');
    expect(setupRowId({ tab: 'pins', pin_id: 'p3' })).toBe('pin-p3');
    expect(setupRowId({ tab: 'non_respondents' })).toBe('nr');
    expect(setupRowId({ tab: 'team_shape' })).toBe('shape');
    expect(setupRowId({ tab: 'projects' })).toBe('projects');
    expect(setupRowId({ tab: null })).toBeNull();
    expect(coreLinkHash({ tab: 'projects', option_id: 'o1' })).toBe('#opt-o1');
    expect(coreLinkHash({ tab: null })).toBeNull();
    expect(coreLinkLabel({ tab: 'projects', option_id: 'o1' })).toBe('Change in Projects');
    expect(coreLinkLabel({ tab: 'questions' })).toBe('Change in Questions');
    expect(coreLinkLabel({ tab: null })).toBeNull();
  });
});

test.describe('setup', () => {
  test('fixed notes on the Setup cards', () => {
    expect(NON_RESPONDENT_MODE_NOTES).toEqual({
      include: 'They fill open seats, at most one per team where possible.',
      group:
        "They're placed together, in teams of their own, on the projects with room, most-wanted first.",
      exclude: 'They get no team from this set.',
    });
    // A set with no grouping question has no projects: Group says what it does there.
    expect(NON_RESPONDENT_MODE_NOTES_FREE).toEqual({
      include: 'They fill open seats, at most one per team where possible.',
      group: "They're placed together, in teams of their own, after everyone who answered.",
      exclude: 'They get no team from this set.',
    });
    expect(nonRespondentModeNotes(true)).toBe(NON_RESPONDENT_MODE_NOTES);
    expect(nonRespondentModeNotes(false)).toBe(NON_RESPONDENT_MODE_NOTES_FREE);
    expect(Object.values(NON_RESPONDENT_MODE_NOTES_FREE).join(' ')).not.toMatch(/project/i);
    expect(PAIRS_IDENTITY_NOTE).toBe('The identity rule is off for teams of two.');
    expect(PROJECTS_FOOTNOTE).toBe(
      'A size here overrides the team size for that project. A project with someone pinned to it runs.'
    );
  });

  test("people who didn't answer: the mode in effect is pressed; unset reads as Default", () => {
    const pressed = (mode: 'include' | 'group' | 'exclude' | null, resolved = 'include' as const) =>
      nonRespondentChoices({ mode, resolved })
        .filter(choice => choice.pressed)
        .map(choice => [choice.label, choice.isDefault]);

    // No setting, and the service resolved the default to Spread (e.g. Group
    // for teams of two that can't form teams): Spread, marked Default.
    expect(nonRespondentChoices({ mode: null, resolved: 'include' })).toEqual([
      { mode: 'include', label: 'Spread them out', pressed: true, isDefault: true },
      { mode: 'group', label: 'Group them together', pressed: false, isDefault: false },
      { mode: 'exclude', label: 'Leave them out', pressed: false, isDefault: false },
    ]);
    expect(nonRespondentChoices({ mode: null, resolved: 'group' }).map(c => c.pressed)).toEqual([
      false,
      true,
      false,
    ]);
    // A saved mode is pressed as it is, never marked Default.
    expect(pressed('include')).toEqual([['Spread them out', false]]);
    expect(pressed('exclude')).toEqual([['Leave them out', false]]);
    expect(TEAMS_LABELS.defaultChip).toBe('Default');
  });

  test('an option size override may leave either end to the set', () => {
    // SetupOption.size is the partial override as stored: a null end follows the set.
    const sizes: SetupOption['size'][] = [
      null,
      { min: 4, max: null },
      { min: null, max: 5 },
      { min: 4, max: 4 },
    ];
    expect(sizes.map(size => (size ? [size.min, size.max] : null))).toEqual([
      null,
      [4, null],
      [null, 5],
      [4, 4],
    ]);
  });

  test('readiness, type facts, counts', () => {
    expect(
      readinessParts({ roster: 24, answered: 21, not_answered: 3, closes_at: null, closed: true })
    ).toEqual(['24 on the roster', '21 answered', "3 haven't"]);
    expect(typeFactsText({ options: 8, ranks: 5 })).toBe('8 options · top 5');
    expect(typeFactsText({ min: 1, max: 5 })).toBe('1–5');
    expect(typeFactsText({ source: 'roster', required: false })).toBe('roster · optional');
    expect(questionCountsText({ answered: 21, skipped: 0, requests: 12, mutual: 4 })).toBe(
      '12 requests · 4 mutual'
    );
    expect(questionCountsText({ answered: 21, skipped: 0, pitchers: 1 })).toBe('1 pitcher');
    expect(questionCountsText({ answered: 21, skipped: 0, class_average: 3.2 })).toBe(
      'Class average 3.2'
    );
    expect(questionCountsText({ answered: 19, skipped: 2 })).toBe('19 answered · 2 skipped');
    expect(questionCountsText({ answered: 9, skipped: 0 })).toBe('9 answered');
    expect(studentsSeeText('Optional. Only course staff can see it.')).toBe(
      'Students see: "Optional. Only course staff can see it."'
    );
  });

  test("a question row's hints: rank costs, the shift, owner and together", () => {
    // The service's defaults: 0, 10, 30, 60, 80, 90; anything else 100.
    expect(rankCostsText({}, 3, false)).toBe('1st 0 · 2nd 10 · 3rd 30 · anything else 100');
    expect(rankCostsText({ rank_costs: [0, 5], unranked_cost: 50 }, 3, false)).toBe(
      '1st 0 · 2nd 5 · 3rd 5 · anything else 50'
    );
    expect(rankCostsText({}, 1, true)).toBe('picked 0 · anything else 100');
    expect(priorityHintText(50)).toBe(
      'For each student, the answer moves weight between rules A and B for that student only. At a 50% shift the rule that counts more is ×1.5 and the other ×0.5.'
    );
    const ranked = { type: 'ranked_choice' as const, type_facts: { options: 8, ranks: 2 } };
    expect(jobHintText(ranked, 'rank', {})).toBe('1st 0 · 2nd 10 · anything else 100');
    expect(jobHintText(ranked, 'owner', {})).toBe('Pitchers go on their own project when it runs.');
    expect(jobHintText(ranked, 'together', {})).toBe('Mutual requests count double.');
    expect(jobHintText(ranked, 'priority', {})).toBe(priorityHintText(50));
    expect(jobHintText(ranked, 'priority', { shift: 70 })).toBe(priorityHintText(70));
    expect(jobHintText(ranked, 'mix', {})).toBeNull();
    expect(JOB_LABELS.no_one_alone).toBe("A team won't have exactly one of these");
  });

  test('a check line names its people after the sentence', () => {
    expect(checkLineText({ message: 'Two pins conflict.' })).toBe('Two pins conflict.');
    expect(checkLineText({ message: 'Two pins conflict.', names: [] })).toBe('Two pins conflict.');
    expect(checkLineText({ message: 'Two pins conflict.', names: ['Ana Ruiz', 'Ben Osei'] })).toBe(
      'Two pins conflict. · Ana Ruiz and Ben Osei'
    );
    expect(CHECK_LEVEL_LABELS).toEqual({ error: 'Error', warning: 'Warning', ok: 'Passed' });
  });

  test('Must labels come from ruleMustLabel, via the question or directly', () => {
    expect(
      mustLabelFor({ must_labels: { rank: 'Everyone gets one of their top 3' } }, 'rank')
    ).toBe('Everyone gets one of their top 3');
    expect(mustLabelFor({ must_labels: {} }, 'balance')).toBeNull();
    expect(
      ruleMustLabel(
        { job: 'rank', params: { must_top: 3 } },
        { id: 'f', type: 'ranked_choice', ranks: 5, options: [] }
      )
    ).toBe('Everyone gets one of their top 3');
  });

  test('which options run, pitchers', () => {
    expect(
      optionRunsSummary([
        { label: 'Trailhead', runs: 'auto' },
        { label: 'Pantry', runs: 'open' },
        { label: 'Roost', runs: 'closed' },
        { label: 'Echo', runs: 'auto' },
      ])
    ).toBe('Pantry always runs and Roost is closed; the solver decides on the other 2.');
    expect(
      optionRunsSummary([
        { label: 'Trailhead', runs: 'auto' },
        { label: 'Echo', runs: 'auto' },
      ])
    ).toBe('The solver decides on all 2.');
    expect(
      optionRunsSummary([
        { label: 'Canopy', runs: 'closed' },
        { label: 'Pulse', runs: 'closed' },
      ])
    ).toBe('Canopy and Pulse are closed.');
    expect(pitchersText([])).toBe('None');
    expect(
      pitchersText([
        { user_id: 'u1', name: 'Maya Okafor', on_roster: true },
        { user_id: null, name: null, on_roster: false },
      ])
    ).toBe('Maya Okafor, Not on the roster');
  });
});

test.describe("run links, the stale chip, Can't solve, fixed labels", () => {
  test('run links', () => {
    expect(showRunText(4)).toBe('Show run 4');
    expect(backToRunText(4)).toBe('Back to run 4');
    expect(openRunText(3)).toBe('Open run 3');
  });

  test('the stale chip: a count or none, no full stop', () => {
    expect(staleChipText(1)).toBe('1 response changed since this run');
    expect(staleChipText(3)).toBe('3 responses changed since this run');
    // Without a count the reason may be the roster or a republish: say both.
    expect(staleChipText()).toBe('Answers or the roster changed since this run');
    expect(staleChipText(null)).toBe('Answers or the roster changed since this run');
  });

  test("Can't solve heading and intro", () => {
    expect(cantSolveHeading()).toBe("These rules can't all hold");
    expect(cantSolveIntro()).toBe('No teams were formed. These settings conflict:');
  });

  test("Can't solve names: each pair on its own, else the list", () => {
    const dev = person('u-dev', 'Dev Rao');
    const eli = person('u-eli', 'Eli Diaz');
    // One pair (from a together or an apart rule: joined the same way).
    expect(corePeopleText({ people: [ana, ben], pairs: [[0, 1]] })).toBe('Ana Ruiz and Ben Osei');
    // One rule's pairs, merged: each pair reads on its own.
    expect(
      corePeopleText({
        people: [ana, ben, cleo, dev],
        pairs: [
          [0, 1],
          [2, 3],
        ],
      })
    ).toBe('Ana Ruiz and Ben Osei; Cleo Park and Dev Rao');
    // Someone in two pairs is named in each.
    expect(
      corePeopleText({
        people: [ana, ben, cleo],
        pairs: [
          [0, 1],
          [0, 2],
        ],
      })
    ).toBe('Ana Ruiz and Ben Osei; Ana Ruiz and Cleo Park');
    // Anyone in no pair follows the pairs, comma-joined.
    expect(corePeopleText({ people: [ana, ben, cleo], pairs: [[0, 1]] })).toBe(
      'Ana Ruiz and Ben Osei; Cleo Park'
    );
    expect(corePeopleText({ people: [ana, ben, cleo, dev, eli], pairs: [[0, 1]] })).toBe(
      'Ana Ruiz and Ben Osei; Cleo Park, Dev Rao, Eli Diaz'
    );
    expect(corePeopleText({ people: [nameless, ben], pairs: [[0, 1]] })).toBe(
      `${UNNAMED} and Ben Osei`
    );
    // Never "with": a pair may be two people kept apart.
    expect(
      corePeopleText({
        people: [ana, ben, cleo, dev],
        pairs: [
          [0, 1],
          [2, 3],
        ],
      })
    ).not.toMatch(/\bwith\b/);
    // No pairs: the names as a list, as before.
    expect(corePeopleText({ people: [ana] })).toBe('Ana Ruiz');
    expect(corePeopleText({ people: [ana, ben, cleo] })).toBe('Ana Ruiz, Ben Osei and Cleo Park');
    expect(corePeopleText({ people: [ana, ben], pairs: [] })).toBe('Ana Ruiz and Ben Osei');
    // A pair pointing outside `people` is skipped; with none left, the list.
    expect(corePeopleText({ people: [ana, ben], pairs: [[0, 5]] })).toBe('Ana Ruiz and Ben Osei');
    expect(
      corePeopleText({
        people: [ana, ben, cleo],
        pairs: [
          [0, 1],
          [1, 9],
        ],
      })
    ).toBe('Ana Ruiz and Ben Osei; Cleo Park');
    // No one named: nothing, pairs or not.
    expect(corePeopleText({})).toBeNull();
    expect(corePeopleText({ people: [] })).toBeNull();
    expect(corePeopleText({ pairs: [[0, 1]] })).toBeNull();
  });

  test('fixed labels, including the ones the components used as literals', () => {
    expect(TEAMS_LABELS).toMatchObject({
      forms: 'Forms',
      teams: 'Teams',
      teamSets: 'Team sets',
      run: 'Run',
      checks: 'Checks',
      compareWith: 'Compare with',
      startSet: 'Start set',
      nonRespondents: "People who didn't answer",
      runs: 'Runs',
      change: 'Change',
      peopleMoved: 'People moved',
      whoMoved: 'Who moved',
      whyTitle: 'Why this placement',
      showWhich: 'Show which',
      discard: 'Discard',
      runAgain: 'Run again',
      addPin: 'Add pin',
      keepOn: 'Keep on',
      moveTo: 'Move to',
      keepApartFrom: 'Keep apart from',
      reason: 'Reason',
      pinned: 'Pinned',
      tagForSet: 'Tag for this set',
      teamNames: 'Team names',
      alsoGithub: 'Also create GitHub teams',
      cancel: 'Cancel',
      retry: 'Retry',
      openInTeams: 'Open in Teams',
      makeGroupAssignment: 'Make a group assignment for this tag',
      startNewSet: 'Start a new set from this setup',
    });
    for (const [key, label] of Object.entries(TEAMS_LABELS)) {
      expect(label.trim(), key).toBe(label);
      expect(label, key).not.toMatch(/\.$/);
    }
  });
});

test.describe('create', () => {
  const team = (patch: Partial<CreateTeamProgress>): CreateTeamProgress => ({
    n: 1,
    name: 'project-teams-trailhead',
    state: 'done',
    members_added: 6,
    size: 6,
    github_team: true,
    ...patch,
  });

  const create: CreateProgressView = {
    status: 'RUNNING',
    run_number: 4,
    attempt: 1,
    total: 5,
    done: 3,
    counts: { teams_created: 3, teams_failed: 0, members_added: 18, members_failed: 0 },
    members_total: 24,
    claimed_by: you,
    started_at: '2026-09-26T19:00:00.000Z',
    finished_at: null,
    tag: { id: 't1', name: 'project-teams' },
    teams: [team({}), team({ n: 2, github_team: false, state: 'queued', members_added: 0 })],
    renamed: [{ n: 3, from: 'project-teams-studio', to: 'project-teams-studio-2' }],
    failures: [],
  };

  test('banner, rows, renames', () => {
    expect(creatingBannerText(create)).toBe(
      'Creating 5 teams from run 4 · 3 of 5 teams done · 18 of 24 members added'
    );
    expect(createStartedText(create, VIEWER)).toBe('From run 4 · started by you');
    expect(createTeamRowText(team({}))).toBe('6 of 6 members · GitHub team made');
    expect(createTeamRowText(team({ github_team: false }))).toBe('6 of 6 members');
    // A live team's GitHub team is never reported (github_team false until done).
    expect(
      createTeamRowText(team({ state: 'live', members_added: 0, size: 4, github_team: false }))
    ).toBe('Adding members · 0 of 4');
    expect(createTeamRowText(team({ state: 'queued' }))).toBe('Queued');
    expect(createTeamRowText(team({ state: 'failed', failure: 'name_collision' }))).toBe(
      'The team name is already taken.'
    );
    expect(renamedText(create.renamed[0])).toBe(
      'project-teams-studio was already taken, so this team is project-teams-studio-2.'
    );
  });

  test('created summary', () => {
    const done: CreateProgressView = {
      ...create,
      status: 'DONE',
      done: 5,
      counts: { teams_created: 5, teams_failed: 0, members_added: 24, members_failed: 0 },
      teams: [team({}), team({ n: 2 })],
    };
    expect(createdTitle(done)).toBe('5 teams created under project-teams');
    expect(createdByText(done, VIEWER, '26 Sep at 3:12 pm')).toBe(
      'By you on 26 Sep at 3:12 pm, from run 4. 24 students and 2 GitHub teams.'
    );
    expect(
      createdByText(
        { ...done, claimed_by: ana, teams: [team({ github_team: false })] },
        VIEWER,
        '26 Sep'
      )
    ).toBe('By Ana Ruiz on 26 Sep, from run 4. 24 students.');
  });

  test("the poll's states go over the loaded rows; names stay as loaded", () => {
    const loaded: CreateProgressView = {
      ...create,
      total: 3,
      done: 1,
      counts: { teams_created: 1, teams_failed: 0, members_added: 6, members_failed: 0 },
      members_total: 16,
      teams: [
        team({}),
        team({ n: 2, name: 'project-teams-pantry', state: 'live', members_added: 0, size: 6 }),
        team({ n: 3, name: 'project-teams-studio', state: 'queued', members_added: 0, size: 4 }),
      ].map(row => (row.state === 'done' ? row : { ...row, github_team: false })),
      renamed: [],
      failures: [],
    };
    const live: CreatePollView = {
      status: 'FAILED',
      run_number: 4,
      attempt: 1,
      total: 3,
      done: 2,
      counts: { teams_created: 2, teams_failed: 1, members_added: 12, members_failed: 0 },
      members_total: 16,
      finished_at: '2026-09-26T19:05:00.000Z',
      teams: [
        { n: 1, state: 'done', members_added: 6, size: 6, github_team: true },
        { n: 2, state: 'done', members_added: 6, size: 6, github_team: true },
        {
          n: 3,
          state: 'failed',
          members_added: 0,
          size: 4,
          github_team: false,
          failure: 'provider_error',
        },
      ],
    };

    // No answer yet, or one about a create from another run: as loaded.
    expect(liveCreate(loaded, null)).toBe(loaded);
    expect(liveCreate(loaded, { ...live, run_number: 5 })).toBe(loaded);

    const shown = liveCreate(loaded, live);
    expect(shown.status).toBe('FAILED');
    expect(shown.done).toBe(2);
    expect(shown.counts).toEqual(live.counts);
    expect(shown.finished_at).toBe(live.finished_at);
    expect(shown.teams.map(row => [row.n, row.name, row.state])).toEqual([
      [1, 'project-teams-trailhead', 'done'],
      [2, 'project-teams-pantry', 'done'],
      [3, 'project-teams-studio', 'failed'],
    ]);
    expect(createTeamRowText(shown.teams[1]!)).toBe('6 of 6 members · GitHub team made');
    expect(createTeamRowText(shown.teams[2]!)).toBe('GitHub returned an error.');
    // Who claimed it, the tag, renames and member failures: the loaded ones.
    expect(shown.claimed_by).toBe(loaded.claimed_by);
    expect(shown.tag).toBe(loaded.tag);
    expect(shown.failures).toBe(loaded.failures);
    expect(shown.renamed).toBe(loaded.renamed);
  });

  test('dialog and why Create is off', () => {
    const preview = {
      run_number: 4,
      name_template: '{set}-{option}',
      teams: [
        { name: 'project-teams-trailhead', option: trailhead, size: 6 },
        { name: 'project-teams-pantry', option: null, size: 6 },
        { name: 'project-teams-studio', option: studio, size: 4 },
      ],
    };
    expect(createDialogTitle(preview)).toBe('Create 3 teams from run 4');
    expect(createDialogTitle(3, 4)).toBe('Create 3 teams from run 4');
    expect(createDialogTitle(1, 2)).toBe('Create 1 team from run 2');
    expect(createButtonText(3)).toBe('Create 3 teams');
    expect(createRetryText({ attempt: 2, teams_already_created: 2 }, 5)).toBe(
      '2 of 5 teams already created.'
    );
    expect(createRetryText({ attempt: 2, teams_already_created: 1 })).toBe(
      '1 team already created.'
    );
    expect(teamNamesExample(preview)).toBe(
      '{set}-{option} → project-teams-trailhead, project-teams-pantry, …'
    );
    expect(createBlockedText({ allowed: false, blockedBy: null })).toBe(
      'Only classroom owners can create teams.'
    );
    expect(createBlockedText({ allowed: true, blockedBy: 'stale' })).toBe(
      'Answers or the roster changed since this run.'
    );
    expect(createBlockedText({ allowed: true, blockedBy: 'create_failed', failedRun: 3 })).toBe(
      'Teams were partly created from run 3; only that run can be retried.'
    );
    expect(createBlockedText({ allowed: true, blockedBy: null })).toBeNull();
  });
});
