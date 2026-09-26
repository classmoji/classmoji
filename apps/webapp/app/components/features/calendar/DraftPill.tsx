/**
 * Marks content that is not published yet.
 *
 * Only staff are ever shown such a thing — the calendar service leaves draft
 * pages, draft decks and unpublished assignments out of a student's payload —
 * so this says "your class cannot see this one". The link list, the link
 * pickers in both modals and the month view's starred line all draw it, and
 * they draw the same one: three copies would have drifted the first time the
 * palette moved.
 */

const DraftPill = ({ className = '' }: { className?: string }) => (
  <span
    className={`shrink-0 text-xs px-1.5 py-0.5 rounded bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 font-normal leading-none ${className}`}
  >
    Draft
  </span>
);

export default DraftPill;
