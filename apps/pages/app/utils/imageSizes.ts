/**
 * How wide an image will actually be laid out, as a `sizes` hint.
 *
 * A responsive `srcset` is only as good as the `sizes` beside it: without one
 * the browser assumes `100vw` and downloads the widest rung it can justify. One
 * global constant therefore is not enough — a 64px avatar and a full-column
 * hero are not the same image, and telling the browser they are is how a
 * profile card ends up fetching a 2560px JPEG.
 *
 * Restated here rather than imported from `@classmoji/services`: these values
 * are read in CLIENT components, and that package pulls in Prisma. The service
 * carries the same default beside the reasoning for it, and the class-site
 * render — which is server-side — uses that one.
 */

/**
 * The default: an image block is laid out at the full width of the article
 * column, and the widest column the editor offers is `max-w-7xl`. 1024px is the
 * middle of the column range and errs one rung low rather than high, which
 * costs a slightly softer image on the widest setting and saves a 2560px
 * download on every other one.
 */
export const IMAGE_SIZES = '(max-width: 1024px) 100vw, 1024px';

/**
 * A profile card's avatar is a fixed 64px circle (`.profile-avatar-image` in
 * blocknote-overrides.css). Saying so is what makes the smallest rung the one
 * the browser picks, even on a 3x display.
 */
export const AVATAR_SIZES = '64px';

/**
 * The hint for one image block, given the width the author resized it to.
 *
 * BlockNote's `previewWidth` is a per-image pixel width set by dragging the
 * resize handles, and it is a CAP, not a floor — the block still shrinks with
 * a narrow viewport. `min(100vw, Npx)` is exactly that: never wider than the
 * author asked for, never wider than the screen.
 *
 * Absent (the author never resized), zero, or nonsense falls back to the
 * full-column default.
 */
export function imageSizesFor(previewWidth?: number | null): string {
  if (typeof previewWidth !== 'number' || !Number.isFinite(previewWidth) || previewWidth <= 0) {
    return IMAGE_SIZES;
  }
  return `min(100vw, ${Math.round(previewWidth)}px)`;
}

/**
 * The `srcSet`/`sizes` pair for one image, or nothing.
 *
 * The lookup and the hint decided in ONE place, because the two surfaces that
 * render an image disagree about the key and must not also disagree about the
 * rest. In the editor the block still holds the STORED reference and the
 * display URL rides beside it, so `key` is the reference. On the class site the
 * document is rewritten to signed URLs before it is rendered, so `key` is the
 * signed URL. Same map shape, same decision, two keys.
 *
 * Returned together or not at all: a `srcSet` with no `sizes` makes the browser
 * assume the image fills the viewport and fetch the widest rung, which is worse
 * than shipping no candidates at all.
 *
 * `sizes` may be given outright (a fixed-size slot like an avatar) or derived
 * from the block's `previewWidth`.
 */
export function responsiveImageAttrs(
  srcSets: Record<string, string> | null | undefined,
  key: string | null | undefined,
  sizes: string
): { srcSet: string; sizes: string } | Record<string, never> {
  if (!srcSets || typeof key !== 'string' || key.length === 0) return {};
  const srcSet = srcSets[key];
  return srcSet ? { srcSet, sizes } : {};
}
