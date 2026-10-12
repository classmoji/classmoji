import { sectionStoreFor } from './sectionCheckbox.ts';

/**
 * A student check list item (`checkListItem` with `personal: true`), in the
 * reader's view.
 *
 * BlockNote's own check list item node view, with its checkbox handed to the
 * reader: for a reader who can tick (`canCheck`), the box shows THEIR state
 * (the section store's `checked`, the same set and the same POST as the
 * checkable headings) instead of the author's stored `checked`, and ticking it
 * toggles their own row. For everyone else (signed out, not an accepted
 * member, viewing as someone) the item stays exactly as BlockNote draws it in
 * a read-only editor: the author's state, a disabled box.
 *
 * The line-through is BlockNote's (`[data-checked="true"]` on the block's
 * content element), so the reader's state sets that attribute too. No fade:
 * a list item has no section.
 */

interface CheckListItemNodeView {
  dom: HTMLElement;
  contentDOM?: HTMLElement;
  ignoreMutation?: (mutation: MutationRecord | { type: 'selection'; target: Node }) => boolean;
  stopEvent?: (event: Event) => boolean;
  destroy?: () => void;
}

/** An item's plain text, for its checkbox's accessible name. */
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

/** What the box shows: the reader's own state when they can tick, else the author's. */
export function personalItemState({
  canCheck,
  checked,
  blockId,
  authorChecked,
}: {
  canCheck: boolean;
  checked: ReadonlySet<string>;
  blockId: string;
  authorChecked: boolean;
}): { checked: boolean; interactive: boolean } {
  return canCheck
    ? { checked: checked.has(blockId), interactive: true }
    : { checked: authorChecked, interactive: false };
}

/**
 * Hand a personal item's checkbox to the reader. Returns the same view with
 * the store subscription's teardown and event/mutation handling folded in.
 */
export function withPersonalCheckbox<T extends CheckListItemNodeView>(
  view: T,
  block: { id: string; content?: unknown; props: { checked?: unknown } },
  editor: object
): T {
  const input = view.dom.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (!input) return view;
  const wrapper = (input.parentElement ?? input) as HTMLElement;
  const store = sectionStoreFor(editor);
  const authorChecked = block.props.checked === true;
  input.setAttribute('aria-label', inlineText(block.content) || 'Check list item');
  input.classList.add('pg-personal-check');

  const sync = () => {
    const { canCheck, checked } = store.get();
    const state = personalItemState({ canCheck, checked, blockId: block.id, authorChecked });
    input.disabled = !state.interactive;
    input.checked = state.checked;
    if (state.checked) view.dom.setAttribute('data-checked', 'true');
    else view.dom.removeAttribute('data-checked');
  };
  sync();
  const unsubscribe = store.subscribe(sync);

  // The box's native toggle is the reader's tick; the store answers with the
  // optimistic state on the next render (and puts it back if the POST fails).
  const onChange = () => {
    if (!store.get().canCheck) {
      sync();
      return;
    }
    store.get().toggleCheck(block.id);
  };
  input.addEventListener('change', onChange);

  const inBox = (target: Node | null) => Boolean(target && wrapper.contains(target));
  const ignoreMutation = view.ignoreMutation;
  const stopEvent = view.stopEvent;
  const destroy = view.destroy;
  return {
    ...view,
    // The reader's state on the block's own element and inside the box is not
    // a document change.
    ignoreMutation: mutation =>
      (mutation.type === 'attributes' &&
        mutation.target === view.dom &&
        (mutation as MutationRecord).attributeName === 'data-checked') ||
      inBox(mutation.target as Node) ||
      (ignoreMutation ? ignoreMutation(mutation) : false),
    // Clicks and keys on the box are the box's (Space ticks it).
    stopEvent: (event: Event) =>
      inBox(event.target as Node | null) || (stopEvent ? stopEvent(event) : false),
    destroy: () => {
      unsubscribe();
      input.removeEventListener('change', onChange);
      destroy?.();
    },
  };
}
