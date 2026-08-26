/**
 * Resource link service.
 *
 * A "resource link" associates a page or a slide deck with either a repository
 * (the assignment container — content shows on the repo page) or one specific
 * assignment inside it. Extracted from the web admin.$class.resources action so
 * that the resources kanban and the MCP resource-link tools share this path —
 * same precedent as roster.service.ts, staff.service.ts and
 * teamAdmin.service.ts. It is not the only writer of these tables: the
 * repository form route, page.service.linkPage and the slides importer all
 * create links of their own and do not come through here.
 *
 * Three rules run through every function here:
 *
 * 1. EVERYTHING IS SCOPED TO THE CLASSROOM. `resourceId`, `targetId` and
 *    `linkId` all originate as caller input, so each is proven to live in the
 *    caller's classroom before it is joined or deleted. Page, Slide and
 *    Repository carry `classroom_id` directly; Assignment does not, and is
 *    reached through its Repository. A record that does not exist and a record
 *    belonging to another classroom raise the SAME typed error, so a probe
 *    cannot tell them apart. Reads apply the same rule to BOTH ends: a row
 *    whose target resolves outside the classroom is dropped rather than
 *    reported, since the writers above are not all classroom-scoped.
 *
 * 2. DUPLICATES ARE CAUGHT BY THE PRE-CHECK, AND ONLY BY THE PRE-CHECK. The
 *    kanban drops a duplicate drag before submitting, but it decides that from
 *    loader data that may be stale, and an API caller has no such check at all.
 *    The @@unique on (page_id, repository_id, assignment_id) cannot stand in
 *    for one either: exactly one of the two target columns is always NULL, and
 *    the Postgres unique index is nulls-distinct (see the migration — no
 *    `NULLS NOT DISTINCT`), so a second identical row inserts happily. The
 *    read-then-write pre-check below is therefore the whole guard, and two
 *    identical adds racing each other can both pass it — a duplicate row from
 *    concurrent adds is an ACCEPTED outcome here, not a prevented one. It is
 *    cosmetic (the manifest keys content by slug, and either row can be
 *    removed), and ruling it out needs an index change the existing rows would
 *    have to be de-duplicated for first.
 *
 * 3. THE MANIFEST IS BEST EFFORT, AND SAYS SO. Every successful write rebuilds
 *    `.classmoji/manifest.json` in the classroom content repo. That push talks
 *    to a git host and must never turn a committed database write into a failed
 *    request, so it is wrapped — but the outcome is not hidden: every mutation
 *    reports `manifestSynced`, false when the push was skipped or failed. It
 *    runs ONLY after a write actually happened — a rejected add or a no-op
 *    remove leaves the manifest untouched.
 *
 * Authorization is NOT re-checked here. Callers (route auth gates / MCP tool
 * scopes) own that, exactly as in the sibling services above.
 */
import getPrisma from '@classmoji/database';

import * as contentManifestService from './contentManifest.service.ts';

/** Which kind of content is being linked. */
export type ResourceLinkResourceType = 'page' | 'slide';
/** What the content is being linked TO. */
export type ResourceLinkTargetType = 'repository' | 'assignment';

/** Thrown for every caller-fixable failure so routes/tools can map it to a message. */
export class ResourceLinkServiceError extends Error {
  code: 'resource_not_found' | 'target_not_found' | 'already_linked' | 'link_not_found';

  constructor(code: ResourceLinkServiceError['code'], message: string) {
    super(message);
    this.name = 'ResourceLinkServiceError';
    this.code = code;
  }
}

/** The row created by `addLink`, in an allow-listed shape safe to hand to a client. */
export interface CreatedResourceLink {
  id: string;
  resourceType: ResourceLinkResourceType;
  resourceId: string;
  targetType: ResourceLinkTargetType;
  targetId: string;
  order: number;
  createdAt: Date;
  /** Whether the manifest push that follows the write actually landed. */
  manifestSynced: boolean;
}

