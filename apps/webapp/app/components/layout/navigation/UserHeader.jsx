import { Avatar } from 'antd';
import { useUser } from '~/hooks';
import { IconChevronDown } from '@tabler/icons-react';
import { Logo } from '@classmoji/ui-components';
import { ProfileDropdown } from '~/components';

const UserHeader = () => {
  const { user } = useUser();

  return (
    <div className="fixed z-10 flex items-center justify-between top-0 bg-lightGray dark:bg-gray-900 p-4 w-screen h-[52px] border-b-[0.5px] border-[#dee2e6] dark:border-gray-800">
      <div className="flex items-center gap-2">
        <Logo size={32} />
      </div>
      <ProfileDropdown>
        <div className="flex items-center gap-1">
          <Avatar
            src={user?.avatar_url}
            className="border-2 border-gray-300 dark:border-gray-700"
          />

          <IconChevronDown size={16} className="text-gray-500 dark:text-gray-400" />
        </div>
      </ProfileDropdown>
    </div>
  );
};

export default UserHeader;
