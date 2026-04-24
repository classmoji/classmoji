import { Popover, Avatar } from 'antd';
import { Link, useNavigate } from 'react-router';

import { useUser } from '~/hooks';

import type { TooltipPlacement } from 'antd/es/tooltip';

interface ProfileDropdownProps {
  children: React.ReactNode;
  placement?: TooltipPlacement;
}

const ProfileDropdown = ({ children, placement = 'bottomRight' }: ProfileDropdownProps) => {
  const { user } = useUser();
  const _navigate = useNavigate();

  const MenuItem = ({ label, path }: { label: string; path: string }) => (
    <Link
      to={path}
      className="block w-full text-sm text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-neutral-700 rounded-md py-1.5 px-2.5 no-underline transition-colors"
    >
      {label}
    </Link>
  );

  const dropdownContent = (
    <div className="w-[220px]">
      <div className="flex items-center gap-2.5 px-3 py-2.5 border-b border-gray-200 dark:border-neutral-700">
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
