import { PersonChip } from './PersonChip.tsx';
import type { ResultTeam } from './types.ts';
import { optionLabel, teamCardMeta, teamSignalChips, type SignalChip } from './teamsView.ts';

/**
 * Results: one team — its option, size and "wanted 1st by", the signal chips
 * (`teamSignalChips`, from the run's own facts), and its members as chips.
 *
 * Grouped sets head the card with the option and show the team's name under
 * it (two teams can share an option); free sets head it with the team's name.
 */

const CHIP_TONE: Readonly<Record<SignalChip['tone'], string>> = {
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  warn: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  plain:
    'border-gray-200 bg-white text-gray-600 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400',
};

/** Pins read as pins wherever they show (the person chip's glyph is the same hue). */
const PINNED_TONE =
  'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-800 dark:bg-violet-950 dark:text-violet-200';

export interface TeamCardProps {
  team: ResultTeam;
  /** The run made its teams from a question; false = free teams (no rank badges, no pick chip). */
  grouped?: boolean;
  /** The person whose facts the why panel shows. */
  selectedUserId: string | null;
  onSelectPerson: (userId: string) => void;
}

export function TeamCard({ team, grouped = true, selectedUserId, onSelectPerson }: TeamCardProps) {
  const chips = teamSignalChips(team.signals, grouped);
  const heading = team.option ? optionLabel(team.option) : team.name;

  return (
    <section
      aria-labelledby={`team-${team.n}-title`}
      data-team={team.n}
      className="grid content-start gap-2 rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2.5 gap-y-0.5">
        <div className="min-w-0">
          <h3
            id={`team-${team.n}-title`}
            className="text-[15px] font-semibold text-gray-900 dark:text-white"
          >
            {heading}
          </h3>
          {team.option ? (
            <div className="truncate font-mono text-xs text-gray-400 dark:text-gray-500">
              {team.name}
            </div>
          ) : null}
        </div>
        <span className="text-xs tabular-nums text-gray-500 dark:text-gray-400">
          {teamCardMeta(team)}
        </span>
      </div>

      {chips.length > 0 ? (
        <ul className="flex flex-wrap">
          {chips.map((chip, index) => (
            <li
              key={`${chip.kind}-${index}`}
              data-signal={chip.kind}
              className={`mb-1 mr-1 whitespace-nowrap rounded border px-1.5 text-[11px] leading-5 ${
                chip.kind === 'pinned' ? PINNED_TONE : CHIP_TONE[chip.tone]
              }`}
            >
              {chip.text}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap">
        {team.members.map(member => (
          <PersonChip
            key={member.user_id}
            member={member}
            grouped={grouped}
            selected={member.user_id === selectedUserId}
            onSelect={onSelectPerson}
          />
        ))}
      </div>
    </section>
  );
}

export default TeamCard;
