const UserThumbnailView = ({ user, truncate = false }) => {
  return (
    <div className={`flex gap-3 ${truncate ? 'min-w-0 flex-1' : 'w-full'}`}>
      {user?.avatar_url && (
        <img
          className="w-[40px] h-[40px] rounded-full flex-shrink-0"
          src={user.avatar_url}
          alt={user.avatar_url}
        />
      )}

      <div className={`flex flex-col gap-[2px] ${truncate ? 'min-w-0 flex-1' : ''}`}>
        <div
          className={`text-xs font-bold dark:text-gray-200 ${truncate ? 'truncate' : ''}`}
          title={truncate ? user?.name : undefined}
        >
          {user?.name}
        </div>
        {(user?.login || user?.slug) && (
          <div className="text-mist dark:text-gray-500 text-xs flex gap-6">
            <div
              className={`text-xs ${truncate ? 'truncate' : ''}`}
              title={truncate ? user?.login || user?.slug : undefined}
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
