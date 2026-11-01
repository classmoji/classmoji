import { useEffect, useState } from 'react';
import { XIcon } from 'lucide-react';

const DISMISSED_KEY = 'classmoji.feedbackLaunchBanner.dismissed';

/**
 * A one-time note that the feedback board exists, until the person opens the
 * board or dismisses it (remembered in this browser). Hidden on the server and
 * on first paint, so it never flashes for someone who already dismissed it.
 */
export function FeedbackLaunchBanner() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      setShow(window.localStorage.getItem(DISMISSED_KEY) !== '1');
    } catch {
      // Storage blocked (private mode): skip the banner rather than nag.
    }
  }, []);

  const dismiss = () => {
    setShow(false);
    try {
      window.localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      // Nothing to remember it with; it is gone for this page view.
    }
  };

  if (!show) return null;

  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-accent-soft-2 bg-accent-soft px-4 py-3 text-sm text-accent-ink"
    >
      <p className="m-0 min-w-0 flex-1">
        <strong>New: the Classmoji feedback board.</strong> Report bugs, request features and vote
        on what we build next. Posts are public.
      </p>
      <a
        href="/feedback"
        target="_blank"
        rel="noopener noreferrer"
        onClick={dismiss}
        className="inline-flex h-8 items-center rounded-lg bg-accent! px-3 text-[13px] font-semibold text-white! no-underline hover:bg-accent-hover!"
      >
        Open the board
      </a>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss"
        className="grid h-8 w-8 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-accent-ink hover:bg-accent-soft-2"
      >
        <XIcon className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
