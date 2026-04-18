import { Fragment } from 'react';
import type { ReactNode } from 'react';

export interface BreadcrumbProps {
  classroomSlug: string;
  classroomHue?: number;
  trail: string[];
  action?: ReactNode;
}

/**
 * Topbar breadcrumb from the redesign bundle (shell.jsx:219-245).
 * Inline styles mirror the design source verbatim; we may Tailwind-ify later.
 */
export function Breadcrumb({
  classroomSlug,
  classroomHue = 285,
  trail,
  action,
}: BreadcrumbProps) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '10px 20px',
        fontSize: 13,
        color: 'var(--ink-2)',
        gap: 8,
        borderBottom: '1px solid var(--line)',
        background: 'var(--bg-1)',
        minHeight: 44,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: `linear-gradient(135deg, oklch(80% 0.11 ${classroomHue}), oklch(58% 0.18 ${classroomHue}))`,
        }}
      />
      <span style={{ color: 'var(--ink-1)', fontWeight: 500 }}>{classroomSlug}</span>
      {trail.map((t, i) => (
        <Fragment key={`${i}-${t}`}>
          <span style={{ color: 'var(--ink-4)' }}>/</span>
          <span
            style={{
              color: i === trail.length - 1 ? 'var(--ink-0)' : 'var(--ink-2)',
              fontWeight: i === trail.length - 1 ? 600 : 500,
            }}
          >
            {t}
          </span>
        </Fragment>
      ))}
      <div style={{ flex: 1 }} />
      {action}
    </div>
  );
}
