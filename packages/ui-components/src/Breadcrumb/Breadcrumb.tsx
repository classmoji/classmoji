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
      className="crumbs"
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '14px 22px 10px',
        fontSize: 12.5,
        color: 'var(--ink-2)',
        gap: 6,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--accent)',
        }}
        aria-hidden="true"
      />
      <span style={{ color: 'var(--ink-2)' }}>{classroomSlug}</span>
      {trail.map((t, i) => (
        <Fragment key={`${i}-${t}`}>
          <span style={{ color: 'var(--ink-4)' }}>/</span>
          <span
            style={{
              color: i === trail.length - 1 ? 'var(--ink-0)' : 'var(--ink-2)',
              fontWeight: i === trail.length - 1 ? 600 : 400,
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
