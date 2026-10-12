import { useEffect, useRef } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import { lockedSectionConfig, lockedSectionGuard } from '@classmoji/page-schema';

import { SectionActivityChip } from '../SectionActivityChip.tsx';

/**
 * A locked section in the EDITOR: the title is the block's `title` prop,
 * edited in a plain text field; the body is its children (BlockNote draws
 * those below, in the block group; page-sections.css tints them and rules
 * them off so the author sees what readers find locked). The config is the
 * shared one from @classmoji/page-schema.
 *
 * With counts in context (OWNER/TEACHER), a chip on the right says how many
 * current students opened it; clicking it lists who and when
 * (`SectionActivityChip`, shared with the checkable headings' chips).
 *
 * Readers never see this render: the in-app viewer draws its own
 * (viewer/sections/LockedSectionView.tsx) and the class site a static one.
 */
const lockedSectionImplementation = {
  render: (props: {
    block: { id: string; props: { title: string } };
    editor: LockedSectionEditorApi;
  }) => <LockedSectionEditor block={props.block} editor={props.editor} />,
  // What a copy out of the editor carries: the title as text (the editor's
  // title field is an input, whose value no HTML export reads) and none of
  // the editor's chrome, so no staff chip. The body follows as the block's
  // children.
  toExternalHTML: (props: { block: { props: { title: string } } }) => (
    <p>
      <strong>{typeof props.block.props.title === 'string' ? props.block.props.title : ''}</strong>
    </p>
  ),
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
  const inputRef = useRef<HTMLInputElement | null>(null);
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
      <SectionActivityChip kind="unlock" blockId={blockId} />
    </div>
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
