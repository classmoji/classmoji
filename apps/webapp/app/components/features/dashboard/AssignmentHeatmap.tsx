import { Card } from 'antd';
import { CardHeader } from '~/components';

export interface AssignmentHealthRow {
  assignmentId: string;
  title: string;
  submissionRate: number;
  medianGrade: number | null;
  medianTimeToGradeHours: number | null;
  regradeRate: number;
}

interface AssignmentHeatmapProps {
  rows: AssignmentHealthRow[];
}

/**
 * Four metrics per assignment, each cell colored from red (bad) to green (good).
 * Keeping this intentionally simple — a table, not a ScatterChart.
 */

// Returns a Tailwind class pair for a normalized "goodness" value in [0, 1].
const bandForGoodness = (g: number): string => {
  if (g >= 0.8) return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
  if (g >= 0.6) return 'bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-300';
  if (g >= 0.4) return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
  if (g >= 0.2) return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
  return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
};

const emptyCell = 'bg-gray-50 text-gray-400 dark:bg-gray-800 dark:text-gray-500';

// Higher = better: submissionRate, medianGrade/100 — use as-is.
// Lower = better: regradeRate, medianTimeToGradeHours — invert.
const goodnessSubmissionRate = (v: number) => Math.max(0, Math.min(1, v));
const goodnessMedianGrade = (v: number | null) =>
  v === null ? null : Math.max(0, Math.min(1, v / 100));
const goodnessRegradeRate = (v: number) => Math.max(0, Math.min(1, 1 - v));
// Treat 0-4h as great, 48h+ as terrible.
const goodnessTTG = (h: number | null) => {
  if (h === null) return null;
  const clamped = Math.max(0, Math.min(48, h));
  return 1 - clamped / 48;
};

const Cell = ({
  value,
  goodness,
}: {
  value: string;
  goodness: number | null;
}) => (
  <div
    className={`flex items-center justify-center text-xs font-medium rounded-md px-2 py-2 tabular-nums ${
      goodness === null ? emptyCell : bandForGoodness(goodness)
    }`}
  >
    {value}
  </div>
);

const AssignmentHeatmap = ({ rows }: AssignmentHeatmapProps) => {
  return (
    <Card className="h-full" data-testid="assignment-heatmap">
      <CardHeader>Assignment Health</CardHeader>
      <div className="overflow-auto max-h-[420px]">
        <div className="min-w-[520px]">
          <div className="grid grid-cols-[1.5fr_1fr_1fr_1fr_1fr] gap-2 text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 pb-2 border-b border-gray-100 dark:border-gray-700 mb-2">
            <div>Assignment</div>
            <div className="text-center">Sub Rate</div>
            <div className="text-center">Median</div>
            <div className="text-center">TTG</div>
            <div className="text-center">Regrade</div>
          </div>

          {rows.length === 0 ? (
            <div className="text-sm text-gray-500 dark:text-gray-400 py-6 text-center">
              No assignments yet.
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {rows.map((r) => (
                <div
                  key={r.assignmentId}
                  className="grid grid-cols-[1.5fr_1fr_1fr_1fr_1fr] gap-2 items-center"
                >
                  <div
                    className="text-sm text-gray-800 dark:text-gray-200 truncate"
                    title={r.title}
                  >
                    {r.title}
                  </div>
                  <Cell
                    value={`${Math.round(r.submissionRate * 100)}%`}
                    goodness={goodnessSubmissionRate(r.submissionRate)}
                  />
                  <Cell
                    value={r.medianGrade === null ? '—' : r.medianGrade.toFixed(0)}
                    goodness={goodnessMedianGrade(r.medianGrade)}
                  />
                  <Cell
                    value={
                      r.medianTimeToGradeHours === null
                        ? '—'
                        : `${r.medianTimeToGradeHours.toFixed(1)}h`
                    }
                    goodness={goodnessTTG(r.medianTimeToGradeHours)}
                  />
                  <Cell
                    value={`${Math.round(r.regradeRate * 100)}%`}
                    goodness={goodnessRegradeRate(r.regradeRate)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};

export default AssignmentHeatmap;
