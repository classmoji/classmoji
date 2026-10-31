import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useFetcher, useNavigate } from 'react-router';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { GlobeIcon, LinkIcon, XIcon } from 'lucide-react';
import type { FeedbackCategory } from '@prisma/client';
import {
  CATEGORY_EMOJI,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  FEEDBACK_ACTION,
  STATUS_META,
} from './feedback';
import type { FeedbackStatus } from '@prisma/client';

/** A post like the one being written, from GET /api/feedback?similar=. */
interface SimilarPost {
  id: string;
  title: string;
  category: FeedbackCategory;
  status: FeedbackStatus | null;
  vote_count: number;
  comment_count: number;
}

const SIMILAR_HEADING: Record<FeedbackCategory, string> = {
  FEATURE: 'Already suggested? Upvote it instead',
  BUG: 'Already reported? Upvote it instead',
  QUESTION: 'Already asked? See the answers',
};

/** The Github bug template's fields (.github/ISSUE_TEMPLATE/bug_report.yml). */
const EMPTY_BUG = { whatHappened: '', expected: '', steps: '', additionalInfo: '' };

/** "Chrome 132 on macOS", added to a bug report so nobody has to look it up. */
const describeBrowser = () => {
  if (typeof navigator === 'undefined') return '';
  const ua = navigator.userAgent;
  const browser =
    ua.match(/Edg\/(\d+)/)?.[1] != null
      ? `Edge ${ua.match(/Edg\/(\d+)/)?.[1]}`
      : ua.match(/Firefox\/(\d+)/)
        ? `Firefox ${ua.match(/Firefox\/(\d+)/)?.[1]}`
        : ua.match(/Chrome\/(\d+)/)
          ? `Chrome ${ua.match(/Chrome\/(\d+)/)?.[1]}`
          : ua.match(/Version\/(\d+).*Safari/)
            ? `Safari ${ua.match(/Version\/(\d+)/)?.[1]}`
            : 'Unknown browser';
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown OS';
  return `${browser} on ${os}`;
};

const fieldClass =
  'w-full resize-y rounded-lg border border-line bg-panel px-3 py-2.5 text-sm leading-relaxed text-ink-1 placeholder:text-ink-4 focus:border-accent focus:outline-none';

