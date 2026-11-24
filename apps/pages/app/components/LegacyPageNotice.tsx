import { LEGACY_PAGE_NOTICE } from '~/utils/legacyPage.ts';

/**
 * The staff notice on a page git still holds in the old format (see
 * `utils/legacyPage.ts`), above the empty page. The amber notice bar the pages
 * editor uses for its other notices (`components/editor/collab/LiveNotices.tsx`);
 * on the class site, which has no sticky chrome, it sits in the article as a
 * box. Plain markup, no state: the class site renders it without a client
 * bundle.
 */
export function LegacyPageNotice({
  layout,
  isEmbedded = false,
}: {
  layout: 'bar' | 'inline';
  isEmbedded?: boolean;
}) {
  const text = (
    <span className="text-sm font-semibold text-amber-900 dark:text-amber-100">
      {LEGACY_PAGE_NOTICE}
    </span>
  );
  if (layout === 'inline') {
    return (
      <div
        role="status"
        data-testid="legacy-page-notice"
        className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 dark:border-amber-700/70 dark:bg-amber-950/90"
      >
        {text}
      </div>
    );
  }
  return (
    <div
      role="status"
      data-testid="legacy-page-notice"
      className={`sticky ${isEmbedded ? 'top-0' : 'top-12'} z-30`}
    >
      <div className="border-y border-amber-300 dark:border-amber-700/70 bg-amber-50/95 dark:bg-amber-950/90 backdrop-blur px-4 sm:px-6 lg:px-8 py-2">
        {text}
      </div>
    </div>
  );
}
