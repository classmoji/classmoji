import { Tabs } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router';
import { IconSettings, IconUser, IconCreditCard } from '@tabler/icons-react';
import { useUser } from '~/hooks';

const UserSettings = () => {
  const navigate = useNavigate();
  const { user } = useUser();
  const location = useLocation();

  const currentTab = location.pathname.split('/').pop() || 'general';

  const items = [
    {
      key: 'general',
      label: (
        <span className="inline-flex items-center gap-2">
          <IconUser size={16} />
          <span>General</span>
        </span>
      ),
      children: <Outlet />,
    },
  ];

  if (user?.is_admin) {
    items.push({
      key: 'billing',
      label: (
        <span className="inline-flex items-center gap-2">
          <IconCreditCard size={16} />
          <span>Billing</span>
        </span>
      ),
      children: <Outlet />,
    });
  }

  return (
    <>
      <div className="flex items-center gap-2 mt-2 mb-4">
        <IconSettings className="text-black dark:text-gray-100" />
        <h1 className="text-2xl font-bold text-black dark:text-gray-100">Account Settings</h1>
      </div>

      <Tabs
        items={items}
        activeKey={currentTab}
        onChange={tabKey => {
          const path = `/settings/${tabKey}`;
          navigate(path);
        }}
      />
    </>
  );
};

export default UserSettings;
