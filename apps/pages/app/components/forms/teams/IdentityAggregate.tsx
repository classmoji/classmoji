import type { IdentityRuleView } from './types.ts';
import { TEAMS_LABELS, identityHeldText, missedTeamsText } from './teamsView.ts';

/**
 * Results: the identity line — on how many teams each identity rule held.
 *
 * Counts only. Which teams missed is never in the run's data; "Show which"
 * asks the route, which posts the `reveal-identity` intent (audited) and passes
 * the answer back as `missedTeams`: team numbers and names, nothing about
 * anyone's answer. The service answers one list for the run, so it is shown
 * once, under the rules, in a polite live region: the button goes away when
 * it is pressed, and the answer is read out in its place.
 */

export interface IdentityAggregateProps {
  /** RunViewModel.identity_rules; nothing renders when it is empty. */
  rules: IdentityRuleView[];
  /** The `reveal-identity` answer, once asked for (the button then goes away). */
  missedTeams?: { n: number; name: string }[] | null;
  /** The reveal is in flight. */
  revealing?: boolean;
  onShowWhich: () => void;
}

export function IdentityAggregate({
  rules,
  missedTeams = null,
  revealing = false,
  onShowWhich,
}: IdentityAggregateProps) {
  if (rules.length === 0) return null;
  const several = rules.length > 1;
  const missed = rules.some(rule => rule.teams_held < rule.teams_total);
  const asked = missedTeams !== null;
  const revealed = missedTeams && missedTeams.length > 0 ? missedTeams : null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-300">
      {rules.map(rule => (
        <span key={rule.rule_id}>{identityHeldText(rule, several)}</span>
      ))}
      {missed && !asked ? (
        <button
          type="button"
          id="identity-show-which"
          onClick={onShowWhich}
          disabled={revealing}
          className="rounded-md px-1.5 py-0.5 text-sm font-medium text-blue-600 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-wait disabled:opacity-60 dark:text-blue-400 dark:hover:bg-blue-950 dark:hover:text-blue-300"
        >
          {TEAMS_LABELS.showWhich}
        </button>
      ) : null}
      <span
        role="status"
        aria-live="polite"
        data-testid="identity-missed"
        className={revealed ? 'basis-full text-gray-900 dark:text-white' : 'sr-only'}
      >
        {revealed ? missedTeamsText(revealed) : null}
      </span>
    </div>
  );
}

export default IdentityAggregate;
