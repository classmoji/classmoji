import { IconFileText, IconPresentation } from '@tabler/icons-react';

/**
 * A published page or slide deck linked to a coursework row's assignment, with
 * where it opens (built on the server: `courseworkMaterials.server`).
 */
export interface CourseworkMaterial {
  kind: 'PAGE' | 'SLIDE';
  id: string;
  title: string;
  /** The pages app for a page, the slides app for a deck. */
  href: string;
}

// A fixed cap, not just max-w-full: in the Assignments table (auto layout) a
// percentage never limits a cell's minimum width, so a long title would widen
// the column instead of truncating, as the repo link beside it avoids too.
const materialLink =
  'inline-flex items-center gap-1 min-w-0 max-w-[14rem] text-xs text-accent-ink! hover:underline underline-offset-2';

/**
 * The pages and decks linked to a row's assignment, one wrapping line of small
 * links under the row's module (the dashboard's Up next and the Assignments
 * page). Both open whole, in a new tab: a page in the pages app, a deck in the
 * slides app. A page is deliberately not a PageLink: these are the material to
 * work from, and the peek drawer covered only half the screen. Nothing is
 * drawn for a row with none.
 */
const CourseworkMaterials = ({ materials }: { materials: CourseworkMaterial[] }) => {
  if (materials.length === 0) return null;
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 min-w-0">
      {materials.map(m => {
        const content = (
          <>
            {m.kind === 'PAGE' ? (
              <IconFileText size={12} className="shrink-0" aria-hidden />
            ) : (
              <IconPresentation size={12} className="shrink-0" aria-hidden />
            )}
            <span className="truncate">{m.title}</span>
          </>
        );
        return (
          <a
            key={`${m.kind === 'PAGE' ? 'page' : 'slide'}-${m.id}`}
            href={m.href}
            target="_blank"
            rel="noreferrer"
            title={m.title}
            className={materialLink}
          >
            {content}
          </a>
        );
      })}
    </div>
  );
};

export default CourseworkMaterials;
