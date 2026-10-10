/**
 * The copy control in the title bar of code and terminal blocks.
 *
 * Readers get a Copy button on a block whose `copyable` prop is on (and
 * nothing on one where it is off); editors get a toggle for the prop in the
 * same place. The vanilla code block (schema.ts), the React terminal block
 * (apps/pages) and the class site's static renders all draw it from the
 * markup here, so the three look and behave alike.
 *
 * DOM is touched only in the builders and click paths, never at import: the
 * collab server and the git worker import this package without a DOM.
 */

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" ' +
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" focusable="false"';

const COPY_PATHS =
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
  '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>';

/** Lucide "copy", "check", and "copy" crossed out. */
const COPY_ICON = `${SVG_OPEN} class="bn-copy-icon-copy">${COPY_PATHS}</svg>`;
const CHECK_ICON = `${SVG_OPEN} class="bn-copy-icon-check"><path d="M20 6 9 17l-5-5"/></svg>`;
const COPY_OFF_ICON = `${SVG_OPEN} class="bn-copy-icon-off">${COPY_PATHS}<path d="m2 2 20 20"/></svg>`;

/** Class of the reader's Copy button (the class site's script keys on it). */
export const COPY_BUTTON_CLASS = 'bn-copy-button';
/** Class of the editor's copying toggle. */
export const COPY_TOGGLE_CLASS = 'bn-copy-toggle';

/**
 * The Copy button's icons: both are drawn, CSS shows the check while the
 * button carries `data-copied` (no markup swap, so the static site's script
 * only flips an attribute).
 */
export const COPY_BUTTON_ICONS = COPY_ICON + CHECK_ICON;
/** The toggle's icons: CSS picks by `aria-pressed`. */
export const COPY_TOGGLE_ICONS = COPY_ICON + COPY_OFF_ICON;

/** How long the Copy button shows its check. */
export const COPIED_MS = 1500;

export const COPY_LABEL = 'Copy';
/** The toggle's fixed name; `aria-pressed` carries the state. */
export const COPY_TOGGLE_LABEL = 'Allow copying';
export const COPY_ALLOWED_TITLE = 'Copying allowed';
export const COPY_DISABLED_TITLE = 'Copying disabled';

/**
 * Whether a block's props allow copying. Props written without validation
 * (MCP) may hold anything, and every render must read them the same way. Only
 * `false` turns copying off — and the string `'false'`, because BlockNote
 * writes any non-default value as `data-copyable="<value>"`, which is what the
 * no-select CSS and the copy guard key on.
 */
export function isCopyable(props: { copyable?: unknown }): boolean {
  return props.copyable !== false && props.copyable !== 'false';
}

/** Toggle title for a block's `copyable` value. */
export function copyToggleTitle(copyable: boolean): string {
  return copyable ? COPY_ALLOWED_TITLE : COPY_DISABLED_TITLE;
}

/** Copy through a hidden textarea: the path left when the Clipboard API is refused. */
function execCommandCopy(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/**
 * Put `text` on the clipboard. A page framed by the webapp is cross-origin
 * and Chrome refuses the Clipboard API there without `clipboard-write`, so a
 * refusal falls back to `execCommand('copy')`, which a click still allows.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Refused: fall through.
  }
  return execCommandCopy(text);
}

/** Show the check on a Copy button for COPIED_MS. */
export function flashCopied(button: HTMLElement): void {
  button.setAttribute('data-copied', '');
  setTimeout(() => button.removeAttribute('data-copied'), COPIED_MS);
}

/**
 * Keep the editor out of a title-bar button's events: a press must not move
 * the selection or focus, and Enter/Space on a focused button must reach the
 * button, not ProseMirror (the code block's node view has no `stopEvent`).
 * Native listeners: ProseMirror's own are native too, and React's synthetic
 * ones run after them. Returns the cleanup.
 */
export function guardControlEvents(button: HTMLElement): () => void {
  const onMouseDown = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const onKey = (event: KeyboardEvent) => event.stopPropagation();
  button.addEventListener('mousedown', onMouseDown);
  button.addEventListener('keydown', onKey);
  button.addEventListener('keyup', onKey);
  return () => {
    button.removeEventListener('mousedown', onMouseDown);
    button.removeEventListener('keydown', onKey);
    button.removeEventListener('keyup', onKey);
  };
}

function baseButton(className: string, icons: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.innerHTML = icons;
  guardControlEvents(button);
  return button;
}

/** The reader's Copy button; `getText` is read at click time. */
export function createCopyButton(getText: () => string): HTMLButtonElement {
  const button = baseButton(COPY_BUTTON_CLASS, COPY_BUTTON_ICONS);
  button.setAttribute('aria-label', COPY_LABEL);
  button.title = COPY_LABEL;
  button.addEventListener('click', () => {
    void writeClipboardText(getText()).then(ok => {
      if (ok) flashCopied(button);
    });
  });
  return button;
}

/** The editor's copying toggle; `onToggle` flips the block's prop. */
export function createCopyToggle(copyable: boolean, onToggle: () => void): HTMLButtonElement {
  const button = baseButton(COPY_TOGGLE_CLASS, COPY_TOGGLE_ICONS);
  button.setAttribute('aria-label', COPY_TOGGLE_LABEL);
  button.setAttribute('aria-pressed', String(copyable));
  button.title = copyToggleTitle(copyable);
  button.addEventListener('click', onToggle);
  return button;
}
