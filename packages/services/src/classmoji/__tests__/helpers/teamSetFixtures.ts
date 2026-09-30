/**
 * Synthetic team-set fixtures. Every id, label and answer here is invented;
 * no real student data. Answers are generated from a fixed-seed PRNG so the
 * fixture is identical on every run, and the first three people have
 * hand-written answers so tests can assert exact compiled numbers.
 */

import { parseFormDefinition, type FormField } from '../../formContract.ts';
import { TeamSetConfigSchema, type TeamSetConfigInput } from '../../teamSetConfig.ts';
import type { CompileInput } from '../../teamSetProblem.ts';

/** A valid, deterministic uuid: namespace in the first group, n in the last. */
export const uuid = (ns: number, n: number) =>
  `${ns.toString(16).padStart(8, '0')}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Workshop form ──────────────────────────────────────────────────────────

export const F = {
  projects: uuid(1, 1),
  tracks: uuid(1, 2),
  react: uuid(1, 3),
  timing: uuid(1, 4),
  partners: uuid(1, 5),
  notes: uuid(1, 6),
};

export const PROJECT_IDS = Array.from({ length: 20 }, (_, i) => uuid(2, i + 1));
export const TRACK_LABELS = ['Health', 'Climate', 'Education', 'Games', 'Civic', 'Tools'];
export const TRACK_IDS = TRACK_LABELS.map((_, i) => uuid(3, i + 1));
export const TIMING_IDS = [1, 2, 3, 4].map(i => uuid(4, i));
export const NO_PREFERENCE = TIMING_IDS[3];
/** 27 people; person index p = n − 1 because ids sort in numeric order. */
export const USER_IDS = Array.from({ length: 27 }, (_, i) => uuid(9, i + 1));
/** The last four never responded. */
export const NON_RESPONDENTS = USER_IDS.slice(23);

export const WORKSHOP_TITLE = 'Workshop Project Preferences — Fall 2026';

export function workshopFields(): FormField[] {
  return parseFormDefinition([
    {
      id: F.projects,
      type: 'ranked_choice',
      label: 'Rank the projects you want to work on',
      ranks: 4,
      options: PROJECT_IDS.map((id, i) => ({ id, label: `Project ${i + 1}` })),
    },
    {
      id: F.tracks,
      type: 'multiselect',
      label: 'Which tracks interest you?',
      options: TRACK_IDS.map((id, i) => ({ id, label: TRACK_LABELS[i] })),
    },
    {
      id: F.react,
      type: 'opinion_scale',
      label: 'How comfortable are you with React?',
      scale: { min: 1, max: 5 },
    },
    {
      id: F.timing,
      type: 'dropdown',
      label: 'When can you meet?',
      options: ['Mornings', 'Afternoons', 'Evenings', 'No preference'].map((label, i) => ({
        id: TIMING_IDS[i],
        label,
      })),
    },
    {
      id: F.partners,
      type: 'roster_select',
      label: 'Who would you like to work with?',
      optionSource: 'roster',
      multiple: true,
      options: USER_IDS.map((id, i) => ({ id, label: `Student ${i + 1}` })),
    },
    { id: F.notes, type: 'long_text', label: 'Anything we should know?' },
  ]).fields;
}

/** Project i (0-based) belongs to track i mod 6. */
export const projectCategory = (i: number) => TRACK_LABELS[i % 6];

export function workshopConfigInput(): TeamSetConfigInput {
  return {
    version: 1,
    grouping: { mode: 'by_option', field_id: F.projects, teams_per_option: 1 },
    team_size: { min: 2, max: 2, allow_one_larger: true },
    // Phase 1 stored configs say 'include' explicitly; pairs would otherwise resolve to 'group'.
    non_respondents: 'include',
    options: Object.fromEntries(PROJECT_IDS.map((id, i) => [id, { category: projectCategory(i) }])),
    rules: [
      { field_id: F.projects, job: 'rank', strength: 'prefer', weight: 8 },
      { field_id: F.tracks, job: 'fallback', strength: 'prefer', weight: 5 },
      { field_id: F.react, job: 'balance', strength: 'prefer', weight: 3 },
      {
        field_id: F.timing,
        job: 'match',
        strength: 'prefer',
        weight: 4,
        params: { wildcard_option_ids: [NO_PREFERENCE] },
      },
      { field_id: F.partners, job: 'together', strength: 'prefer', weight: 5 },
      { field_id: F.notes, job: 'note', strength: 'prefer' },
    ],
  };
}

export const workshopConfig = () => TeamSetConfigSchema.parse(workshopConfigInput());

export function workshopResponses(): CompileInput['responses'] {
  const fixed: Record<string, unknown>[] = [
    {
      // person 0
      [F.projects]: PROJECT_IDS.slice(0, 4),
      [F.tracks]: [TRACK_IDS[0]], // Health
      [F.react]: 5,
      [F.timing]: TIMING_IDS[0], // Mornings
      [F.partners]: [USER_IDS[1], USER_IDS[2]],
      [F.notes]: 'Synthetic note one',
    },
    {
      // person 1
      [F.projects]: [PROJECT_IDS[1], PROJECT_IDS[0], PROJECT_IDS[4], PROJECT_IDS[5]],
      [F.tracks]: [TRACK_IDS[1]], // Climate
      [F.react]: 1,
      [F.timing]: NO_PREFERENCE,
      [F.partners]: [USER_IDS[0]],
      [F.notes]: null,
    },
    {
      // person 2
      [F.projects]: [PROJECT_IDS[2], PROJECT_IDS[3], PROJECT_IDS[6], PROJECT_IDS[7]],
      [F.tracks]: [],
      [F.react]: 3,
      [F.timing]: TIMING_IDS[2], // Evenings
      [F.partners]: [],
      [F.notes]: '',
    },
  ];
  const rand = prng(20260924);
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const shuffled = <T>(list: T[]) => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  const answers = USER_IDS.slice(0, 23).map((self, i) => {
    if (i < fixed.length) return fixed[i];
    const projects = shuffled(PROJECT_IDS).slice(0, 4);
    const tracks = shuffled(TRACK_IDS).slice(0, 1 + Math.floor(rand() * 2));
    const partners = shuffled(USER_IDS.filter(id => id !== self)).slice(0, Math.floor(rand() * 3));
    return {
      [F.projects]: projects,
      [F.tracks]: tracks,
      [F.react]: 1 + Math.floor(rand() * 5),
      [F.timing]: pick(TIMING_IDS),
      [F.partners]: partners,
      [F.notes]: `Synthetic note ${i + 1}`,
    };
  });
  return answers.map((a, i) => ({
    response_id: uuid(8, i + 1),
    user_id: USER_IDS[i],
    answers: a,
  }));
}

export function workshopInput(overrides: Partial<CompileInput> = {}): CompileInput {
  return {
    setName: 'workshop-pairs',
    config: workshopConfig(),
    fields: workshopFields(),
    responses: workshopResponses(),
    // Deliberately NOT in id order: compile sorts.
    roster: [...USER_IDS].reverse().map(user_id => ({ user_id })),
    seed: 7,
    ...overrides,
  };
}

// ─── Bidding form (hand-checkable: option sizes, group, owner, priority,
// identity) ──────────────────────────────────────────────────────────────────

export const B = {
  projects: uuid(31, 1),
  pitched: uuid(31, 2),
  partners: uuid(31, 3),
  identity: uuid(31, 4),
  matters: uuid(31, 5),
  timing: uuid(31, 6),
  lead: uuid(31, 7),
};

/** Five projects; the pitched dropdown shares their ids. */
export const BID_PROJECT_IDS = [1, 2, 3, 4, 5].map(i => uuid(32, i));
/** Answers A, B, C and an exclusive "Prefer not to say" (the last). */
export const BID_IDENTITY_IDS = [1, 2, 3, 4].map(i => uuid(33, i));
/** "The project", "The people", "Both equally". */
export const MATTERS_IDS = [1, 2, 3].map(i => uuid(34, i));
/** Mornings, Evenings. */
export const BID_TIMING_IDS = [1, 2].map(i => uuid(35, i));
/** 8 people; person index p = n − 1. The last two never responded. */
export const BID_USERS = [1, 2, 3, 4, 5, 6, 7, 8].map(n => uuid(39, n));

export function biddingFields(): FormField[] {
  const projects = BID_PROJECT_IDS.map((id, i) => ({ id, label: `Project ${i + 1}` }));
  return parseFormDefinition([
    {
      id: B.projects,
      type: 'ranked_choice',
      label: 'Rank the projects',
      ranks: 4,
      options: projects,
    },
    {
      id: B.pitched,
      type: 'dropdown',
      label: 'Did you pitch one of these projects?',
      options: projects,
    },
    {
      id: B.partners,
      type: 'roster_select',
      label: 'Who would you like to work with?',
      optionSource: 'roster',
      multiple: true,
      options: BID_USERS.map((id, i) => ({ id, label: `Person ${i + 1}` })),
    },
    {
      id: B.identity,
      type: 'multiselect',
      label: 'Which of these describe you?',
      identity_question: true,
      options: [
        { id: BID_IDENTITY_IDS[0], label: 'Answer A' },
        { id: BID_IDENTITY_IDS[1], label: 'Answer B' },
        { id: BID_IDENTITY_IDS[2], label: 'Answer C' },
        { id: BID_IDENTITY_IDS[3], label: 'Prefer not to say', exclusive: true },
      ],
    },
    {
      id: B.matters,
      type: 'dropdown',
      label: 'What matters more to you?',
      options: ['The project', 'The people', 'Both equally'].map((label, i) => ({
        id: MATTERS_IDS[i],
        label,
      })),
    },
    {
      id: B.timing,
      type: 'dropdown',
      label: 'When can you meet?',
      options: ['Mornings', 'Evenings'].map((label, i) => ({ id: BID_TIMING_IDS[i], label })),
    },
    { id: B.lead, type: 'switch', label: 'Would you like to lead a team?' },
  ]).fields;
}

/**
 * Teams of 2–3 by project, fairness 0 (d is not bent), rank 5 (costs 0, 50,
 * 150, 300; unranked 500), together 4, match on timing 3 (a mismatched pair
 * costs round(200 × 3 / 2) = 300). Non-respondents pinned to 'include'.
 */
export function biddingConfigInput(): TeamSetConfigInput {
  return {
    version: 1,
    grouping: { mode: 'by_option', field_id: B.projects, teams_per_option: 1 },
    team_size: { min: 2, max: 3 },
    non_respondents: 'include',
    fairness: 0,
    rules: [
      { field_id: B.projects, job: 'rank', strength: 'prefer', weight: 5 },
      { field_id: B.partners, job: 'together', strength: 'prefer', weight: 4 },
      { field_id: B.timing, job: 'match', strength: 'prefer', weight: 3 },
    ],
  };
}

export const biddingConfig = () => TeamSetConfigSchema.parse(biddingConfigInput());

/**
 *        projects       pitched  partners  identity  matters  timing  lead
 *   p0   P1 P2 P3       P1       p1        A         project  M       true
 *   p1   P2 P1          —        p0 p2     B         people   M       false
 *   p2   P1 P3          P3       —         A B       both     E       —
 *   p3   P2             —        p0        C         people   E       —
 *   p4   P3 P2 P1       —        —         (opt out) —        M       —
 *   p5   P1             P1       —         B         project  —       —
 *   p6, p7 never responded.
 */
export function biddingResponses(): CompileInput['responses'] {
  const [P1, P2, P3] = BID_PROJECT_IDS as [string, string, string, string, string];
  const [A, Bb, C, OPT_OUT] = BID_IDENTITY_IDS as [string, string, string, string];
  const [PROJECT, PEOPLE, BOTH] = MATTERS_IDS as [string, string, string];
  const [MORNINGS, EVENINGS] = BID_TIMING_IDS as [string, string];
  const u = BID_USERS;
  const answers: Record<string, unknown>[] = [
    {
      [B.projects]: [P1, P2, P3],
      [B.pitched]: P1,
      [B.partners]: [u[1]],
      [B.identity]: [A],
      [B.matters]: PROJECT,
      [B.timing]: MORNINGS,
      [B.lead]: true,
    },
    {
      [B.projects]: [P2, P1],
      [B.partners]: [u[0], u[2]],
      [B.identity]: [Bb],
      [B.matters]: PEOPLE,
      [B.timing]: MORNINGS,
      [B.lead]: false,
    },
    {
      [B.projects]: [P1, P3],
      [B.pitched]: P3,
      [B.partners]: [],
      [B.identity]: [A, Bb],
      [B.matters]: BOTH,
      [B.timing]: EVENINGS,
    },
    {
      [B.projects]: [P2],
      [B.partners]: [u[0]],
      [B.identity]: [C],
      [B.matters]: PEOPLE,
      [B.timing]: EVENINGS,
    },
    { [B.projects]: [P3, P2, P1], [B.identity]: [OPT_OUT], [B.timing]: MORNINGS },
    { [B.projects]: [P1], [B.pitched]: P1, [B.identity]: [Bb], [B.matters]: PROJECT },
  ];
  return answers.map((a, i) => ({ response_id: uuid(38, i + 1), user_id: u[i], answers: a }));
}

export function biddingInput(overrides: Partial<CompileInput> = {}): CompileInput {
  return {
    setName: 'bidding',
    config: biddingConfig(),
    fields: biddingFields(),
    responses: biddingResponses(),
    roster: [...BID_USERS].reverse().map(user_id => ({ user_id })),
    seed: 3,
    ...overrides,
  };
}

// ─── Mini form (hand-checkable metrics and checks) ──────────────────────────

export const M = { ideas: uuid(11, 1), colors: uuid(11, 2), friends: uuid(11, 3) };
/** X (Red), Y (Blue), Z (Red). */
export const IDEA_IDS = [uuid(12, 1), uuid(12, 2), uuid(12, 3)];
export const COLOR_IDS = [uuid(13, 1), uuid(13, 2)];
export const MINI_USERS = [1, 2, 3, 4, 5].map(n => uuid(19, n));

export function miniFields(): FormField[] {
  return parseFormDefinition([
    {
      id: M.ideas,
      type: 'ranked_choice',
      label: 'Rank the ideas',
      ranks: 2,
      options: ['X', 'Y', 'Z'].map((label, i) => ({ id: IDEA_IDS[i], label: `Idea ${label}` })),
    },
    {
      id: M.colors,
      type: 'multiselect',
      label: 'Colors',
      options: ['Red', 'Blue'].map((label, i) => ({ id: COLOR_IDS[i], label })),
    },
    {
      id: M.friends,
      type: 'roster_select',
      label: 'Friends',
      optionSource: 'roster',
      multiple: true,
      options: MINI_USERS.map((id, i) => ({ id, label: `Mini ${i + 1}` })),
    },
  ]).fields;
}

export function miniConfigInput(): TeamSetConfigInput {
  return {
    version: 1,
    grouping: { mode: 'by_option', field_id: M.ideas },
    team_size: { min: 1, max: 3 },
    options: {
      [IDEA_IDS[0]]: { category: 'Red' },
      [IDEA_IDS[1]]: { category: 'Blue' },
      [IDEA_IDS[2]]: { category: 'Red' },
    },
    rules: [
      { field_id: M.ideas, job: 'rank', strength: 'prefer' },
      { field_id: M.colors, job: 'fallback', strength: 'prefer' },
      { field_id: M.friends, job: 'together', strength: 'prefer' },
    ],
  };
}

/**
 * u1 ranks [X, Y], asks for u2; u2 ranks [Y, X], asks for u1 (mutual);
 * u3 ranks [X], likes Red, asks for u4; u4 ranks [Y]; u5 never responded.
 */
export function miniInput(overrides: Partial<CompileInput> = {}): CompileInput {
  const [X, Y] = IDEA_IDS as [string, string, string];
  const [u1, u2, u3, u4] = MINI_USERS as [string, string, string, string, string];
  const answers: Record<string, unknown>[] = [
    { [M.ideas]: [X, Y], [M.colors]: [], [M.friends]: [u2] },
    { [M.ideas]: [Y, X], [M.colors]: [], [M.friends]: [u1] },
    { [M.ideas]: [X], [M.colors]: [COLOR_IDS[0]], [M.friends]: [u4] },
    { [M.ideas]: [Y], [M.colors]: null, [M.friends]: [] },
  ];
  return {
    setName: 'mini',
    config: TeamSetConfigSchema.parse(miniConfigInput()),
    fields: miniFields(),
    responses: answers.map((a, i) => ({
      response_id: uuid(18, i + 1),
      user_id: [u1, u2, u3, u4][i],
      answers: a,
    })),
    roster: MINI_USERS.map(user_id => ({ user_id })),
    seed: 1,
    ...overrides,
  };
}
