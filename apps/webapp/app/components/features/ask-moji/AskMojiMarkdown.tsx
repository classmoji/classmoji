import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import { normalizeAssistantText } from '~/utils/contentReferenceUrl';

/**
 * An answer's Markdown: GFM (tables, task lists, strikethrough) and code
 * highlighting. Tables and code blocks scroll sideways inside the answer;
 * each code block has its own Copy.
 *
 * Links and images render as they always have (Tim's choice), except that a
 * link the model invented with nowhere to go (`content://…`, `#`, no href)
 * is plain text: the source chips carry the real links.
 */

type HastNode = { type?: string; value?: string; children?: HastNode[] };

/** The text of a hast node (a code block's source, for its Copy). */
export const hastText = (node: HastNode | undefined): string => {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
};

/** Whether an href goes nowhere a reader can follow. */
export const isDeadHref = (href: string | undefined | null) =>
  !href || href === '#' || href.startsWith('content://');

/** Copy text to the clipboard; resolves whether it worked. */
export const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
};

/** A Copy button that says "Copied" for a moment after it worked. */
export function CopyButton({
  text,
  label,
  className,
  showLabel = true,
}: {
  text: string;
  label: string;
  className?: string;
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  const onClick = useCallback(async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    clearTimeout(timer.current ?? undefined);
    timer.current = setTimeout(() => setCopied(false), 1800);
  }, [text]);
  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
      {showLabel && <span>{copied ? 'Copied' : 'Copy'}</span>}
      <span className="sr-only" aria-live="polite">
        {copied ? 'Copied' : ''}
      </span>
    </button>
  );
}

const components: Components = {
  a: ({ href, children }) =>
    isDeadHref(href) ? (
      <span>{children}</span>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
  pre: ({ node, children }) => (
    <div className="moji-code">
      <CopyButton
        text={hastText(node as HastNode)}
        label="Copy code"
        className="moji-code-copy"
        showLabel={false}
      />
      <pre>{children}</pre>
    </div>
  ),
  table: ({ children }) => (
    <div className="moji-table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export default function AskMojiMarkdown({ text }: { text: string }): ReactNode {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={components}
    >
      {normalizeAssistantText(text)}
    </ReactMarkdown>
  );
}
