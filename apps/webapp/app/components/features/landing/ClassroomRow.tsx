import { useState } from 'react';
import { IconChevron } from '@classmoji/ui-components';
import { ClassMark } from './ClassMark';
import { RoleChip } from './RoleChip';
import type { LandingClass } from './types';

// Desktop table grid — 6 columns. Hidden below `sm`, where rows render as a
// stacked compact card instead so they fit a phone-width viewport.
const DESKTOP_COLS = 'sm:grid-cols-[36px_1.8fr_1fr_90px_110px_30px]';

// Org avatar (GitHub org image) with the initials ClassMark as fallback. Kept a
// rounded square so it slots in next to the ClassMark fallback seamlessly.
function RowMark({ c }: { c: LandingClass }) {
  const [errored, setErrored] = useState(false);
  if (c.avatar && !errored) {
    return (
      <img
        src={c.avatar}
        alt=""
        onError={() => setErrored(true)}
        className="h-7 w-7 rounded-md object-cover ring-1 ring-[var(--line)] bg-panel-tint"
      />
    );
  }
  return <ClassMark hue={c.hue} name={c.name} />;
}

export function ClassroomRowHeader() {
  return (
    <div
      className={`hidden sm:grid ${DESKTOP_COLS} items-center gap-4 px-3.5 py-2.5 border-b border-[var(--line)] bg-[var(--bg-2)] text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--ink-3)]`}
    >
      <span />
      <span>Class</span>
      <span>Description</span>
      <span>Role</span>
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
        c.role === 'PENDING INVITE' ? 'pending-invite' : c.is_example ? 'example-course' : undefined
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
        <RowMark c={c} />
        <div className="min-w-0">
          <div className="font-medium">{c.name}</div>
          <div className="font-mono text-[11.5px] text-[var(--ink-3)]">{c.slug}</div>
        </div>
        <div className="truncate text-[12.5px] text-[var(--ink-2)]">{c.subtitle || '—'}</div>
        <RoleChip role={c.role} />
        <div className="text-[12px] text-[var(--ink-3)]">updated {c.updated}</div>
        <span className="inline-flex -rotate-90 text-[var(--ink-4)]">
          <IconChevron size={12} />
        </span>
      </div>

      {/* Mobile: stacked compact row (mark · name/slug/meta · chevron) */}
      <div className="grid grid-cols-[36px_1fr_auto] items-center gap-3 px-3.5 py-3 sm:hidden">
        <RowMark c={c} />
        <div className="min-w-0">
          <div className="truncate font-medium">{c.name}</div>
          <div className="truncate font-mono text-[11.5px] text-[var(--ink-3)]">{c.slug}</div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            <RoleChip role={c.role} />
            <span className="font-mono text-[11.5px] text-[var(--ink-3)]">updated {c.updated}</span>
          </div>
        </div>
        <span className="inline-flex -rotate-90 text-[var(--ink-4)]">
          <IconChevron size={12} />
        </span>
      </div>
    </div>
  );
}
