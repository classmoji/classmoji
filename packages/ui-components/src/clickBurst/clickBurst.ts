/**
 * The click burst: four short rays fan upward from a point, slide outward,
 * shrink to a point and fade (400 ms). Plain DOM and the Web Animations API,
 * no React: a fixed SVG layer on <body>, removed once its rays are done.
 *
 * `installClickBurst` plays it on every click of a control (a button, a link,
 * a checkbox, a tab…) in every app, at the pointer, or at the control's centre
 * when the click came from the keyboard. Never on a disabled control, never
 * inside an editing surface (a contenteditable, a code editor, a text field,
 * anything under `[data-no-burst]`), never for a drag (the pointer moved
 * since it went down), never for the Enter that submits a form from a text
 * field, never when the reader prefers reduced motion, never where
 * `Element.prototype.animate` is missing.
 *
 * Drawn in the control's `--burst-color` (tokens.css; the pages app maps it to
 * its check green), else the control's own text colour. The pages reader's
 * tick boxes play the same burst themselves (`playBurst`), on tick-on only,
 * and carry `data-no-burst` so a tick bursts once.
 *
 * Framework-free and its own subpath (`@classmoji/ui-components/click-burst`):
 * importing it pulls nothing else from this package. Nothing touches the DOM
 * at import time, so server renders (and the admin Worker) can import it.
 */

const NS = 'http://www.w3.org/2000/svg';
/** Degrees, 0 = right, counter-clockwise (so "up" is −y on screen). */
const ANGLES = [45, 80, 115, 150];
const SIZE = 60;
const DURATION = 400;
const EASING = 'cubic-bezier(.33,1,.68,1)';

/** The class on every burst's SVG layer. */
export const BURST_CLASS = 'cm-burst';

export interface BurstRay {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** How far the ray slides outward over the burst. */
  dx: number;
  dy: number;
}

/**
 * The rays in a `size`×`size` box: each from 10% to 25% of the size out from
 * the centre, sliding a quarter of the size further out.
 */
export function burstRays(size: number = SIZE): BurstRay[] {
  const c = size / 2;
  return ANGLES.map(deg => {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    return {
      x1: c + size * 0.1 * cos,
      y1: c - size * 0.1 * sin,
      x2: c + size * 0.25 * cos,
      y2: c - size * 0.25 * sin,
      dx: (size / 4) * cos,
      dy: (-size / 4) * sin,
    };
  });
}

