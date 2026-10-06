import { useState } from 'react';
import _ from 'lodash';
import { isPlaceholderAvatar } from '@classmoji/utils';

interface TeamThumbnailViewProps {
  team: {
    avatar_url?: string | null;
    name: string;
    /** When present, the members are listed under the name instead of a handle. */
    memberships?: Array<{ user: { name?: string | null; login?: string | null } }>;
  };
}

const SHOWN_MEMBERS = 2;

const TeamThumbnailView = ({ team }: TeamThumbnailViewProps) => {
  const { avatar_url, name, memberships } = team;
  // The team's initial stands in for a missing, generic or unloadable picture.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = isPlaceholderAvatar(avatar_url) ? null : avatar_url;
  const members = memberships?.map(m => m.user.name || m.user.login).filter(Boolean) ?? [];
  // Two names and a count, the full list on hover: a team of eight would
  // otherwise stretch the table column it sits in.
  const shown = members.slice(0, SHOWN_MEMBERS).join(', ');
  const more = members.length - SHOWN_MEMBERS;
  return (
    <div className="flex gap-3 min-w-0 max-w-[18rem]">
      {src && failedSrc !== src ? (
        <img
          className="w-[37px] h-[37px] rounded-full shrink-0"
          src={src}
          alt=""
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <div
          aria-hidden
          className="w-[37px] h-[37px] rounded-full shrink-0 flex items-center justify-center bg-stone-100 text-stone-600 ring-1 ring-stone-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700 text-sm font-semibold"
        >
          {name.trim().charAt(0).toUpperCase()}
        </div>
      )}

      <div className="min-w-0">
        <div className="text-sm font-bold">{_.capitalize(name)}</div>
        {memberships ? (
          <div className="text-xs text-ink-3 truncate" title={members.join(', ')}>
            {members.length ? (more > 0 ? `${shown} +${more} more` : shown) : 'No members'}
          </div>
        ) : (
          <div className="text-sm">@{name}</div>
        )}
      </div>
    </div>
  );
};

export default TeamThumbnailView;
