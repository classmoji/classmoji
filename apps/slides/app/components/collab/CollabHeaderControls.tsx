import { useEffect, useRef, useState } from 'react';
import { Tooltip } from 'antd';
import {
  IconBrandGithub,
  IconCloudCheck,
  IconCloudOff,
  IconLoader2,
  IconRefresh,
  IconSparkles,
} from '@tabler/icons-react';

import SaveVersionPopover from './SaveVersionPopover';
import { checkpointErrorReason } from './checkpointReason';

import {
  SYNC_STATUS_LABEL,
  initialsOf,
  peerLabel,
  savedToGitHubStatus,
  type LiveCheckpoint,
  type CollabPeer,
  type SyncStatus,
} from '~/utils/collab/collab';
import { useDisplayedSyncStatus } from '~/hooks/useDisplayedSyncStatus';

/** Avatars shown before the rest collapse into "+N". */
const MAX_AVATARS = 4;

/** What the header can show: the sync status, or that the first connection is still being made. */
type ShownStatus = SyncStatus | 'connecting';

const STATUS_LABEL: Record<ShownStatus, string> = {
  ...SYNC_STATUS_LABEL,
  connecting: 'Connecting',
} as Record<ShownStatus, string>;

const statusStyle: Record<ShownStatus, string> = {
  synced: 'text-green-600 dark:text-green-400',
  syncing: 'text-gray-500 dark:text-gray-400',
  connecting: 'text-gray-500 dark:text-gray-400',
  offline: 'text-amber-600 dark:text-amber-400',
};

function StatusIcon({ status }: { status: ShownStatus }) {
  if (status === 'synced') return <IconCloudCheck size={16} aria-hidden />;
  if (status === 'offline') return <IconCloudOff size={16} aria-hidden />;
  if (status === 'connecting') {
    return <IconLoader2 size={16} className="motion-safe:animate-spin" aria-hidden />;
  }
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

export function PeerAvatar({
  peer,
  size = 'md',
}: {
  peer: Pick<CollabPeer, 'name' | 'color'> & { self?: boolean; agent?: boolean; agentTag?: string };
  size?: 'sm' | 'md';
}) {
  const label = peerLabel({
    name: peer.name,
    agent: peer.agent ?? false,
    self: peer.self,
    ...(peer.agentTag ? { agentTag: peer.agentTag } : {}),
  });
  return (
    <span
      role="img"
      title={label}
      aria-label={label}
      className={`relative inline-flex items-center justify-center rounded-full font-semibold text-white ring-2 ring-white dark:ring-gray-900 ${
        size === 'sm' ? 'h-5 w-5 text-[9px]' : 'h-6 w-6 text-[10px]'
      }`}
      style={{ backgroundColor: peer.color }}
      data-agent={peer.agent ? 'true' : undefined}
    >
      {initialsOf(peer.name)}
      {peer.agent && (
        <span
          className="absolute -bottom-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-violet-600 text-white ring-2 ring-white dark:bg-violet-500 dark:ring-gray-900"
          aria-hidden
        >
          <IconSparkles size={9} stroke={2.5} />
        </span>
      )}
    </span>
  );
}

/**
 * What the saved line announces: only a new checkpoint outcome (saved, or
 * not saved), never the relative time re-rendering, and nothing on load.
 */
function useSavedAnnouncement(
  checkpoint: LiveCheckpoint | null,
  tone: 'saved' | 'unsaved' | null
): string {
  const key = checkpoint
    ? `${checkpoint.at}|${checkpoint.commit ?? ''}|${checkpoint.error ?? ''}`
    : '';
  // `count` alternates a trailing no-break space, so the same outcome twice
  // in a row is still a change the live region announces.
  const [announcement, setAnnouncement] = useState({ text: '', count: 0 });
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!tone) return;
    if (lastKey.current === null) {
      lastKey.current = key;
      return;
    }
    if (lastKey.current === key) return;
    lastKey.current = key;
    const text = tone === 'saved' ? 'Saved to GitHub' : 'Not saved to GitHub yet';
    setAnnouncement(current => ({ text, count: current.count + 1 }));
  }, [key, tone]);
  return announcement.text + (announcement.count % 2 === 1 ? '\u00a0' : '');
}

/**
 * The live deck's header controls: who is in the deck, whether this
 * browser's edits have reached the server, and "Save version".
 */
export default function CollabHeaderControls({
  peers,
  syncStatus,
  checkpoint = null,
  onSaveVersion,
  savingVersion,
}: {
  peers: CollabPeer[];
  /** `connecting` while the first connection is being made (nothing is wrong yet). */
  syncStatus: ShownStatus;
  /** The last checkpoint covering this deck (null before anything is known). */
  checkpoint?: LiveCheckpoint | null;
  /** Null while a version cannot be asked for (refused, not synced). */
  onSaveVersion: ((message: string) => void) | null;
  savingVersion: boolean;
}) {
  const now = useNow(30_000);
  const saved = savedToGitHubStatus(checkpoint, now);
  const savedTitle = checkpoint?.error ? checkpointErrorReason(checkpoint.error) : saved?.title;
  const savedAnnouncement = useSavedAnnouncement(checkpoint, saved?.tone ?? null);
  // Debounced for display only: a keystroke's round trip never flashes it.
  // The first connection shows as it is, never as offline.
  const debounced = useDisplayedSyncStatus(syncStatus === 'connecting' ? 'syncing' : syncStatus);
  const shownStatus: ShownStatus = syncStatus === 'connecting' ? 'connecting' : debounced;
  const shown = peers.slice(0, MAX_AVATARS);
  const hidden = peers.slice(MAX_AVATARS);

  return (
    <div className="flex items-center gap-3 text-sm" data-testid="live-header-controls">
      {peers.length > 0 && (
        <div className="flex -space-x-1.5" data-testid="live-peers">
          {shown.map(peer => (
            <PeerAvatar key={peer.key} peer={peer} />
          ))}
          {hidden.length > 0 && (
            <span
              role="img"
              aria-label={hidden.map(peer => peerLabel(peer)).join(', ')}
              title={hidden.map(peer => peerLabel(peer)).join(', ')}
              className="inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-gray-200 px-1 text-[10px] font-semibold text-gray-700 ring-2 ring-white dark:bg-gray-700 dark:text-gray-200 dark:ring-gray-900"
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
        {STATUS_LABEL[shownStatus]}
      </span>

      {saved && (
        // Below md the line is its icon (the label stays for screen readers
        // and in the tooltip, which focus and a tap open too); its relative
        // time is never a live region.
        <Tooltip
          title={savedTitle ? `${saved.label} · ${savedTitle}` : saved.label}
          trigger={['hover', 'focus', 'click']}
        >
          <span
            tabIndex={0}
            data-testid="live-saved-status"
            data-tone={saved.tone}
            className={`flex items-center gap-1 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400 ${
              saved.tone === 'saved'
                ? 'text-gray-500 dark:text-gray-400'
                : 'text-amber-600 dark:text-amber-400'
            }`}
          >
            <IconBrandGithub size={14} aria-hidden />
            <span className="sr-only md:not-sr-only">{saved.label}</span>
            {savedTitle && <span className="sr-only">{`: ${savedTitle}`}</span>}
          </span>
        </Tooltip>
      )}
      <span className="sr-only" role="status" aria-live="polite" data-testid="live-saved-announce">
        {savedAnnouncement}
      </span>

      {onSaveVersion && <SaveVersionPopover onSave={onSaveVersion} saving={savingVersion} />}
    </div>
  );
}
