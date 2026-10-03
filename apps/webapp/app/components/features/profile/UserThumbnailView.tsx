import UserAvatar from '~/components/shared/UserAvatar';

interface UserThumbnailViewProps {
  user?: {
    avatar_url?: string | null;
    name?: string | null;
    login?: string | null;
    slug?: string | null;
  };
  truncate?: boolean;
}

const UserThumbnailView = ({ user, truncate = false }: UserThumbnailViewProps) => {
  return (
    <div className={`flex gap-3 ${truncate ? 'min-w-0 flex-1' : 'w-full'}`}>
      <UserAvatar
        image={user?.avatar_url}
        name={user?.name}
        login={user?.login || user?.slug}
        size={40}
      />

      <div className={`flex flex-col gap-[2px] ${truncate ? 'min-w-0 flex-1' : ''}`}>
        <div
          className={`text-xs font-bold dark:text-gray-200 ${truncate ? 'truncate' : ''}`}
          title={truncate ? (user?.name ?? undefined) : undefined}
        >
          {user?.name}
        </div>
        {(user?.login || user?.slug) && (
          <div className="text-mist dark:text-gray-500 text-xs flex gap-6">
            <div
              className={`text-xs ${truncate ? 'truncate' : ''}`}
              title={truncate ? ((user?.login || user?.slug) ?? undefined) : undefined}
            >
              @{user?.login || user?.slug}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default UserThumbnailView;
