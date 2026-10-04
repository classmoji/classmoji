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
    props: { language },
    content: [{ type: 'text', text: `echo ${i}`, styles: {} }],
    children: [],
  }));
}
