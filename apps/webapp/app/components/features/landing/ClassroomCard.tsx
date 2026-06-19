import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { motion, AnimatePresence } from 'framer-motion';
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
  const pinFetcher = useFetcher<{ pin_order: number | null }>();
  const [hover, setHover] = useState(false);
  const [avatarError, setAvatarError] = useState(false);
  const lastPinStateRef = useRef<typeof pinFetcher.state>('idle');

  const isPinned = c.pin_order != null;
  const canPin = c.role !== 'PENDING INVITE';

  useEffect(() => {
    if (pinFetcher.state === 'idle' && lastPinStateRef.current !== 'idle' && pinFetcher.data) {
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
        c.role === 'PENDING INVITE' ? 'pending-invite' : c.is_example ? 'example-course' : undefined
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
      className={`relative rounded-lg overflow-hidden flex flex-col w-[373px] h-[173px] bg-panel ring-1 ring-stone-200 dark:ring-neutral-700 hover:ring-stone-300 dark:hover:ring-neutral-600 hover:shadow-sm transition-all duration-150 ${draggable ? 'cursor-grab' : 'cursor-pointer'} ${fetcher.state !== 'idle' ? 'opacity-70' : ''}`}
    >
      {/* Colored top strip */}
      <div className="h-1.5 w-full shrink-0" style={{ backgroundColor: 'var(--accent)' }} />

      {/* Body */}
      <div className="flex-1 p-4 flex flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-base font-bold text-ink-0 tracking-tight truncate">{c.name}</div>
            <div className="text-sm text-ink-3 mt-0.5 truncate" title={c.githubOrg}>
              @{c.githubOrg}
            </div>
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

            {/* Organization avatar (falls back to the ClassMark) */}
            {c.avatar && !avatarError ? (
              <img
                src={c.avatar}
                alt=""
                onError={() => setAvatarError(true)}
                className="w-10 h-10 rounded-full object-cover ring-1 ring-line bg-panel-tint"
              />
            ) : (
              <ClassMark hue={c.hue} name={c.name} size={40} />
            )}
          </div>
        </div>

        {showSlug && c.subtitle && (
          <div className="text-sm text-ink-3 leading-relaxed mt-2">{c.subtitle}</div>
        )}

        {/* Bottom row: role + status chips */}
        <div className="mt-auto pt-4 flex items-center gap-2">
          <RoleChip role={c.role} />
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
        </div>
      </div>
    </div>
  );
}
