import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createReactBlockSpec } from '@blocknote/react';
import { lockedSectionConfig, lockedSectionGuard } from '@classmoji/page-schema';

import { useSectionStats } from '~/hooks/useSectionStats.ts';

/**
 * A locked section in the EDITOR: the title is the block's `title` prop,
 * edited in a plain text field; the body is its children (BlockNote draws
 * those below, in the block group; page-sections.css tints them and rules
 * them off so the author sees what readers find locked). The config is the
 * shared one from @classmoji/page-schema.
 *
 * With unlock counts in context (OWNER/TEACHER), a chip on the right says how
 * many current students opened it; clicking it lists who and when.
 *
 * Readers never see this render: the in-app viewer draws its own
 * (viewer/sections/LockedSectionView.tsx) and the class site a static one.
 */
const lockedSectionImplementation = {
  render: (props: {
    block: { id: string; props: { title: string } };
    editor: LockedSectionEditorApi;
  }) => <LockedSectionEditor block={props.block} editor={props.editor} />,
};

/** The spec in the shared schema (the class site and the viewer start from it). */
export const LockedSection = createReactBlockSpec(
  lockedSectionConfig,
  lockedSectionImplementation as never
);

/**
 * The spec the page EDITOR runs (`editingSchema.ts`): the same block plus
 * `lockedSectionGuard`, which keeps the body under the lock while the author
 * edits (no key, block-type change or merge carries it out).
 */
export const EditorLockedSection = createReactBlockSpec(
  lockedSectionConfig,
  lockedSectionImplementation as never,
  [lockedSectionGuard()]
);

/** What the title field needs of the editor. */
export interface LockedSectionEditorApi {
  isEditable: boolean;
  updateBlock: (id: string, update: unknown) => unknown;
  getBlock: (id: string) => { id: string; children: Array<{ id: string }> } | undefined;
  setTextCursorPosition: (id: string, placement?: 'start' | 'end') => void;
  focus: () => void;
}

/**
 * Locked sections just inserted from the slash menu: their title field takes
 * focus when it mounts (the insert happens before React renders the block).
 */
const focusTitleOnMount = new Set<string>();

/** Mark a just-inserted locked section so its title field takes focus. */
export function focusLockedSectionTitle(blockId: string) {
  focusTitleOnMount.add(blockId);
}

/**
 * What a key in the title field does: Enter moves on into the body;
 * Backspace and Delete only ever edit the title (in an empty field they would
 * otherwise reach the editor's handlers, which delete or merge the block).
 * Neither reaches the editor. Any other key: the field's own behaviour.
 */
export function titleKeyAction(key: string): 'enter-body' | 'keep' | null {
  if (key === 'Enter') return 'enter-body';
  if (key === 'Backspace' || key === 'Delete') return 'keep';
  return null;
}

/** Put the cursor at the start of the body, adding an empty first line if there is none. */
export function enterLockedSectionBody(editor: LockedSectionEditorApi, blockId: string) {
  const current = editor.getBlock(blockId);
  if (!current) return;
  if (current.children.length === 0) {
    editor.updateBlock(blockId, { children: [{ type: 'paragraph' }] });
  }
  const first = editor.getBlock(blockId)?.children[0];
  if (!first) return;
  editor.focus();
  try {
    editor.setTextCursorPosition(first.id, 'start');
  } catch {
    // A first child without text (an image, a divider): focus is enough.
  }
}

function LockedSectionEditor({
  block,
  editor,
}: {
  block: { id: string; props: { title: string } };
  editor: LockedSectionEditorApi;
}) {
  const blockId = block.id;
  const title = typeof block.props.title === 'string' ? block.props.title : '';
  const { pageId, stats } = useSectionStats();
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const count = stats ? (stats.unlocks[blockId] ?? 0) : 0;
  const editable = editor.isEditable;

  useEffect(() => {
    if (!focusTitleOnMount.delete(blockId)) return;
    inputRef.current?.focus({ preventScroll: true });
  }, [blockId]);

  return (
    <div className="pg-locked-editor" data-locked-section="" contentEditable={false}>
      <span className="pg-lock-badge" role="img" aria-label="Locked section" title="Locked section">
        <LockGlyph />
      </span>
      {editable ? (
        <input
          ref={inputRef}
          className="pg-locked-editor-title"
          type="text"
          value={title}
          placeholder="Section title"
          aria-label="Locked section title"
          onChange={event => editor.updateBlock(blockId, { props: { title: event.target.value } })}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return;
            const action = titleKeyAction(event.key);
            if (!action) return;
            event.stopPropagation();
            if (action === 'enter-body') {
              event.preventDefault();
              enterLockedSectionBody(editor, blockId);
            }
          }}
        />
      ) : (
        <span className="pg-locked-editor-title">{title}</span>
      )}
      {stats ? (
        <button
          ref={chipRef}
          type="button"
          className="pg-unlock-chip"
          aria-haspopup="dialog"
          aria-expanded={open}
          onMouseDown={event => event.preventDefault()}
          onClick={() => setOpen(value => !value)}
        >
          <PeopleGlyph />
          Unlocked by {count} of {stats.students}
        </button>
      ) : null}
      {open && stats && pageId ? (
        <UnlockList
          anchor={chipRef}
          pageId={pageId}
          blockId={blockId}
          onClose={returnFocus => {
            setOpen(false);
            if (returnFocus) chipRef.current?.focus({ preventScroll: true });
          }}
        />
      ) : null}
    </div>
  );
}

