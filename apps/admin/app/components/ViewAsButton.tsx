import { IconUserShare } from '@tabler/icons-react';
import { useViewAs } from '~/hooks/useViewAs';
import { BTN_PRIMARY_XS, BTN_XS } from '~/components/ui';

/**
 * "View as": one click starts it. The platform audit row is still written
 * (`/api/view-as`), so the activity log shows who viewed as whom.
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
  const isSelf = adminId === userId;
  const busy = pendingId === userId;

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => void viewAs({ userId, classroomSlug })}
        disabled={isSelf || pendingId !== null}
        title={
          isSelf
            ? 'This is you'
            : `View Classmoji as ${name} for up to an hour (recorded in the activity log)`
        }
        className={primary ? BTN_PRIMARY_XS : BTN_XS}
      >
        <IconUserShare size={14} />
        {busy ? 'Starting…' : label}
      </button>
      {error && !busy ? (
        <span
          role="alert"
          className="absolute right-0 top-full mt-1 text-[11px] text-red-600 dark:text-red-400 whitespace-nowrap"
        >
          {error}
        </span>
      ) : null}
    </div>
  );
};
