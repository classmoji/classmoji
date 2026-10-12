import type { ReaderSectionsValue } from '~/hooks/useReaderSections.tsx';

/**
 * The tick box on a checkable heading, in the reader's view.
 *
 * Added to BlockNote's own heading node view rather than drawn by React: the
 * viewer's heading spec (viewerBlocks.tsx) is the shared page heading with its
 * render wrapped, so the heading, its toggle (toggle headings), its parse
 * rules and input rules are BlockNote's, unchanged. The box is one
 * non-editable button appended to the block's content element, outside the
 * heading's inline content, like BlockNote's own toggle button.
 *
 * Node views are plain DOM, so the reader's state reaches them through a small
 * store per editor (`sectionStoreFor`), which the viewer fills from
 * `ReaderSectionsContext` and the boxes subscribe to. The same store carries
 * which locked sections have their body in this editor (`filled`), which the
 * viewer publishes and the locked sections read.
 */

type StoreState = Pick<ReaderSectionsValue, 'canCheck' | 'checked' | 'toggleCheck'> & {
  /** Locked sections whose body (children) is in this editor now. */
  filled: ReadonlySet<string>;
};

export interface SectionStore {
  get: () => StoreState;
  /** Merge `patch` into the state and notify. */
  set: (patch: Partial<StoreState>) => void;
  subscribe: (listener: () => void) => () => void;
}

const stores = new WeakMap<object, SectionStore>();

function createStore(): SectionStore {
  let state: StoreState = {
    canCheck: false,
    checked: new Set(),
    toggleCheck: () => {},
    filled: new Set(),
  };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: patch => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener();
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The store for one editor (created on first ask). */
export function sectionStoreFor(editor: object): SectionStore {
  let store = stores.get(editor);
  if (!store) {
    store = createStore();
    stores.set(editor, store);
  }
  return store;
}

/** A heading's plain text, for the box's label. */
function inlineText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map(node => {
      if (!node || typeof node !== 'object') return '';
      const item = node as { text?: unknown; content?: unknown };
      if (typeof item.text === 'string') return item.text;
      return inlineText(item.content);
    })
    .join('')
    .trim();
}

interface HeadingNodeView {
  dom: HTMLElement;
  contentDOM?: HTMLElement;
  ignoreMutation?: (mutation: MutationRecord | { type: 'selection'; target: Node }) => boolean;
  stopEvent?: (event: Event) => boolean;
  destroy?: () => void;
}

const CHECK_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" pathLength="1"/></svg>';

/**
 * Add the reader's tick box to a heading's node view (only for a heading the
 * author made checkable). Returns the same view with the box's teardown and
 * event/mutation handling folded in.
 */
export function withSectionCheckbox<T extends HeadingNodeView>(
  view: T,
  block: { id: string; content?: unknown },
  editor: object
): T {
  const store = sectionStoreFor(editor);
  const label = inlineText(block.content) || 'this section';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'pg-section-check';
  button.contentEditable = 'false';
  button.setAttribute('role', 'checkbox');
  button.setAttribute('aria-label', `Mark '${label}' done`);
  const box = document.createElement('span');
  box.className = 'pg-section-check-box';
  box.innerHTML = CHECK_SVG;
  button.appendChild(box);

  const sync = () => {
    const state = store.get();
    button.hidden = !state.canCheck;
    const on = state.checked.has(block.id);
    button.setAttribute('aria-checked', on ? 'true' : 'false');
    button.dataset.tooltip = on ? 'Mark not done' : 'Mark done';
  };
  sync();
  const unsubscribe = store.subscribe(sync);

  // As BlockNote's toggle button does: no selection change on press.
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    store.get().toggleCheck(block.id);
  });

  view.dom.appendChild(button);

  const ignoreMutation = view.ignoreMutation;
  const stopEvent = view.stopEvent;
  const destroy = view.destroy;
  return {
    ...view,
    // The box's own attribute changes are not document changes.
    ignoreMutation: mutation =>
      button.contains(mutation.target as Node) ||
      (ignoreMutation ? ignoreMutation(mutation) : false),
    stopEvent: event =>
      button.contains(event.target as Node) || (stopEvent ? stopEvent(event) : false),
    destroy: () => {
      unsubscribe();
      button.remove();
      destroy?.();
    },
  };
}
