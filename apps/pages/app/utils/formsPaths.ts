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
  if (segments.length < 2 || segments[1].toLowerCase() !== 'forms') return null;

  /**
   * Lower-cased before the set lookups, because the ROUTER is case-insensitive
   * about these and this function was not — and it disagreed in both directions.
   *
   *  - `/cs52/forms/NEW` resolved to the admin new-form drawer and classified as
   *    PUBLIC, exempting an admin surface from the login redirect;
   *  - `/cs52/forms/waitlist/VERIFY` served the magic-link page and classified
   *    as ADMIN, so a link whose case a mail client had touched demanded a
   *    Classmoji account from someone who has never had one.
   *
   * Only the SUBPATH names are folded. The slug itself is never compared here,
   * and the raw-not-decoded rule above still stands: `%4eEW` is not `NEW`.
   */
  const rest = segments.slice(2).map(segment => segment.toLowerCase());

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

/**
 * A form slug as `titleToIdentifier` (and therefore the create path) can
 * produce one: lowercase alphanumerics with interior hyphens.
 *
 * The bridge below validates against it rather than forwarding whatever
 * arrived, because its output goes into a `Location` header. Everything the
 * check accepts is byte-identical decoded and raw, which is what lets the
 * bridge read React Router's already-decoded splat param instead of doing raw
 * path surgery on the request URL.
 */
const FORM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Second-level paths under a form that the class-site bridge forwards.
 *
 * A superset of `PUBLIC_FORM_SUBPATHS`, and deliberately so. `delivery` is a
 * RESOURCE route — the fill page polls it for a bounce — so `root.tsx` never
 * runs for it and `classifyFormsPath` has no reason to exempt it from a login
 * redirect it will never meet. The bridge asks a different question: "does this
 * path belong to the public fill flow", and delivery does. Widening the gate's
 * set to match would exempt a path the gate does not guard, which is a change
 * with no upside; two sets, each answering its own question, is the honest
 * shape.
 */
const BRIDGED_FORM_SUBPATHS: ReadonlySet<string> = new Set([...PUBLIC_FORM_SUBPATHS, 'delivery']);

/**
 * The canonical-host path suffix a class-site request for `/forms/{rest}`
 * should be redirected to, or `null` when this shape is not bridged.
 *
 * `rest` is the splat under `_site/{subdomain}/forms/`. The answer is appended
 * to `/{classroomSlug}/forms/` on the canonical pages host — see
 * `app/site/forms.ts` for why a class site redirects instead of rendering.
 *
 * ADMIN SURFACES ARE NOT BRIDGED. `/forms` (the list), `/forms/new`, and
 * everything under a form that is not a fill surface answer 404 on a site host:
 * a course website is an anonymous, script-less reading surface, and a staff
 * screen reached from it could only bounce the visitor to a login. The
 * one-segment case is passed through `classifyFormsPath` rather than compared
 * against a second copy of the admin names, so an admin path invented later is
 * refused here the moment it is refused there.
 */
export function siteFormsBridgePath(rest: string): string | null {
  const segments = rest.split('/').filter(Boolean);
  // `{slug}` or `{slug}/{subpath}`. `responses/export` is the only deeper shape
  // that exists, and it is an admin one.
  if (segments.length === 0 || segments.length > 2) return null;

  const slug = segments[0];
  if (!FORM_SLUG.test(slug)) return null;
  // Catches `new`; every other RESERVED_FORM_SLUGS entry is refused at create,
  // so a bridged link to one simply finds no form on the far side.
  if (classifyFormsPath(`/_/forms/${slug}`) !== 'public') return null;

  if (segments.length === 1) return slug;

  // Folded for the same reason the gate folds these: a mail client that
  // upper-cased `/verify` must not turn a magic link into a 404.
  const subpath = segments[1].toLowerCase();
  return BRIDGED_FORM_SUBPATHS.has(subpath) ? `${slug}/${subpath}` : null;
}
