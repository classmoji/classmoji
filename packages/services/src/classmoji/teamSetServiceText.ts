/**
 * Team sets — the sentences teamSet.service writes itself: why a run is out
 * of date, the create preview's warnings, the refusals whose text a page
 * shows as a list item (a new pin naming someone outside the classroom, a
 * retry blocked by someone who left), and the messages of two refusals.
 *
 * PURE MODULE (no imports), so the copy test can produce every one of them.
 * Facts only: counts, numbers and names; never advice, never how the work is
 * done.
 */

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What differs between a run's inputs and the form now (teamSet.service staleReasons). */
export interface StaleFacts {
  /** The form was republished after the run. */
  republished: boolean;
  /**
   * A question the run grouped by, or took an answer from for a rule other
   * than no one alone, is now an identity question.
   */
  identity: boolean;
  /** Responses whose answers changed. */
  edited: number;
  /** Responses that came in after the run. */
  added: number;
  /** Responses withdrawn or removed since. */
  removed: number;
  /** Roster moves; null when the roster doesn't count (people who didn't answer are left out). */
  roster: { joined: number; left: number } | null;
}

/** Why a run is out of date, one sentence per fact; [] = it is not. */
export function staleReasonTexts(facts: StaleFacts): string[] {
  const reasons: string[] = [];
  if (facts.republished) reasons.push('The form was republished after this run.');
  if (facts.identity) reasons.push('A question this run used is now an identity question.');
  if (facts.edited > 0) {
    reasons.push(`${plural(facts.edited, 'response was', 'responses were')} edited.`);
  }
  if (facts.added > 0) {
    reasons.push(`${plural(facts.added, 'new response', 'new responses')} came in.`);
  }
  if (facts.removed > 0) {
    reasons.push(
      `${plural(facts.removed, 'response was', 'responses were')} withdrawn or removed.`
    );
  }
  if (facts.roster && (facts.roster.joined > 0 || facts.roster.left > 0)) {
    reasons.push(`The roster changed (${facts.roster.joined} joined, ${facts.roster.left} left).`);
  }
  return reasons;
}

/** A create preview whose team names were not looked up on GitHub (over `max` teams). */
export const namesNotCheckedWarning = (max: number): string =>
  `Team names were not checked against GitHub: there are more than ${max} teams.`;

/** A create preview: people on teams still to make who have no GitHub login. */
export const noLoginWarning = (people: number): string =>
  `${plural(people, 'person has', 'people have')} no GitHub login and cannot be added to a GitHub team.`;

/** A same-run retry's preview: what changed since the run (its stale reasons, as sentences). */
export const changedSinceRunWarning = (runNumber: number, reasons: readonly string[]): string =>
  `Changed since run ${runNumber}: ${reasons.join(' ')}`;

/** `name_collision`: the planned names GitHub already has. */
export const nameCollisionText = (names: readonly string[]): string =>
  `${plural(names.length, 'team name is', 'team names are')} already used in the GitHub organization: ${names.join(', ')}.`;

/** A save's new pins name people who aren't members of the classroom (a count, no names). */
export const pinPeopleOutsideText = (outside: number): string =>
  outside === 1
    ? 'A person named in a new pin isn’t in this classroom.'
    : `${outside} people named in new pins aren’t in this classroom.`;

/** A same-run retry: people on teams still to make who left the class. */
export const retryBlockedText = (gone: number): string =>
  `${plural(gone, 'person', 'people')} on teams not yet created ${gone === 1 ? 'has' : 'have'} left the class.`;

/** A typed set name with nothing left once it is made a set name ("!!!"). */
export const SET_NAME_EMPTY_TEXT = 'A team set name needs at least one letter or digit.';

/** `set_busy`: a save waited for the set's row past its time limit; nothing was written. */
export const SET_BUSY_TEXT = 'Another save or run held this set; this change was not saved.';

/** `set_busy` from a run's start: its transaction ran out of time; no run was made. */
export const SET_BUSY_RUN_TEXT = 'Another save or run held this set; no run was started.';
