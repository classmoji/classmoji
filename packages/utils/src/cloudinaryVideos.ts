/**
 * Which videos in a slides import may go to Cloudinary (browser-safe, pure).
 *
 * Cloudinary hosting is billed per account, so it is a Pro feature. The
 * decision is a pure function here — rather than inline in the import route —
 * so it can be unit tested: `apps/slides` runs Playwright only, and an
 * entitlement gate that nothing asserts is a gate that quietly stops holding.
 *
 * Non-Pro is treated exactly like Cloudinary-not-configured: the caller passes
 * an empty list, `slidesComImporter.server.ts` finds nothing in its
 * `cloudinaryVideoSet`, and every video is committed to the content repo
 * instead. The import DEGRADES rather than failing — a classroom that never had
 * Cloudinary still gets its slides, with its videos served from GitHub.
 *
 * `requested` is attacker-controlled (it arrives as a form field), which is the
 * whole reason this runs server-side on every import. The UI also hides the
 * choice for non-Pro classrooms, but that is cosmetic.
 */
export function cloudinaryVideoSelection({
  isPro,
  configured,
  requested,
}: {
  isPro: boolean;
  configured: boolean;
  requested: readonly string[];
}): string[] {
  if (!isPro || !configured) return [];
  return [...requested];
}
