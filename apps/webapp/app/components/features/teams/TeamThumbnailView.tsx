import _ from 'lodash';

interface TeamThumbnailViewProps {
  team: {
    avatar_url?: string | null;
    name: string;
    /** When present, the members are listed under the name instead of a handle. */
    memberships?: Array<{ user: { name?: string | null; login?: string | null } }>;
  };
}

const TeamThumbnailView = ({ team }: TeamThumbnailViewProps) => {
  const { avatar_url, name, memberships } = team;
  const members = memberships?.map(m => m.user.name || m.user.login).filter(Boolean) ?? [];
  return (
    <div className="flex gap-3 min-w-0">
      {avatar_url ? (
        <img className="w-[37px] h-[37px] rounded-full shrink-0" src={avatar_url} alt="" />
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
            {members.length ? members.join(', ') : 'No members'}
          </div>
        ) : (
          <div className="text-sm">@{name}</div>
        )}
      </div>
    </div>
  );
};

export default TeamThumbnailView;