/** One row of `GET /api/page-sections` (`unlocks[]`). */
interface Unlocker {
  userId: string;
  name: string | null;
  login: string | null;
  avatarUrl: string | null;
  unlockedAt: string;
}

type ListState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; students: number; unlocks: Unlocker[] };

const timeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : timeFormat.format(date);
}

const AVATAR_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#db2777',
  '#ea580c',
  '#0d9488',
  '#4f46e5',
  '#65a30d',
  '#b45309',
];

function avatarColor(key: string): string {
  const sum = [...key].reduce((total, ch) => total + ch.charCodeAt(0), 0);
  return AVATAR_COLORS[sum % AVATAR_COLORS.length];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
  return (first + last).toUpperCase();
}

const POPOVER_WIDTH = 300;

/**
 * Who unlocked this section, newest first. Portaled to <body>: inside the
 * block it would sit in ProseMirror's DOM, where clicks become selections.
 */
function UnlockList({
  anchor,
  pageId,
  blockId,
  onClose,
}: {
  anchor: React.RefObject<HTMLButtonElement | null>;
  pageId: string;
  blockId: string;
  onClose: (returnFocus: boolean) => void;
}) {
  const [state, setState] = useState<ListState>({ status: 'loading' });
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(
    null
  );
  const popRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ pageId, blockId });
    fetch(`/api/page-sections?${query}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
      .then(response => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body: { students?: unknown; unlocks?: unknown }) => {
        const unlocks = (Array.isArray(body.unlocks) ? (body.unlocks as Unlocker[]) : [])
          .slice()
          .sort((a, b) => Date.parse(b.unlockedAt) - Date.parse(a.unlockedAt));
        setState({
          status: 'ready',
          students: typeof body.students === 'number' ? body.students : 0,
          unlocks,
        });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'error' });
      });
    return () => controller.abort();
  }, [pageId, blockId]);

  useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 32);
      const left = Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16));
      setPosition({ top: rect.bottom + 6, left, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (popRef.current?.contains(target) || anchor.current?.contains(target)) return;
      onCloseRef.current(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current(true);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [anchor]);

  if (typeof document === 'undefined' || !position) return null;

  let body: React.ReactNode;
  let header = 'Unlocked by';
  if (state.status === 'loading') {
    body = <div className="pg-unlock-pop-status">Loading…</div>;
  } else if (state.status === 'error') {
    body = <div className="pg-unlock-pop-status">Couldn’t load the list. Try again.</div>;
  } else {
    header = `Unlocked by ${state.unlocks.length} of ${state.students}`;
    body =
      state.unlocks.length === 0 ? (
        <div className="pg-unlock-pop-empty">
          <div className="pg-unlock-pop-empty-title">No unlocks yet</div>
          <div className="pg-unlock-pop-empty-text">
            Students who unlock this section appear here.
          </div>
        </div>
      ) : (
        <ul className="pg-unlock-pop-list">
          {state.unlocks.map(row => {
            const name = row.name || row.login || 'Unknown';
            return (
              <li key={row.userId}>
                {row.avatarUrl ? (
                  <img className="pg-unlock-avatar" src={row.avatarUrl} alt="" />
                ) : (
                  <span
                    className="pg-unlock-avatar"
                    style={{ background: avatarColor(name) }}
                    aria-hidden="true"
                  >
                    {initials(name)}
                  </span>
                )}
                <span className="pg-unlock-name">{name}</span>
                <time dateTime={row.unlockedAt}>{formatTime(row.unlockedAt)}</time>
              </li>
            );
          })}
        </ul>
      );
  }

  return createPortal(
    <div
      ref={popRef}
      className="pg-unlock-pop"
      role="dialog"
      aria-label="Unlocked by"
      style={{ top: position.top, left: position.left, width: position.width }}
    >
      <div className="pg-unlock-pop-header">{header}</div>
      {body}
    </div>,
    document.body
  );
}

function LockGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

function PeopleGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
