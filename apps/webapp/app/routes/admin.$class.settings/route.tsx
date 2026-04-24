import { Outlet, useNavigate, useParams, useLocation } from 'react-router';

import { ProTierFeature } from '~/components';
import { useSubscription } from '~/hooks';

interface TabDef {
  key: string;
  label: string;
  pro?: boolean;
  danger?: boolean;
}

const ALL_TABS: TabDef[] = [
  { key: 'general', label: 'General' },
  { key: 'repos', label: 'Repositories' },
  { key: 'grades', label: 'Grades' },
  { key: 'quizzes', label: 'Quizzes' },
  { key: 'content', label: 'Content' },
  { key: 'team', label: 'Team', pro: true },
  { key: 'extension', label: 'Extension' },
  { key: 'danger-zone', label: 'Danger Zone', danger: true },
];

const OrgSettings = () => {
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const location = useLocation();
  const { isProTier } = useSubscription();

  const currentTab = location.pathname.split('/').pop() || 'general';
  const visibleTabs = ALL_TABS.filter(t => !t.pro || isProTier);

  return (
    <div className="min-h-full flex flex-col">
      <h1 className="mt-2 mb-4 text-base font-semibold text-gray-600 dark:text-gray-400">
        Settings
      </h1>

      <div className="flex-1 flex flex-col">
        <div className="flex -mb-px relative overflow-x-auto">
          {visibleTabs.map((tab, idx) => {
            const isActive = tab.key === currentTab;
            const baseZ = visibleTabs.length - idx;
            const zStyle = { zIndex: isActive ? 40 : baseZ };
            const activeTextColor = tab.danger
              ? 'text-red-600 dark:text-red-400'
              : 'text-gray-900 dark:text-gray-100';
            const inactiveTextColor = tab.danger
              ? 'text-red-500/80 dark:text-red-400/80 hover:text-red-600 dark:hover:text-red-400'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200';
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => navigate(`/admin/${classSlug}/settings/${tab.key}`)}
                style={zStyle}
                className={`relative px-4 py-2 text-sm font-medium rounded-t-2xl border whitespace-nowrap transition-colors ${
                  idx > 0 ? '-ml-2' : ''
                } ${
                  isActive
                    ? `bg-white dark:bg-neutral-900 ${activeTextColor} border-stone-200 dark:border-neutral-800 border-b-transparent`
                    : `bg-stone-100 dark:bg-neutral-800 ${inactiveTextColor} border-stone-200 dark:border-neutral-700`
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <section className="flex-1 rounded-2xl rounded-tl-none bg-white dark:bg-neutral-900 border border-stone-200 dark:border-neutral-800 min-h-[calc(100vh-10rem)] p-5 sm:p-6 overflow-auto">
          {currentTab === 'team' ? (
            <ProTierFeature>
              <Outlet />
            </ProTierFeature>
          ) : (
            <Outlet />
          )}
        </section>
      </div>
    </div>
  );
};

export default OrgSettings;
