import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import { ModuleItemType, type Prisma } from '@prisma/client';

interface ModuleWriteInput {
  title: string;
  description?: string | null;
}

/** ModuleItemType → the nullable target column it populates on ModuleItem. */
const ITEM_TYPE_COLUMN: Record<
  ModuleItemType,
  'page_id' | 'repository_id' | 'quiz_id' | 'slide_id'
> = {
  PAGE: 'page_id',
  REPOSITORY: 'repository_id',
  QUIZ: 'quiz_id',
  SLIDE: 'slide_id',
};

// Items carry their full target plus, for repositories, the nested assignments
// and attached resources the read-only tree needs. A literal include keeps
// Prisma's inferred types on the returned shape.
const ITEM_INCLUDE = {
  page: true,
  slide: true,
  quiz: true,
  repository: {
    include: {
      assignments: { orderBy: { title: 'asc' } },
      pages: { include: { page: true }, orderBy: { order: 'asc' } },
      slides: { include: { slide: true }, orderBy: { order: 'asc' } },
      quizzes: true,
    },
  },
} satisfies Prisma.ModuleItemInclude;

const DETAIL_INCLUDE = {
  items: { orderBy: { position: 'asc' }, include: ITEM_INCLUDE },
} satisfies Prisma.ModuleInclude;

type ModuleItemWithTargets = Prisma.ModuleItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

/**
 * Whether a module item should be visible to students, based on the publish
 * state of its underlying target (the single source of truth for item
 * visibility, mirrored by the plan's visibility rules).
 */
export const isItemPublished = (item: ModuleItemWithTargets): boolean => {
  switch (item.item_type) {
    case 'PAGE':
      return !!item.page && !item.page.is_draft;
    case 'SLIDE':
      return !!item.slide && !item.slide.is_draft;
    case 'REPOSITORY':
      return !!item.repository && item.repository.is_published;
    case 'QUIZ':
      return !!item.quiz && item.quiz.status !== 'DRAFT';
    default:
      return false;
  }
};

const isItemTargetInClassroom = (item: ModuleItemWithTargets, classroomId: string): boolean => {
  switch (item.item_type) {
    case 'PAGE':
      return item.page?.classroom_id === classroomId;
    case 'SLIDE':
      return item.slide?.classroom_id === classroomId;
    case 'REPOSITORY':
      return item.repository?.classroom_id === classroomId;
    case 'QUIZ':
      return item.quiz?.classroom_id === classroomId;
    default:
      return false;
  }
};

const findClassroomIdBySlug = async (classroomSlug: string) => {
  const classroom = await getPrisma().classroom.findFirst({
    where: { slug: classroomSlug },
    select: { id: true },
  });
  return classroom?.id ?? null;
};

/**
 * List every Module in a classroom (by slug), ordered for display, with an
 * item count for the index.
 */
export const findByClassroomSlug = async (classroomSlug: string) => {
  const classroomId = await findClassroomIdBySlug(classroomSlug);
  if (!classroomId) return [];

  return getPrisma().module.findMany({
    where: { classroom_id: classroomId },
    include: { _count: { select: { items: true } } },
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
  });
};

/**
 * Find a single Module within a classroom by its slug (falls back to title),
 * with its ordered items, for the admin builder and the detail page.
 */
export const findByClassroomSlugAndModuleSlug = async (
  classroomSlug: string,
  moduleSlug: string
) => {
  const classroomId = await findClassroomIdBySlug(classroomSlug);
  if (!classroomId) return null;

  const module = await getPrisma().module.findFirst({
    where: {
      classroom_id: classroomId,
      OR: [{ slug: moduleSlug }, { title: moduleSlug }],
    },
    include: DETAIL_INCLUDE,
  });
  if (!module) return null;

  return {
    ...module,
    items: module.items.filter(item => isItemTargetInClassroom(item, classroomId)),
  };
};

export const findById = async (id: string) => {
  return getPrisma().module.findUnique({ where: { id }, include: DETAIL_INCLUDE });
};

/**
 * List a classroom's modules with their ordered items for the read-only
 * student/assistant tree. Students (`includeUnpublished = false`) see only
 * published modules and published items; the teaching team sees everything.
 */
export const listForClassroom = async (
  classroomSlug: string,
  { includeUnpublished = false }: { includeUnpublished?: boolean } = {}
) => {
  const classroomId = await findClassroomIdBySlug(classroomSlug);
  if (!classroomId) return [];

  const modules = await getPrisma().module.findMany({
    where: {
      classroom_id: classroomId,
      ...(includeUnpublished ? {} : { is_published: true }),
    },
    include: DETAIL_INCLUDE,
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
  });

  const modulesWithScopedItems = modules.map(m => ({
    ...m,
    items: m.items.filter(item => isItemTargetInClassroom(item, classroomId)),
  }));

  if (includeUnpublished) return modulesWithScopedItems;

  // Drop items whose target is not published. Module-level publish is already
  // filtered in the query above.
  return modulesWithScopedItems.map(m => ({ ...m, items: m.items.filter(isItemPublished) }));
};

/**
 * The four content types a module item can point at, with the minimal fields
 * the admin "add item" picker needs (id, label, and publish state for a pill).
 */