function prefersReducedMotion(view: Window | null): boolean {
  return Boolean(
    view &&
    typeof view.matchMedia === 'function' &&
    view.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Play the burst centred on (`x`, `y`), viewport coordinates of `doc`, in
 * `color`. Returns a promise that settles when the burst is gone, or null
 * when none plays (no DOM, no Web Animations, reduced motion).
 */
export function playBurst(
  x: number,
  y: number,
  color: string,
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document
): Promise<void> | null {
  const view = doc?.defaultView ?? null;
  if (
    !doc?.body ||
    !view ||
    typeof (view as Window & typeof globalThis).Element?.prototype.animate !== 'function' ||
    prefersReducedMotion(view)
  ) {
    return null;
  }

  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('class', BURST_CLASS);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', String(SIZE));
  svg.setAttribute('height', String(SIZE));
  // The CSSOM, not a style attribute: the slides app and the class site run a
  // CSP that may refuse inline style attributes.
  svg.style.cssText =
    `position:fixed;left:${x - SIZE / 2}px;top:${y - SIZE / 2}px;` +
    `width:${SIZE}px;height:${SIZE}px;pointer-events:none;overflow:visible;` +
    `z-index:2147483647;color:${color}`;

  const animations = burstRays().map(ray => {
    const line = doc.createElementNS(NS, 'line');
    line.setAttribute('x1', String(ray.x1));
    line.setAttribute('y1', String(ray.y1));
    line.setAttribute('x2', String(ray.x2));
    line.setAttribute('y2', String(ray.y2));
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linecap', 'square');
    line.setAttribute('pathLength', '1');
    svg.appendChild(line);
    // The inner end catches up with the outer end while the ray slides out.
    return line.animate(
      [
        { strokeDasharray: '1 1', strokeDashoffset: 0, transform: 'translate(0,0)', opacity: 1 },
        {
          strokeDasharray: '1 1',
          strokeDashoffset: -1,
          transform: `translate(${ray.dx}px,${ray.dy}px)`,
          opacity: 0,
        },
      ],
      { duration: DURATION, easing: EASING, fill: 'forwards' }
    );
  });
  doc.body.appendChild(svg);

  // Gone when the rays finish, are cancelled, or (a hidden tab holds them)
  // shortly after they should have.
  return new Promise<void>(resolve => {
    const remove = () => {
      view.clearTimeout(fallback);
      svg.remove();
      resolve();
    };
    const fallback = view.setTimeout(remove, DURATION + 200);
    Promise.all(animations.map(animation => animation.finished)).then(remove, remove);
  });
}

/** What counts as a control. */
const CONTROL = [
  'button',
  'a[href]',
  'summary',
  'label',
  ...['checkbox', 'radio', 'submit', 'button', 'reset'].map(type => `input[type="${type}"]`),
  ...[
    'button',
    'link',
    'checkbox',
    'switch',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'option',
    'radio',
    'treeitem',
  ].map(role => `[role="${role}"]`),
].join(',');

/** Inputs that are pressed, not typed into. */
const PRESSED_INPUTS = ['checkbox', 'radio', 'submit', 'button', 'reset'];

/**
 * Where text is typed: an input that is not pressed, a textarea, a
 * contenteditable. One `:not()` per type, not a list inside one: the admin
 * build still targets browsers without selector lists in `:not()`.
 */
const TEXT_FIELD = [
  `input${PRESSED_INPUTS.map(type => `:not([type="${type}"])`).join('')}`,
  'textarea',
  '[contenteditable]:not([contenteditable="false"])',
].join(',');

/**
 * Editing surfaces: a click anywhere inside one never bursts. A
 * `contenteditable="false"` island inside an editor is still in the editor
 * (the outer match finds it); a read-only ProseMirror (the pages reader) is
 * `contenteditable="false"` all the way up, so its controls burst. Antd's
 * number input counts as one with its stepper buttons.
 */
const EDITABLE = [TEXT_FIELD, '.cm-editor', '.monaco-editor', 'select', '.ant-input-number'].join(
  ','
);

/** How far (px) the pointer may move between down and click and still be a click. */
const DRAG_SLOP = 5;

function isDisabled(control: Element): boolean {
  if (control.matches(':disabled') || control.closest('[aria-disabled="true"]')) return true;
  // A disabled fieldset disables its controls, except those in its first legend.
  const fieldset = control.closest('fieldset[disabled]');
  if (fieldset) {
    const legend = fieldset.querySelector(':scope > legend');
    if (!legend || !legend.contains(control)) return true;
  }
  return false;
}

/** A label's control, when it is a checkbox or a radio (else null). */
function labelledToggle(label: Element): HTMLInputElement | null {
  const control = (label as HTMLLabelElement).control;
  return control &&
    control.tagName === 'INPUT' &&
    ['checkbox', 'radio'].includes((control as HTMLInputElement).type)
    ? (control as HTMLInputElement)
    : null;
}

/**
 * The control a click on `target` pressed, or null when that click should not
 * burst: not on a control, on a disabled one, inside an editing surface, or
 * under `[data-no-burst]`. A label counts only when its control is a checkbox
 * or a radio (and that control is enabled).
 */
export function isBurstTarget(target: EventTarget | null): Element | null {
  const node = target as Node | null;
  if (!node || typeof node.nodeType !== 'number') return null;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!element) return null;
  if (element.closest('[data-no-burst]') || element.closest(EDITABLE)) return null;
  const control = element.closest(CONTROL);
  if (!control || isDisabled(control)) return null;
  if (control.tagName === 'LABEL') {
    const toggle = labelledToggle(control);
    if (!toggle || isDisabled(toggle) || toggle.closest('[data-no-burst]')) return null;
  }
  return control;
}

/** The colour a control's burst is drawn in. */
function burstColor(control: Element, view: Window): string {
  const style = view.getComputedStyle(control);
  return style.getPropertyValue('--burst-color').trim() || style.color || 'currentColor';
}

interface Installed {
  count: number;
  onClick: (event: MouseEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
}

/** On the document itself, so a second copy of this module (HMR) finds it. */
const INSTALLED = Symbol.for('classmoji.clickBurst');
type BurstDocument = Document & { [INSTALLED]?: Installed };

/**
 * Burst on every click of a control in `doc` (see `isBurstTarget`). Capture-
 * phase listeners on the document (the click, and the pointerdown that tells
 * a drag from a press), so a handler that stops the click does not stop the
 * burst. Installing again only counts: the listener stays
 * one. Returns the uninstall (the listener goes with the last one).
 */
export function installClickBurst(
  doc: Document | undefined = typeof document === 'undefined' ? undefined : document
): () => void {
  if (!doc) return () => {};
  const target = doc as BurstDocument;
  let installed = target[INSTALLED];
  if (!installed) {
    // A label's click is followed, in the same task, by the click the browser
    // sends its control: that one is the label's burst, already played. A
    // timer, not a microtask: microtasks run between the two dispatches.
    let labelled: Element | null = null;
    let clearLabelled: number | undefined;
    // Where the last pointer went down: a click that ends far from it was a
    // drag (a grip dropped, text selected inside a link), not a press.
    let down: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      down = event.isPrimary === false ? down : { x: event.clientX, y: event.clientY };
    };
    const onClick = (event: MouseEvent) => {
      const from = down;
      down = null;
      const control = isBurstTarget(event.target);
      if (!control) return;
      if (control === labelled) {
        labelled = null;
        return;
      }
      const view = doc.defaultView;
      if (!view) return;
      let x = event.clientX;
      let y = event.clientY;
      const keyboard = event.detail === 0 || (x === 0 && y === 0);
      if (!keyboard && from && Math.hypot(x - from.x, y - from.y) > DRAG_SLOP) return;
      if (keyboard) {
        // Enter in a text field submits its form with a click on the submit
        // button: that is typing, not a press.
        if (doc.activeElement?.closest(TEXT_FIELD)) return;
        // The keyboard (or a script): from the control's centre, if it is drawn.
        const rect = control.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        x = rect.left + rect.width / 2;
        y = rect.top + rect.height / 2;
      }
      if (!playBurst(x, y, burstColor(control, view), doc)) return;
      if (control.tagName === 'LABEL') {
        labelled = labelledToggle(control);
        view.clearTimeout(clearLabelled);
        clearLabelled = view.setTimeout(() => (labelled = null), 0);
      }
    };
    installed = { count: 0, onClick, onPointerDown };
    target[INSTALLED] = installed;
    doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    doc.addEventListener('click', onClick, { capture: true, passive: true });
  }
  installed.count += 1;
  const mine = installed;
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    mine.count -= 1;
    if (mine.count === 0 && target[INSTALLED] === mine) {
      doc.removeEventListener('pointerdown', mine.onPointerDown, { capture: true });
      doc.removeEventListener('click', mine.onClick, { capture: true });
      delete target[INSTALLED];
    }
  };
}
