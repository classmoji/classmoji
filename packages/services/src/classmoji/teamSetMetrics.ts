/**
 * Team sets — what a solved run looks like to a person reading it.
 *
 * PURE MODULE. The solver's objective is one number that nobody can reason
 * about; an instructor wants "19 of 27 got their first choice, 11 of 14
 * requests kept". These metrics are computed from the compiled problem, its
 * context and the teams — never from the objective — so they mean the same
 * thing whatever weights produced the teams.
 *
 * Placement of one person (grouped mode):
 *   '1'…'4', '5+'  the option they got was their Nth pick — N counted in the
 *                  answer as submitted (context.people[].ranked), the same
 *                  position compile charged, even if an earlier pick was
 *                  since deleted from the question
 *   'fallback'     not ranked, but in a category they chose on the fallback question
 *   'missed'       they ranked something and got none of it (nor a category)
 *   'no_answer'    they ranked nothing (or did not respond) — also everyone in free mode
 *
 * requests: together-rule asks (directed p→q), kept = same team; mutual
 * pairs counted once. avoids: apart-rule asks (directed), broken = same team.
 *
 * `PersonPlacement.team` is the SLOT index (problem.slots), -1 if the person is
 * on no team; it is stable however the caller orders its teams.
 */

import { FREE_OPTION_ID, type TeamSetContext, type TeamSetProblem } from './teamSetProblem.ts';
import { placeAssignment, scoreAssignment, type TeamSetAssignment } from './teamSetScore.ts';

export type TeamSetPlacement = '1' | '2' | '3' | '4' | '5+' | 'fallback' | 'missed' | 'no_answer';

export interface TeamSetMetrics {
  people: number;
  responded: number;
  teams: number;
  options_open: number;
  options_total: number;
  placement: Record<TeamSetPlacement, number>;
  first_choice: number;
  top2: number;
  requests: { total: number; kept: number; mutual_pairs: number; mutual_pairs_kept: number };
  /** Apart-rule asks (directed p→q, both in the set); broken = they share a team. */
  avoids: { total: number; broken: number };
  /** Hard constraints (musts and pins) the teams break — 0 for any accepted run. */
  must_broken: number;
}

export interface PersonPlacement {
  user_id: string;
  team: number;
  option_id: string | null;
  placement: keyof TeamSetMetrics['placement'];
  requests: { user_id: string; kept: boolean }[];
}

export function computeMetrics(
  problem: TeamSetProblem,
  context: TeamSetContext,
  teams: TeamSetAssignment[]
): { metrics: TeamSetMetrics; people: PersonPlacement[] } {
  const { slotOf, open } = placeAssignment(problem, teams);
  const index = new Map(problem.people.map((id, p) => [id, p]));
  const contextOf = new Map(context.people.map(person => [person.user_id, person]));
  const freeMode = problem.options.length === 1 && problem.options[0].id === FREE_OPTION_ID;
  const sameTeam = (p: number, q: number) => slotOf[p] !== -1 && slotOf[p] === slotOf[q];

  const placement: TeamSetMetrics['placement'] = {
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    '5+': 0,
    fallback: 0,
    missed: 0,
    no_answer: 0,
  };
  const requests = { total: 0, kept: 0, mutual_pairs: 0, mutual_pairs_kept: 0 };
  const avoids = { total: 0, broken: 0 };

  const people: PersonPlacement[] = problem.people.map((user_id, p) => {
    const person = contextOf.get(user_id);
    const slot = slotOf[p] ?? -1;
    const o = slot === -1 ? -1 : problem.slots[slot].option;
    const optionId = freeMode || o === -1 ? null : (problem.options[o]?.id ?? null);

    let where: TeamSetPlacement;
    const ranked = person?.ranked ?? [];
    if (freeMode || ranked.length === 0) {
      where = 'no_answer';
    } else {
      const position = optionId === null ? -1 : ranked.indexOf(optionId);
      const category = o === -1 ? null : (context.option_categories?.[o] ?? null);
      if (position !== -1) where = position < 4 ? (String(position + 1) as TeamSetPlacement) : '5+';
      else if (category !== null && (person?.categories ?? []).includes(category))
        where = 'fallback';
      else where = 'missed';
    }
    placement[where] += 1;

    const asked = (person?.requests ?? []).filter(id => index.has(id));
    const personRequests = asked.map(id => {
      const kept = sameTeam(p, index.get(id)!);
      requests.total += 1;
      if (kept) requests.kept += 1;
      return { user_id: id, kept };
    });

    for (const id of person?.avoids ?? []) {
      if (!index.has(id)) continue;
      avoids.total += 1;
      if (sameTeam(p, index.get(id)!)) avoids.broken += 1;
    }

    return { user_id, team: slot, option_id: optionId, placement: where, requests: personRequests };
  });

  // Mutual pairs, each unordered pair once.
  const requestSets = problem.people.map(
    id => new Set((contextOf.get(id)?.requests ?? []).filter(other => index.has(other)))
  );
  problem.people.forEach((id, p) => {
    for (const other of requestSets[p]) {
      const q = index.get(other)!;
      if (q <= p || !requestSets[q].has(id)) continue;
      requests.mutual_pairs += 1;
      if (sameTeam(p, q)) requests.mutual_pairs_kept += 1;
    }
  });

  const openOptions = new Set(open.map(team => problem.slots[team.slot].option));
  const mustBroken = scoreAssignment(problem, teams).violations.filter(v => v.src !== null).length;

  const metrics: TeamSetMetrics = {
    people: problem.people.length,
    responded: context.people.filter(person => person.responded).length,
    teams: open.length,
    options_open: openOptions.size,
    options_total: problem.options.length,
    placement,
    first_choice: placement['1'],
    top2: placement['1'] + placement['2'],
    requests,
    avoids,
    must_broken: mustBroken,
  };
  return { metrics, people };
}
