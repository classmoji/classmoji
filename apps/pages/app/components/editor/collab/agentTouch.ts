/**
 * What an agent just changed in a live page, shown on the blocks themselves:
 * each block an agent's op batch inserted or changed gets a tint and a left
 * bar in the agent's colour plus a name chip, fading out over a few seconds.
 *
 * A generated stylesheet keyed by block id (`.bn-block[data-id=…]`), like the
 * preview highlight: it never touches ProseMirror or the document, never
 * moves anyone's caret, and does not care whether a block's DOM arrives
 * before or after the awareness update naming it. Which blocks and for how
 * long comes from `AgentTouchTracker` (@classmoji/collab), fed by the
 * session's awareness.
 *
 * Pure (no React, no DOM): tests/unit/agent-touch.spec.ts.
 */

import { AGENT_TOUCH_FADE_MS, textOnColor, type AgentTouch } from '@classmoji/collab';

import { cssAttrValue } from '~/components/preview/previewHighlight.ts';

/** Chip text as a CSS string: quotes, backslashes and newlines escaped, never `</style>`. */
export function cssString(text: string): string {
  return `"${text
    .replace(/["\\]/g, ch => `\\${ch}`)
    .replace(/[\n\r\f]/g, ' ')
    .replace(/</g, '\\3c ')}"`;
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * The stylesheet for `touches` inside `scope` (a class on the editor's
 * wrapper). One rule set per batch, its fade named after the batch, so a
 * block touched again restarts its fade and nothing else ever does. With
 * `prefers-reduced-motion: reduce` the mark is static and simply goes when
 * the touch expires. Dark mode deepens the tint.
 */
export function agentTouchCss(touches: AgentTouch[], scope: string): string {
  if (touches.length === 0) return '';
  const batches = new Map<number, { touch: AgentTouch; ids: string[] }>();
  for (const touch of touches) {
    const entry = batches.get(touch.batch) ?? { touch, ids: [] };
    entry.ids.push(touch.id);
    batches.set(touch.batch, entry);
  }

  const rules: string[] = [`.dark .${scope} { --cm-agent-mix: 24%; }`];
  for (const { touch, ids } of batches.values()) {
    const color = HEX_COLOR.test(touch.color) ? touch.color : '#6b7280';
    const fade = `cm-agent-touch-${touch.batch}`;
    const blocks = ids.map(id => `.${scope} .bn-block[data-id=${cssAttrValue(id)}]`);
    const chips = blocks.map(selector => `${selector}::after`);
    const tint = 'color-mix(in srgb, var(--cm-agent) var(--cm-agent-mix, 16%), transparent)';
    rules.push(
      `${blocks.join(',\n')} { --cm-agent: ${color}; position: relative; border-radius: 4px; ` +
        `background-color: ${tint}; box-shadow: inset 3px 0 0 var(--cm-agent); }`,
      `${chips.join(',\n')} { content: ${cssString(touch.name)} / ""; position: absolute; ` +
        'top: -0.6rem; right: 0.25rem; z-index: 3; pointer-events: none; padding: 0 0.4rem; ' +
        'border-radius: 9999px; font-size: 0.6875rem; line-height: 1.15rem; font-weight: 600; ' +
        `white-space: nowrap; background-color: ${color}; color: ${textOnColor(color)}; ` +
        'box-shadow: 0 1px 2px rgb(0 0 0 / 0.2); }',
      `@keyframes ${fade}-mark { from { background-color: ${tint}; ` +
        'box-shadow: inset 3px 0 0 var(--cm-agent); } ' +
        'to { background-color: transparent; box-shadow: inset 3px 0 0 transparent; } }',
      `@keyframes ${fade}-chip { 0%, 70% { opacity: 1; } to { opacity: 0; } }`,
      `@media (prefers-reduced-motion: no-preference) { ${blocks.join(',\n')} { animation: ` +
        `${fade}-mark ${AGENT_TOUCH_FADE_MS}ms ease-out forwards; } ${chips.join(',\n')} ` +
        `{ animation: ${fade}-chip ${AGENT_TOUCH_FADE_MS}ms ease-out forwards; } }`
    );
  }
  return rules.join('\n');
}
