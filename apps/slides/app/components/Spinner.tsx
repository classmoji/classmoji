/**
 * Spinner — the one piece of motion that says "still working".
 *
 * Pure SVG, drawn in `currentColor`, so it takes the colour of whatever it sits
 * in: white inside `.btn-primary`, accent green inside the upload panel. Size is
 * a className (`h-4 w-4`), like every other icon on these screens. No
 * dependency, no image, nothing to load.
 *
 * ## Reduced motion
 *
 * `animate-spin` is Tailwind's rotation. `.cm-spinner` (defined in
 * `~/styles/tailwind.css`) replaces it with a slow opacity fade under
 * `@media (prefers-reduced-motion: reduce)` — nothing rotates. The label beside
 * a spinner always says what is happening in words, so the motion is never the
 * only carrier of that news.
 *
 * ## Announcing it
 *
 * By default this is a live region (`role="status"`) with visually hidden text,
 * which is what a spinner standing on its own needs. Pass `label={null}` where
 * the surrounding UI already says it — inside a button whose text reads
 * "Uploading…", or inside an `aria-live` panel — so a screen reader hears it
 * once instead of twice.
 */

export function Spinner({
  className = 'h-4 w-4',
  label = 'Loading…',
}: {
  /** Sizing/colour utilities for the SVG itself. */
  className?: string;
  /** Visually hidden status text, or `null` for a decorative spinner. */
  label?: string | null;
}) {
  const svg = (
    <svg
      className={`cm-spinner animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      {/* The track, then the arc that reads as the moving part. */}
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );

  if (label === null) return svg;

  return (
    <span role="status" className="inline-flex">
      {svg}
      <span className="sr-only">{label}</span>
    </span>
  );
}

export default Spinner;
