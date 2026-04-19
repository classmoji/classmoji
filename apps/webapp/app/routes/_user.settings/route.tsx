import { Tabs } from 'antd';
import { Outlet, useNavigate, useLocation } from 'react-router';
import { IconSettings, IconUser, IconCreditCard } from '@tabler/icons-react';
import { useUser } from '~/hooks';

const UserSettings = () => {
  const navigate = useNavigate();
  const { user: _user } = useUser();
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
    {
      key: 'billing',
      label: (
        <span className="inline-flex items-center gap-2">
          <IconCreditCard size={16} />
          <span>Billing</span>
        </span>
      ),
      children: <Outlet />,
    },
  ];

  return (
    <>
      <div className="flex items-center gap-2 mt-2 mb-6">
        <IconSettings className="text-ink-0" />
        <h1 className="display text-3xl text-ink-0">Account Settings</h1>
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
