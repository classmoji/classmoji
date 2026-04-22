import { Outlet } from 'react-router';

import { SettingsShell, type SettingsTab } from '~/components/features/settings';
import { useSubscription } from '~/hooks';

const OrgSettings = () => {
  const { isProTier } = useSubscription();

  const tabs: SettingsTab[] = [
    { key: 'general', label: 'General' },
    { key: 'repos', label: 'Repositories' },
    { key: 'grades', label: 'Grades' },
    { key: 'quizzes', label: 'Quizzes' },
    { key: 'content', label: 'Content' },
    ...(isProTier ? [{ key: 'team', label: 'Team', pro: true } as SettingsTab] : []),
    { key: 'extension', label: 'Extension' },
    { key: 'danger-zone', label: 'Danger zone', danger: true },
  ];

  return (
    <SettingsShell title="Settings" tabs={tabs}>
      <Outlet />
    </SettingsShell>
  );
};

export default OrgSettings;
