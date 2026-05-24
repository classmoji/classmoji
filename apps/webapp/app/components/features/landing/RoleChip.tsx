import type { LandingRole } from './types';

const ROLE_META: Record<LandingRole, { label: string; color: string; bg: string; border: string }> =
  {
    OWNER: { label: 'Owner', color: '#8a2a16', bg: '#fdecea', border: '#f7cfca' },
    ASSISTANT: { label: 'Assistant', color: '#1d4f8f', bg: '#e6effb', border: '#c9d9ee' },
    STUDENT: { label: 'Student', color: '#1a6b3e', bg: '#e3f3e8', border: '#c1dfcb' },
    'PENDING INVITE': {
      label: 'Pending invite',
      color: '#7a5b00',
      bg: '#fdf3d4',
      border: '#ecdda0',
    },
  };

export function RoleChip({ role }: { role: LandingRole }) {
  const m = ROLE_META[role];
  return (
    <span
      className="inline-flex items-center gap-1 text-[10.5px] font-semibold tracking-[0.04em] px-1.5 py-px rounded-full uppercase"
      style={{
        color: m.color,
        background: m.bg,
        border: `1px solid ${m.border}`,
      }}
    >
      {m.label}
    </span>
  );
}
