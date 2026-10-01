import { IconPinFilled } from '@tabler/icons-react';

import { PLACEMENT_BADGE } from './PlacementBar.tsx';
import type { ResultMember } from './types.ts';
import { rankBadgeText, TEAMS_LABELS, UNNAMED } from './teamsView.ts';

/**
 * Results: one person on a team card — name, rank badge, pin glyph.
 *
 * A button: choosing a person shows their facts in the why panel. The badge's
 * color follows the person's placement, the same hue as the placement bar.
 * No badge for someone who answered whose placement the view doesn't show,
 * or on a run with no grouping question (rankBadgeText gives '').
 */

export interface PersonChipProps {
  member: ResultMember;
  /** The run made its teams from a question; false = nobody ranked anything. */
  grouped?: boolean;
  selected: boolean;
  onSelect: (userId: string) => void;
}

export function PersonChip({ member, grouped = true, selected, onSelect }: PersonChipProps) {
  const badge =
    (member.placement ? PLACEMENT_BADGE[member.placement] : undefined) ?? PLACEMENT_BADGE.no_answer;
  const badgeText = rankBadgeText(member, grouped);

  return (
    <button
      type="button"
      aria-pressed={selected}
      data-user-id={member.user_id}
      onClick={() => onSelect(member.user_id)}
      className={`mb-1 mr-1 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-sm ${
        selected
          ? 'border-blue-500 bg-blue-50 text-gray-900 dark:border-blue-400 dark:bg-blue-950 dark:text-white'
          : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:bg-gray-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:border-gray-600 dark:hover:bg-gray-800'
      }`}
    >
      <span>{member.name ?? UNNAMED}</span>
      {badgeText ? (
        <span className={`rounded px-1.5 text-[11px] font-medium leading-4 ${badge}`}>
          {badgeText}
        </span>
      ) : null}
      {member.pinned ? (
        <span
          role="img"
          aria-label={TEAMS_LABELS.pinned}
          title={TEAMS_LABELS.pinned}
          className="inline-grid h-4 w-4 place-items-center rounded-full bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-200"
        >
          <IconPinFilled size={10} aria-hidden="true" />
        </span>
      ) : null}
    </button>
  );
}

export default PersonChip;
