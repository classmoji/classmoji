import { personName } from './teamsView.ts';
import type { CreateProgressView, PersonRef, ResultTeam } from './types.ts';

/**
 * Team sets — the created teams as compact cards: the team's name and its
 * members. Rendered under CreatedSummary on a created set's landing.
 *
 * Presentational. `createdTeamCards` builds the cards from the run the teams
 * came from (members) and the create (the names the teams got: a name that
 * was taken is renamed, and `create.teams[].name` holds the final one). A team
 * the create did not make is left out.
 */

export interface CreatedTeamCard {
  /** The team's `n` in the run's views (1-based); the create numbers it the same. */
  n: number;
  /** The name the team got. */
  name: string;
  members: PersonRef[];
}

/** The cards for a create, from its run's teams; members copied key by key. */
export function createdTeamCards(
  runTeams: readonly Pick<ResultTeam, 'n' | 'name' | 'members'>[],
  create: Pick<CreateProgressView, 'teams'> | null
): CreatedTeamCard[] {
  const made = new Map((create?.teams ?? []).map(team => [team.n, team]));
  return runTeams
    .filter(team => made.get(team.n)?.state !== 'failed')
    .map(team => ({
      n: team.n,
      name: made.get(team.n)?.name ?? team.name,
      members: team.members.map(member => ({ user_id: member.user_id, name: member.name })),
    }));
}

export interface CreatedTeamsListProps {
  teams: readonly CreatedTeamCard[];
}

export function CreatedTeamsList({ teams }: CreatedTeamsListProps) {
  if (teams.length === 0) return null;
  return (
    <ul className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(12.5rem,1fr))] gap-2.5">
      {teams.map(team => (
        <li
          key={team.n}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 dark:border-gray-700 dark:bg-gray-900"
        >
          <div className="mb-1 break-all font-mono text-xs text-gray-900 dark:text-white">
            {team.name}
          </div>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {team.members.map(personName).join(', ')}
          </p>
        </li>
      ))}
    </ul>
  );
}