/** The title and description are bare text on the card, like a document. */
const bare =
  'appearance-none border-0! bg-transparent p-0 shadow-none! outline-none! ring-0! focus:border-0! focus:shadow-none! focus:outline-none! focus:ring-0!';

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export function NewPostDialog({
  open,
  onClose,
  initialCategory = null,
}: {
  open: boolean;
  onClose: () => void;
  /** Picked in advance (the help dialog's links); otherwise the author picks. */
  initialCategory?: FeedbackCategory | null;
}) {
  const reduced = useReducedMotion();
  const navigate = useNavigate();
  const fetcher = useFetcher<{ ok?: boolean; error?: string; postId?: string }>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  // No default: a type picked for them is how questions and bugs ended up
  // filed as feature requests.
  const [category, setCategory] = useState<FeedbackCategory | null>(initialCategory);
  const [bug, setBug] = useState(EMPTY_BUG);
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState('');
  // No type picked on submit: shown at the cards, not at the bottom of the form.
  const [typeMissing, setTypeMissing] = useState(false);
  const firstTypeRef = useRef<HTMLButtonElement>(null);
  const sent = useRef(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const pending = fetcher.state !== 'idle';
  const similar = useFetcher<{ posts: SimilarPost[] }>();
  const isBug = category === 'BUG';

  // Posts like the title being typed, so a vote goes to the one that exists
  // instead of a copy that splits it. Debounced; same type only.
  useEffect(() => {
    const q = title.trim();
    if (!open || !category || q.length < 4) return;
    const timer = window.setTimeout(() => {
      similar.load(
        `${FEEDBACK_ACTION}?similar=${encodeURIComponent(q)}&type=${category.toLowerCase()}`
      );
    }, 350);
    return () => window.clearTimeout(timer);
    // `similar` is stable per mount; listing it would re-run on every load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, category, open]);
  const similarPosts = title.trim().length >= 4 && category ? (similar.data?.posts ?? []) : [];

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setBody('');
    setBug(EMPTY_BUG);
    setCategory(initialCategory);
    setTypeMissing(false);
    setAnonymous(false);
    setError('');
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, initialCategory]);

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
    if (!category) {
      setTypeMissing(true);
      firstTypeRef.current?.focus();
      return;
    }
    if (title.trim().length < 3) {
      setError('Give your post a short title.');
      return;
    }
    if (isBug && (!bug.whatHappened.trim() || !bug.expected.trim())) {
      setError('Say what happened and what should have happened.');
      return;
    }
    if (!isBug && !body.trim()) {
      setError('Add a few details so others understand your post.');
      return;
    }
    const browser = describeBrowser();
    sent.current = true;
    fetcher.submit(
      {
        intent: 'create-post',
        title: title.trim(),
        category,
        anonymous: String(anonymous),
        ...(isBug
          ? {
              bug_what_happened: bug.whatHappened.trim(),
              bug_expected: bug.expected.trim(),
              bug_steps: bug.steps.trim(),
              bug_additional_info: [bug.additionalInfo.trim(), browser && `Browser: ${browser}`]
                .filter(Boolean)
                .join('\n'),
            }
          : { body: body.trim() }),
      },
      { method: 'post', action: FEEDBACK_ACTION }
    );
  };

  const bugField = (
    key: keyof typeof EMPTY_BUG,
    label: string,
    hint: string,
    placeholder: string,
    rows: number,
    required = false
  ) => (
    <div className="flex flex-col gap-1">
      <label htmlFor={`bug-${key}`} className="text-[13px] font-semibold text-ink-1">
        {label}
        {required && (
          <span className="ml-0.5 text-rose-ink" aria-hidden>
            *
          </span>
        )}
      </label>
      <span id={`bug-${key}-hint`} className="text-[12px] text-ink-3">
        {hint}
      </span>
      <textarea
        id={`bug-${key}`}
        rows={rows}
        maxLength={3000}
        required={required}
        aria-describedby={`bug-${key}-hint`}
        value={bug[key]}
        onChange={e => {
          setBug({ ...bug, [key]: e.target.value });
          if (error) setError('');
        }}
        placeholder={placeholder}
        className={fieldClass}
      />
    </div>
  );

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
              <div className="flex items-center justify-between gap-4">
                <h2 id="post-type-heading" className="text-[15px] font-semibold text-ink-0">
                  What kind of post is this?
                </h2>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label="Close"
                  className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-panel-hover hover:text-ink-0"
                >
                  <XIcon className="h-4 w-4" aria-hidden />
                </button>
              </div>
              {/* The type is the first decision, so it gets the first row and
                  full-size cards: as small chips it was easy to miss. */}
              <div
                role="radiogroup"
                aria-labelledby="post-type-heading"
                aria-describedby={typeMissing ? 'post-type-error' : undefined}
                aria-invalid={typeMissing || undefined}
                className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3"
              >
                {CATEGORY_ORDER.map((c, i) => {
                  const picked = category === c;
                  return (
                    <button
                      key={c}
                      ref={i === 0 ? firstTypeRef : undefined}
                      type="button"
                      role="radio"
                      aria-checked={picked}
                      onClick={() => {
                        setCategory(c);
                        setTypeMissing(false);
                        if (error) setError('');
                      }}
                      className={`flex cursor-pointer items-center justify-center rounded-xl border px-3.5 py-3 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
                        picked
                          ? 'border-accent bg-accent-soft ring-1 ring-accent'
                          : typeMissing
                            ? 'border-rose-ink bg-panel hover:bg-panel-hover'
                            : 'border-line bg-panel hover:border-line-strong hover:bg-panel-hover'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2 text-[14px] font-semibold text-ink-0">
                        <span aria-hidden>{CATEGORY_EMOJI[c]}</span>
                        {CATEGORY_LABELS[c]}
                      </span>
                    </button>
                  );
                })}
              </div>
              {typeMissing && (
                <p
                  id="post-type-error"
                  role="alert"
                  className="mt-2.5 rounded-lg bg-rose-bg px-3 py-2 text-[13px] font-medium text-rose-ink dark:bg-rose-950/40"
                >
                  Pick what kind of post this is.
                </p>
              )}

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
                placeholder={
                  category === 'BUG'
                    ? 'What went wrong?'
                    : category === 'QUESTION'
                      ? 'What would you like to know?'
                      : 'Title of your post'
                }
                aria-describedby={error ? 'post-error' : undefined}
                className={`mt-6 w-full ${bare} text-2xl font-bold tracking-tight text-ink-0 placeholder:text-ink-4`}
              />
              {similarPosts.length > 0 && category && (
                <section
                  aria-label="Similar posts"
                  className="mt-4 rounded-xl bg-amber-bg px-4 py-3 dark:bg-amber-900/30"
                >
                  <p className="m-0 text-[12px] font-semibold text-amber-ink">
                    {SIMILAR_HEADING[category]}
                  </p>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {similarPosts.map(post => (
                      <li key={post.id} className="text-[13px]">
                        <Link
                          to={`/feedback/p/${post.id}`}
                          onClick={onClose}
                          className="font-medium text-accent! no-underline hover:underline"
                        >
                          {post.title}
                        </Link>
                        <span className="text-ink-3">
                          {' '}
                          · {post.status ? STATUS_META[post.status].label : 'Open'} ·{' '}
                          {post.vote_count} {post.vote_count === 1 ? 'vote' : 'votes'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {isBug ? (
                <div className="mt-5 flex flex-col gap-4">
                  {bugField(
                    'whatHappened',
                    'What happened?',
                    'A clear description of the bug',
                    'Example: When I click the grade export button, nothing happens',
                    3,
                    true
                  )}
                  {bugField(
                    'expected',
                    'What should have happened?',
                    'What did you expect to happen instead?',
                    'Example: It should download a CSV file with grades',
                    2,
                    true
                  )}
                  {bugField(
                    'steps',
                    'Steps to reproduce',
                    'How can we reproduce this bug?',
                    "1. Go to classroom settings\n2. Click on 'Export Grades'\n3. See error",
                    3
                  )}
                  {bugField(
                    'additionalInfo',
                    'Additional info',
                    'Error messages or anything else that helps. Your browser is added for you.',
                    '',
                    2
                  )}
                </div>
              ) : (
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
                  placeholder={
                    category === 'QUESTION'
                      ? 'What are you trying to do, and where are you stuck?'
                      : 'Add the details...'
                  }
                  className={`mt-4 min-h-[300px] w-full resize-y ${bare} text-sm leading-relaxed text-ink-1 placeholder:text-ink-4`}
                />
              )}

              <div className="mt-2 flex items-center gap-3 border-t border-line pt-3">
                {!isBug && (
                  <button
                    type="button"
                    onClick={insertLink}
                    title="Add a link"
                    aria-label="Add a link"
                    className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-ink-3 transition-colors duration-150 hover:bg-panel-hover hover:text-ink-0"
                  >
                    <LinkIcon className="h-4 w-4" aria-hidden />
                  </button>
                )}
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
                      : 'Everyone can see this.'}{' '}
                    Leave out student names, emails and grades.
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
                  {pending
                    ? 'Posting…'
                    : category === 'QUESTION' && similarPosts.length > 0
                      ? 'None of these, ask anyway'
                      : 'Create a new post'}
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
