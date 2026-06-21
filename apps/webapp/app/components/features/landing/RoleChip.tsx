import type { LandingRole } from './types';

const ROLE_CLASSES: Record<LandingRole, { label: string; classes: string }> = {
  OWNER: {
    label: 'Owner',
    classes: 'text-[#8a2a16] bg-[#fdecea] border-[#f7cfca] dark:text-red-300 dark:bg-red-950/30 dark:border-red-800/40',
  },
  ASSISTANT: {
    label: 'Assistant',
    classes: 'text-[#1d4f8f] bg-[#e6effb] border-[#c9d9ee] dark:text-blue-300 dark:bg-blue-950/30 dark:border-blue-800/40',
  },
  STUDENT: {
    label: 'Student',
    classes: 'text-[#1a6b3e] bg-[#e3f3e8] border-[#c1dfcb] dark:text-emerald-300 dark:bg-emerald-950/30 dark:border-emerald-800/40',
  },
  'PENDING INVITE': {
    label: 'Pending invite',
    classes: 'text-[#7a5b00] bg-[#fdf3d4] border-[#ecdda0] dark:text-amber-300 dark:bg-amber-950/30 dark:border-amber-800/40',
  },
};

export function RoleChip({ role }: { role: LandingRole }) {
  const m = ROLE_CLASSES[role];
  return (
    <span className={`inline-flex items-center justify-center leading-none text-xs font-semibold tracking-[0.04em] px-1.5 py-0.5 rounded-full uppercase border ${m.classes}`}>
      {m.label}
    </span>
  );
}
