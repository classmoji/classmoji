import type { ActivityData } from './assignmentTypes';

interface ActivityCardProps {
  activity: ActivityData;
}

/**
 * Ported from redesign (assignments.jsx:290-300).
 */
export function ActivityCard({ activity }: ActivityCardProps) {
  if (!activity.commits.length) return null;
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="caps" style={{ marginBottom: 8 }}>
        Activity
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {activity.commits.map((c, i) => (
          <div key={`${c.sha}-${i}`} style={{ fontSize: 11.5 }}>
            <div style={{ fontWeight: 500 }}>{c.msg}</div>
            <div className="mono" style={{ color: 'var(--ink-3)' }}>
              {c.sha} · {c.time}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
