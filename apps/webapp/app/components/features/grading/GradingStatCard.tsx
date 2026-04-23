interface GradingStatCardProps {
  label: string;
  value: string | number;
  color?: string;
}

export function GradingStatCard({ label, value, color = 'var(--ink-1)' }: GradingStatCardProps) {
  return (
    <div className="card" style={{ padding: 16 }}>
      <div className="caps">{label}</div>
      <div
        className="display"
        style={{
          fontSize: 28,
          fontWeight: 500,
          color,
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default GradingStatCard;
