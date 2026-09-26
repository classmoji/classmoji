/**
 * Team sets — pre-solve checks.
 *
 * PURE MODULE. Runs on the compiled problem BEFORE a run is queued, so the
 * common impossible setups are refused with a sentence an instructor can act
 * on ("27 people can't make teams of exactly 2") instead of a solver
 * INFEASIBLE with a core to decode. Error-level issues stop `startRun`;
 * warnings ride along with the run.
 *
 * These are NECESSARY conditions only — passing them does not promise a
 * solution (two musts can still collide in ways only the solver sees; its
 * core names those). Every check here is cheap and exact for what it tests.
 *
 * Messages carry counts and rule/pin labels, never names: user ids go in
 * `user_ids` for the caller to resolve.
 *
 * Codes (closed vocabulary):
 *   errors   no_people · capacity · model_too_large · all_options_forbidden ·
 *            conflicting_required_options · pinned_option_closed ·
 *            required_option_forbidden · required_pair_forbidden ·
 *            together_group_too_large · count_contradiction
 *   warnings no_response · forced_open_unranked · pin_people_missing ·
 *            odd_group_in_pairs
 *
 * model_too_large is the one check that is about the ENGINE, not the rules:
 * the CP-SAT model builds a same-team indicator per pair term per slot, so
 * z = (pair entries + pair hards) × slots estimates its size. Above
 * MODEL_SIZE_LIMIT the engine runs out of memory before it finds anything —
 * refuse up front and say what shrinks it (fewer match/mix rules, which
 * compare every pair of people; or grouping by a question, which cuts the
 * pairs that can share a slot).
 */

import {
  FREE_OPTION_ID,
  type TeamSetContext,
  type TeamSetHard,
  type TeamSetProblem,
} from './teamSetProblem.ts';

