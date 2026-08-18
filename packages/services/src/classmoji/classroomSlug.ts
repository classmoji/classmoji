/**
 * Classroom slug: normalization, deterministic collision candidates, and the
 * constraint-and-retry wrapper that every slug-creating path goes through.
 *
 * `Classroom.slug` is GLOBALLY unique — it is the sole key in every app URL
 * (/admin/:class, /student/:class, the ICS feed, the autograde callback), none
 * of which carry an org segment. Two orgs can therefore legitimately want the
 * same slug. Rather than refuse the second one, a create walks a candidate list
 * and retries on the unique violation.
 *
 * The candidate order is DETERMINISTIC on purpose. A re-import has to land on
 * the slug it landed on last time, or idempotency is gone and every re-run
 * mints another classroom; a random or uuid tail would be unreproducible. The
 * order (bare slug → org-qualified → numeric) also mirrors what the
 * 20260818103726_classroom_slug_global_unique migration did to repair existing
 * duplicates, so a row renamed by that migration and a row created here are
 * named by the same rule.
 *
 * Pure: no Prisma import. The write is supplied by the caller.
 */

/** Highest numeric fallback: `{slug}-2` … `{slug}-11`. */
export const MAX_CLASSROOM_SLUG_SUFFIX = 11;

/**
 * Normalize a string into a classroom slug.
 *
 * Byte-for-byte the rule used by the create wizard, the import wizard, and the
 * slug-repair migration's org-login sanitizer (`lower()`, non-`[a-z0-9]` runs
 * collapse to `-`, edges trimmed). Anything else would mint a slug some other
 * code path cannot reproduce. Doubles as the org-login sanitizer below — the
 * two rules are identical, so they are deliberately one function.
 */
export const slugify = (str: string): string =>
  String(str ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/**
 * The slugs to try, in order, for a new classroom: the bare slug, then
 * `{slug}-{org login}`, then `{slug}-2` … `{slug}-N`.
 *
 * Org-qualified BEFORE numeric: a global collision is almost always two
 * different schools naming a course the same thing, and `cs101-dartmouth-cs52`
 * says which one this is where `cs101-2` says nothing. Returns `[]` when the
 * input has no slug-usable characters at all.
 */
export function classroomSlugCandidates(slug: string, orgLogin: string): string[] {
  const base = slugify(slug);
  if (!base) return [];

  const candidates = [base];
  const org = slugify(orgLogin);
  if (org) candidates.push(`${base}-${org}`);
  for (let n = 2; n <= MAX_CLASSROOM_SLUG_SUFFIX; n++) candidates.push(`${base}-${n}`);
  return candidates;
}

/** Every candidate was taken (or the input had no usable characters). */
export class ClassroomSlugUnavailableError extends Error {
  readonly requestedSlug: string;
  readonly candidates: string[];

  constructor(requestedSlug: string, candidates: string[]) {
    super(
      candidates.length === 0
        ? `'${requestedSlug}' contains no characters usable in a classroom slug.`
        : `No free classroom slug for '${requestedSlug}' — all ${candidates.length} candidates are taken (${candidates.join(', ')}).`
    );
    this.name = 'ClassroomSlugUnavailableError';
    this.requestedSlug = requestedSlug;
    this.candidates = candidates;
  }
}

/**
 * The two unique indexes that a colliding classroom slug can violate, and the
 * field sets Prisma reports for them.
 *
 * Prisma does not pin the shape of `meta.target`: depending on driver and
 * version it is an array of field names (`['git_org_id', 'slug']`), the raw
 * constraint name (`'classrooms_slug_key'`), or that name inside a one-element
 * array. All three are handled.
 *
 * Matching is EXACT on the field set, never "contains slug" — `Team` and
 * `Slide` are both `@@unique([classroom_id, slug])`, and the importer writes
 * both inside the same transaction. A substring match would replay an entire
 * import because one team name collided.
 */
const SLUG_INDEX_NAMES = new Set(['classrooms_slug_key', 'classrooms_git_org_id_slug_key']);
const SLUG_FIELD_SETS = new Set(['slug', 'git_org_id,slug']);

const targetTokens = (target: unknown): string[] => {
  const raw = Array.isArray(target) ? target : typeof target === 'string' ? target.split(',') : [];
  return raw.map(t => String(t).trim().toLowerCase()).filter(Boolean);
};

/**
 * Is this error a unique violation on a CLASSROOM SLUG index specifically?
 *
 * A bare `code === 'P2002'` test is wrong twice over: in create-classroom it
 * would turn the friendly content-repo-collision error into silent slug
 * suffixing, and in the importer it would re-run the whole roster because a
 * user login or a team slug collided. An unrecognized target is treated as NOT
 * a slug conflict — failing loudly beats retrying blind.
 */
export function isClassroomSlugConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;

  const tokens = targetTokens((error as { meta?: { target?: unknown } }).meta?.target);
  if (tokens.length === 0) return false;
  if (tokens.length === 1 && SLUG_INDEX_NAMES.has(tokens[0])) return true;
  return SLUG_FIELD_SETS.has([...tokens].sort().join(','));
}

/**
 * Run `write` with the first classroom slug that isn't already taken.
 *
 * `write` receives the candidate slug and MUST perform the whole write — if it
 * opens an interactive transaction, the `prisma.$transaction(...)` call itself
 * belongs INSIDE this callback, never the other way around. A P2002 raised
 * inside an interactive transaction aborts the whole transaction (Postgres
 * 25P02), so a retry attempted from within it fails every remaining candidate
 * with "current transaction is aborted"; the same reasoning is spelled out at
 * `githubClassroomImport.service.ts` (`resolveImportedUser`). Because the
 * transaction rolls back completely, replaying the callback is safe — but any
 * accumulator the callback mutates (counters, warning lists) must be created
 * INSIDE it so a retry starts from zero.
 *
 * Returns the candidate the successful write used. A callback that may instead
 * update a PRE-EXISTING row (import re-runs) must read the slug off the
 * persisted row rather than trusting this value.
 *
 * @throws ClassroomSlugUnavailableError when every candidate is taken.
 */
export async function createWithUniqueClassroomSlug<T>(
  params: { slug: string; orgLogin: string },
  write: (slug: string) => Promise<T>
): Promise<{ slug: string; result: T }> {
  const candidates = classroomSlugCandidates(params.slug, params.orgLogin);
  if (candidates.length === 0) {
    throw new ClassroomSlugUnavailableError(params.slug, candidates);
  }

  for (const candidate of candidates) {
    try {
      return { slug: candidate, result: await write(candidate) };
    } catch (error: unknown) {
      if (!isClassroomSlugConflict(error)) throw error;
    }
  }

  throw new ClassroomSlugUnavailableError(params.slug, candidates);
}
