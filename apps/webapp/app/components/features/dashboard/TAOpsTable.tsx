import { Card, Table } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CardHeader } from '~/components';

export interface TaOpsRow {
  taId: string;
  login: string;
  name: string | null;
  throughput7d: number;
  avgTimeToGradeHours: number | null;
  overturnRate: number | null;
  gradeDistributionMean: number | null;
}

interface TAOpsTableProps {
  rows: TaOpsRow[];
}

const TAOpsTable = ({ rows }: TAOpsTableProps) => {
  const columns: ColumnsType<TaOpsRow> = [
    {
      title: 'TA',
      key: 'ta',
      render: (_, r) => (
        <div className="flex items-center gap-2 min-w-0">
          {r.login ? (
            <img
              src={`https://github.com/${r.login}.png`}
              alt={r.name || r.login}
              className="w-7 h-7 rounded-full ring-1 ring-gray-200 dark:ring-gray-700 flex-shrink-0"
            />
          ) : (
            <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-[11px] font-semibold text-gray-600 dark:text-gray-300">
              {(r.name || r.login || '?').slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="text-sm text-gray-900 dark:text-gray-100 truncate">
              {r.name || r.login || 'Unknown'}
            </div>
            {r.login && (
              <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                @{r.login}
              </div>
            )}
          </div>
        </div>
      ),
    },
    {
      title: 'Throughput (7d)',
      key: 'throughput7d',
      dataIndex: 'throughput7d',
      align: 'right',
      sorter: (a, b) => a.throughput7d - b.throughput7d,
      render: (v: number) => <span className="tabular-nums">{v}</span>,
    },
    {
      title: 'Avg TTG',
      key: 'avgTimeToGradeHours',
      align: 'right',
      sorter: (a, b) =>
        (a.avgTimeToGradeHours ?? Number.POSITIVE_INFINITY) -
        (b.avgTimeToGradeHours ?? Number.POSITIVE_INFINITY),
      render: (_, r) => (
        <span className="tabular-nums">
          {r.avgTimeToGradeHours === null ? '—' : `${r.avgTimeToGradeHours.toFixed(1)}h`}
        </span>
      ),
    },
    {
      title: 'Overturn %',
      key: 'overturnRate',
      align: 'right',
      sorter: (a, b) => (a.overturnRate ?? -1) - (b.overturnRate ?? -1),
      render: (_, r) => (
        <span className="tabular-nums">
          {r.overturnRate === null ? '—' : `${Math.round(r.overturnRate * 100)}%`}
        </span>
      ),
    },
    {
      title: 'Avg Grade Given',
      key: 'gradeDistributionMean',
      align: 'right',
      sorter: (a, b) => (a.gradeDistributionMean ?? -1) - (b.gradeDistributionMean ?? -1),
      render: (_, r) => (
        <span className="tabular-nums">
          {r.gradeDistributionMean === null ? '—' : r.gradeDistributionMean.toFixed(1)}
        </span>
      ),
    },
  ];

  return (
    <Card className="h-full" data-testid="ta-ops-table">
      <CardHeader>TA Operations</CardHeader>
      <Table<TaOpsRow>
        rowKey="taId"
        size="small"
        pagination={false}
        dataSource={rows}
        columns={columns}
        scroll={{ x: true, y: 340 }}
        locale={{ emptyText: 'No TAs yet.' }}
      />
    </Card>
  );
};

export default TAOpsTable;
