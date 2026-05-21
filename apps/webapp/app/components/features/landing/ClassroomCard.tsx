import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { motion, AnimatePresence } from 'framer-motion';
import { IconGithub } from '@classmoji/ui-components';
import { ClassMark } from './ClassMark';
import { RoleChip } from './RoleChip';
import type { LandingClass } from './types';
import { showUnpublishedModal } from '~/utils/classroomStatusModals';

interface ClassroomCardProps {
  c: LandingClass;
  onOpen: () => void;
  showSlug?: boolean;
  /** Called after the pin endpoint responds with the new pin_order. */
  onPinChanged?: (id: string, pin_order: number | null) => void;
  /** Drag handlers — supplied only inside the Pinned section. */
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragEnd?: (e: React.DragEvent<HTMLDivElement>) => void;
}

function PinIcon({ filled, size = 14 }: { filled: boolean; size?: number }) {
  // Simple inline pin icon; switches between filled (pinned) and outline.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 2 L15 8 L21 9 L17 13 L18 20 L12 17 L6 20 L7 13 L3 9 L9 8 Z" />
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
  // Pinning is a personal organization feature — available to all roles
  // except pending invites.
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

  const fetcher = pinFetcher; // alias used downstream for opacity styling

  const blockedUnpublished = c.status === 'UNPUBLISHED' && c.role !== 'OWNER';
  const handleOpenGuarded = () => {
    if (blockedUnpublished) {
      showUnpublishedModal();
      return;
    }
    onOpen();
  };

  return (
    <div
      onClick={handleOpenGuarded}
      role="button"
      tabIndex={0}
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
      style={{
        position: 'relative',
        background: 'var(--bg-1)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        padding: '14px 14px 12px',
        cursor: draggable ? 'grab' : 'pointer',
        transition: 'border-color 120ms, background 120ms, opacity 120ms',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        minHeight: 150,
        opacity: fetcher.state !== 'idle' ? 0.7 : 1,
      }}
      onMouseEnter={e => {
        setHover(true);
        e.currentTarget.style.borderColor = 'var(--line-strong)';
        e.currentTarget.style.background = 'var(--panel-hover)';
      }}
      onMouseLeave={e => {
        setHover(false);
        e.currentTarget.style.borderColor = 'var(--line)';
        e.currentTarget.style.background = 'var(--bg-1)';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <ClassMark hue={c.hue} name={c.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--ink-0)',
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {c.name}
          </div>
          {showSlug && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--ink-3)',
                marginTop: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={c.slug}
            >
              {c.slug}
            </div>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}
        >
          <AnimatePresence initial={false}>
            {canPin && (hover || isPinned) && (
              <motion.button
                key="pin-btn"
                type="button"
                aria-label={isPinned ? 'Unpin classroom' : 'Pin classroom'}
                title={isPinned ? 'Unpin' : 'Pin'}
                onClick={handlePinClick}
                initial={{ opacity: 0, scale: 0.6, width: 0 }}
                animate={{
                  opacity: 1,
                  scale: 1,
                  width: 'auto',
                  rotate: isPinned ? -18 : 0,
                }}
                exit={{ opacity: 0, scale: 0.6, width: 0 }}
                whileHover={{ scale: 1.15 }}
                whileTap={{ scale: 0.85, rotate: isPinned ? 0 : -18 }}
                transition={{ type: 'spring', stiffness: 600, damping: 22 }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: isPinned ? 'var(--accent)' : 'var(--ink-3)',
                  cursor: 'pointer',
                  padding: 2,
                  borderRadius: 4,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  overflow: 'hidden',
                }}
              >
                <PinIcon filled={isPinned} />
              </motion.button>
            )}
          </AnimatePresence>
          {c.status === 'LOCKED' && (
            <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200 px-2 py-0.5 text-xs">
              Read-only
            </span>
          )}
          {c.status === 'UNPUBLISHED' && (
            <span className="inline-flex items-center rounded-full bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300 px-2 py-0.5 text-xs">
              Unpublished
            </span>
          )}
          <RoleChip role={c.role} />
        </div>
      </div>

      {c.subtitle && (
        <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.4, marginTop: -2 }}>
          {c.subtitle}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          gap: 14,
          paddingTop: 10,
          borderTop: '1px solid var(--line)',
          marginTop: 'auto',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, fontSize: 11 }}>
          <span style={{ color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>Roster</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              color: 'var(--ink-0)',
              fontWeight: 500,
            }}
          >
            {c.students}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, fontSize: 11 }}>
          <span style={{ color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{roleVerb}</span>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              fontWeight: 500,
              color:
                c.pending === 0 ? 'var(--ink-3)' : c.role === 'STUDENT' ? '#8a2a16' : '#1a6b3e',
            }}
          >
            {c.pending}
          </span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: 'var(--ink-3)',
        }}
      >
        <IconGithub size={12} />
        <span style={{ fontFamily: 'var(--font-mono)' }}>main</span>
        <span
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            background: 'var(--ink-4)',
            display: 'inline-block',
          }}
        />
        <span>updated {c.updated}</span>
      </div>
    </div>
  );
}
