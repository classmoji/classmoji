import type { CSSProperties } from 'react';
import { Outlet, useNavigate, useParams, useLocation } from 'react-router';

interface TabDef {
  key: string;
  label: string;
  danger?: boolean;
}

const ALL_TABS: TabDef[] = [
  { key: 'general', label: 'General' },
  { key: 'repos', label: 'Repositories' },
  { key: 'grades', label: 'Grades' },
  { key: 'quizzes', label: 'Quizzes' },
  { key: 'content', label: 'Content' },
  { key: 'team', label: 'Team' },
  { key: 'extension', label: 'Extension' },
  { key: 'danger-zone', label: 'Danger Zone', danger: true },
];

const OrgSettings = () => {
  const navigate = useNavigate();
  const { class: classSlug } = useParams();
  const location = useLocation();

  const currentTab = location.pathname.split('/').pop() || 'general';

  return (
    <div className="min-h-full flex flex-col">
      <h1 className="mt-2 mb-4 text-base font-semibold text-ink-2">
        Settings
      </h1>

      <div className="flex-1 flex flex-col">
        <div className="flex -mb-px relative overflow-x-auto">
          {ALL_TABS.map((tab, idx) => {
            const isActive = tab.key === currentTab;
            const baseZ = ALL_TABS.length - idx;
            const zStyle = { zIndex: isActive ? 10 : baseZ };
            const inactiveTextColor = tab.danger
              ? 'text-red-500/80 dark:text-red-400/80 hover:text-red-600 dark:hover:text-red-400'
              : 'text-ink-3 hover:text-gray-800 dark:hover:text-gray-200';
            const activeStyle: CSSProperties = isActive
              ? tab.danger
                ? { ...zStyle }
                : { ...zStyle, color: 'var(--accent)', borderTopColor: 'var(--accent)' }
              : zStyle;
            return (
              <button
                key={tab.key}
                type="button"
                data-tour={`settings-tab-${tab.key}`}
                onClick={() => navigate(`/admin/${classSlug}/settings/${tab.key}`)}
                style={activeStyle}
                className={`relative px-4 py-2 text-sm font-medium rounded-t-2xl border whitespace-nowrap transition-colors ${
                  idx > 0 ? '-ml-2' : ''
                } ${
                  isActive
                    ? `bg-panel ${
                        tab.danger ? 'text-red-600 dark:text-red-400' : ''
                      } border-line border-b-transparent`
                    : `bg-nav-hover ${inactiveTextColor} border-line`
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <section className="flex-1 rounded-2xl rounded-tl-none bg-panel border border-line min-h-[calc(100vh-10rem)] p-5 sm:p-6 overflow-auto">
          <Outlet />
        </section>
      </div>
    </div>
  );
};

export default OrgSettings;