export interface CheckIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  srcs?: string[];
  user_ids?: string[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Largest z = (pair entries + pair hards) × slots the engine is asked to build. */
export const MODEL_SIZE_LIMIT = 150_000;

export function runChecks(problem: TeamSetProblem, context: TeamSetContext): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const N = problem.people.length;
  const O = problem.options.length;
  const { min, max, larger } = problem.size;
  const labelOf = srcLabeler(context);
  const userIds = (indices: Iterable<number>) => [...indices].map(p => problem.people[p]);

  // ── Nobody / capacity ──
  if (N === 0) {
    issues.push({
      level: 'error',
      code: 'no_people',
      message: 'There is nobody to place in teams.',
    });
  } else {
    const usable = problem.slots.filter(
      slot => problem.options[slot.option]?.open !== 'closed'
    ).length;
    const forcedOpen = problem.options.filter(option => option.open === 'open').length;
    const kMin = Math.max(problem.team_count.min, forcedOpen, 1);
    const kMax = Math.min(problem.team_count.max, usable);
    let feasible = false;
    for (let k = kMin; k <= kMax && !feasible; k++) {
      if (k * min <= N && N <= k * max + Math.min(larger, k)) feasible = true;
    }
    if (!feasible) {
      const sizeText = min === max ? `exactly ${min}` : `${min}–${max}`;
      const extra = larger ? ` (one team may have ${max + 1})` : '';
      issues.push({
        level: 'error',
        code: 'capacity',
        message:
          `${plural(N, 'person', 'people')} can't be split into teams of ${sizeText}${extra}` +
          ` (${plural(usable, 'usable team slot')}, team count ${problem.team_count.min}–${problem.team_count.max}` +
          `${forcedOpen ? `, ${forcedOpen} option(s) forced open` : ''}).`,
      });
    }
  }

  // ── Engine size ──
  const pairHards = problem.hard.filter(
    h => h.kind === 'forbid_pair' || h.kind === 'require_pair'
  ).length;
  const modelSize = (problem.pair.length + pairHards) * problem.slots.length;
  if (modelSize > MODEL_SIZE_LIMIT) {
    const pairRules = context.rules.filter(rule => rule.job === 'match' || rule.job === 'mix');
    issues.push({
      level: 'error',
      code: 'model_too_large',
      message:
        `This setup is too large to solve: ${plural(problem.pair.length + pairHards, 'pair term')} across ` +
        `${plural(problem.slots.length, 'team slot')}. Remove a match or mix rule (each compares every pair of people)` +
        `${problem.options.length === 1 && problem.options[0].id === FREE_OPTION_ID ? ', or group teams by a question' : ''}.`,
      ...(pairRules.length ? { srcs: pairRules.map(rule => rule.id) } : {}),
    });
  }

  // ── Count constraints ──
  // not_one ∧ max = 1 says "never exactly one, at most one" — only 0 fits,
  // and every member sits on some open team. compileProblem never emits it
  // (max_per_team replaces not_one); this guards the IR itself.
  const countEntries: { src: string; members: number[]; not_one?: true; max?: number }[] = [
    ...problem.hard.filter(
      (h): h is Extract<TeamSetHard, { kind: 'team_count' }> => h.kind === 'team_count'
    ),
    ...problem.soft_counts,
  ];
  const contradictions = countEntries.filter(
    entry => entry.not_one === true && entry.max === 1 && entry.members.length > 0
  );
  if (contradictions.length) {
    const srcs = [...new Set(contradictions.map(entry => entry.src))];
    issues.push({
      level: 'error',
      code: 'count_contradiction',
      message: `A count rule says both "nobody alone" and "at most 1 per team", which no team can satisfy (by ${describe(srcs, labelOf)}).`,
      srcs,
    });
  }
  // Teams of exactly 2 (no larger team allowed): a hard "nobody alone" group
  // can only be split into pairs, so an odd group always leaves one alone.
  if (max === 2 && larger === 0) {
    for (const h of problem.hard) {
      if (h.kind !== 'team_count' || h.not_one !== true || h.members.length % 2 === 0) continue;
      issues.push({
        level: 'warning',
        code: 'odd_group_in_pairs',
        message: `${plural(h.members.length, 'person', 'people')} must not be alone in their group, but teams are pairs and the group is odd — allow one team of 3 or make the rule 'prefer' (by ${describe([h.src], labelOf)}).`,
        srcs: [h.src],
        user_ids: userIds(h.members),
      });
    }
  }

  // ── Per-person place constraints ──
  const forbidden = new Map<number, Map<number, string[]>>(); // p → o → srcs
  const required = new Map<number, Map<number, string[]>>();
  const note = (map: Map<number, Map<number, string[]>>, p: number, o: number, src: string) => {
    const byOption = map.get(p) ?? new Map<number, string[]>();
    byOption.set(o, [...(byOption.get(o) ?? []), src]);
    map.set(p, byOption);
  };
  for (const h of problem.hard) {
    if (h.kind === 'forbid_place') note(forbidden, h.p, h.o, h.src);
    if (h.kind === 'require_place') note(required, h.p, h.o, h.src);
  }

  const allForbidden: number[] = [];
  const allForbiddenSrcs = new Set<string>();
  for (const [p, byOption] of forbidden) {
    if (O > 0 && byOption.size >= O) {
      allForbidden.push(p);
      for (const srcs of byOption.values()) srcs.forEach(src => allForbiddenSrcs.add(src));
    }
  }
  if (allForbidden.length) {
    issues.push({
      level: 'error',
      code: 'all_options_forbidden',
      message: `${plural(allForbidden.length, 'person has', 'people have')} every option ruled out (by ${describe(allForbiddenSrcs, labelOf)}).`,
      srcs: [...allForbiddenSrcs],
      user_ids: userIds(allForbidden),
    });
  }

  for (const [p, byOption] of required) {
    if (byOption.size > 1) {
      const srcs = [...new Set([...byOption.values()].flat())];
      issues.push({
        level: 'error',
        code: 'conflicting_required_options',
        message: `One person is required on ${byOption.size} different options (by ${describe(srcs, labelOf)}).`,
        srcs,
        user_ids: userIds([p]),
      });
    }
    for (const [o, srcs] of byOption) {
      const blockers = forbidden.get(p)?.get(o) ?? [];
      if (blockers.length === 0) continue;
      const optionClosed = problem.options[o]?.open === 'closed';
      const all = [...new Set([...srcs, ...blockers])];
      issues.push({
        level: 'error',
        code: optionClosed ? 'pinned_option_closed' : 'required_option_forbidden',
        message: optionClosed
          ? `One person is required on an option that is closed (by ${describe(srcs, labelOf)}).`
          : `One person is both required on and kept off the same option (by ${describe(all, labelOf)}).`,
        srcs: all,
        user_ids: userIds([p]),
      });
    }
  }

  // ── Pairs: require ∧ forbid, and require_pair groups ──
  const pairKey = (p: number, q: number) => `${Math.min(p, q)}:${Math.max(p, q)}`;
  const forbidPairs = new Map<string, string[]>();
  for (const h of problem.hard) {
    if (h.kind !== 'forbid_pair') continue;
    const key = pairKey(h.p, h.q);
    forbidPairs.set(key, [...(forbidPairs.get(key) ?? []), h.src]);
  }
  const requires = problem.hard.filter(
    (h): h is Extract<TeamSetHard, { kind: 'require_pair' }> => h.kind === 'require_pair'
  );
  for (const h of requires) {
    const blockers = forbidPairs.get(pairKey(h.p, h.q));
    if (!blockers) continue;
    const srcs = [...new Set([h.src, ...blockers])];
    issues.push({
      level: 'error',
      code: 'required_pair_forbidden',
      message: `Two people must be together and must be apart (by ${describe(srcs, labelOf)}).`,
      srcs,
      user_ids: userIds([h.p, h.q]),
    });
  }

  // Groups joined by require_pair must fit one team, and inherit each other's
  // place requirements and pair bans.
  const parent = problem.people.map((_, p) => p);
  const find = (p: number): number => {
    while (parent[p] !== p) {
      parent[p] = parent[parent[p]];
      p = parent[p];
    }
    return p;
  };
  for (const h of requires) parent[find(h.p)] = find(h.q);
  const groups = new Map<number, { members: number[]; srcs: Set<string> }>();
  for (const h of requires) {
    const root = find(h.p);
    const group = groups.get(root) ?? { members: [], srcs: new Set<string>() };
    group.srcs.add(h.src);
    groups.set(root, group);
  }
  for (let p = 0; p < N; p++) groups.get(find(p))?.members.push(p);
  // A ban between two members of one group, other than a directly required
  // pair (already reported above). One pass over the bans, bucketed by group.
  const requiredKeys = new Set(requires.map(h => pairKey(h.p, h.q)));
  const innerBans = new Map<number, string[]>();
  for (const h of problem.hard) {
    if (h.kind !== 'forbid_pair' || requiredKeys.has(pairKey(h.p, h.q))) continue;
    const root = find(h.p);
    if (root !== find(h.q) || !groups.has(root)) continue;
    innerBans.set(root, [...(innerBans.get(root) ?? []), h.src]);
  }
  const capacity = max + (larger > 0 ? 1 : 0);
  for (const [root, group] of groups) {
    const srcs = [...group.srcs];
    if (group.members.length > capacity) {
      issues.push({
        level: 'error',
        code: 'together_group_too_large',
        message: `${group.members.length} people must all be on one team, but teams hold at most ${capacity} (by ${describe(srcs, labelOf)}).`,
        srcs,
        user_ids: userIds(group.members),
      });
    }
    const inner = innerBans.get(root);
    if (inner) {
      const all = [...new Set([...srcs, ...inner])];
      issues.push({
        level: 'error',
        code: 'required_pair_forbidden',
        message: `A group that must stay together contains two people who must be apart (by ${describe(all, labelOf)}).`,
        srcs: all,
        user_ids: userIds(group.members),
      });
    }
    const options = new Map<number, string[]>();
    for (const m of group.members) {
      for (const [o, s] of required.get(m) ?? []) options.set(o, [...(options.get(o) ?? []), ...s]);
    }
    if (options.size > 1) {
      const all = [...new Set([...srcs, ...[...options.values()].flat()])];
      issues.push({
        level: 'error',
        code: 'conflicting_required_options',
        message: `A group that must stay together is required on ${options.size} different options (by ${describe(all, labelOf)}).`,
        srcs: all,
        user_ids: userIds(group.members),
      });
    }
  }

  // ── Warnings ──
  const absent = context.people.filter(person => !person.responded).map(person => person.user_id);
  if (absent.length) {
    issues.push({
      level: 'warning',
      code: 'no_response',
      message: `${plural(absent.length, 'person has', 'people have')} not responded; they will be placed wherever they fit.`,
      user_ids: absent,
    });
  }

  const rankedAnything = context.people.some(person => person.ranked.length > 0);
  if (rankedAnything) {
    const rankedIds = new Set(context.people.flatMap(person => person.ranked));
    const lonely = problem.options
      .map((option, o) => ({ option, o }))
      .filter(({ option }) => option.open === 'open' && !rankedIds.has(option.id));
    if (lonely.length) {
      issues.push({
        level: 'warning',
        code: 'forced_open_unranked',
        message: `${plural(lonely.length, 'option is', 'options are')} forced open but nobody ranked ${lonely.length === 1 ? 'it' : 'them'}.`,
        srcs: lonely.map(({ option }) => `option:${option.id}`),
      });
    }
  }

  for (const pin of context.pins) {
    if (!pin.missing?.length) continue;
    issues.push({
      level: 'warning',
      code: 'pin_people_missing',
      message: `Pin ${pin.id} (${pin.label}) names ${plural(pin.missing.length, 'person', 'people')} who ${pin.missing.length === 1 ? 'is' : 'are'} not in this set; that part of the pin is ignored.`,
      srcs: [`pin:${pin.id}`],
      user_ids: pin.missing,
    });
  }

  return issues;
}

/** src → a human label: the rule's question, the pin's label, or the option. */
function srcLabeler(context: TeamSetContext): (src: string) => string {
  const labels = new Map<string, string>();
  for (const rule of context.rules) labels.set(rule.id, `${rule.job} "${rule.label}"`);
  for (const pin of context.pins) labels.set(`pin:${pin.id}`, `pin ${pin.id} (${pin.label})`);
  return src => {
    if (labels.has(src)) return labels.get(src)!;
    if (src.startsWith('option:')) return 'a closed option';
    return src;
  };
}

function describe(srcs: Iterable<string>, labelOf: (src: string) => string): string {
  const unique = [...new Set([...srcs].map(labelOf))];
  if (unique.length <= 3) return unique.join(', ');
  return `${unique.slice(0, 3).join(', ')} and ${unique.length - 3} more`;
}
