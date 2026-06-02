import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { motion, AnimatePresence } from 'framer-motion';
import { IconGithub } from '@classmoji/ui-components';
import { ClassMark } from './ClassMark';
import { RoleChip } from './RoleChip';
import type { LandingClass } from './types';
import { useClassroomStatusModals } from '~/utils/classroomStatusModals';

interface ClassroomCardProps {
  c: LandingClass;
  onOpen: () => void;
  showSlug?: boolean;
  onPinChanged?: (id: string, pin_order: number | null) => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLDivElement>) => void;
}

function PinIcon({ filled, size = 14 }: { filled: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? '#f59e0b' : 'none'}
      stroke={filled ? '#f59e0b' : 'currentColor'}
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2l2.94 5.95L21 8.95l-4.5 4.39 1.06 6.18L12 16.5l-5.56 2.92 1.06-6.18L3 8.95l6.06-.94L12 2z" />
    </svg>
  );
}

export function ClassroomCard({
  c,
  onOpen,
  showSlug = false,
  onPinChanged,
  draggable = false,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ClassroomCardProps) {
  const roleVerb =
    c.role === 'OWNER' || c.role === 'ASSISTANT'
      ? 'To grade'
      : c.role === 'STUDENT'
        ? 'Open'
        : 'Pending';

  const pinFetcher = useFetcher<{ pin_order: number | null }>();
  const [hover, setHover] = useState(false);
  const lastPinStateRef = useRef<typeof pinFetcher.state>('idle');

  const isPinned = c.pin_order != null;
  const canPin = c.role !== 'PENDING INVITE';

  useEffect(() => {
    if (
      pinFetcher.state === 'idle' &&
      lastPinStateRef.current !== 'idle' &&
      pinFetcher.data
    ) {
      onPinChanged?.(c.id, pinFetcher.data.pin_order);
    }
    lastPinStateRef.current = pinFetcher.state;
  }, [pinFetcher.state, pinFetcher.data, c.id, onPinChanged]);

  const handlePinClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pinFetcher.state !== 'idle') return;
    pinFetcher.submit(JSON.stringify({ role: c.membershipRole }), {
      method: 'POST',
      action: `/api/classrooms/${c.classroomId}/pin`,
      encType: 'application/json',
    });
  };

  const fetcher = pinFetcher;
  const { showUnpublished } = useClassroomStatusModals();

  const blockedUnpublished = c.status === 'UNPUBLISHED' && c.membershipRole !== 'OWNER';
  const handleOpenGuarded = () => {
    if (blockedUnpublished) {
      showUnpublished();
      return;
    }
    onOpen();
  };

  return (
    <div
      onClick={handleOpenGuarded}
      role="button"
      tabIndex={0}
      data-onboarding={
        c.role === 'PENDING INVITE'
          ? 'pending-invite'
          : c.is_example
            ? 'example-course'
            : undefined
      }
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleOpenGuarded();
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={`relative rounded-2xl p-4 flex flex-col gap-2.5 min-h-[150px] bg-panel ring-1 ring-line hover:ring-stone-300 dark:hover:ring-neutral-700 hover:shadow-sm transition-all duration-150 ${draggable ? 'cursor-grab' : 'cursor-pointer'} ${fetcher.state !== 'idle' ? 'opacity-70' : ''}`}
      style={{ borderLeft: '3px solid var(--accent)' }}
    >
      <div className="flex items-start gap-2.5">
        <ClassMark hue={c.hue} name={c.name} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-ink-0 tracking-tight truncate">
            {c.name}
          </div>
          {showSlug && (
            <div
              className="text-xs text-ink-4 mt-px truncate"
              style={{ fontFamily: 'var(--font-mono)' }}
              title={c.slug}
            >
              {c.slug}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <AnimatePresence initial={false}>
            {canPin && (hover || isPinned) && (
              <motion.button
                key="pin-btn"
                type="button"
                aria-label={isPinned ? 'Unpin classroom' : 'Pin classroom'}
                title={isPinned ? 'Unpin' : 'Pin'}
                onClick={handlePinClick}
                initial={{ opacity: 0, scale: 0.5, rotate: -90 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                exit={{ opacity: 0, scale: 0.5, rotate: 90 }}
                whileHover={{ scale: 1.2, rotate: 15 }}
                whileTap={{ scale: 0.8, rotate: -15 }}
                transition={{ type: 'spring', stiffness: 200, damping: 15 }}
                className={`border-none bg-transparent cursor-pointer p-2 -m-1.5 rounded-lg inline-flex items-center justify-center ${isPinned ? 'text-amber-500' : 'text-ink-4 hover:text-amber-400'}`}
              >
                <PinIcon filled={isPinned} />
              </motion.button>
            )}
          </AnimatePresence>
          {c.status === 'LOCKED' && (
            <span className="inline-flex items-center rounded-md bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200 ring-1 ring-amber-200 dark:ring-amber-800/50 px-2 py-0.5 text-xs font-medium">
              Read-only
            </span>
          )}
          {c.status === 'UNPUBLISHED' && (
            <span className="inline-flex items-center rounded-md bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 ring-1 ring-gray-200 dark:ring-gray-700 px-2 py-0.5 text-xs font-medium">
              Unpublished
            </span>
          )}
          <RoleChip role={c.role} />
        </div>
      </div>

      {c.subtitle && (
        <div className="text-xs text-ink-3 leading-relaxed -mt-0.5">
          {c.subtitle}
        </div>
      )}

      <div className="flex gap-3.5 pt-2.5 mt-auto">
        <div className="flex flex-col gap-px text-xs">
          <span className="text-ink-4 whitespace-nowrap">Roster</span>
          <span className="text-xs font-medium text-ink-0">
            {c.students}
          </span>
        </div>
        <div className="flex flex-col gap-px text-xs">
          <span className="text-ink-4 whitespace-nowrap">{roleVerb}</span>
          <span
            className="text-xs font-medium"
            style={{
              color:
                c.pending === 0 ? 'var(--ink-3)' : c.role === 'STUDENT' ? 'var(--ink-0)' : 'var(--ink-0)',
            }}
          >
            {c.pending}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-ink-4">
        <IconGithub size={12} />
        <span style={{ fontFamily: 'var(--font-mono)' }}>main</span>
        <span className="w-1 h-1 rounded-full bg-gray-300 dark:bg-gray-600 inline-block" />
        <span>updated {c.updated}</span>
      </div>
    </div>
  );
}
