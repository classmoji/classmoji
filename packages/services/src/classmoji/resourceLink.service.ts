/**
 * Resource link service.
 *
 * A "resource link" associates a page or a slide deck with either a repository
 * (the assignment container — content shows on the repo page) or one specific
 * assignment inside it. Extracted from the web admin.$class.resources action so
 * that route and the MCP resource-link tools take ONE code path — same
 * precedent as roster.service.ts, assistant.service.ts and teamAdmin.service.ts.
 *
 * Three rules run through every function here:
 *
 * 1. EVERYTHING IS SCOPED TO THE CLASSROOM. `resourceId`, `targetId` and
 *    `linkId` all originate as caller input, so each is proven to live in the
 *    caller's classroom before it is joined or deleted. Page, Slide and
 *    Repository carry `classroom_id` directly; Assignment does not, and is
 *    reached through its Repository. A record that does not exist and a record
 *    belonging to another classroom raise the SAME typed error, so a probe
 *    cannot tell them apart.
 *
 * 2. DUPLICATES ARE CAUGHT IN SQL, NOT IN THE UI. The web kanban hides
 *    already-linked targets client-side; an API caller has no such guard. The
 *    @@unique on (page_id, repository_id, assignment_id) does NOT catch this on
 *    its own: exactly one of the two target columns is always NULL, and the
 *    Postgres unique index is nulls-distinct (see the migration — no
 *    `NULLS NOT DISTINCT`), so a second identical row inserts happily. Hence the
 *    explicit pre-check below, with the P2002 catch kept as a race backstop.
 *
 * 3. THE MANIFEST IS BEST EFFORT. Every successful write rebuilds
 *    `.classmoji/manifest.json` in the classroom content repo. That push talks
 *    to a git host and must never turn a committed database write into a failed
 *    request, so it is wrapped: a failure is logged and the mutation still
 *    reports success. It runs ONLY after a write actually happened — a rejected
 *    add or a no-op remove leaves the manifest untouched.
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
}

/** The row removed by `removeLink`. */
export interface RemovedResourceLink {
  id: string;
  resourceType: ResourceLinkResourceType;
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

/** A Prisma unique-constraint violation (the race backstop for a duplicate link). */
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

/** Prove the page/slide being linked lives in this classroom. */
async function assertResourceInClassroom(
  classroomId: string,
  resourceType: ResourceLinkResourceType,
  resourceId: string
): Promise<void> {
  const where = { id: resourceId, classroom_id: classroomId };
  const found =
    resourceType === 'page'
      ? await getPrisma().page.findFirst({ where, select: { id: true } })
      : await getPrisma().slide.findFirst({ where, select: { id: true } });

  if (!found) {
    throw new ResourceLinkServiceError(
      'resource_not_found',
      `[resourceLink] ${resourceType} ${resourceId} not found in classroom ${classroomId}`
    );
  }
}

/**
 * Prove the link target lives in this classroom. Repository carries
 * `classroom_id` directly; Assignment is reached through its Repository.
 */
async function assertTargetInClassroom(
  classroomId: string,
  targetType: ResourceLinkTargetType,
  targetId: string
): Promise<void> {
  const found =
    targetType === 'repository'
      ? await getPrisma().repository.findFirst({
          where: { id: targetId, classroom_id: classroomId },
          select: { id: true },
        })
      : await getPrisma().assignment.findFirst({
          where: { id: targetId, repository: { classroom_id: classroomId } },
          select: { id: true },
        });

  if (!found) {
    throw new ResourceLinkServiceError(
      'target_not_found',
      `[resourceLink] ${targetType} ${targetId} not found in classroom ${classroomId}`
    );
  }
}

/**
 * Rebuild and push the content manifest after a successful write.
 *
 * Best effort by contract: the manifest describes the link graph for the
 * content repo, and the link row is already committed by the time this runs.
 * Failing the mutation because a git push did not land would report "nothing
 * happened" for a change that DID happen, so a failure is logged instead.
 */
async function syncManifest(classroomId: string): Promise<void> {
  try {
    await contentManifestService.saveManifest(classroomId);
  } catch (error: unknown) {
    console.error(
      '[resourceLink] failed to update the content manifest:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Link a page or slide deck to a repository or a specific assignment.
 *
 * Both ends are proven to be in `classroomId` BEFORE the row is created, and an
 * existing identical link is reported as `already_linked` rather than inserted
 * twice. On success the content manifest is refreshed (best effort).
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

  await assertResourceInClassroom(classroomId, resourceType, resourceId);
  await assertTargetInClassroom(classroomId, targetType, targetId);

  // Exactly one target column is set; the other is explicitly NULL so the
  // duplicate lookup and the insert describe the same row.
  const repositoryId = targetType === 'repository' ? targetId : null;
  const assignmentId = targetType === 'assignment' ? targetId : null;

  const duplicateWhere =
    resourceType === 'page'
      ? { page_id: resourceId, repository_id: repositoryId, assignment_id: assignmentId }
      : { slide_id: resourceId, repository_id: repositoryId, assignment_id: assignmentId };

  const existing =
    resourceType === 'page'
      ? await getPrisma().pageLink.findFirst({
          where: duplicateWhere as { page_id: string },
          select: { id: true },
        })
      : await getPrisma().slideLink.findFirst({
          where: duplicateWhere as { slide_id: string },
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
            data: {
              page_id: resourceId,
              repository_id: repositoryId,
              assignment_id: assignmentId,
            },
            select: { id: true, order: true, created_at: true },
          })
        : await getPrisma().slideLink.create({
            data: {
              slide_id: resourceId,
              repository_id: repositoryId,
              assignment_id: assignmentId,
            },
            select: { id: true, order: true, created_at: true },
          });
  } catch (error: unknown) {
    // Race backstop for the pre-check above. It only fires where the unique
    // index actually bites, but a concurrent add must never surface as an
    // opaque database failure.
    if (!isUniqueViolation(error)) throw error;
    throw new ResourceLinkServiceError(
      'already_linked',
      `[resourceLink] ${resourceType} ${resourceId} is already linked to ${targetType} ${targetId}`
    );
  }

  await syncManifest(classroomId);

  return {
    id: created.id,
    resourceType,
    resourceId,
    targetType,
    targetId,
    order: created.order,
    createdAt: created.created_at,
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

  const { count } =
    resourceType === 'page'
      ? await getPrisma().pageLink.deleteMany({
          where: { id: linkId, page: { classroom_id: classroomId } },
        })
      : await getPrisma().slideLink.deleteMany({
          where: { id: linkId, slide: { classroom_id: classroomId } },
        });

  if (count !== 1) {
    throw new ResourceLinkServiceError(
      'link_not_found',
      `[resourceLink] link ${linkId} not found in classroom ${classroomId}`
    );
  }

  await syncManifest(classroomId);

  return { id: linkId, resourceType };
};

/** The include shared by both link queries — resolves names in ONE round trip each. */
const LINK_INCLUDE = {
  repository: { select: { id: true, title: true, slug: true } },
  assignment: {
    select: {
      id: true,
      title: true,
      slug: true,
      repository: { select: { id: true, title: true } },
    },
  },
} as const;

type LinkRow = {
  id: string;
  order: number;
  created_at: Date;
  repository: { id: string; title: string; slug: string | null } | null;
  assignment: {
    id: string;
    title: string;
    slug: string | null;
    repository: { id: string; title: string } | null;
  } | null;
};

/** Fold a raw link row plus its resource into the allow-listed summary shape. */
function toSummary(
  row: LinkRow,
  resourceType: ResourceLinkResourceType,
  resource: { id: string; title: string; slug: string | null }
): ResourceLinkSummary | null {
  // Exactly one of the two target columns is set. A row with neither is
  // corrupt (or the target was deleted mid-read) and is dropped rather than
  // reported with a hole in it.
  if (row.repository) {
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
        ...(row.assignment.repository
          ? {
              repositoryId: row.assignment.repository.id,
              repositoryTitle: row.assignment.repository.title,
            }
          : {}),
      },
    };
  }
  return null;
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
 * includes — no per-row lookups.
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
      const summary = toSummary(row as unknown as LinkRow, 'page', row.page);
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
      const summary = toSummary(row as unknown as LinkRow, 'slide', row.slide);
      if (summary) links.push(summary);
    }
  }

  return links;
};