/** The row removed by `removeLink`. */
export interface RemovedResourceLink {
  id: string;
  resourceType: ResourceLinkResourceType;
  /** Whether the manifest push that follows the delete actually landed. */
  manifestSynced: boolean;
}

/** One row of `listLinks`, resolved to human-readable resource and target names. */
export interface ResourceLinkSummary {
  id: string;
  resourceType: ResourceLinkResourceType;
  targetType: ResourceLinkTargetType;
  order: number;
  createdAt: Date;
  resource: { id: string; title: string; slug: string | null };
  target: {
    id: string;
    title: string;
    slug: string | null;
    /** Present for assignment targets only — the repository the assignment sits in. */
    repositoryId?: string;
    repositoryTitle?: string;
  };
}

/** A Prisma unique-constraint violation, mapped rather than surfaced raw. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';

/**
 * Ids reach this service from untyped request bodies. Prisma DROPS an
 * `undefined` value from a `where` rather than rejecting it, and its id fields
 * also accept a filter object, so a non-string id would silently WIDEN a
 * classroom-scoped lookup or delete instead of narrowing it. Reject anything
 * that is not a real string up front, as the same not-found the caller would
 * get for an id that names nothing.
 */
function assertUsableId(
  value: unknown,
  code: ResourceLinkServiceError['code'],
  what: string
): asserts value is string {
  if (typeof value !== 'string' || !value) {
    throw new ResourceLinkServiceError(code, `[resourceLink] ${what} is not a usable id`);
  }
}

/** The resource half of a link row — exactly one of the two id columns. */
type ResourceColumn = { page_id: string } | { slide_id: string };
/** The target half — exactly one id, the other written as an explicit NULL. */
type TargetColumns = { repository_id: string | null; assignment_id: string | null };

/**
 * Prove the page/slide being linked lives in this classroom, and hand back the
 * column the write will use.
 *
 * `resourceType` is caller input like the ids are. Validating it in one place
 * and returning the column from the SAME switch is what keeps the check and the
 * write on the same side: a value that is neither literal cannot be validated
 * as one kind and written as the other, it is refused here before any query
 * runs — as the same not-found an unknown id gets.
 */
async function resolveResource(
  classroomId: string,
  resourceType: ResourceLinkResourceType,
  resourceId: string
): Promise<ResourceColumn> {
  const where = { id: resourceId, classroom_id: classroomId };
  const notFound = () =>
    new ResourceLinkServiceError(
      'resource_not_found',
      `[resourceLink] ${resourceType} ${resourceId} not found in classroom ${classroomId}`
    );

  switch (resourceType) {
    case 'page': {
      const found = await getPrisma().page.findFirst({ where, select: { id: true } });
      if (!found) throw notFound();
      return { page_id: resourceId };
    }
    case 'slide': {
      const found = await getPrisma().slide.findFirst({ where, select: { id: true } });
      if (!found) throw notFound();
      return { slide_id: resourceId };
    }
    default:
      throw new ResourceLinkServiceError(
        'resource_not_found',
        `[resourceLink] ${String(resourceType)} is not a resource type`
      );
  }
}

/**
 * Prove the link target lives in this classroom, and hand back the pair of
 * target columns the write will use. Repository carries `classroom_id`
 * directly; Assignment is reached through its Repository.
 *
 * One switch decides both halves, for the same reason as `resolveResource`: an
 * unrecognised `targetType` is refused before any query rather than checked
 * against one table and written as the other.
 */
async function resolveTarget(
  classroomId: string,
  targetType: ResourceLinkTargetType,
  targetId: string
): Promise<TargetColumns> {
  const notFound = () =>
    new ResourceLinkServiceError(
      'target_not_found',
      `[resourceLink] ${targetType} ${targetId} not found in classroom ${classroomId}`
    );

  switch (targetType) {
    case 'repository': {
      const found = await getPrisma().repository.findFirst({
        where: { id: targetId, classroom_id: classroomId },
        select: { id: true },
      });
      if (!found) throw notFound();
      return { repository_id: targetId, assignment_id: null };
    }
    case 'assignment': {
      const found = await getPrisma().assignment.findFirst({
        where: { id: targetId, repository: { classroom_id: classroomId } },
        select: { id: true },
      });
      if (!found) throw notFound();
      return { repository_id: null, assignment_id: targetId };
    }
    default:
      throw new ResourceLinkServiceError(
        'target_not_found',
        `[resourceLink] ${String(targetType)} is not a target type`
      );
  }
}

