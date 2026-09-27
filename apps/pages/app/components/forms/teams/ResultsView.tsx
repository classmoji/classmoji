import { useRef, useState } from 'react';

import type { TeamSetPinAdd } from '@classmoji/services/team-set-config';

import { ChangesNotRun } from './ChangesNotRun.tsx';
import { IdentityAggregate } from './IdentityAggregate.tsx';
import { MetricTiles } from './MetricTiles.tsx';
import { PinBlock } from './PinBlock.tsx';
import { PlacementBar } from './PlacementBar.tsx';
import { TeamCard } from './TeamCard.tsx';
import { WhyPanel } from './WhyPanel.tsx';
import type { PlacementFacts, RunPageData, RunViewModel, SetupChanges } from './types.ts';
import { metricTiles } from './teamsView.ts';

/**
 * Results: a SOLVED run, under the runline (which the run route renders).
 *
 * In order: the changes not run yet, the headline tiles, the identity line,
 * the placement bar, then the team cards beside the why panel with the pin
 * block. A run with no grouping question (`run.grouped` false, from the run's
 * own setup) has no picks: no pick tiles, no placement bar, no rank badges. Presentational: the data comes from the run page's loader and the set
 * layout's, and every write goes out through a callback for the route to post
 * (`patch` with `pins.add`, `discard`, `run`, `reveal-identity`).
 *
 * The only state held here is who is chosen. It starts on
 * `initialSelectedUserId`, else the first member of the first team, and falls
 * back to that first member (else the first person with facts) when the
 * chosen person is not in this run (the route can move between runs without
 * remounting). Choosing someone brings the why panel into view when it is off
 * screen (on a phone it sits under every team card).
 */

/** Tailwind's `lg`: the cards and the why panel side by side. */
const WIDE_LAYOUT = '(min-width: 64rem)';

export interface ResultsViewProps {
  run: RunViewModel;
  /** The why facts for everyone in the run (RunPageData.placements). */
  placements: PlacementFacts[];
  /** What the pin block offers (RunPageData.pinTargets). */
  pinTargets: RunPageData['pinTargets'];
  /** The set's changes since its latest run (TeamSetLayoutData.changes). */
  changes: SetupChanges;
  viewerId: string;
  /** The set is created or being created: pins, Discard and Run again are off. */
  locked: boolean;
  /** Who is chosen first; default the first member of the first team. */
  initialSelectedUserId?: string | null;

  /** The `reveal-identity` answer, once asked for. */
  missedTeams?: { n: number; name: string }[] | null;
  /** The reveal is in flight. */
  revealing?: boolean;
  /** "Show which": the route posts `reveal-identity` for this run. */
  onShowWhich: () => void;

  /** "Add pin": the route posts `patch` with `{ pins: { add: [pin] } }`. */
  onAddPin: (pin: TeamSetPinAdd) => void;
  /** A pin is being saved. */
  pinBusy?: boolean;

  /** Discard: the route confirms, then posts `discard`. */
  onDiscard: () => void;
  /** Run again: the route posts `run`. */
  onRunAgain: () => void;
  /** A discard or run is in flight. */
  changesBusy?: boolean;
  /** A run can't start now (one is active). */
  runDisabled?: boolean;
}

export function ResultsView({
  run,
  placements,
  pinTargets,
  changes,
  viewerId,
  locked,
  initialSelectedUserId = null,
  missedTeams = null,
  revealing = false,
  onShowWhich,
  onAddPin,
  pinBusy = false,
  onDiscard,
  onRunAgain,
  changesBusy = false,
  runDisabled = false,
}: ResultsViewProps) {
  const firstMemberId = run.teams[0]?.members[0]?.user_id ?? null;
  const [chosen, setChosen] = useState<string | null>(initialSelectedUserId ?? firstMemberId);
  const whyRef = useRef<HTMLElement>(null);

  const choose = (userId: string) => {
    setChosen(userId);
    const panel = whyRef.current;
    // From lg up the panel sits beside the cards and stays in view (sticky).
    if (!panel || window.matchMedia?.(WIDE_LAYOUT).matches) return;
    const { top, bottom } = panel.getBoundingClientRect();
    // Off screen, or starting in the lower part of it: bring its top up.
    if (top > window.innerHeight * 0.6 || bottom < 0) {
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      panel.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }
  };

  const factsOf = (userId: string | null) =>
    userId === null ? undefined : placements.find(facts => facts.user_id === userId);
  const facts = factsOf(chosen) ?? factsOf(firstMemberId) ?? placements[0] ?? null;
  const selectedUserId = facts?.user_id ?? null;

  // Picks, placements and projects running: only on a run whose own setup
  // made teams from a question (`run.grouped`, from the run's setup). A count
  // the view leaves null skips its tile or the bar (metricTiles, PlacementBar).
  const grouped = run.grouped;

  return (
    <div>
      <ChangesNotRun
        changes={changes}
        viewerId={viewerId}
        onDiscard={onDiscard}
        onRunAgain={onRunAgain}
        busy={changesBusy}
        runDisabled={locked || runDisabled}
        discardDisabled={locked}
      />

      {run.metrics ? <MetricTiles tiles={metricTiles(run.metrics, grouped)} /> : null}

      <IdentityAggregate
        rules={run.identity_rules}
        missedTeams={missedTeams}
        revealing={revealing}
        onShowWhich={onShowWhich}
      />

      {run.metrics?.placement && grouped ? <PlacementBar metrics={run.metrics} /> : null}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid content-start gap-2.5 xl:grid-cols-2">
          {run.teams.map(team => (
            <TeamCard
              key={team.n}
              team={team}
              grouped={grouped}
              selectedUserId={selectedUserId}
              onSelectPerson={choose}
            />
          ))}
        </div>

        <WhyPanel ref={whyRef} facts={facts} viewerId={viewerId}>
          {facts ? (
            <PinBlock
              key={facts.user_id}
              person={{ user_id: facts.user_id, name: facts.name }}
              currentOption={facts.team.option}
              options={pinTargets.options}
              people={pinTargets.people}
              disabled={locked}
              busy={pinBusy}
              onAddPin={onAddPin}
            />
          ) : null}
        </WhyPanel>
      </div>
    </div>
  );
}

export default ResultsView;
