/**
 * The page's cover, read-only: the band `HeaderImage` draws for an editor,
 * without any of its controls (and so without its router fetcher). A
 * rendered preview marks a cover it changes.
 */
export function ReaderCover({
  imageUrl,
  position,
  highlighted = false,
}: {
  imageUrl: string;
  position: number;
  highlighted?: boolean;
}) {
  return (
    <div
      className="page-header-image relative w-full overflow-hidden"
      style={{
        backgroundImage: `url(${imageUrl})`,
        backgroundPosition: `center ${position}%`,
      }}
    >
      {highlighted && (
        <div
          data-testid="preview-cover-changed"
          className="pointer-events-none absolute inset-0 z-10 shadow-[inset_0_0_0_3px_rgb(245,158,11)] dark:shadow-[inset_0_0_0_3px_rgb(251,191,36)]"
        >
          <span className="absolute left-3 top-3 rounded-full bg-amber-500 px-2 py-0.5 text-xs font-semibold text-white dark:bg-amber-400 dark:text-amber-950">
            Cover changed
          </span>
        </div>
      )}
    </div>
  );
}
