import type { MetricTile } from './teamsView.ts';

/**
 * Results: the headline counts — 1st pick and top 3 (runs made from a
 * question), requests kept, Must rules broken, projects running (grouped runs
 * whose view shows the options).
 *
 * Takes the tiles `metricTiles(metrics, grouped, projects)` builds; the markup is the
 * Responses page's stat tile. "Must rules broken" at 0 is shown in the accent
 * color, as the mockup does.
 */

export interface MetricTilesProps {
  tiles: MetricTile[];
}

export function MetricTiles({ tiles }: MetricTilesProps) {
  if (tiles.length === 0) return null;
  return (
    <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map(tile => {
        const clear = tile.key === 'must_broken' && tile.value === 0;
        return (
          <div
            key={tile.key}
            data-tile={tile.key}
            className="rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-gray-700 dark:bg-gray-900"
          >
            <div
              className={`text-2xl font-semibold tabular-nums ${
                clear ? 'text-emerald-600 dark:text-emerald-400' : 'text-gray-900 dark:text-white'
              }`}
            >
              {tile.value}
              {tile.of !== null ? (
                <span className="text-sm font-medium text-gray-400 dark:text-gray-500">
                  /{tile.of}
                </span>
              ) : null}
            </div>
            <div className="truncate text-xs text-gray-500 dark:text-gray-400" title={tile.label}>
              {tile.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default MetricTiles;
