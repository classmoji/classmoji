/**
 * slideDocumentAccess.ts — the two path rules the legacy content proxy needs
 * now that a slide can BE a document.
 *
 * `/content/{org}/{repo}/{path}` authorizes a PATH against a REPO: prove the
 * caller belongs to a classroom that owns this content repo (or that a public
 * slide in it points at this path) and the bytes are served. That is the right
 * rule for what the route was built for — a deck's `index.html`, its images and
 * the shared theme CSS, all of which are assets OF a deck rather than things
 * with visibility settings of their own.
 *
 * An uploaded FILE slide is not that. Its document sits in the same repo, at
 * `slides/<slug>/<name>.pdf`, and the slide row carries its own draft / private
 * / public setting — the same one `/{slideId}` enforces. So the proxy has to
 * ask the slide, not the repo, and that question is answered here.
 *
 * ## Pure, and deliberately so
 *
 * Nothing in this file imports Prisma or `@classmoji/services`. The lookup and
 * the access check arrive as callbacks, which is why `tests/unit` can pin the
 * rule — a draft document refused, a public one redirected — without a database
 * or a dev stack.
 */

import { nonDeckHeaders } from './slideKind';

/**
 * Is `path` INSIDE `contentPath` (or is it that path itself)?
 *
 * The separator is the whole point. A bare `startsWith` on `slides/week-1`
 * also matches `slides/week-10/anything`, so a slide whose slug is a prefix of
 * another's would authorize the other one's folder — and slugs are chosen by
 * instructors, who number weeks and lectures exactly that way.
 */
export function isWithinContentPath(path: string, contentPath: string | null | undefined): boolean {
  if (!contentPath) return false;
  return path === contentPath || path.startsWith(`${contentPath}/`);
}

/**
 * Could this path be a slide document AT ALL?
 *
 * The rule below costs a query, and the proxy serves fonts, stylesheets and
 * images by the dozen per page — it caches memberships for eight hours
 * precisely so that an asset request touches no database. A slide document
 * always ends in one of the upload policy's extensions, so this filter answers
 * "no" for every one of those assets before anything is looked up.
 *
 * The extension list is passed in rather than restated, so it cannot fall
 * behind the policy that produced the filename.
 */
export function couldBeSlideDocument(path: string, extensions: readonly string[]): boolean {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return extensions.includes(name.slice(dot + 1).toLowerCase());
}

/** The least a slide row has to carry for the rule below to act on it. */
export interface FileSlideRef {
  id: string;
}

/**
 * What the proxy should do about this path.
 *
 * `pass` is "no file slide claims it" — the ordinary case, and the one every
 * deck asset takes. `redirect` and `refuse` are the two halves of the slide's
 * own view gate.
 */
export type SlideDocumentDecision =
  | { outcome: 'pass' }
  | { outcome: 'redirect'; response: Response }
  | { outcome: 'refuse' };

/**
 * Apply a FILE slide's own view gate to a request for its document.
 *
 * More than one slide can answer: a content repo is shared across a whole
 * GitHub org in the legacy fallback, so one path can belong to a classroom the
 * caller is staff in and to one they are not in at all. Every match is checked
 * and the first that admits this viewer wins — refusing because the SECOND row
 * said no would hide a document its owner is looking straight at.
 *
 * A caller that passes the gate is sent to `/{slideId}` rather than served from
 * here. That route is the one that knows the document's real filename, signs a
 * short-lived URL for it where the delivery layer is on, and marks the answer
 * `no-store`; proxying the bytes instead would put a private classroom's
 * document into a cache keyed on nothing but a repo path.
 */
export async function slideDocumentDecision<T extends FileSlideRef>({
  path,
  classroomIds,
  extensions,
  findFileSlides,
  assertView,
}: {
  path: string;
  classroomIds: readonly string[];
  extensions: readonly string[];
  findFileSlides: (classroomIds: readonly string[], path: string) => Promise<T[]>;
  assertView: (slide: T) => Promise<unknown>;
}): Promise<SlideDocumentDecision> {
  if (classroomIds.length === 0) return { outcome: 'pass' };
  if (!couldBeSlideDocument(path, extensions)) return { outcome: 'pass' };

  const slides = await findFileSlides(classroomIds, path);
  if (slides.length === 0) return { outcome: 'pass' };

  for (const slide of slides) {
    try {
      await assertView(slide);
    } catch {
      continue;
    }
    return { outcome: 'redirect', response: slideDocumentRedirect(slide.id) };
  }

  return { outcome: 'refuse' };
}

/** The hop to the gated viewer route, carrying the non-deck headers with it. */
export function slideDocumentRedirect(slideId: string): Response {
  return new Response(null, {
    status: 302,
    headers: nonDeckHeaders({ Location: `/${encodeURIComponent(slideId)}` }),
  });
}
