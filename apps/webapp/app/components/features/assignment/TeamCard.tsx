import type { TeamData } from './assignmentTypes';

interface TeamCardProps {
  team: TeamData;
}

/**
 * Ported from redesign (assignments.jsx:274-289).
 */
export function TeamCard({ team }: TeamCardProps) {
  if (!team.members.length) return null;
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="caps" style={{ marginBottom: 8 }}>
        Team
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {team.members.map((m, i) => (
          <div
            key={`${m.initials}-${i}`}
            style={{ display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <span
              className="avatar"
              style={{
                background: `linear-gradient(135deg, oklch(80% 0.1 ${m.hue}), oklch(62% 0.18 ${m.hue}))`,
                width: 22,
                height: 22,
                fontSize: 9,
              }}
            >
              {m.initials}
            </span>
            <span style={{ fontSize: 12.5 }}>{m.name}</span>
            <div style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
              {m.linesChanged} lines
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
