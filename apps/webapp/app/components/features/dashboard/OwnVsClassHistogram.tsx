import { Card, Empty } from 'antd';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { CardHeader } from '~/components';
import { useDarkMode } from '~/hooks';

export interface GradeBucket {
  bucket: string;
  count: number;
}

interface OwnVsClassHistogramProps {
  yours: GradeBucket[];
  classroom: GradeBucket[];
}

// Class distribution stays a neutral gray so the two bar series never collide
// visually regardless of the user's accent choice. "Yours" is resolved at
// render time from the live accent (Recharts doesn't reliably resolve
// `var(--accent)` in SVG fill attributes).
const CLASS_COLOR = '#94a3b8';

function normalize(rows: GradeBucket[]): Map<string, number> {
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(r.bucket, total > 0 ? r.count / total : 0);
  }
  return out;
}

const OwnVsClassHistogram = ({ yours, classroom }: OwnVsClassHistogramProps) => {
  const { accent } = useDarkMode();
  const yoursMap = normalize(yours);
  const classMap = normalize(classroom);
  // Preserve order from `classroom` buckets (canonical), fall back to yours.
  const source = classroom.length > 0 ? classroom : yours;
  const data = source.map((r) => ({
    bucket: r.bucket,
    yours: Math.round((yoursMap.get(r.bucket) ?? 0) * 1000) / 10,
    classroom: Math.round((classMap.get(r.bucket) ?? 0) * 1000) / 10,
  }));
  const totalYours = yours.reduce((s, r) => s + r.count, 0);
  const totalClass = classroom.reduce((s, r) => s + r.count, 0);
  const isEmpty = totalYours === 0 && totalClass === 0;

  return (
    <Card className="h-full" data-testid="own-vs-class-histogram">
      <CardHeader>My Grades vs. Class</CardHeader>
      {isEmpty ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span className="text-gray-500 dark:text-gray-400">No grades yet.</span>
          }
        />
      ) : (
        <div style={{ height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
              <CartesianGrid stroke="#e5e7eb" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 11, fill: '#6b7280' }}
                axisLine={{ stroke: '#e5e7eb' }}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#6b7280' }}
                axisLine={{ stroke: '#e5e7eb' }}
                tickLine={false}
                tickFormatter={(v: number) => `${v}%`}
              />
              <Tooltip
                formatter={(v: number, name: string) => [
                  `${v.toFixed(1)}%`,
                  name === 'yours' ? 'Yours' : 'Classroom',
                ]}
                contentStyle={{ fontSize: 12 }}
              />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(v: string) => (v === 'yours' ? 'Yours' : 'Classroom')}
              />
              <Bar dataKey="yours" fill={accent} radius={[2, 2, 0, 0]} />
              <Bar dataKey="classroom" fill={CLASS_COLOR} radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
};

export default OwnVsClassHistogram;
