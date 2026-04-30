import { useEffect, useRef, useState, useMemo } from 'react';
import { useFetcher, useNavigate } from 'react-router';
import { IconBell, IconX } from '@classmoji/ui-components';
import { notificationLink } from './notificationLinks';

export type NotificationRole = 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';

export interface BellNotification {
  id: string;
  type: string;
  title: string;
  resource_type: string;
  resource_id: string;
  read_at: string | null;
  created_at: string;
  classroom: { id: string; slug: string; name: string } | null;
  metadata: Record<string, unknown> | null;
}

interface Props {
  initialItems: BellNotification[];
  initialUnreadCount: number;
  membershipRoles: Record<string, NotificationRole[]>;
}

const iconBtn: React.CSSProperties = {
  width: 36,
  height: 36,
  borderRadius: 8,
  display: 'grid',
  placeItems: 'center',
  color: 'var(--ink-2)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  position: 'relative',
};

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

export function NotificationBell({ initialItems, initialUnreadCount, membershipRoles }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(initialItems);
  const [unread, setUnread] = useState(initialUnreadCount);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const readFetcher = useFetcher();
  const dismissFetcher = useFetcher();

  useEffect(() => {
    setItems(initialItems);
    setUnread(initialUnreadCount);
  }, [initialItems, initialUnreadCount]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const sorted = useMemo(
    () => [...items].sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)),
    [items]
  );

  const markRead = (ids: string[]) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    setItems(prev => {
      const newlyReadCount = prev.reduce(
        (acc, n) => acc + (idSet.has(n.id) && !n.read_at ? 1 : 0),
        0
      );
      setUnread(c => Math.max(0, c - newlyReadCount));
      return prev.map(n =>
        idSet.has(n.id) && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n
      );
    });
    readFetcher.submit(
      { ids: JSON.stringify(ids) },
      { method: 'post', action: '/api/notifications/read' }
    );
  };

  const markAllRead = () => {
    setItems(prev => prev.map(n => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })));
    setUnread(0);
    readFetcher.submit({ all: 'true' }, { method: 'post', action: '/api/notifications/read' });
  };

  const dismiss = (id: string) => {
    setItems(prev => {
      const target = prev.find(n => n.id === id);
      if (target && !target.read_at) setUnread(c => Math.max(0, c - 1));
      return prev.filter(n => n.id !== id);
    });
    dismissFetcher.submit(
      { ids: JSON.stringify([id]) },
      { method: 'post', action: '/api/notifications/dismiss' }
    );
  };

  const onRowClick = (n: BellNotification) => {
    if (!n.read_at) markRead([n.id]);
    const roles = n.classroom ? membershipRoles[n.classroom.id] : [];
    const url = notificationLink(n, roles);
    if (url) {
      setOpen(false);
      navigate(url);
    }
  };

  const onRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, n: BellNotification) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onRowClick(n);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        title="Notifications"
        style={iconBtn}
        onClick={() => setOpen(o => !o)}
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
      >
        <IconBell size={16} />
        {unread > 0 && (
          <span
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              minWidth: 16,
              height: 16,
              padding: '0 4px',
              borderRadius: 8,
              background: 'var(--violet)',
              color: 'white',
              fontSize: 10,
              fontWeight: 600,
              display: 'grid',
              placeItems: 'center',
              lineHeight: 1,
            }}
          >
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          style={{
            position: 'absolute',
            top: 'calc(100% + 8px)',
            right: 0,
            width: 'min(380px, calc(100vw - 24px))',
            maxHeight: 480,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--bg-1)',
            border: '1px solid var(--line)',
            borderRadius: 12,
            boxShadow: '0 12px 32px rgba(0,0,0,0.12)',
            zIndex: 50,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '12px 14px',
              borderBottom: '1px solid var(--line)',
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-0)' }}>
              Notifications
            </span>
            <button
              type="button"
              onClick={markAllRead}
              disabled={unread === 0}
              style={{
                background: 'transparent',
                border: 'none',
                color: unread === 0 ? 'var(--ink-3)' : 'var(--violet)',
                fontSize: 12,
                cursor: unread === 0 ? 'default' : 'pointer',
                padding: 0,
              }}
            >
              Mark all as read
            </button>
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {sorted.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--ink-3)' }}>
                <div style={{ fontWeight: 500, color: 'var(--ink-2)' }}>All caught up</div>
                <div style={{ fontSize: 12, marginTop: 4 }}>New activity will appear here.</div>
              </div>
            ) : (
              sorted.map(n => (
                <div
                  key={n.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onRowClick(n)}
                  onKeyDown={event => onRowKeyDown(event, n)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '8px 1fr auto',
                    columnGap: 10,
                    alignItems: 'flex-start',
                    padding: '10px 14px',
                    borderBottom: '1px solid var(--line)',
                    cursor: 'pointer',
                    background: n.read_at ? 'transparent' : 'var(--bg-2)',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: n.read_at ? 'transparent' : 'var(--violet)',
                      marginTop: 6,
                    }}
                  />
                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: n.read_at ? 400 : 600,
                        color: 'var(--ink-0)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {n.title}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--ink-3)', marginTop: 2 }}>
                      {n.classroom?.name ? `${n.classroom.name} | ` : ''}
                      {formatRelative(n.created_at)}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Dismiss"
                    onClick={e => {
                      e.stopPropagation();
                      dismiss(n.id);
                    }}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'var(--ink-3)',
                      cursor: 'pointer',
                      padding: 4,
                      fontSize: 14,
                      lineHeight: 1,
                    }}
                  >
                    <IconX size={14} />
                  </button>
                </div>
              ))
            )}
          </div>

          <div
            style={{
              borderTop: '1px solid var(--line)',
              padding: '8px 14px',
              textAlign: 'center',
            }}
          >
            <a
              href="/settings/notifications"
              style={{ fontSize: 12, color: 'var(--ink-2)', textDecoration: 'none' }}
              onClick={() => setOpen(false)}
            >
              Notification settings
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
