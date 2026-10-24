/**
 * The CSS classes an instructor sets on a slide block from the properties
 * panel. Themes key their styling off classes (`plain`, `card`, …), and they
 * live on the block's `.sl-block-content`, which is where slides.com put them.
 *
 * Only the user's classes are ever shown or changed. The structural ones are
 * how the editor finds and selects a block, so they can be neither listed nor
 * removed.
 */

const STRUCTURAL_CLASSES = new Set(['sl-block', 'sl-block-content']);

/** A class name a stylesheet can select without escaping. */
const CLASS_NAME = /^-?[_a-zA-Z][_a-zA-Z0-9-]*$/;

/** The classes on `element` that belong to the user, in their order. */
export function userClassesOf(element: Element): string[] {
  return Array.from(element.classList).filter(name => !STRUCTURAL_CLASSES.has(name));
}

/**
 * The classes typed into the field: separated by spaces or commas, each once.
 * `invalid` names what was left out because no selector could match it.
 */
export function parseClassInput(text: string): { classes: string[]; invalid: string[] } {
  const classes: string[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    if (STRUCTURAL_CLASSES.has(token) || classes.includes(token) || invalid.includes(token)) {
      continue;
    }
    (CLASS_NAME.test(token) ? classes : invalid).push(token);
  }
  return { classes, invalid };
}

/**
 * Make the user's classes on `element` exactly `classes`, leaving the
 * structural ones alone. Returns whether anything changed.
 */
export function applyUserClasses(element: Element, classes: string[]): boolean {
  const wanted = new Set(classes);
  let changed = false;
  for (const name of userClassesOf(element)) {
    if (!wanted.has(name)) {
      element.classList.remove(name);
      changed = true;
    }
  }
  for (const name of wanted) {
    if (!element.classList.contains(name)) {
      element.classList.add(name);
      changed = true;
    }
  }
  return changed;
}
