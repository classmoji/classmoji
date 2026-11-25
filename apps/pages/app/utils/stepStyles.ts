import type { StepInfo } from '@classmoji/page-schema/sections';

/**
 * The CSS that draws a page's steps: a numbered circle on each step heading
 * and a line joining one step to the next.
 *
 * BlockNote's blocks are flat siblings, so a step's line cannot hang off a
 * wrapper. Like the section fade, the rules are read off the document
 * (`stepLayout`) and keyed on `.bn-block-outer[data-id]`: the heading's own
 * block carries the circle (a `::before` with the number), and every block in
 * the step's section is indented and draws its slice of the line as a
 * background, so the line runs unbroken from the heading to the next step.
 *
 * What the static CSS (page-sections.css) cannot know, this works out:
 *
 * - The number. A step heading's `::before` is empty until a rule here fills
 *   it, so a heading that is not a step (or an H3 that carries the prop) never
 *   shows a circle.
 * - Where the circle sits. It is centred on the heading's first line, so its
 *   offset depends on the level (30px / 1.3 for H1, 24px / 1.4 for H2). The
 *   space above a step heading is fixed here (`GAP_PAD`) instead of following
 *   what comes before it, so the offsets are known.
 * - The line. 10px short of each circle, from the circle above to the circle
 *   below, with the heading's own gap in between filled by the heading.
 *   Several steps can hold one block (an H2 step inside an H1 step): the block
 *   is indented once per step and draws one line per step.
 *
 * The rules are scoped to `.page-editor`, the class the editor and the reader
 * wrap their content in.
 */

/**
 * Circle diameter, the indent of a step's content, the line's gap and the line's width, px.
 * The 1.5px line is the weight of the icons elsewhere in the app (the circle's ring is 2px,
 * page-sections.css); the indent is the circle plus a 16px gap to the text.
 */
export const STEP_CIRCLE = 30;
export const STEP_INDENT = 46;
export const STEP_STROKE = 1.5;
const LINE_GAP = 10;
/** The line's x inside one indent level: the circle's centre, less half its width. */
const LINE_X = STEP_CIRCLE / 2 - STEP_STROKE / 2;

/** A step heading's line height (`--level` x `--heading-lh`, blocknote-overrides.css), px. */
const LINE_HEIGHT: Record<number, number> = { 1: 30 * 1.3, 2: 24 * 1.4 };
/**
 * The padding above a step heading, px: the gap above H1 (56) and H2 (22) less
 * the 8px a paragraph pads under itself. Fixed, so the circle's offset is.
 */
const GAP_PAD: Record<number, number> = { 1: 48, 2: 14 };

interface Layer {
  x: number;
  y: number;
  /** A length: px, or a calc() ending at the element's bottom. */
  height: string;
}

const px = (value: number) => `${Math.round(value * 100) / 100}px`;
const attr = (id: string) => id.replace(/["\\]/g, '\\$&');

export function stepStylesheet(layout: ReadonlyMap<string, StepInfo>): string {
  if (layout.size === 0) return '';

  // How many steps hold each block, and the line slices each one draws.
  const depth = new Map<string, number>();
  const layers = new Map<string, Layer[]>();
  const addLayer = (id: string, layer: Layer) => {
    const list = layers.get(id);
    if (list) list.push(layer);
    else layers.set(id, [layer]);
  };
  for (const step of layout.values()) {
    for (const id of step.ids) depth.set(id, (depth.get(id) ?? 0) + 1);
  }

  const rules: string[] = [];
  // An ordinary block is a `.bn-block-outer`; a column list is not (it sits in
  // the block group beside them, and is a flex row), so the indent and the line
  // go on whatever carries the id, and `display: flow-root` only on the former.
  const outer = (id: string) => `.page-editor .bn-block-outer[data-id="${attr(id)}"]`;
  // `data-id` is also on the inner `.bn-block`, so name the two that carry a
  // block's place in its list.
  const block = (id: string) =>
    `.page-editor :is(.bn-block-outer, .bn-block-column-list)[data-id="${attr(id)}"]`;
  const content = '.bn-block-content[data-content-type="heading"]::before';

  for (const [headingId, step] of layout) {
    const x = STEP_INDENT * (step.depth - 1) + LINE_X;
    const lineHeight = LINE_HEIGHT[step.level] ?? 24 * 1.4;
    const pad = step.firstInList ? 0 : (GAP_PAD[step.level] ?? 0);
    const offset = (lineHeight - STEP_CIRCLE) / 2;
    const circleTop = pad + offset;

    if (step.hasPrev) {
      const height = circleTop - LINE_GAP;
      if (height >= 4) addLayer(headingId, { x, y: 0, height: px(height) });
    }
    if (step.hasNext) {
      const y = circleTop + STEP_CIRCLE + LINE_GAP;
      addLayer(headingId, { x, y, height: `calc(100% - ${px(y)})` });
      for (const id of step.ids.slice(1)) addLayer(id, { x, y: 0, height: '100%' });
    }

    if (!step.firstInList) {
      rules.push(`${outer(headingId)} > .bn-block { padding-top: ${px(pad)} !important; }`);
    }
    // A toggle heading keeps its content in BlockNote's frame (0.56+), one
    // level further in than a plain heading.
    rules.push(
      `${outer(headingId)} > .bn-block > ${content}, ` +
        `${outer(headingId)} > .bn-block > .bn-toggle-frame > .bn-toggle-slot > ${content} ` +
        `{ content: "${step.number}"; top: ${px(offset)}; }`
    );
  }

  for (const [id, count] of depth) {
    const own = layers.get(id) ?? [];
    const declarations = [`padding-left: ${STEP_INDENT * count}px`];
    if (own.length > 0) {
      declarations.push(
        `background-image: ${own.map(() => 'linear-gradient(var(--st-line), var(--st-line))').join(', ')}`,
        'background-repeat: no-repeat',
        `background-size: ${own.map(l => `${STEP_STROKE}px ${l.height}`).join(', ')}`,
        `background-position: ${own.map(l => `${px(l.x)} ${px(l.y)}`).join(', ')}`
      );
    }
    rules.push(`${block(id)} { ${declarations.join('; ')}; }`);
    rules.push(`${outer(id)} { display: flow-root; }`);
  }
  return rules.join('\n');
}
