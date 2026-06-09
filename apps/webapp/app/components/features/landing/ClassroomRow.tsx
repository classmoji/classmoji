import { IconChevron } from '@classmoji/ui-components';
import { ClassMark } from './ClassMark';
import { RoleChip } from './RoleChip';
import type { LandingClass } from './types';

// Desktop table grid — 8 columns. Hidden below `sm`, where rows render as a
// stacked compact card instead so they fit a phone-width viewport.
const DESKTOP_COLS = 'sm:grid-cols-[36px_1.8fr_1fr_90px_110px_100px_110px_30px]';

export function ClassroomRowHeader() {
  return (
    <div
      className={`hidden sm:grid ${DESKTOP_COLS} items-center gap-4 px-3.5 py-2.5 border-b border-[var(--line)] bg-[var(--bg-2)] text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--ink-3)]`}
    >
      <span />
      <span>Class</span>
      <span>Description</span>
      <span>Role</span>
      <span>Roster</span>
      <span>Pending</span>
      <span>Updated</span>
      <span />
    </div>
  );
}

export function ClassroomRow({ c, onOpen }: { c: LandingClass; onOpen: () => void }) {
  return (
    <div
      onClick={onOpen}
      role="button"
      tabIndex={0}
      data-onboarding={
        c.role === 'PENDING INVITE'
          ? 'pending-invite'
          : c.is_example
            ? 'example-course'
            : undefined
      }
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="cursor-pointer border-b border-[var(--line)] text-[13px] transition-colors hover:bg-[var(--bg-2)]"
    >
      {/* Desktop: full 8-column table row */}
      <div className={`hidden sm:grid ${DESKTOP_COLS} items-center gap-4 px-3.5 py-2.5`}>
        <ClassMark hue={c.hue} name={c.name} />
        <div className="min-w-0">
          <div className="font-medium">{c.name}</div>
          <div className="font-mono text-[11.5px] text-[var(--ink-3)]">{c.slug}</div>
        </div>
        <div className="truncate text-[12.5px] text-[var(--ink-2)]">{c.subtitle || '—'}</div>
        <RoleChip role={c.role} />
        <div className="font-mono text-[12px] text-[var(--ink-1)]">
          {c.students} <span className="text-[var(--ink-3)]">students</span>
        </div>
        <div
          className="font-mono text-[12px]"
          style={{ color: c.pending ? 'var(--violet-ink)' : 'var(--ink-3)' }}
        >
          {c.pending || '—'}
        </div>
        <div className="text-[12px] text-[var(--ink-3)]">updated {c.updated}</div>
        <span className="inline-flex -rotate-90 text-[var(--ink-4)]">
          <IconChevron size={12} />
        </span>
      </div>

      {/* Mobile: stacked compact row (mark · name/slug/meta · chevron) */}
      <div className="grid grid-cols-[36px_1fr_auto] items-center gap-3 px-3.5 py-3 sm:hidden">
        <ClassMark hue={c.hue} name={c.name} />
        <div className="min-w-0">
          <div className="truncate font-medium">{c.name}</div>
          <div className="truncate font-mono text-[11.5px] text-[var(--ink-3)]">{c.slug}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <RoleChip role={c.role} />
            <span className="font-mono text-[11.5px] text-[var(--ink-3)]">
              {c.students} students
            </span>
            {c.pending ? (
              <span className="font-mono text-[11.5px] text-[var(--violet-ink)]">
                {c.pending} pending
              </span>
            ) : null}
          </div>
        </div>
        <span className="inline-flex -rotate-90 text-[var(--ink-4)]">
          <IconChevron size={12} />
        </span>
      </div>
    </div>
  );
}
