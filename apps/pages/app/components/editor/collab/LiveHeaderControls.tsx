import { useEffect, useState } from 'react';
import {
  IconBrandGithub,
  IconCloudCheck,
  IconCloudOff,
  IconRefresh,
  IconSparkles,
} from '@tabler/icons-react';

import {
  SYNC_STATUS_LABEL,
  initialsOf,
  peerLabel,
  savedToGitHubAnnouncement,
  savedToGitHubStatus,
  type CollabPeer,
  type LiveCheckpoint,
  type SyncStatus,
} from '~/utils/collab.ts';
import { useDisplayedSyncStatus } from '~/hooks/useDisplayedSyncStatus.ts';

import SaveVersionPopover from './SaveVersionPopover.tsx';

/** Avatars shown before the rest collapse into "+N". */
const MAX_AVATARS = 4;
/** The floating indicator of an embed has less room. */
const MAX_AVATARS_COMPACT = 3;

export interface LiveHeaderControlsProps {
  peers: CollabPeer[];
  syncStatus: SyncStatus;
  /** The last checkpoint covering this page (null before anything is known). */
  checkpoint?: LiveCheckpoint | null;
  /** The page has changed since that checkpoint. */
  editsSince?: boolean;
  /**
   * Save a version, with an optional note (the checkpoint's message). Null
   * while the editor cannot ask for one (refused, not synced).
   */
  onSaveVersion: ((message?: string) => void) | null;
  savingVersion: boolean;
  /** The floating indicator of an embedded editor: smaller, same contents. */
  compact?: boolean;
}

const statusStyle: Record<SyncStatus, string> = {
  synced: 'text-green-600 dark:text-green-400',
  syncing: 'text-gray-500 dark:text-gray-400',
  offline: 'text-amber-600 dark:text-amber-400',
};

function StatusIcon({ status }: { status: SyncStatus }) {
  if (status === 'synced') return <IconCloudCheck size={16} aria-hidden />;
  if (status === 'offline') return <IconCloudOff size={16} aria-hidden />;
  return <IconRefresh size={16} className="motion-safe:animate-spin" aria-hidden />;
}

/** Re-render every `ms` so a relative time stays true. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return now;
}

/** One person (or agent) on the page. */
export function PeerAvatar({ peer }: { peer: CollabPeer }) {
  const label = peerLabel(peer);
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      data-agent={peer.agent ? 'true' : undefined}
      className="relative inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold text-white ring-2 ring-white dark:ring-[#191919]"
      style={{ backgroundColor: peer.color }}
    >
      <span aria-hidden>{initialsOf(peer.name)}</span>
      {peer.agent && (
        <span
          aria-hidden
          className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-violet-600 text-white ring-2 ring-white dark:bg-violet-500 dark:ring-[#191919]"
        >
          <IconSparkles size={9} stroke={2.5} />
        </span>
      )}
    </span>
  );
}

/**
 * The live editor's header controls: who is on the page, whether this
 * browser's edits have reached the server, whether the page is saved to
 * GitHub, and "Save version".
 */
const LiveHeaderControls = ({
  peers,
  syncStatus,
  checkpoint = null,
  editsSince = false,
  onSaveVersion,
  savingVersion,
  compact = false,
}: LiveHeaderControlsProps) => {
  const max = compact ? MAX_AVATARS_COMPACT : MAX_AVATARS;
  const shown = peers.slice(0, max);
  const hidden = peers.slice(max);
  const now = useNow(30_000);
  const saved = savedToGitHubStatus(checkpoint, now, editsSince);
  // Announced on its own, without the relative time: the visible line
  // re-renders on the clock, and a screen reader must not hear every tick.
  const savedAnnouncement = savedToGitHubAnnouncement(saved);
  // Debounced for display only: a keystroke's round trip never flashes it.
  const shownStatus = useDisplayedSyncStatus(syncStatus);

  return (
    <div
      className={`flex items-center ${compact ? 'gap-2 text-xs' : 'gap-3 text-sm'}`}
      data-testid="live-header-controls"
    >
      {shown.length > 0 && (
        <div className="flex -space-x-1.5" data-testid="live-peers">
          {shown.map(peer => (
            <PeerAvatar key={peer.key} peer={peer} />
          ))}
          {hidden.length > 0 && (
            <span
              role="img"
              aria-label={hidden.map(peerLabel).join(', ')}
              title={hidden.map(peerLabel).join(', ')}
              className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-gray-200 px-1 text-[10px] font-semibold text-gray-700 ring-2 ring-white dark:bg-neutral-700 dark:text-gray-200 dark:ring-[#191919]"
            >
              +{hidden.length}
            </span>
          )}
        </div>
      )}

      <span
        role="status"
        aria-live="polite"
        className={`flex items-center gap-1 ${statusStyle[shownStatus]}`}
        data-testid="live-sync-status"
        data-status={shownStatus}
      >
        <StatusIcon status={shownStatus} />
        {SYNC_STATUS_LABEL[shownStatus]}
      </span>

      <span role="status" aria-live="polite" className="sr-only">
        {savedAnnouncement}
      </span>
      {saved && (
        <span
          title={saved.title}
          data-testid="live-saved-status"
          data-tone={saved.tone}
          data-edits-since={saved.editsSince ? 'true' : undefined}
          className={`flex items-center gap-1 ${
            saved.tone === 'saved'
              ? 'text-gray-500 dark:text-gray-400'
              : 'text-amber-600 dark:text-amber-400'
          } ${compact ? 'hidden sm:flex' : ''}`}
        >
          <IconBrandGithub size={compact ? 12 : 14} aria-hidden />
          {saved.label}
        </span>
      )}

      {onSaveVersion && (
        <SaveVersionPopover
          onSave={message => onSaveVersion(message || undefined)}
          saving={savingVersion}
          compact={compact}
        />
      )}
    </div>
  );
};

export default LiveHeaderControls;