export const getCandidateContent = async (classroomId: string) => {
  const prisma = getPrisma();
  const [repositories, pages, slides, quizzes] = await Promise.all([
    prisma.repository.findMany({
      where: { classroom_id: classroomId },
      select: { id: true, title: true, is_published: true },
      orderBy: { title: 'asc' },
    }),
    prisma.page.findMany({
      where: { classroom_id: classroomId },
      select: { id: true, title: true, is_draft: true },
      orderBy: { title: 'asc' },
    }),
    prisma.slide.findMany({
      where: { classroom_id: classroomId },
      select: { id: true, title: true, is_draft: true },
      orderBy: { title: 'asc' },
    }),
    prisma.quiz.findMany({
      where: { classroom_id: classroomId },
      select: { id: true, name: true, status: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  return { repositories, pages, slides, quizzes };
};

export const create = async (classroomId: string, input: ModuleWriteInput) => {
  return getPrisma().module.create({
    data: {
      classroom_id: classroomId,
      title: input.title,
      slug: titleToIdentifier(input.title),
      description: input.description ?? null,
    },
  });
};

export const update = async (id: string, input: ModuleWriteInput) => {
  // Slug is set once on creation and never updated, matching Repository/Assignment.
  return getPrisma().module.update({
    where: { id },
    data: { title: input.title, description: input.description ?? null },
  });
};

const assertModuleInClassroom = async (moduleId: string, classroomId: string) => {
  const module = await getPrisma().module.findFirst({
    where: { id: moduleId, classroom_id: classroomId },
    select: { id: true },
  });
  if (!module) throw new Error('Module not found in classroom');
};

const assertTargetInClassroom = async (
  type: ModuleItemType,
  targetId: string,
  classroomId: string
) => {
  const prisma = getPrisma();
  const select = { id: true };
  let target: { id: string } | null = null;

  switch (type) {
    case ModuleItemType.PAGE:
      target = await prisma.page.findFirst({
        where: { id: targetId, classroom_id: classroomId },
        select,
      });
      break;
    case ModuleItemType.REPOSITORY:
      target = await prisma.repository.findFirst({
        where: { id: targetId, classroom_id: classroomId },
        select,
      });
      break;
    case ModuleItemType.QUIZ:
      target = await prisma.quiz.findFirst({
        where: { id: targetId, classroom_id: classroomId },
        select,
      });
      break;
    case ModuleItemType.SLIDE:
      target = await prisma.slide.findFirst({
        where: { id: targetId, classroom_id: classroomId },
        select,
      });
      break;
  }

  if (!target) throw new Error('Module item target not found in classroom');
};

export const updateForClassroom = async (
  id: string,
  classroomId: string,
  input: ModuleWriteInput
) => {
  await assertModuleInClassroom(id, classroomId);
  return update(id, input);
};

export const deleteById = async (id: string, classroomId?: string) => {
  if (classroomId) await assertModuleInClassroom(id, classroomId);
  // ModuleItem rows cascade; the underlying pages/repos/quizzes/slides remain.
  return getPrisma().module.delete({ where: { id } });
};

export const setPublished = async (id: string, isPublished: boolean, classroomId?: string) => {
  if (classroomId) await assertModuleInClassroom(id, classroomId);
  return getPrisma().module.update({
    where: { id },
    data: { is_published: isPublished },
  });
};

/**
 * Append an item of the given type to a module (at max position + 1). The
 * unique (module, target) constraint prevents adding the same item twice.
 */
export const addItem = async (
  moduleId: string,
  type: ModuleItemType,
  targetId: string,
  classroomId?: string
) => {
  const prisma = getPrisma();
  if (classroomId) {
    await assertModuleInClassroom(moduleId, classroomId);
    await assertTargetInClassroom(type, targetId, classroomId);
  }
  const last = await prisma.moduleItem.findFirst({
    where: { module_id: moduleId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  const position = last ? last.position + 1 : 0;

  return prisma.moduleItem.create({
    data: {
      module_id: moduleId,
      item_type: type,
      position,
      [ITEM_TYPE_COLUMN[type]]: targetId,
    },
  });
};

export const removeItem = async (moduleItemId: string, classroomId?: string) => {
  if (classroomId) {
    const moduleItem = await getPrisma().moduleItem.findFirst({
      where: { id: moduleItemId, module: { classroom_id: classroomId } },
      select: { id: true },
    });
    if (!moduleItem) throw new Error('Module item not found in classroom');
  }
  return getPrisma().moduleItem.delete({ where: { id: moduleItemId } });
};

/**
 * Persist a new ordering for a module's items. `orderedItemIds` is the full
 * list of ModuleItem ids in their new order; each row's position becomes its
 * index.
 */
export const reorderItems = async (
  moduleId: string,
  orderedItemIds: string[],
  classroomId?: string
) => {
  const prisma = getPrisma();
  if (classroomId) await assertModuleInClassroom(moduleId, classroomId);

  const existingItems = await prisma.moduleItem.findMany({
    where: { module_id: moduleId },
    select: { id: true },
  });
  const existingIds = new Set(existingItems.map(item => item.id));
  const orderedIds = new Set(orderedItemIds);
  const hasExactSet =
    existingIds.size === orderedItemIds.length &&
    orderedIds.size === orderedItemIds.length &&
    orderedItemIds.every(id => existingIds.has(id));
  if (!hasExactSet) throw new Error('Ordered item ids must match module items');

  await prisma.$transaction(
    orderedItemIds.map((id, index) =>
      prisma.moduleItem.update({
        where: { id, module_id: moduleId },
        data: { position: index },
      })
    )
  );
};

// `export const ModuleItemTypes` mirror so callers (routes/UI) can reference the
// canonical set without importing Prisma directly.
export const MODULE_ITEM_TYPES: ModuleItemType[] = [
  ModuleItemType.PAGE,
  ModuleItemType.REPOSITORY,
  ModuleItemType.QUIZ,
  ModuleItemType.SLIDE,
];
