/**
 * The delivery answer's vocabulary, in a module with NO IMPORTS.
 *
 * ── Why this is not declared next to the route that produces it ────────────
 * `delivery.ts` is a resource route, and it imports Prisma. Importing anything
 * from it — even `import type`, whose erasure is a compiler detail rather than
 * a graph one — puts an edge from the fill page into that module, and the fill
 * page HAS a client bundle. Vite then follows the edge, tries to resolve
 * `@prisma/client` for the browser, and fails:
 *
 *   Failed to resolve entry for package "@prisma/client"
 *
 * The damage is not limited to this page. That failure breaks the client build
 * for the surrounding routes, so an unrelated admin page stops hydrating and
 * its controls quietly do nothing — which is exactly how it was found: the
 * builder's close-time input stopped saving whenever the bounce specs had run
 * first.
 *
 * A leaf module with no imports cannot pull anything anywhere, so both sides
 * can share the vocabulary without the server's dependencies following it.
 */

export type DeliveryState =
  /**
   * Nothing to report. Covers, DELIBERATELY INDISTINGUISHABLY: in flight,
   * delivered, no webhook configured, no cookie, an id naming nothing, and a
   * client that has walked past the distinct-address ceiling.
   */
  | 'pending'
  /** The provider could not deliver it. The one thing worth interrupting for. */
  | 'bounced'
  /**
   * WE never managed to send it — the dispatch failed outright, so no message
   * reached the provider at all.
   *
   * Kept separate from `bounced` because the copy must not lie about whose
   * fault it was and the recovery differs: a bounce says "that address did not
   * accept mail" and is usually a typo to fix; this says "we did not get it
   * out" and is usually worth simply asking again. The same weight, though —
   * from where the respondent sits, both mean the link is not coming.
   */
  | 'failed'
  /** Delayed, and still trying. Worth a softer word, not an alarm. */
  | 'delayed';

export interface DeliveryStatus {
  state: DeliveryState;
}
