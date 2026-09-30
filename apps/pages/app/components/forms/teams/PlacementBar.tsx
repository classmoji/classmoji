import type { TeamSetMetrics, TeamSetPlacement } from './types.ts';
import { placementLegend, type ShownMetrics } from './teamsView.ts';

/**
 * Results: where everyone landed, as one bar and its legend.
 *
 * Each segment's width is its share of the people counted, so the bar is drawn
 * to scale; placements nobody got are left out of both the bar and the legend
 * (`placementLegend`). The bar's accessible name is the legend itself.
 *
 * The colors are exported so a person chip's rank badge matches its segment.
 */

/** A placement's segment fill. */
export const PLACEMENT_FILL: Readonly<Record<TeamSetPlacement, string>> = {
  '1': 'bg-emerald-500 dark:bg-emerald-400',
  '2': 'bg-emerald-300 dark:bg-emerald-600',
  '3': 'bg-amber-300 dark:bg-amber-500',
  '4': 'bg-amber-400 dark:bg-amber-600',
  '5+': 'bg-orange-400 dark:bg-orange-600',
  fallback: 'bg-sky-400 dark:bg-sky-500',
  missed: 'bg-rose-400 dark:bg-rose-500',
  no_answer: 'bg-gray-300 dark:bg-gray-600',
};

/** A placement's badge on a person chip (same hue as its segment). */
export const PLACEMENT_BADGE: Readonly<Record<TeamSetPlacement, string>> = {
  '1': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200',
  '2': 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  '3': 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  '4': 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100',
  '5+': 'bg-orange-100 text-orange-900 dark:bg-orange-900 dark:text-orange-100',
  fallback: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-200',
  missed: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200',
  no_answer:
    'border border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400',
};

export interface PlacementBarProps {
  metrics: Pick<ShownMetrics, 'placement'> | Pick<TeamSetMetrics, 'placement'>;
}

export function PlacementBar({ metrics }: PlacementBarProps) {
  const legend = placementLegend(metrics);
  const total = legend.reduce((sum, item) => sum + item.count, 0);
  if (total === 0) return null;

  return (
    <div data-testid="placement-bar" className="mb-4">
      <div
        role="img"
        aria-label={legend.map(item => item.text).join(', ')}
        className="my-1 flex h-3 overflow-hidden rounded-full border border-gray-200 dark:border-gray-700"
      >
        {legend.map(item => (
          <span
            key={item.placement}
            className={`block h-full ${PLACEMENT_FILL[item.placement]}`}
            style={{ width: `${(item.count / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
        {legend.map(item => (
          <li key={item.placement} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className={`inline-block h-2.5 w-2.5 rounded-sm ${PLACEMENT_FILL[item.placement]}`}
            />
            <span className="tabular-nums">{item.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default PlacementBar;
