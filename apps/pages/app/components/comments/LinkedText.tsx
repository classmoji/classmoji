import type { ReactNode } from 'react';

/**
 * Comment text with its links made clickable: `[label](https://…)` and bare
 * `https://…` URLs. Only http(s) become links, they open in a new tab and are
 * marked user-generated, and everything is built as React elements, so the
 * text itself can never inject markup. Ported from the webapp's feedback
 * `LinkedText` (apps/webapp/app/components/features/feedback/LinkedText.tsx).
 */
const LINK =
  /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

const anchorClass =
  'break-words font-medium text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600 dark:text-blue-400 dark:decoration-blue-400/40 dark:hover:decoration-blue-400';

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