/**
 * Rebuild and push the content manifest after a successful write.
 *
 * Best effort by contract: the manifest describes the link graph for the
 * content repo, and the link row is already committed by the time this runs.
 * Failing the mutation because a git push did not land would report "nothing
 * happened" for a change that DID happen, so a failure is logged instead — and
 * reported, as the boolean every mutation passes back to its caller. Best
 * effort is not the same as invisible.
 */
async function syncManifest(classroomId: string): Promise<boolean> {
  try {
    return await contentManifestService.saveManifest(classroomId);
  } catch (error: unknown) {
    console.error(
      '[resourceLink] failed to update the content manifest:',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}

/**
 * Link a page or slide deck to a repository or a specific assignment.
 *
 * Both ends are proven to be in `classroomId` BEFORE the row is created, and an
 * existing identical link is reported as `already_linked` rather than inserted
 * twice. On success the content manifest is refreshed (best effort — the result
 * comes back as `manifestSynced`).
 */
export const addLink = async ({
  classroomId,
  resourceType,
  resourceId,
  targetType,
  targetId,
}: {
  classroomId: string;
  resourceType: ResourceLinkResourceType;
  resourceId: string;
  targetType: ResourceLinkTargetType;
  targetId: string;
}): Promise<CreatedResourceLink> => {
  assertUsableId(resourceId, 'resource_not_found', 'resourceId');
  assertUsableId(targetId, 'target_not_found', 'targetId');

  // Each resolve validates its discriminant, proves its end of the link is in
  // this classroom, and returns the columns for that end. Building the row from
  // those return values is what makes the duplicate lookup and the insert
  // describe the same row: the unset target column is an explicit NULL in both,
  // never an `undefined` that Prisma would drop from the `where`.
  const resourceColumn = await resolveResource(classroomId, resourceType, resourceId);
  const targetColumns = await resolveTarget(classroomId, targetType, targetId);
  const columns = { ...resourceColumn, ...targetColumns };

  const existing =
    resourceType === 'page'
      ? await getPrisma().pageLink.findFirst({
          where: columns as { page_id: string },
          select: { id: true },
        })
      : await getPrisma().slideLink.findFirst({
          where: columns as { slide_id: string },
          select: { id: true },
        });

  if (existing) {
    throw new ResourceLinkServiceError(
      'already_linked',
      `[resourceLink] ${resourceType} ${resourceId} is already linked to ${targetType} ${targetId}`
    );
  }

  let created: { id: string; order: number; created_at: Date };
  try {
    created =
      resourceType === 'page'
        ? await getPrisma().pageLink.create({
            data: columns as { page_id: string } & TargetColumns,
            select: { id: true, order: true, created_at: true },
          })
        : await getPrisma().slideLink.create({
            data: columns as { slide_id: string } & TargetColumns,
            select: { id: true, order: true, created_at: true },
          });
  } catch (error: unknown) {
    // The nulls-distinct index cannot fire on the rows written here (rule 2
    // above), so this is not a race backstop — it is cheap insurance for the
    // day the indexes are tightened, and it keeps a unique violation from
    // reaching a caller as an opaque database failure either way.
    if (!isUniqueViolation(error)) throw error;
    throw new ResourceLinkServiceError(
      'already_linked',
      `[resourceLink] ${resourceType} ${resourceId} is already linked to ${targetType} ${targetId}`
    );
  }

  const manifestSynced = await syncManifest(classroomId);

  return {
    id: created.id,
    resourceType,
    resourceId,
    targetType,
    targetId,
    order: created.order,
    createdAt: created.created_at,
    manifestSynced,
  };
};

/**
 * Remove a link by id.
 *
 * `deleteMany` takes the classroom compound that `delete` cannot. Past the id
 * guard `id` is the primary key, so the compound matches AT MOST one row: a
 * count other than 1 means zero rows matched — the link was not this
 * classroom's and nothing was deleted. That distinction is what keeps the
 * manifest from being rewritten to describe links that are still there (and
 * makes a cross-classroom delete a safe no-op rather than a leak).
 *
 * `resourceType` picks the table, so it is validated in the same switch that
 * issues the delete: an unrecognised value is refused rather than falling
 * through to the slide table and deleting from the wrong one.
 */
export const removeLink = async ({
  classroomId,
  resourceType,
  linkId,
}: {
  classroomId: string;
  resourceType: ResourceLinkResourceType;
  linkId: string;
}): Promise<RemovedResourceLink> => {
  assertUsableId(linkId, 'link_not_found', 'linkId');

  let count: number;
  switch (resourceType) {
    case 'page':
      ({ count } = await getPrisma().pageLink.deleteMany({
        where: { id: linkId, page: { classroom_id: classroomId } },
      }));
      break;
    case 'slide':
      ({ count } = await getPrisma().slideLink.deleteMany({
        where: { id: linkId, slide: { classroom_id: classroomId } },
      }));
      break;
    default:
      throw new ResourceLinkServiceError(
        'link_not_found',
        `[resourceLink] ${String(resourceType)} is not a resource type`
      );
  }

  if (count !== 1) {
    throw new ResourceLinkServiceError(
      'link_not_found',
      `[resourceLink] link ${linkId} not found in classroom ${classroomId}`
    );
  }

  const manifestSynced = await syncManifest(classroomId);

  return { id: linkId, resourceType, manifestSynced };
};

/**
 * The include shared by both link queries — resolves names in ONE round trip
 * each. `classroom_id` rides along on both repository selects because the
 * `where` can only scope the RESOURCE side (that is where the classroom lives);
 * the target side is checked per row in `toSummary`.
 */
const LINK_INCLUDE = {
  repository: { select: { id: true, title: true, slug: true, classroom_id: true } },
  assignment: {
    select: {
      id: true,
      title: true,
      slug: true,
      repository: { select: { id: true, title: true, classroom_id: true } },
    },
  },
} as const;

type LinkRow = {
  id: string;
  order: number;
  created_at: Date;
  repository: { id: string; title: string; slug: string | null; classroom_id: string } | null;
  assignment: {
    id: string;
    title: string;
    slug: string | null;
    repository: { id: string; title: string; classroom_id: string } | null;
  } | null;
};

/**
 * Fold a raw link row plus its resource into the allow-listed summary shape,
 * or drop the row.
 *
 * A row is only reported when its target resolves to exactly one record IN THIS
 * CLASSROOM. That second half matters because the `where` cannot express it —
 * PageLink/SlideLink carry no classroom, so the query scopes the page/slide
 * side and the target relations come back unfiltered. Not every writer of these
 * tables is classroom-scoped, so a row pointing at another classroom's
 * repository or assignment is possible; it is dropped and logged rather than
 * folded into a list that claims to be one classroom's.
 */
function toSummary(
  row: LinkRow,
  resourceType: ResourceLinkResourceType,
  resource: { id: string; title: string; slug: string | null },
  classroomId: string
): ResourceLinkSummary | null {
  const drop = (why: string) => {
    console.warn(`[resourceLink] dropping ${resourceType} link ${row.id}: ${why}`);
    return null;
  };

  // Exactly one of the two target columns is expected to be set.
  if (row.repository && row.assignment) {
    // Both set: the row does not describe one place, so report the narrower
    // target (the repository the assignment sits in is a superset of it).
    console.warn(
      `[resourceLink] ${resourceType} link ${row.id} names both a repository and an assignment; using the repository`
    );
  }

  if (row.repository) {
    if (row.repository.classroom_id !== classroomId) {
      return drop('its repository target is in another classroom');
    }
    return {
      id: row.id,
      resourceType,
      targetType: 'repository',
      order: row.order,
      createdAt: row.created_at,
      resource,
      target: { id: row.repository.id, title: row.repository.title, slug: row.repository.slug },
    };
  }

  if (row.assignment) {
    // Assignment has no classroom of its own; its repository is what places it.
    if (!row.assignment.repository) {
      return drop('its assignment target has no repository to place it in a classroom');
    }
    if (row.assignment.repository.classroom_id !== classroomId) {
      return drop('its assignment target is in another classroom');
    }
    return {
      id: row.id,
      resourceType,
      targetType: 'assignment',
      order: row.order,
      createdAt: row.created_at,
      resource,
      target: {
        id: row.assignment.id,
        title: row.assignment.title,
        slug: row.assignment.slug,
        repositoryId: row.assignment.repository.id,
        repositoryTitle: row.assignment.repository.title,
      },
    };
  }

  // Neither column set — the row is corrupt, or the target was deleted
  // mid-read. Dropped rather than reported with a hole in it.
  return drop('it names neither a repository nor an assignment');
}

/**
 * Build the target half of the `where`. Filters only ever NARROW: the classroom
 * scope is applied separately and is never caller-supplied, so a filter can at
 * worst return fewer of this classroom's own rows.
 */
function targetWhere(
  targetType?: ResourceLinkTargetType,
  targetId?: string
): Record<string, unknown> {
  if (targetType === 'repository') {
    return targetId ? { repository_id: targetId } : { repository_id: { not: null } };
  }
  if (targetType === 'assignment') {
    return targetId ? { assignment_id: targetId } : { assignment_id: { not: null } };
  }
  // No target type given: an id may name either kind of target.
  return targetId ? { OR: [{ repository_id: targetId }, { assignment_id: targetId }] } : {};
}

/**
 * List every page/slide link in a classroom, optionally filtered.
 *
 * At most two queries (one per resource type, skipped when `resourceType`
 * narrows to one), each resolving its resource and target names through
 * includes — no per-row lookups. The `where` scopes the page/slide side, which
 * is the side that carries the classroom; the target side is confirmed row by
 * row in `toSummary`, which drops anything resolving elsewhere.
 */
export const listLinks = async ({
  classroomId,
  resourceType,
  resourceId,
  targetType,
  targetId,
}: {
  classroomId: string;
  resourceType?: ResourceLinkResourceType;
  resourceId?: string;
  targetType?: ResourceLinkTargetType;
  targetId?: string;
}): Promise<ResourceLinkSummary[]> => {
  const target = targetWhere(targetType, targetId);
  const links: ResourceLinkSummary[] = [];

  if (resourceType !== 'slide') {
    const rows = await getPrisma().pageLink.findMany({
      where: {
        // Classroom scope through the parent — PageLink has no classroom_id.
        page: { classroom_id: classroomId },
        ...(resourceId ? { page_id: resourceId } : {}),
        ...target,
      },
      include: { ...LINK_INCLUDE, page: { select: { id: true, title: true, slug: true } } },
      orderBy: [{ created_at: 'asc' }],
    });
    for (const row of rows) {
      const summary = toSummary(row as unknown as LinkRow, 'page', row.page, classroomId);
      if (summary) links.push(summary);
    }
  }

  if (resourceType !== 'page') {
    const rows = await getPrisma().slideLink.findMany({
      where: {
        slide: { classroom_id: classroomId },
        ...(resourceId ? { slide_id: resourceId } : {}),
        ...target,
      },
      include: { ...LINK_INCLUDE, slide: { select: { id: true, title: true, slug: true } } },
      orderBy: [{ created_at: 'asc' }],
    });
    for (const row of rows) {
      const summary = toSummary(row as unknown as LinkRow, 'slide', row.slide, classroomId);
      if (summary) links.push(summary);
    }
  }

  return links;
};
