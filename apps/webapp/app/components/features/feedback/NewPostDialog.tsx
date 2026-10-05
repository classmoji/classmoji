import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useFetcher, useNavigate } from 'react-router';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { GlobeIcon, LinkIcon, XIcon } from 'lucide-react';
import { FEEDBACK_ACTION } from './feedback';

/** The title and description are bare text on the card, like a document. */
const bare =
  'appearance-none border-0! bg-transparent p-0 shadow-none! outline-none! ring-0! focus:border-0! focus:shadow-none! focus:outline-none! focus:ring-0!';

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export function NewPostDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reduced = useReducedMotion();
  const navigate = useNavigate();
  const fetcher = useFetcher<{ ok?: boolean; error?: string; postId?: string }>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState('');
  const sent = useRef(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const pending = fetcher.state !== 'idle';

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBody('');
    setAnonymous(false);
    setError('');
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Go to the new post once it exists; show the server's reason if refused.
  useEffect(() => {
    if (!sent.current || fetcher.state !== 'idle') return;
    sent.current = false;
    if (fetcher.data?.postId) {
      onClose();
      navigate(`/feedback/p/${fetcher.data.postId}`);
    } else if (fetcher.data?.error) {
      setError(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data, navigate, onClose]);

  /** Puts `[link text](https://)` at the cursor and selects the label to type over. */
  const insertLink = () => {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const label = body.slice(start, end) || 'link text';
    const snippet = `[${label}](https://)`;
    setBody(body.slice(0, start) + snippet + body.slice(end));
    // After React writes the new value, so the selection lands on it.
    window.setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(start + 1, start + 1 + label.length);
    });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (title.trim().length < 3) {
      setError('Give your post a short title.');
      return;
    }
    if (!body.trim()) {
      setError('Add a few details so others understand the request.');
      return;
    }
    sent.current = true;
    fetcher.submit(
      {
        intent: 'create-post',
        title: title.trim(),
        body: body.trim(),
        anonymous: String(anonymous),
      },
      { method: 'post', action: FEEDBACK_ACTION }
    );
  };

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto px-4 pt-[12vh]">
          <motion.div
            aria-hidden
            onClick={onClose}
            className="fixed inset-0 bg-[#0A0D17]/40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15, ease: EASE_OUT }}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-post-title"
            className="relative w-full max-w-[680px] rounded-2xl bg-panel shadow-[0_10px_30px_rgba(20,25,50,0.12),0_2px_6px_rgba(20,25,50,0.06)] ring-1 ring-stone-200 dark:ring-neutral-800"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
          >
            <form onSubmit={onSubmit} noValidate className="px-7 pb-6 pt-6">
              <div className="flex items-start justify-between gap-4">
                <span className="inline-flex items-center gap-2 rounded-full border border-line bg-stone-50 px-3.5 py-1.5 text-[13px] font-medium text-ink-1 dark:bg-neutral-800/60">
                  <span aria-hidden>💡</span>
                  Feature Request
                </span>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-panel-hover hover:text-ink-0"
                >
                  <XIcon className="h-4 w-4" aria-hidden />
                </button>
              </div>

              <h2 id="new-post-title" className="sr-only">
                Create a new post
              </h2>
              <input
                id="post-title"
                aria-label="Title"
                autoFocus
                maxLength={120}
                value={title}
                onChange={e => {
                  setTitle(e.target.value);
                  if (error) setError('');
                }}
                placeholder="Title of your request"
                aria-describedby={error ? 'post-error' : undefined}
                className={`mt-6 w-full ${bare} text-2xl font-bold tracking-tight text-ink-0 placeholder:text-ink-4`}
              />
              <textarea
                id="post-body"
                ref={bodyRef}
                aria-label="Description"
                rows={12}
                maxLength={5000}
                value={body}
                onChange={e => {
                  setBody(e.target.value);
                  if (error) setError('');
                }}
                required
                placeholder="Describe your request..."
                className={`mt-4 min-h-[340px] w-full resize-y ${bare} text-sm leading-relaxed text-ink-1 placeholder:text-ink-4`}
              />

              <div className="mt-2 flex items-center gap-3 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={insertLink}
                  title="Add a link"
                  aria-label="Add a link"
                  className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-panel-hover hover:text-ink-0"
                >
                  <LinkIcon className="h-4 w-4" aria-hidden />
                </button>
                <span className="text-[12px] text-ink-4">Links you paste become clickable.</span>
              </div>

              {error && (
                <p id="post-error" role="alert" className="mt-2 text-[13px] text-rose-ink">
                  {error}
                </p>
              )}

              <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
                <div className="flex flex-col gap-2 text-[13px] text-ink-3">
                  <span className="inline-flex items-center gap-2">
                    <GlobeIcon className="h-4 w-4" aria-hidden />
                    {anonymous
                      ? 'Everyone can see this, but not who posted it.'
                      : 'Everyone can see this.'}
                  </span>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-ink-2">
                    <input
                      type="checkbox"
                      checked={anonymous}
                      onChange={e => setAnonymous(e.target.checked)}
                      className="h-4 w-4 cursor-pointer accent-[var(--color-accent)]"
                    />
                    Post anonymously
                  </label>
                </div>
                <button
                  type="submit"
                  disabled={pending}
                  className="h-10 cursor-pointer rounded-full bg-accent px-6 text-[13px] font-semibold text-white transition-colors duration-150 hover:bg-accent-hover disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
                >
                  {pending ? 'Posting…' : 'Create a new post'}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
