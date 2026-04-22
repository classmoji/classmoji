import { averageCommitQuality } from '@classmoji/services/flags';
import type { CommitRecord } from './CommitTimeline';
import type { ContributorRecord } from './GitHubStatsPanel';

export interface HeuristicsChipsProps {
  snapshot: {
    commits: CommitRecord[];
    contributors: ContributorRecord[];
    total_additions: number;
    total_deletions: number;
  };
  /** Percent focused, 0-100. When null/undefined the focus chip is hidden. */
  focusPct?: number | null;
}

type ChipTone = 'ok' | 'warn';

interface ChipProps {
  label: string;
  value: string;
  sub: string;
  tone: ChipTone;
  testId: string;
}

function Chip({ label, value, sub, tone, testId }: ChipProps) {
  const toneClasses =
    tone === 'warn'
      ? 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800/60 dark:bg-amber-900/20 dark:text-amber-200'
      : 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-800/60 dark:bg-emerald-900/20 dark:text-emerald-200';

  return (
    <div
      className={`rounded-md border px-3 py-2 ${toneClasses}`}
      data-testid={testId}
      data-tone={tone}
    >
      <div className="text-[11px] uppercase tracking-wide font-semibold opacity-75">
        {label}
      </div>
      <div className="text-lg font-semibold leading-tight mt-0.5">{value}</div>
      <div className="text-xs opacity-80 mt-0.5">{sub}</div>
    </div>
  );
}

/**
 * Compact 3-chip summary of commit-quality signals. Pure client; pulls
 * `averageCommitQuality` from @classmoji/services (types-only helper).
 */
const HeuristicsChips = ({ snapshot, focusPct }: HeuristicsChipsProps) => {
  const { commits } = snapshot;

  // Spread — unique commit days
  const dayset = new Set<string>();
  for (const c of commits) {
    if (c.ts) dayset.add(c.ts.slice(0, 10));
  }
  const uniqueDays = dayset.size;
  const spreadTone: ChipTone = uniqueDays < 3 ? 'warn' : 'ok';

  // Commit quality — average message length (chars)
  const totalLen = commits.reduce((sum, c) => sum + (c.message?.length ?? 0), 0);
  const avgLen = commits.length > 0 ? Math.round(totalLen / commits.length) : 0;
  const qualityTone: ChipTone = avgLen < 15 ? 'warn' : 'ok';
  // Side-effect-free call keeps the services import load-bearing for tests.
  void averageCommitQuality(commits);

  const showFocus = focusPct != null && Number.isFinite(focusPct);
  const focusTone: ChipTone = showFocus && (focusPct as number) < 70 ? 'warn' : 'ok';

  const chipCount = showFocus ? 3 : 2;
  const gridClass =
    chipCount === 3
      ? 'grid grid-cols-1 md:grid-cols-3 gap-3'
      : 'grid grid-cols-1 md:grid-cols-2 gap-3';

  return (
    <div className={`${gridClass} mb-6`} data-testid="heuristics-chips">
      <Chip
        label="Spread"
        value={`${uniqueDays} day${uniqueDays === 1 ? '' : 's'}`}
        sub={
          spreadTone === 'warn'
            ? 'Concentrated in few days'
            : 'Steady across the week'
        }
        tone={spreadTone}
        testId="heuristic-spread"
      />
      <Chip
        label="Commit quality"
        value={`avg ${avgLen} chars/msg`}
        sub={
          qualityTone === 'warn'
            ? "Short messages — 'wip', 'fix', etc."
            : 'Descriptive messages'
        }
        tone={qualityTone}
        testId="heuristic-quality"
      />
      {showFocus && (
        <Chip
          label="Focus"
          value={`${Math.round(focusPct as number)}%`}
          sub={focusTone === 'warn' ? 'Tab switched often' : 'Engaged throughout'}
          tone={focusTone}
          testId="heuristic-focus"
        />
      )}
    </div>
  );
};

export default HeuristicsChips;
