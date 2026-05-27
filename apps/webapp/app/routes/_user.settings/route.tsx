import { Outlet, useNavigate, useLocation } from 'react-router';

interface TabDef {
  key: string;
  label: string;
}

const ALL_TABS: TabDef[] = [
  { key: 'general', label: 'General' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'billing', label: 'Billing' },
];

const UserSettings = () => {
  const navigate = useNavigate();
  const location = useLocation();

  const currentTab = location.pathname.split('/').pop() || 'general';

  return (
    <div className="min-h-full flex flex-col">
      <h1 className="mt-2 mb-4 text-base font-semibold text-ink-2">
        Account Settings
      </h1>

      <div className="flex-1 flex flex-col">
        <div className="flex -mb-px relative overflow-x-auto">
          {ALL_TABS.map((tab, idx) => {
            const isActive = tab.key === currentTab;
            const baseZ = ALL_TABS.length - idx;
            const zStyle = { zIndex: isActive ? 10 : baseZ };
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => navigate(`/settings/${tab.key}`)}
                style={
                  isActive
                    ? { ...zStyle, color: 'var(--accent)', borderTopColor: 'var(--accent)' }
                    : zStyle
                }
                className={`relative px-4 py-2 text-sm font-medium rounded-t-2xl border whitespace-nowrap transition-colors ${
                  idx > 0 ? '-ml-2' : ''
                } ${
                  isActive
                    ? 'bg-panel border-line border-b-transparent'
                    : 'bg-nav-hover text-ink-3 hover:text-gray-800 dark:hover:text-gray-200 border-line'
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

export default UserSettings;
