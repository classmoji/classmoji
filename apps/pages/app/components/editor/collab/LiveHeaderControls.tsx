import { IconCloudCheck, IconCloudOff, IconRefresh } from '@tabler/icons-react';

import { SYNC_STATUS_LABEL, initialsOf, type CollabPeer, type SyncStatus } from '~/utils/collab.ts';

/** Avatars shown before the rest collapse into "+N". */
const MAX_AVATARS = 4;

export interface LiveHeaderControlsProps {
  peers: CollabPeer[];
  syncStatus: SyncStatus;
  /** Null while the editor cannot ask for a version (refused, not synced). */
  onSaveVersion: (() => void) | null;
  savingVersion: boolean;
}

const statusStyle: Record<SyncStatus, string> = {
  synced: 'text-green-600 dark:text-green-400',
  syncing: 'text-gray-500 dark:text-gray-400',
  offline: 'text-amber-600 dark:text-amber-400',
};

function StatusIcon({ status }: { status: SyncStatus }) {
  if (status === 'synced') return <IconCloudCheck size={16} aria-hidden />;
  if (status === 'offline') return <IconCloudOff size={16} aria-hidden />;
  return <IconRefresh size={16} className="animate-spin" aria-hidden />;
}

/**
 * The live editor's header controls: who is on the page, whether this
 * browser's edits have reached the server, and "Save version".
 */
const LiveHeaderControls = ({
  peers,
  syncStatus,
  onSaveVersion,
  savingVersion,
}: LiveHeaderControlsProps) => {
  const shown = peers.slice(0, MAX_AVATARS);
  const hidden = peers.slice(MAX_AVATARS);

  return (
    <div className="flex items-center gap-3 text-sm" data-testid="live-header-controls">
      {peers.length > 0 && (
        <div className="flex -space-x-1.5" data-testid="live-peers">
          {shown.map(peer => (
            <span
              key={peer.key}
              title={peer.self ? `${peer.name} (you)` : peer.name}
              aria-label={peer.self ? `${peer.name} (you)` : peer.name}
              className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-white dark:ring-[#191919]"
              style={{ backgroundColor: peer.color }}
            >
              {initialsOf(peer.name)}
            </span>
          ))}
          {hidden.length > 0 && (
            <span
              title={hidden.map(peer => peer.name).join(', ')}
              className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-gray-200 px-1 text-[10px] font-semibold text-gray-700 ring-2 ring-white dark:bg-neutral-700 dark:text-gray-200 dark:ring-[#191919]"
            >
              +{hidden.length}
            </span>
          )}
        </div>
      )}

      <span
        className={`flex items-center gap-1 ${statusStyle[syncStatus]}`}
        data-testid="live-sync-status"
        data-status={syncStatus}
      >
        <StatusIcon status={syncStatus} />
        {SYNC_STATUS_LABEL[syncStatus]}
      </span>

      {onSaveVersion && (
        <button
          type="button"
          onClick={onSaveVersion}
          disabled={savingVersion}
          className="px-2.5 py-1 text-sm font-medium rounded transition-colors text-gray-700 ring-1 ring-gray-300 hover:bg-gray-100 disabled:opacity-60 disabled:cursor-not-allowed dark:text-gray-200 dark:ring-neutral-600 dark:hover:bg-neutral-800"
        >
          {savingVersion ? 'Saving version…' : 'Save version'}
        </button>
      )}
    </div>
  );
};

export default LiveHeaderControls;
