/**
 * Team sets — pre-solve checks.
 *
 * PURE MODULE. Runs on the compiled problem BEFORE a run is queued, so the
 * common impossible setups are refused with a sentence of facts ("27 people
 * can't be split into teams of exactly 2") instead of a solver INFEASIBLE
 * with a core to decode. Error-level issues stop `startRun`; warnings ride
 * along with the run. With `includePassed`, the checks the Setup tab lists
 * add an `ok` line with their facts when they pass ("24 people fit 5 teams
 * of 4–6.", "27 people: 12 teams of 2 and 1 team of 3."); startRun never
 * asks for them, so a run's stored issues are problems only.
 *
 * These are NECESSARY conditions only — passing them does not promise a
 * solution (two musts can still collide in ways only the solver sees; its
 * core names those). Every check here is cheap, and every error other than
 * model_too_large is sound: no assignment meets the rules it names (the test
 * brute-forces tiny problems to hold it to that).
 *
 * Messages are facts: counts, sizes and rule/pin/option labels. They never
 * say what to change; that advice is the agent's, in the MCP tool's hints.
 * They never carry names: user ids go in `user_ids` for the caller to
 * resolve — and never on an issue about an identity question's rule, whose
 * answers are never tied to a person. `srcs` are rule-level: a per-person
 * src (`<rule>@3`, `<rule>@1+4`) is reported as its rule; the people are in
 * `user_ids`.
 *
 * Codes (closed vocabulary):
 *   errors   no_people · capacity · model_too_large · all_options_forbidden ·
 *            conflicting_required_options · pinned_option_closed ·
 *            required_option_forbidden · required_pair_forbidden ·
 *            together_group_too_large · count_contradiction ·
 *            option_capacity_pins · owner_no_pitcher · group_too_small ·
 *            group_no_option · group_split
 *   warnings no_response · forced_open_unranked · pin_people_missing ·
 *            odd_group_in_pairs · identity_single_answer ·
 *            identity_rule_pairs · priority_target_off
 *   ok       capacity · options_ok · pins_ok · option_capacity_pins ·
 *            group_ok (includePassed only)
 *
 * model_too_large is the one check that is about the ENGINE, not the rules:
 * the CP-SAT model builds a same-team indicator per pair term per slot, so
 * z = (pair entries + pair hards) × slots estimates its size. Above
 * MODEL_SIZE_LIMIT the engine runs out of memory before it finds anything,
 * so it is refused up front. Its srcs name the match and mix rules (each
 * compares every pair of people).
 *
 * Team sizes: an option with its own size (problem.options[o].size, IR v2)
 * bounds the teams on its slots; every other slot uses problem.size. The
 * remainder flex (teamSetFlex.ts) lets the fewest teams be one person over
 * or under their size, capped per population by the IR: size.larger/smaller
 * for everyone (for the people placed first in Group mode), group.larger/
 * smaller for the people who didn't answer. Capacity asks minimalFlex, over
 * the usable slots (the ones compile sized the caps over), within those
 * caps, for each population — exactly — and its answer is the Setup's fit
 * line. teamCountRange adds the two populations' fitting counts within the
 * set's team count.
 *
 * The owner rule at Must (`owner_if_open`): an option opens only with one of
 * its pitchers on it. An option none of whose pitchers can be on it (each
 * is kept off it, or must be on another option) never opens, so its slots
 * are not usable; when the option must open (it always runs, or someone must
 * be on it) that is an error.
 *
 * People who didn't answer, grouped (`problem.group`, IR v2): they are
 * seated only with each other, on options whose option_cost is not null
 * (every option that can open), after everyone else is placed. How much room
 * the first stage leaves is only known after solving; the checks here are
 * the ones that hold whatever it leaves: the people placed first fit the
 * team counts left after the group's (groupTeamCounts), and the group fits
 * the options that can open, less one team of each option the people placed
 * first surely open and every option only a pitcher placed first can open
 * (groupSlotIndices, ownerOnlyOptions).
 */

import type { FormField } from './formContract.ts';
import { fieldOptions, teamSetRuleId, type TeamSetConfig } from './teamSetConfig.ts';
import { FLEX_SMALLEST_TEAM, minimalFlex, type FlexSlot, type TeamSetFlex } from './teamSetFlex.ts';
import {
  FREE_OPTION_ID,
  baseSrc,
  groupTeamCounts,
  groupSlotIndices,
  hardStructure,
  ownerOnlyOptions,
  parseSrc,
  type TeamSetContext,
  type TeamSetHard,
  type TeamSetProblem,
} from './teamSetProblem.ts';

