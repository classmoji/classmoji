/**
 * Which forms surface (if any) a pathname names — the ONE place the root auth
 * gate learns that `/{classroomSlug}/forms/…` is not a page view.
 *
 * PURE MODULE. No imports, no Prisma, no Request: `root.tsx` runs this on the
 * server before it touches the session, and the spec in
 * `tests/unit/forms-paths.spec.ts` runs it in the Playwright runner with no
 * browser and no dev stack — the same shape as `server/siteHost.ts` and its
 * spec, which carry the class-sites security boundary.
 *
 * ── Why the gate needs this at all ─────────────────────────────────────────
 * The root loader's page-view branch matches ANY two-segment path
 * (`/^\/([^/]+)\/([^/]+)$/`) and looks the second segment up as a Page id. Left
 * alone, an anonymous GET of `/cs52/forms` runs `page.findUnique({ id:
 * 'forms' })` — a pointless query on every request, and a branch whose "is this
 * public?" answer has nothing to do with forms. Classifying first is what stops
 * that misfire.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * ADMIN paths still require a session; the gate keeps redirecting anonymous
 * callers to the webapp login exactly as before. Only the PUBLIC fill surfaces
 * are exempted, because a waitlist link has to open for someone who has never
 * heard of Classmoji.
 *
 *   /{class}/forms                 admin — the list
 *   /{class}/forms/new             admin — the new-form drawer
 *   /{class}/forms/{slug}          public — fill
 *   /{class}/forms/{slug}/verify   public — magic-link review + confirm
 *   /{class}/forms/{slug}/edit     admin — the builder
 *   /{class}/forms/{slug}/…        admin — anything else, deliberately
 *
 * The last line is the safety property: an unrecognized shape classifies as
 * ADMIN, so a future route added under the subtree requires a session until
 * someone deliberately lists it as public here. Failing the other way — "not a
 * shape I know, so let it through" — is how exemptions rot into holes.
 *
 * `edit`, `responses` and `new` can never collide with a real form slug:
 * `RESERVED_FORM_SLUGS` in form.service refuses them at create.
 */

export type FormsRouteKind = 'admin' | 'public';

/** Second-level paths under a form that anyone may reach without a session. */
const PUBLIC_FORM_SUBPATHS: ReadonlySet<string> = new Set(['verify']);

/** First-level paths under `/forms` that are admin surfaces, not form slugs. */
const ADMIN_FORM_SUBPATHS: ReadonlySet<string> = new Set(['new']);

/**
 * Strip React Router's single-fetch suffix. A client-side navigation to
 * `/cs52/forms/waitlist` fetches `/cs52/forms/waitlist.data`, which must be
 * classified the same way as the document request — otherwise the first render
 * is public and every subsequent navigation demands a login.
 */
function stripDataSuffix(pathname: string): string {
  return pathname.endsWith('.data') ? pathname.slice(0, -'.data'.length) : pathname;
}

/**
 * Path segments, with empty ones dropped so a trailing slash, a doubled slash,
 * or `.data` never changes the answer.
 *
 * Segments are compared RAW, never decoded: `%66orms` must not be accepted as
 * `forms`. It falls through to `null` and the caller's ordinary auth path,
 * which is the safe end of the ambiguity.
 */
function segmentsOf(pathname: string): string[] {
  return stripDataSuffix(pathname).split('/').filter(Boolean);
}

/**
 * `'admin'`, `'public'`, or `null` when the path is not in the forms subtree at
 * all (in which case the caller's existing gate logic applies unchanged).
 */
export function classifyFormsPath(pathname: string): FormsRouteKind | null {
  const segments = segmentsOf(pathname);
  if (segments.length < 2 || segments[1] !== 'forms') return null;

  const rest = segments.slice(2);

  // /{class}/forms — the admin list.
  if (rest.length === 0) return 'admin';

  // /{class}/forms/new — the drawer, a child of the list.
  if (rest.length === 1 && ADMIN_FORM_SUBPATHS.has(rest[0])) return 'admin';

  // /{class}/forms/{slug} — the fill page.
  if (rest.length === 1) return 'public';

  // /{class}/forms/{slug}/verify — the magic-link review page.
  if (rest.length === 2 && PUBLIC_FORM_SUBPATHS.has(rest[1])) return 'public';

  // Everything else in the subtree: the builder, the responses view, and any
  // shape not yet invented. Session required.
  return 'admin';
}

/** True for the paths the root gate exempts from the login redirect. */
export function isPublicFormsPath(pathname: string): boolean {
  return classifyFormsPath(pathname) === 'public';
}

/** True for any path inside the forms subtree, public or admin. */
export function isFormsPath(pathname: string): boolean {
  return classifyFormsPath(pathname) !== null;
}
