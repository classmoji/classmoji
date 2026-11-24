import type { HighlighterCore, ShikiTransformer } from '@shikijs/core';

/**
 * A terminal block's coloured code, as HTML for its display element.
 *
 * Shiki puts the theme's background on the `<pre>`; the terminal draws its own,
 * so that one declaration is dropped from the `<pre>`'s style and nowhere else.
 * The code itself is Shiki's escaped text: a command that contains
 * `background-color:red;`, `<b>` or `&` shows exactly as typed.
 */
const preWithoutBackground: ShikiTransformer = {
  name: 'terminal-pre-without-background',
  pre(node) {
    const style = node.properties.style;
    if (typeof style !== 'string') return;
    const kept = style
      .split(';')
      .map(declaration => declaration.trim())
      .filter(declaration => declaration && !/^background(-color)?\s*:/i.test(declaration))
      .join(';');
    if (kept) node.properties.style = kept;
    else delete node.properties.style;
  },
};

export function terminalCodeHtml(highlighter: HighlighterCore, code: string): string {
  return highlighter.codeToHtml(code, {
    lang: 'bash',
    theme: 'one-dark-pro',
    transformers: [preWithoutBackground],
  });
}
