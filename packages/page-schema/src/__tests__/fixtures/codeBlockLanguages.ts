/**
 * Code blocks in the languages saved pages actually hold: canonical ids,
 * aliases, a different case, a language BlockNote never listed, empty, and a
 * name that is an Object.prototype key. Paired with what the code block's
 * language select should show for each.
 */
export const CODE_LANGUAGES: Array<[stored: string, shown: string]> = [
  ['bash', 'shellscript'],
  ['sh', 'shellscript'],
  ['shell', 'shellscript'],
  ['js', 'javascript'],
  ['jsx', 'jsx'],
  ['ts', 'typescript'],
  ['py', 'python'],
  ['yml', 'yaml'],
  ['Python', 'python'],
  ['javascript', 'javascript'],
  ['brainfuck', 'text'],
  ['', 'text'],
  ['toString', 'text'],
];

/** One code block per entry of CODE_LANGUAGES, ids `code-<index>`. */
export function codeBlocks() {
  return CODE_LANGUAGES.map(([language], i) => ({
    id: `code-${i}`,
    type: 'codeBlock',
    props: { language, copyable: true },
    content: [{ type: 'text', text: `echo ${i}`, styles: {} }],
    children: [],
  }));
}

/**
 * Code blocks as BlockNote 0.46 could save them (inline content): a link, a
 * bold run, an inline-code run, coloured text, across newlines. 0.55 refuses
 * the link and drops the styles; `RICH_CODE_TEXT[id]` is the plain text each
 * must load as.
 */
export function richCodeBlocks() {
  const run = (text: string, styles: Record<string, unknown> = {}) => ({
    type: 'text',
    text,
    styles,
  });
  return [
    {
      id: 'rich-link',
      type: 'codeBlock',
      props: { language: 'bash' },
      content: [
        run('curl '),
        { type: 'link', href: 'https://example.com', content: [run('https://example.com')] },
        run('\necho done'),
      ],
      children: [],
    },
    {
      id: 'rich-bold',
      type: 'codeBlock',
      props: { language: 'python' },
      content: [run('def '), run('main', { bold: true }), run('():\n    pass', { code: true })],
      children: [],
    },
    {
      id: 'rich-nested-parent',
      type: 'paragraph',
      props: {},
      content: [run('parent')],
      children: [
        {
          id: 'rich-nested',
          type: 'codeBlock',
          props: { language: 'js' },
          content: [run('let a', { textColor: 'red' }), run(' = 1;')],
          children: [],
        },
      ],
    },
  ];
}

export const RICH_CODE_TEXT: Record<string, string> = {
  'rich-link': 'curl https://example.com\necho done',
  'rich-bold': 'def main():\n    pass',
  'rich-nested': 'let a = 1;',
};
