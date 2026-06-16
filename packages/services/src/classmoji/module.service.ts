import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import type { Prisma } from '@prisma/client';

interface ModuleWriteInput {
  title: string;
  description?: string | null;
  /** Page ids to link to this module (replaces existing module page links). */
  linkedPageIds?: string[];
}

// Literal include so Prisma infers the nested `repositories` and `pages.page`
// relations on the returned type (a conditional/spread include erases them).
const DETAIL_INCLUDE = {
  repositories: { orderBy: { title: 'asc' } },
  pages: { include: { page: true }, orderBy: { order: 'asc' } },
} satisfies Prisma.ModuleInclude;

/**
 * List every Module in a classroom (by classroom slug), ordered for display.
 * Always includes a repository count so the index can show membership at a glance.
 */
export const findByClassroomSlug = async (classroomSlug: string) => {
  const classroom = await getPrisma().classroom.findFirst({
    where: { slug: classroomSlug },
    select: { id: true },
  });

  if (!classroom) return [];

  return getPrisma().module.findMany({
    where: { classroom_id: classroom.id },
    include: {
      _count: { select: { repositories: true } },
      // Page ids so the edit form can prefill (and avoid wiping) linked pages.
      pages: { select: { page_id: true } },
    },
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
  });
};

/**
 * Find a single Module within a classroom by its slug (falls back to title),
 * with member repositories and linked pages, for the detail page.
 */
export const findByClassroomSlugAndModuleSlug = async (
  classroomSlug: string,
  moduleSlug: string
) => {
  const classroom = await getPrisma().classroom.findFirst({
    where: { slug: classroomSlug },
    select: { id: true },
  });

  if (!classroom) return null;

  return getPrisma().module.findFirst({
    where: {
      classroom_id: classroom.id,
      OR: [{ slug: moduleSlug }, { title: moduleSlug }],
    },
    include: DETAIL_INCLUDE,
  });
};

export const findById = async (id: string) => {
  return getPrisma().module.findUnique({
    where: { id },
    include: DETAIL_INCLUDE,
  });
};

const syncModulePageLinks = async (moduleId: string, linkedPageIds?: string[]) => {
  if (linkedPageIds === undefined) return;

  // Replace the module's page links with the provided set.
  await getPrisma().pageLink.deleteMany({ where: { module_id: moduleId } });

  if (linkedPageIds.length === 0) return;

  await getPrisma().pageLink.createMany({
    data: linkedPageIds.map(pageId => ({ page_id: pageId, module_id: moduleId })),
    skipDuplicates: true,
  });
};

export const create = async (classroomId: string, input: ModuleWriteInput) => {
  const created = await getPrisma().module.create({
    data: {
      classroom_id: classroomId,
      title: input.title,
      slug: titleToIdentifier(input.title),
      description: input.description ?? null,
    },
  });

  await syncModulePageLinks(created.id, input.linkedPageIds);

  return created;
};

export const update = async (id: string, input: ModuleWriteInput) => {
  const updated = await getPrisma().module.update({
    where: { id },
    // Slug is set once on creation from the title and never updated, matching
    // Repository/Assignment behaviour.
    data: {
      title: input.title,
      description: input.description ?? null,
    },
  });

  await syncModulePageLinks(id, input.linkedPageIds);

  return updated;
};

export const deleteById = async (id: string) => {
  // Member repositories are detached (module_id SET NULL) by the FK; page links
  // cascade. The repositories themselves are never deleted.
  return getPrisma().module.delete({ where: { id } });
};

/**
 * Place a repository in a module (or remove it from any module with null).
 */
export const assignRepository = async (repositoryId: string, moduleId: string | null) => {
  return getPrisma().repository.update({
    where: { id: repositoryId },
    data: { module_id: moduleId },
  });
};
