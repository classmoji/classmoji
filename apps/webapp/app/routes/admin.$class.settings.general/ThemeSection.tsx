import { IconCheck } from '@tabler/icons-react';

import { useGlobalFetcher } from '~/hooks';
import { SettingSection } from '~/components';
import { CLASSROOM_THEMES, DEFAULT_CLASSROOM_THEME } from '~/constants';

interface ThemeSectionProps {
  currentTheme: string;
}

const ThemeSection = ({ currentTheme }: ThemeSectionProps) => {
  const { fetcher } = useGlobalFetcher();
  const activeKey = currentTheme || DEFAULT_CLASSROOM_THEME;

  const handleSelect = (themeKey: string) => {
    if (themeKey === activeKey) return;
    fetcher!.submit(
      { theme: themeKey },
      { action: '?/saveTheme', method: 'POST', encType: 'application/json' }
    );
  };

  return (
    <SettingSection
      title="Theme"
      description="Choose a background color for your classroom. This applies to everyone in the classroom."
    >
      <div className="flex flex-wrap gap-4">
        {CLASSROOM_THEMES.map(theme => {
          const isActive = theme.key === activeKey;
          return (
            <button
              key={theme.key}
              type="button"
              onClick={() => handleSelect(theme.key)}
              className="group flex flex-col items-center gap-2 focus:outline-none"
            >
              <span
                className={`relative flex h-14 w-14 items-center justify-center rounded-full border-2 transition-all ${
                  isActive
                    ? 'border-gray-900 dark:border-gray-100 ring-2 ring-offset-2 ring-gray-900 dark:ring-gray-100 ring-offset-white dark:ring-offset-gray-900'
                    : 'border-stone-200 dark:border-neutral-700 group-hover:border-gray-400 dark:group-hover:border-gray-500'
                }`}
                style={{ backgroundColor: theme.background }}
              >
                {isActive && <IconCheck size={20} className="text-gray-900" />}
              </span>
              <span
                className={`text-xs font-medium ${
                  isActive
                    ? 'text-gray-900 dark:text-gray-100'
                    : 'text-gray-600 dark:text-gray-400'
                }`}
              >
                {theme.label}
              </span>
            </button>
          );
        })}
      </div>
    </SettingSection>
  );
};

export default ThemeSection;