export type CheckLevel = 'error' | 'warning' | 'ok';

export interface CheckIssue {
  /** 'ok' = a check that passed, with its facts (only with includePassed). */
  level: CheckLevel;
  code: string;
  message: string;
  srcs?: string[];
  user_ids?: string[];
  /** Grouping option ids the issue is about (links to their rows). */
  option_ids?: string[];
}

export interface RunChecksOptions {
  /** Add an `ok` line for each check that passed. */
  includePassed?: boolean;
  /** The config the problem was compiled from; the priority check reads it. */
  config?: TeamSetConfig;
  /** The current revision's fields: question and option labels for messages. */
  fields?: FormField[];
}

type Bounds = { min: number; max: number };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const uniq = <T>(values: Iterable<T>): T[] => [...new Set(values)];
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Largest z = (pair entries + pair hards) × slots the engine is asked to build. */
export const MODEL_SIZE_LIMIT = 150_000;

export function runChecks(
  problem: TeamSetProblem,
  context: TeamSetContext,
  opts: RunChecksOptions = {}
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const N = problem.people.length;
  const O = problem.options.length;
  const { min, max, larger } = problem.size;
  const labels = labelMaps(opts.fields);
  const labelOf = srcLabeler(problem, context, labels);
  const userIds = (indices: Iterable<number>) => [...indices].map(p => problem.people[p]);
  const optionId = (o: number) => problem.options[o]?.id ?? context.option_ids[o];
  /** `'Label'`, or null when the option's label is unknown. */
  const optionName = (o: number) => {
    const label = labels.options.get(optionId(o));
    return label === undefined ? null : `'${label}'`;
  };
  const grouped = !(O === 1 && problem.options[0].id === FREE_OPTION_ID);
  const boundsOf = (o: number): Bounds => problem.options[o]?.size ?? { min, max };
  const slotsOf = (o: number) => problem.slots.filter(slot => slot.option === o).length;
  const closed = (o: number) => problem.options[o]?.open === 'closed';

  const {
    forbidden,
    required,
    requires,
    pairKey,
    find,
    groups,
    membersWith,
    rootRequired,
    blocked,
    usable,
  } = hardStructure(problem);
  const openOptions = problem.options.map((_, o) => o).filter(usable);
  /** The largest team each option that can open allows (the set's max when none can). */
  const teamMaxes = openOptions.length ? openOptions.map(o => boundsOf(o).max) : [max];
  const fits = populationFits(problem, context, usable);

  // ── Nobody / capacity ──
  let mainFit: string | null = null;
  if (N === 0) {
    issues.push({
      level: 'error',
      code: 'no_people',
      message: 'There is nobody to place in teams.',
    });
  } else if (fits.main) {
    const { who, people, slots, forced, flex, teamCount, reserved } = fits.main;
    const range = sizeRange(slots, { min, max });
    if (flex) {
      mainFit = fitLine(who, people, flex, range);
    } else {
      // Group mode: the counts left once the group's teams are kept.
      const kept = reserved
        ? ` after the ${reserved[0] === reserved[1] ? plural(reserved[0], 'team') : `${reserved[0]}–${reserved[1]} teams`} for the people who didn't answer`
        : '';
      // An empty range is said as such, never as "team count 6–5". It is
      // "left after" the group's teams only when the set's own team count
      // has room in the usable slots; otherwise no count fits either way.
      const setRoom = problem.team_count.min <= problem.team_count.max;
      const counts =
        teamCount.min > teamCount.max
          ? reserved && setRoom
            ? `no team count left${kept}`
            : 'no team count fits'
          : `team count ${teamCount.min}–${teamCount.max}${kept}`;
      issues.push({
        level: 'error',
        code: 'capacity',
        message:
          `${capitalize(who)} can't be split into teams of ${range.text}${flexWords(slots)}` +
          ` (${range.uniform ? '' : 'sizes set per option, '}${plural(slots.length, 'usable team slot')}` +
          `, ${counts}` +
          `${forced.size ? `, ${plural(forced.size, 'option')} forced open` : ''}).`,
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
        `${plural(problem.slots.length, 'team slot')}.`,
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
    const srcs = uniq(contradictions.map(entry => entry.src));
    issues.push({
      level: 'error',
      code: 'count_contradiction',
      message: `A count rule says both "nobody alone" and "at most 1 per team", which no team can satisfy (by ${describe(srcs, labelOf)}).`,
      srcs,
    });
  }
  // Teams of 2: a hard "nobody alone" group fills pairs two by two, so a
  // group with an odd count needs a team of 3 of its own, and only
  // size.larger teams may have 3 (the remainder flex).
  if (teamMaxes.every(teamMax => teamMax === 2)) {
    const odd = problem.hard.filter(
      (h): h is Extract<TeamSetHard, { kind: 'team_count' }> =>
        h.kind === 'team_count' && h.not_one === true && h.members.length % 2 === 1
    );
    if (odd.length > larger && larger === 0) {
      for (const h of odd) {
        issues.push({
          level: 'warning',
          code: 'odd_group_in_pairs',
          message: `${plural(h.members.length, 'person', 'people')} must not be alone in their group, and an odd group can't be split into pairs (by ${describe([h.src], labelOf)}).`,
          srcs: [h.src],
          user_ids: userIds(h.members),
        });
      }
    } else if (odd.length > larger) {
      const srcs = uniq(odd.map(h => h.src));
      issues.push({
        level: 'warning',
        code: 'odd_group_in_pairs',
        message: `${plural(odd.length, 'group')} that must not leave anyone alone ${odd.length === 1 ? 'has' : 'have'} an odd count, and ${plural(larger, 'team')} of 3 ${larger === 1 ? 'is' : 'are'} allowed (by ${describe(srcs, labelOf)}).`,
        srcs,
        user_ids: userIds(uniq(odd.flatMap(h => h.members))),
      });
    }
  }

  // ── Per-person place constraints ──
  // An option that can never open (owner rule) rules itself out for everyone.
  const allForbidden: number[] = [];
  const allForbiddenSrcs = new Set<string>();
  for (const [p, byOption] of forbidden) {
    const neverOpen = [...blocked].filter(([o]) => !byOption.has(o));
    if (O > 0 && byOption.size + neverOpen.length >= O) {
      allForbidden.push(p);
      for (const srcs of byOption.values()) srcs.forEach(src => allForbiddenSrcs.add(src));
      for (const [, h] of neverOpen) allForbiddenSrcs.add(h.src);
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
      const srcs = uniq([...byOption.values()].flat());
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
      const optionClosed = closed(o);
      const all = uniq([...srcs, ...blockers]);
      issues.push({
        level: 'error',
        code: optionClosed ? 'pinned_option_closed' : 'required_option_forbidden',
        message: optionClosed
          ? `One person is required on an option that is closed (by ${describe(srcs, labelOf)}).`
          : `One person is both required on and kept off the same option (by ${describe(all, labelOf)}).`,
        srcs: all,
        user_ids: userIds([p]),
        option_ids: [optionId(o)],
      });
    }
  }

  // ── Pairs: require ∧ forbid, and require_pair groups ──
  const forbidPairs = new Map<string, string[]>();
  for (const h of problem.hard) {
    if (h.kind !== 'forbid_pair') continue;
    const key = pairKey(h.p, h.q);
    forbidPairs.set(key, [...(forbidPairs.get(key) ?? []), h.src]);
  }
  for (const h of requires) {
    const blockers = forbidPairs.get(pairKey(h.p, h.q));
    if (!blockers) continue;
    const srcs = uniq([h.src, ...blockers]);
    issues.push({
      level: 'error',
      code: 'required_pair_forbidden',
      message: `Two people must be together and must be apart (by ${describe(srcs, labelOf)}).`,
      srcs,
      user_ids: userIds([h.p, h.q]),
    });
  }

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
  const extraSeat = larger > 0 ? 1 : 0;
  const largestTeam = Math.max(...teamMaxes) + extraSeat;
  for (const [root, group] of groups) {
    const srcs = [...group.srcs];
    const options = rootRequired.get(root) ?? new Map<number, string[]>();
    // A group due on one option fits a team of that option; otherwise the largest team anywhere.
    const [only] = options.size === 1 ? [...options.keys()] : [undefined];
    const capacity = only === undefined ? largestTeam : boundsOf(only).max + extraSeat;
    if (group.members.length > capacity) {
      const where = only === undefined ? '' : ` on ${optionName(only) ?? 'that option'}`;
      issues.push({
        level: 'error',
        code: 'together_group_too_large',
        message: `${group.members.length} people must all be on one team, but teams${where} hold at most ${capacity} (by ${describe(srcs, labelOf)}).`,
        srcs,
        user_ids: userIds(group.members),
        ...(only === undefined ? {} : { option_ids: [optionId(only)] }),
      });
    }
    const inner = innerBans.get(root);
    if (inner) {
      const all = uniq([...srcs, ...inner]);
      issues.push({
        level: 'error',
        code: 'required_pair_forbidden',
        message: `A group that must stay together contains two people who must be apart (by ${describe(all, labelOf)}).`,
        srcs: all,
        user_ids: userIds(group.members),
      });
    }
    if (options.size > 1) {
      const all = uniq([...srcs, ...[...options.values()].flat()]);
      issues.push({
        level: 'error',
        code: 'conflicting_required_options',
        message: `A group that must stay together is required on ${options.size} different options (by ${describe(all, labelOf)}).`,
        srcs: all,
        user_ids: userIds(group.members),
      });
    }
  }

  // ── Options people must be on: seats, and the owner rule ──
  // People due on exactly one option (theirs or their group's); anyone due on
  // two is reported above.
  const dueOn = new Map<number, { people: number[]; srcs: Set<string> }>();
  for (let p = 0; p < N; p++) {
    const options = rootRequired.get(find(p));
    if (!options || options.size !== 1) continue;
    const [[o, srcs]] = [...options];
    const entry = dueOn.get(o) ?? { people: [], srcs: new Set<string>() };
    entry.people.push(p);
    srcs.forEach(src => entry.srcs.add(src));
    groups.get(find(p))?.srcs.forEach(src => entry.srcs.add(src));
    dueOn.set(o, entry);
  }
  const seated: { o: number; people: number; seats: number }[] = [];
  for (const [o, entry] of dueOn) {
    if (!usable(o)) continue; // closed: pinned_option_closed; blocked: owner_no_pitcher
    // Up to size.larger of its teams may hold one more.
    const seats = slotsOf(o) * boundsOf(o).max + Math.min(larger, slotsOf(o));
    if (entry.people.length <= seats) {
      seated.push({ o, people: entry.people.length, seats });
      continue;
    }
    const srcs = [...entry.srcs];
    issues.push({
      level: 'error',
      code: 'option_capacity_pins',
      message: `${capitalize(optionName(o) ?? 'an option')} has ${plural(seats, 'seat')}, and ${plural(entry.people.length, 'person', 'people')} must be on it (by ${describe(srcs, labelOf)}).`,
      srcs,
      user_ids: userIds(entry.people),
      option_ids: [optionId(o)],
    });
  }

  for (const [o, h] of blocked) {
    const due = dueOn.get(o);
    const forcedOpen = problem.options[o].open === 'open';
    if (!forcedOpen && !due) continue; // it simply stays closed
    const name = optionName(o) ?? 'an option';
    const opens = forcedOpen
      ? `${capitalize(name)} always runs`
      : `${plural(due!.people.length, 'person', 'people')} must be on ${name}`;
    const pitchers =
      h.members.length === 0
        ? 'nobody in this set pitched it'
        : h.members.length === 1
          ? "its pitcher can't be on it"
          : `none of its ${h.members.length} pitchers can be on it`;
    // What keeps each pitcher off: bans on o or musts elsewhere — theirs, or
    // their must-together group's (and then the group's own srcs).
    const blockers = h.members.flatMap(m => {
      const kept = membersWith(m).flatMap(member => forbidden.get(member)?.get(o) ?? []);
      const elsewhere = [...(rootRequired.get(find(m)) ?? [])].flatMap(([other, srcs]) =>
        other === o ? [] : srcs
      );
      const group = groups.get(find(m));
      return [...kept, ...elsewhere, ...(group ? group.srcs : [])];
    });
    const srcs = uniq([h.src, ...blockers, ...(forcedOpen ? [] : [...due!.srcs])]);
    issues.push({
      level: 'error',
      code: 'owner_no_pitcher',
      message: `${opens}, and ${pitchers} (by ${describe(srcs, labelOf)}).`,
      srcs,
      ...(h.members.length ? { user_ids: userIds(h.members) } : {}),
      option_ids: [optionId(o)],
    });
  }

  // ── People who didn't answer, grouped ──
  let groupFit: string | null = null;
  const group = problem.group;
  if (group && group.members.length > 0 && fits.group) {
    const { who, people: G, slots: eligible, flex } = fits.group;
    const didnt = `${plural(G, 'person', 'people')} didn't answer`;
    const takes = problem.options
      .map((_, o) => o)
      .filter(
        o => usable(o) && group.option_cost[o] !== null && group.option_cost[o] !== undefined
      );
    const srcs = ['non_respondents'];
    const members = userIds(group.members);
    if (eligible.length === 0) {
      const takesOptions = uniq(takes.map(optionId));
      // Each option they could take is either surely opened by the people
      // placed first with its only team, or runs only with one of its
      // pitchers and none of them is among these people (ownerOnlyOptions).
      const ownerOnly = ownerOnlyOptions(problem, group);
      const owned = takes.filter(o => ownerOnly.has(o));
      const ownerSrcs = uniq(
        problem.hard.flatMap(h =>
          h.kind === 'owner_if_open' && owned.includes(h.o) ? [h.src] : []
        )
      );
      const why =
        takes.length === 0
          ? 'no option can open'
          : owned.length === 0
            ? 'the options that can open have no team left for them'
            : owned.length === takes.length
              ? 'every option that can open runs only with one of its pitchers'
              : 'every option that can open has no team left for them or runs only with one of its pitchers';
      issues.push({
        level: 'error',
        code: 'group_no_option',
        message: `${didnt}, and ${why}.`,
        srcs: [...srcs, ...ownerSrcs],
        user_ids: members,
        ...(takesOptions.length ? { option_ids: takesOptions } : {}),
      });
    } else {
      const range = sizeRange(eligible, { min, max });
      const where = range.uniform ? '' : ' on the options they can take';
      // The smallest team the flex allows: one under the smallest min, never below 2.
      const smallest = Math.min(
        ...eligible.map(slot => (slot.min - 1 >= FLEX_SMALLEST_TEAM ? slot.min - 1 : slot.min))
      );
      if (G < smallest) {
        issues.push({
          level: 'error',
          code: 'group_too_small',
          message: `${didnt}, fewer than the smallest team allowed${where} (${smallest}).`,
          srcs,
          user_ids: members,
        });
      } else if (!flex) {
        issues.push({
          level: 'error',
          code: 'group_split',
          message: `${capitalize(who)} can't be split into teams of ${range.text}${where}${flexWords(eligible)}.`,
          srcs,
          user_ids: members,
        });
      } else {
        groupFit = fitLine(who, G, flex, range, where);
      }
    }
  }

  // ── Identity questions (never user ids) ──
  for (const rule of context.rules) {
    if (rule.off === 'pairs') {
      issues.push({
        level: 'warning',
        code: 'identity_rule_pairs',
        message: `The rule on "${rule.label}" is off for teams of two.`,
        srcs: [rule.id],
      });
    } else if (rule.identity && (rule.single_answers ?? 0) > 0) {
      const k = rule.single_answers!;
      issues.push({
        level: 'warning',
        code: 'identity_single_answer',
        message: `${plural(k, 'answer')} to "${rule.label}" ${k === 1 ? 'has' : 'have'} a single student.`,
        srcs: [rule.id],
      });
    }
  }

  // ── Priority rules whose targets are off ──
  if (opts.config) {
    const active = new Set(context.rules.filter(rule => !rule.off).map(rule => rule.id));
    const question = (ruleId: string) => {
      const [fieldId = '', job = ''] = ruleId.split(':');
      const label =
        context.rules.find(rule => rule.id === ruleId)?.label ?? labels.fields.get(fieldId);
      return label === undefined ? `the ${job} rule` : `"${label}"`;
    };
    for (const rule of opts.config.rules) {
      if (rule.job !== 'priority' || rule.strength === 'off') continue;
      const { rule_a: a, rule_b: b } = rule.params;
      if (a === undefined || b === undefined || a === b) continue; // the config check says so
      const id = teamSetRuleId(rule);
      const off = [a, b].filter(target => !active.has(target));
      if (off.length === 0) continue;
      const on = [a, b].find(target => active.has(target));
      const q = question(id);
      issues.push({
        level: 'warning',
        code: 'priority_target_off',
        message:
          on === undefined
            ? `${capitalize(question(a))} and ${question(b)} are off, so ${q} changes nothing.`
            : `${capitalize(question(off[0]))} is off, so ${q} changes only how much ${question(on)} counts.`,
        srcs: [id, ...off],
      });
    }
  }

  // ── Warnings ──
  const absent = context.people.filter(person => !person.responded).map(person => person.user_id);
  if (absent.length) {
    issues.push({
      level: 'warning',
      code: 'no_response',
      message: `${plural(absent.length, 'person has', 'people have')} not responded.`,
      user_ids: absent,
    });
  }

  const rankedAnything = context.people.some(person => person.ranked.length > 0);
  if (rankedAnything) {
    const rankedIds = new Set(context.people.flatMap(person => person.ranked));
    const lonely = problem.options.filter(
      option => option.open === 'open' && !rankedIds.has(option.id)
    );
    if (lonely.length) {
      issues.push({
        level: 'warning',
        code: 'forced_open_unranked',
        message: `${plural(lonely.length, 'option is', 'options are')} forced open but nobody ranked ${lonely.length === 1 ? 'it' : 'them'}.`,
        srcs: lonely.map(option => `option:${option.id}`),
        option_ids: lonely.map(option => option.id),
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

  // ── Passed checks ──
  const passed: CheckIssue[] = [];
  if (opts.includePassed) {
    const failed = new Set(issues.map(issue => issue.code));
    if (mainFit) passed.push({ level: 'ok', code: 'capacity', message: mainFit });
    if (grouped && O > 0 && N > 0 && !failed.has('all_options_forbidden')) {
      passed.push({
        level: 'ok',
        code: 'options_ok',
        message: 'Everyone has at least one allowed option.',
      });
    }
    const pinErrors = issues.some(
      issue => issue.level === 'error' && issue.srcs?.some(src => src.startsWith('pin:'))
    );
    if (context.pins.length > 0 && !pinErrors) {
      passed.push({ level: 'ok', code: 'pins_ok', message: 'Pins agree with the Must rules.' });
    }
    if (seated.length > 0 && !failed.has('option_capacity_pins')) {
      const [one] = seated;
      passed.push({
        level: 'ok',
        code: 'option_capacity_pins',
        message:
          seated.length === 1
            ? `${capitalize(optionName(one.o) ?? 'an option')} has ${plural(one.seats, 'seat')} for the ${plural(one.people, 'person', 'people')} who must be on it.`
            : `${seated.length} options have seats for everyone who must be on them.`,
        option_ids: seated.map(entry => optionId(entry.o)),
      });
    }
    if (groupFit) passed.push({ level: 'ok', code: 'group_ok', message: groupFit });
  }

  // Rule-level srcs; no person on an issue about an identity question's rule.
  const identityRules = new Set(context.rules.filter(rule => rule.identity).map(rule => rule.id));
  return [...passed, ...issues].map(issue => {
    if (!issue.srcs) return issue;
    const srcs = uniq(issue.srcs.map(baseSrc));
    const { user_ids: ids, ...rest } = issue;
    const keep = ids !== undefined && !srcs.some(src => identityRules.has(src));
    return { ...rest, srcs, ...(keep ? { user_ids: ids } : {}) };
  });
}

/** One population the teams are made for, and how it fits (minimalFlex). */
interface PopulationFit {
  /** "27 people", "23 people who answered", "5 people who didn't answer". */
  who: string;
  people: number;
  /** The usable slots it can take, with their bounds. */
  slots: FlexSlot[];
  forced: Set<number>;
  /** The team counts it may take. */
  teamCount: { min: number; max: number };
  /** The people placed first in Group mode: [k2_min, k2_max], the teams kept for the group. */
  reserved?: [number, number];
  /** null: no team count fits, even with the flex the IR allows. */
  flex: TeamSetFlex | null;
}

/**
 * How each population fits the usable slots within the IR's caps:
 *   main   everyone — without a group — or the people placed first (not in
 *          problem.group), at the team counts stage 2 leaves them
 *          ([min − k2_max, max − k2_min], groupTeamCounts); null when nobody.
 *   group  the people who didn't answer, on the slots they can take
 *          (groupSlotIndices: usable options, less one slot of each option
 *          the others surely open), 1 to max teams; null without a group.
 * The same arithmetic compile used for the caps, so the Setup's fit line is
 * what the engine is allowed.
 */
function populationFits(
  problem: TeamSetProblem,
  context: TeamSetContext,
  usable: (o: number) => boolean
): { main: PopulationFit | null; group: PopulationFit | null } {
  const boundsOf = (o: number) => problem.options[o]?.size ?? problem.size;
  const slotsWhere = (keep: (o: number) => boolean): FlexSlot[] =>
    problem.slots.flatMap(slot =>
      keep(slot.option) ? [{ option: slot.option, ...pick(boundsOf(slot.option)) }] : []
    );
  const group = problem.group && problem.group.members.length > 0 ? problem.group : null;
  const G = group?.members.length ?? 0;
  const R = problem.people.length - G;
  const { min: tcMin, max: tcMax } = problem.team_count;

  let main: PopulationFit | null = null;
  if (R > 0) {
    const slots = slotsWhere(usable);
    const forced = new Set(
      slots.map(slot => slot.option).filter(o => problem.options[o].open === 'open')
    );
    const [k2Min, k2Max] = group ? groupTeamCounts(problem, group) : [0, 0];
    const teamCount = { min: Math.max(1, tcMin - k2Max), max: tcMax - k2Min };
    let who = plural(R, 'person', 'people');
    if (group) {
      // Placed first: everyone who answered, and anyone who didn't but is
      // named by a pin or a must-together (compile keeps them with the rest).
      const inGroup = new Set(group.members);
      const kept = context.people.filter((person, p) => !person.responded && !inGroup.has(p));
      who +=
        kept.length === 0 ? ' who answered' : ' who answered or are named in a pin or Must rule';
    }
    main = {
      who,
      people: R,
      slots,
      forced,
      teamCount,
      ...(k2Max > 0 ? { reserved: [k2Min, k2Max] as [number, number] } : {}),
      flex: minimalFlex(R, slots, {
        kMin: teamCount.min,
        kMax: teamCount.max,
        forced,
        maxLarger: problem.size.larger,
        maxSmaller: problem.size.smaller ?? 0,
      }),
    };
  }

  let groupFit: PopulationFit | null = null;
  if (group) {
    const slots = groupSlotIndices(problem, group, usable).map(s => {
      const o = problem.slots[s].option;
      return { option: o, ...pick(boundsOf(o)) };
    });
    groupFit = {
      who: `${plural(G, 'person', 'people')} who didn't answer`,
      people: G,
      slots,
      forced: new Set(),
      teamCount: { min: 1, max: Math.min(slots.length, tcMax) },
      flex: minimalFlex(G, slots, {
        kMin: 1,
        kMax: Math.min(slots.length, tcMax),
        maxLarger: group.larger ?? 0,
        maxSmaller: group.smaller ?? 0,
      }),
    };
  }
  return { main, group: groupFit };
}

const pick = (bounds: Bounds): Bounds => ({ min: bounds.min, max: bounds.max });

/**
 * The team counts the set's sizes allow for its people, with the fewest
 * teams one person off their size (the capacity check's arithmetic,
 * populationFits): in Group mode, every sum of a count that fits the people
 * placed first and one that fits the people who didn't answer, within the
 * set's team count. Other counts can fit with more teams off their size;
 * the flex is set for these. Returned only when those counts are one
 * unbroken range, so every count in it fits; null when they have a gap,
 * when a population fits no count (the checks then say so), or when there
 * is nobody.
 */
export function teamCountRange(
  problem: TeamSetProblem,
  context: TeamSetContext
): { min: number; max: number } | null {
  const fits = populationFits(problem, context, hardStructure(problem).usable);
  const parts = [fits.main, fits.group].filter((fit): fit is PopulationFit => fit !== null);
  if (parts.length === 0 || parts.some(fit => fit.flex === null)) return null;
  let totals = [0];
  for (const fit of parts) {
    totals = uniq(totals.flatMap(sum => fit.flex!.counts.map(count => sum + count)));
  }
  const { min: tcMin, max: tcMax } = problem.team_count;
  const counts = totals.filter(n => n >= tcMin && n <= tcMax).sort((a, b) => a - b);
  if (counts.length === 0 || counts.at(-1)! - counts[0] + 1 !== counts.length) return null;
  return { min: counts[0], max: counts.at(-1)! };
}

/**
 * A population's fit as the Setup states it: "24 people fit 5 teams of
 * 4–6." without flex; with it, the teams by size when every slot shares one
 * ("27 people: 12 teams of 2 and 1 team of 3."), else how many are one over
 * or under their size.
 */
function fitLine(
  who: string,
  people: number,
  flex: TeamSetFlex,
  range: ReturnType<typeof sizeRange>,
  where = ''
): string {
  const { from, to } = flex.teams;
  const teams = countsText(flex.counts);
  const sizes = range.min === range.max ? `${range.min}` : `${range.min}–${range.max}`;
  const changed = flex.larger || flex.smaller;
  const subject = capitalize(who);
  if (!changed) {
    return `${subject} ${people === 1 ? 'fits' : 'fit'} ${teams} ${to === 1 ? 'team' : 'teams'} of ${sizes}${where}.`;
  }
  if (range.uniform) {
    const edge = flex.larger ? range.max + 1 : range.min - 1;
    const rest = from - changed;
    const parts = [
      ...(rest > 0 ? [`${plural(rest, 'team')} of ${sizes}`] : []),
      `${plural(changed, 'team')} of ${edge}`,
    ];
    return `${subject}: ${parts.join(' and ')}${where}.`;
  }
  return `${subject}: ${teams} ${to === 1 ? 'team' : 'teams'} of ${sizes}${where}, ${changed} of them one person ${flex.larger ? 'over' : 'under'} ${changed === 1 ? 'its' : 'their'} size.`;
}

/** "5", "4 to 6", "1 or 3", "1, 3 or 5": the team counts, gaps kept. */
function countsText(counts: readonly number[]): string {
  const first = counts[0];
  const last = counts[counts.length - 1];
  if (counts.length === 1) return `${first}`;
  if (last - first + 1 === counts.length) return `${first} to ${last}`;
  return `${counts.slice(0, -1).join(', ')} or ${last}`;
}

/** ", even with teams one person larger[ or smaller]" — the flex the slots allow. */
function flexWords(slots: readonly Bounds[]): string {
  const shrink = slots.some(slot => slot.min - 1 >= FLEX_SMALLEST_TEAM);
  return `, even with teams one person larger${shrink ? ' or smaller' : ''}`;
}

/**
 * The size span of some slots: smallest min, largest max, whether they all
 * share one size, and the span as message text ("exactly 2", "4–6").
 * `fallback` (the set's size) when there are no slots.
 */
function sizeRange(
  bounds: Bounds[],
  fallback: Bounds
): { min: number; max: number; uniform: boolean; text: string } {
  const all = bounds.length ? bounds : [fallback];
  const lo = Math.min(...all.map(b => b.min));
  const hi = Math.max(...all.map(b => b.max));
  const uniform = all.every(b => b.min === all[0].min && b.max === all[0].max);
  return { min: lo, max: hi, uniform, text: lo === hi ? `exactly ${lo}` : `${lo}–${hi}` };
}

/** Question labels and option labels (every choice field's options) by id. */
function labelMaps(fields: FormField[] | undefined): {
  fields: Map<string, string>;
  options: Map<string, string>;
} {
  const fieldLabels = new Map<string, string>();
  const optionLabels = new Map<string, string>();
  for (const field of fields ?? []) {
    if (typeof field.label === 'string' && field.label) fieldLabels.set(field.id, field.label);
    for (const option of fieldOptions(field)) {
      if (!optionLabels.has(option.id)) optionLabels.set(option.id, option.label);
    }
  }
  return { fields: fieldLabels, options: optionLabels };
}

/** src → a human label: the rule's question, the pin's label, or the option. */
function srcLabeler(
  problem: TeamSetProblem,
  context: TeamSetContext,
  labels: { options: Map<string, string> }
): (src: string) => string {
  const known = new Map<string, string>();
  for (const rule of context.rules) known.set(rule.id, `${rule.job} "${rule.label}"`);
  for (const pin of context.pins) known.set(`pin:${pin.id}`, `pin ${pin.id} (${pin.label})`);
  const optionState = new Map(problem.options.map(option => [option.id, option.open]));
  return src => {
    const base = baseSrc(src);
    if (known.has(base)) return known.get(base)!;
    const parsed = parseSrc(src);
    switch (parsed.kind) {
      case 'option': {
        const label = labels.options.get(parsed.option_id);
        if (optionState.get(parsed.option_id) === 'open')
          return label === undefined ? 'an option that always runs' : `'${label}' always runs`;
        return label === undefined ? 'a closed option' : `'${label}' is closed`;
      }
      case 'size': {
        const label = labels.options.get(parsed.option_id);
        return label === undefined ? "an option's team size" : `'${label}' team size`;
      }
      case 'non_respondents':
        return "people who didn't answer";
      case 'rule':
        return `${/^[aeiou]/.test(parsed.job) ? 'an' : 'a'} ${parsed.job} rule`;
      default:
        return src;
    }
  };
}

function describe(srcs: Iterable<string>, labelOf: (src: string) => string): string {
  const unique = uniq([...srcs].map(labelOf));
  if (unique.length <= 3) return unique.join(', ');
  return `${unique.slice(0, 3).join(', ')} and ${unique.length - 3} more`;
}
