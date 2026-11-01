import { useEffect, useRef, useState } from 'react';
import { IconUserShare } from '@tabler/icons-react';
import { useViewAs } from '~/hooks/useViewAs';
import { BTN_PRIMARY_XS, BTN_XS } from '~/components/ui';

/**
 * "View as" with a small confirm step that takes an optional reason. The
 * reason goes into the platform audit row, so the activity log says why.
 */
export const ViewAsButton = ({
  userId,
  name,
  classroomSlug,
  label = 'View as',
  primary = false,
}: {
  userId: string;
  name: string;
  classroomSlug?: string;
  label?: string;
  primary?: boolean;
}) => {
  const { viewAs, pendingId, error, adminId } = useViewAs();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const isSelf = adminId === userId;
  const busy = pendingId === userId;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-flex" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={isSelf || pendingId !== null}
        title={isSelf ? 'This is you' : `Sign in to Classmoji as ${name}`}
        className={primary ? BTN_PRIMARY_XS : BTN_XS}
      >
        <IconUserShare size={14} />
        {busy ? 'Starting…' : label}
      </button>
      {open ? (
        <form
          className="absolute right-0 top-full mt-1 z-30 w-72 rounded-xl bg-panel ring-1 ring-line shadow-lg p-3 text-left"
          onSubmit={e => {
            e.preventDefault();
            setOpen(false);
            void viewAs({ userId, classroomSlug, reason });
          }}
        >
          <p className="text-xs text-ink-2">
            View Classmoji as <b className="text-ink-0">{name}</b> for up to an hour. This is
            recorded in the activity log.
          </p>
          <label htmlFor={`reason-${userId}`} className="block mt-2 text-[11px] text-ink-3">
            Reason (optional)
          </label>
          <input
            id={`reason-${userId}`}
            autoFocus
            value={reason}
            maxLength={200}
            onChange={e => setReason(e.target.value)}
            placeholder="e.g. quiz won't publish"
            className="mt-1 w-full rounded-md border border-line bg-panel px-2 py-1 text-xs text-ink-0 focus:outline-none focus:border-line-strong"
          />
          <div className="mt-2.5 flex justify-end gap-2">
            <button type="button" onClick={() => setOpen(false)} className={BTN_XS}>
              Cancel
            </button>
            <button type="submit" className={BTN_PRIMARY_XS}>
              Start
            </button>
          </div>
        </form>
      ) : null}
      {error && !busy ? (
        <span role="alert" className="absolute right-0 top-full mt-1 text-[11px] text-red-600 dark:text-red-400 whitespace-nowrap">
          {error}
        </span>
      ) : null}
    </div>
  );
};
