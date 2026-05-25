import { useState } from 'react';
import { StatsGradingProgress, TAGradingLeaderboard } from '~/components';

type TabKey = 'grading' | 'ta';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'grading', label: 'Grading progress' },
  { key: 'ta', label: 'TA activity' },
];

interface GradingProgressItem {
  id?: string;
  title: string;
  progress: number;
  student_deadline: string | Date | null;
  [key: string]: unknown;
}

interface GradingLeaderboardItem {
  id: string;
  login: string | null;
  name: string | null;
  progress: number;
  gradedCount?: number;
  gradedThisWeek?: number;
}

interface GradingTabsCardProps {
  gradingProgress: GradingProgressItem[];
  assistantsProgress: GradingLeaderboardItem[];
}

const GradingTabsCard = ({ gradingProgress, assistantsProgress }: GradingTabsCardProps) => {
  const [active, setActive] = useState<TabKey>('grading');

  return (
    <div className="flex flex-col">
      <div className="flex -mb-px relative">
        {TABS.map((tab, idx) => {
          const isActive = tab.key === active;
          const baseZ = TABS.length - idx;
          const zStyle = { zIndex: isActive ? 10 : baseZ };
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActive(tab.key)}
              style={
                isActive
                  ? { ...zStyle, color: 'var(--accent)', borderTopColor: 'var(--accent)' }
                  : zStyle
              }
              className={`relative px-4 py-2 text-sm font-medium rounded-t-[15px] border whitespace-nowrap transition-colors ${
                idx > 0 ? '-ml-2' : ''
              } ${
                isActive
                  ? 'bg-panel border-line border-b-transparent'
                  : 'bg-nav-hover text-ink-3 border-line hover:text-gray-800 dark:hover:text-gray-200'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <section className="rounded-2xl rounded-tl-none bg-panel ring-1 ring-line p-4 sm:p-5 min-h-[240px]">
        {active === 'grading' ? (
          <StatsGradingProgress gradingProgress={gradingProgress} bare />
        ) : (
          <TAGradingLeaderboard progress={assistantsProgress} bare />
        )}
      </section>
    </div>
  );
};

export default GradingTabsCard;
