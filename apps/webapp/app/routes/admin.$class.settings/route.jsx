import { Outlet, useNavigate, useParams, useLocation } from 'react-router';
import { Tabs, Card } from 'antd';
import {
  IconSettings,
  IconSchool,
  IconUsers,
  IconPuzzle,
  IconAlertTriangle,
  IconBrandGit,
  IconBrain,
  IconFileText,
} from '@tabler/icons-react';

import { PageHeader, ProTierFeature } from '~/components';
import { useSubscription } from '~/hooks';

const OrgSettings = () => {
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const location = useLocation();
  const { isProTier } = useSubscription();

  // Extract current tab from URL
  const currentTab = location.pathname.split('/').pop() || 'general';

  const items = [
    {
      key: 'general',
      label: (
        <div className="flex items-center gap-2">
          <IconSettings size={16} />
          <span>General</span>
        </div>
      ),
      children: <Outlet />,
    },
    {
      key: 'repos',
      label: (
        <div className="flex items-center gap-2">
          <IconBrandGit size={16} />
          <span>Repositories</span>
        </div>
      ),
      children: <Outlet />,
    },
    {
      key: 'grades',
      label: (
        <div className="flex items-center gap-2">
          <IconSchool size={16} />
          <span>Grades</span>
        </div>
      ),
      children: <Outlet />,
    },
    {
      key: 'quizzes',
      label: (
        <div className="flex items-center gap-2">
          <IconBrain size={16} />
          <span>Quizzes</span>
        </div>
      ),
      children: <Outlet />,
    },
    {
      key: 'content',
      label: (
        <div className="flex items-center gap-2">
          <IconFileText size={16} />
          <span>Content</span>
        </div>
      ),
      children: <Outlet />,
    },
    ...(isProTier
      ? [
          {
            key: 'team',
            label: (
              <div className="flex items-center gap-2">
                <IconUsers size={16} />
                <span>Team</span>
              </div>
            ),
            children: (
              <ProTierFeature>
                <Outlet />
              </ProTierFeature>
            ),
          },
        ]
      : []),
    {
      key: 'extension',
      label: (
        <div className="flex items-center gap-2">
          <IconPuzzle size={16} />
          <span>Extension</span>
        </div>
      ),
      children: <Outlet />,
    },
    {
      key: 'danger-zone',
      label: (
        <div className="flex items-center gap-2 text-red-600">
          <IconAlertTriangle size={16} />
          <span>Danger Zone</span>
        </div>
      ),
      children: <Outlet />,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Classroom Settings" routeName="settings" />

      <style>
        {`.danger-zone-active .ant-tabs-ink-bar { background: #dc2626 !important; }`}
      </style>
      <Tabs
        activeKey={currentTab}
        items={items}
        className={currentTab === 'danger-zone' ? 'danger-zone-active' : ''}
        onChange={tabKey => {
          const path = `/admin/${classSlug}/settings/${tabKey}`;
          navigate(path);
        }}
        tabBarStyle={{
          marginBottom: '24px',
          borderBottom: '1px solid #f0f0f0',
          marginTop: '-18px',
        }}
      />
    </div>
  );
};

export default OrgSettings;
