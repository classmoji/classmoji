import { Popover, Avatar } from 'antd';
import { Link, useNavigate } from 'react-router';

import { useUser } from '~/hooks';
import { signOut } from '@classmoji/auth/client';

const ProfileDropdown = ({ children, placement = 'bottomRight' }) => {
  const { user } = useUser();
  const navigate = useNavigate();

  const MenuItem = ({ label, path }) => (
    <Link
      to={path}
      className="block w-full text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-md py-1.5 px-2.5 no-underline transition-colors"
    >
      {label}
    </Link>
  );

  const dropdownContent = (
    <div className="w-[220px]">
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-gray-200 dark:border-gray-700">
        <Avatar
          src={user?.avatar_url}
          className="border border-gray-300 dark:border-gray-600 flex-shrink-0"
          size={40}
        />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm text-gray-900 dark:text-gray-100 truncate">
            {user?.name}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate">@{user?.login}</div>
        </div>
      </div>

      <div className="flex flex-col gap-0.5 p-1.5">
        <MenuItem label="Account Settings" path="/settings/general" />
        <MenuItem label="Usage & Billing" path="/settings/billing" />
      </div>

      <div className="border-t border-gray-200 dark:border-gray-700 p-1.5">
        <button
          className="block w-full text-left text-sm text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30 rounded-md py-1.5 px-2.5 transition-colors cursor-pointer"
          onClick={async () => {
            await signOut();
            window.location.href = window.location.origin;
          }}
        >
          Logout
        </button>
      </div>
    </div>
  );

  return (
    <Popover
      content={dropdownContent}
      trigger={['hover']}
      placement={placement}
      overlayClassName="z-50"
    >
      {children}
    </Popover>
  );
};

export default ProfileDropdown;
