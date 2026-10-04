import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { ArrowUpIcon } from 'lucide-react';
import { signInHref } from './feedback';
import { useFeedbackAction } from './useFeedbackAction';

interface CommentComposerProps {
  postId: string;
  parentId?: string;
  signedIn: boolean;
  placeholder?: string;
  compact?: boolean;
  autoFocus?: boolean;
  onCancel?: () => void;
  onPosted?: () => void;
}

export function CommentComposer({
  postId,
  parentId,
  signedIn,
  placeholder = 'Add a comment…',
  compact = false,
  autoFocus = false,
  onCancel,
  onPosted,
}: CommentComposerProps) {
  const [body, setBody] = useState('');
  const location = useLocation();
  const { fetcher, submit, pending } = useFeedbackAction(signedIn);
  const sent = useRef(false);
  const empty = body.trim().length === 0;

  // Clear once the server took it; keep the text if it was refused.
  useEffect(() => {
    if (!sent.current || fetcher.state !== 'idle') return;
    sent.current = false;
    if (fetcher.data?.ok) {
      setBody('');
      onPosted?.();
    }
  }, [fetcher.state, fetcher.data, onPosted]);

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    if (empty || pending) return;
    sent.current = true;
    submit({ intent: 'comment', postId, body: body.trim(), ...(parentId ? { parentId } : {}) });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
    if (e.key === 'Escape' && onCancel) onCancel();
  };

  if (!signedIn) {
    return (
      <Link
        to={signInHref(`${location.pathname}${location.search}`)}
        className="block rounded-xl border border-dashed border-line-2 px-4 py-4 text-sm text-ink-3! no-underline transition-colors duration-150 hover:border-line-strong hover:text-ink-0!"
      >
        <span className="font-medium text-accent">Sign in</span> to join the conversation.
      </Link>
    );
  }

  return (
    <div>
      <form
        onSubmit={send}
        className="rounded-xl border border-line-2 bg-panel transition-colors duration-150 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20"
      >
        <textarea
          aria-label={placeholder}
          rows={compact ? 2 : 3}
          autoFocus={autoFocus}
          maxLength={3000}
          value={body}
          onChange={e => setBody(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className="block w-full resize-none appearance-none border-0! bg-transparent px-4 pt-3 text-sm text-ink-0 shadow-none! outline-none! ring-0! placeholder:text-ink-4 focus:border-0! focus:shadow-none! focus:outline-none! focus:ring-0!"
        />
        <div className="flex items-center justify-end gap-2 px-3 pb-3">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="h-8 cursor-pointer rounded-md px-3 text-xs font-medium text-ink-3 transition-colors duration-150 hover:text-ink-0"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={empty || pending}
            aria-label="Post comment"
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-full bg-accent text-white transition-colors duration-150 hover:bg-accent-hover disabled:cursor-default disabled:bg-line disabled:text-ink-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
          >
            <ArrowUpIcon className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </form>
      {fetcher.data?.error && <p className="mt-1.5 text-xs text-rose-ink">{fetcher.data.error}</p>}
    </div>
  );
}
