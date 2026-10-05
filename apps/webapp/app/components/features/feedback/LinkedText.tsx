import type { ReactNode } from 'react';

/**
 * Feedback text with its links made clickable: `[label](https://…)` and bare
 * `https://…` URLs. Only http(s) become links, they open in a new tab and are
 * marked user-generated, and everything is built as React elements, so the
 * text itself can never inject markup.
 */
const LINK =
  /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

const anchorClass =
  'break-words font-medium text-accent! underline decoration-accent/40 underline-offset-2 hover:decoration-accent';

export function LinkedText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK)) {
    const index = match.index ?? 0;
    if (index > last) parts.push(text.slice(last, index));
    const [, label, labelledUrl, bareUrl] = match;
    const href = labelledUrl ?? bareUrl;
    parts.push(
      <a
        key={index}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow ugc"
        className={anchorClass}
      >
        {label ?? bareUrl}
      </a>
    );
    last = index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

/** The same text with `[label](url)` reduced to its label, for one-line previews. */
export const plainText = (text: string) =>
  text.replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g, '$1');
