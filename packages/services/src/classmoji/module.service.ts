import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import { ModuleItemType, type Prisma } from '@prisma/client';

interface ModuleWriteInput {
  title: string;
  description?: string | null;
}

/**
 * The item types a module's ordered content list still carries. Assignments
 * belong to a module through `Assignment.module_id`, not through an item row;
 * a repository is storage a REPO assignment points at and is not a module
 * member at all. See the legacy block below.
 */
export type ContentItemType = Exclude<ModuleItemType, 'REPOSITORY'>;

/**
 * Compile-time exhaustiveness guard for the switches over ModuleItemType below.
 * Adding a value to the enum without teaching every switch about it becomes a
 * type error here; if one is ever reached at runtime it throws rather than
 * silently rendering the item as "not published" / "not in this classroom".
 */
const unhandledItemType = (type: never): never => {
  throw new Error(`Unhandled ModuleItemType: ${String(type)}`);
};

/** ModuleItemType → the nullable target column it populates on ModuleItem. */
const ITEM_TYPE_COLUMN: Record<
  ModuleItemType,
  'page_id' | 'repository_id' | 'quiz_id' | 'slide_id' | 'form_id'
> = {
  PAGE: 'page_id',
  REPOSITORY: 'repository_id',
  QUIZ: 'quiz_id',
  SLIDE: 'slide_id',
  FORM: 'form_id',
};

// Items carry their full target. Legacy REPOSITORY rows still resolve their
// repository (with publish state) so the visibility predicates keep working;
// the UI no longer renders them.
const ITEM_INCLUDE = {
  page: true,
  slide: true,
  quiz: true,
  form: true,
  repository: true,
} satisfies Prisma.ModuleItemInclude;

// A module's own coursework: its assignments of every kind, each with its
// target resolved (the repository a REPO assignment submits through, the
// quiz, or the form) and the pages / slide decks attached to it.
const ASSIGNMENT_INCLUDE = {
  repository: { select: { id: true, title: true, slug: true, type: true, is_published: true } },
  quiz: { select: { id: true, name: true, status: true } },
  form: { select: { id: true, title: true, slug: true, status: true } },
  pages: { include: { page: true }, orderBy: { order: 'asc' } },
  slides: { include: { slide: true }, orderBy: { order: 'asc' } },
  _count: { select: { git_repo_assignments: true } },
} satisfies Prisma.AssignmentInclude;

const DETAIL_INCLUDE = {
  items: { orderBy: { position: 'asc' }, include: ITEM_INCLUDE },
  assignments: {
    include: ASSIGNMENT_INCLUDE,
    orderBy: [{ student_deadline: { sort: 'asc', nulls: 'last' } }, { title: 'asc' }],
  },
} satisfies Prisma.ModuleInclude;

type ModuleItemWithTargets = Prisma.ModuleItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

/**
 * The minimum an item must carry for a visibility decision. Stated structurally
 * rather than as `ModuleItemWithTargets` so callers that select only the flags —
 * the public course site, which must not pull a repository's assignments and
 * attached resources into an anonymous request — can use the same predicates.
 * A fully-included ModuleItem satisfies it.
 */
export type ModuleItemVisibility = {
  item_type: ModuleItemType;
  page?: { is_draft: boolean; is_public: boolean } | null;
  slide?: { is_draft: boolean; is_public: boolean } | null;
  repository?: { is_published: boolean } | null;
  quiz?: { status: string } | null;
  form?: { status: string; access: string } | null;
};

/**
 * Whether a module item should be visible to students, based on the publish
 * state of its underlying target (the single source of truth for item
 * visibility, mirrored by the plan's visibility rules).
 */
export const isItemPublished = (item: ModuleItemVisibility): boolean => {
  switch (item.item_type) {
    case 'PAGE':
      return !!item.page && !item.page.is_draft;
    case 'SLIDE':
      return !!item.slide && !item.slide.is_draft;
    case 'REPOSITORY':
      return !!item.repository && item.repository.is_published;
    case 'QUIZ':
      return !!item.quiz && item.quiz.status !== 'DRAFT';
    // A CLOSED form stays visible on purpose: students should still see the
    // thing they were asked to fill in, reading honestly as "Closed". Only a
    // DRAFT — never published, no revision to render — is hidden.
    case 'FORM':
      return !!item.form && item.form.status !== 'DRAFT';
    default:
      return unhandledItemType(item.item_type);
  }
};

/**
 * Whether a module item may be shown to an ANONYMOUS visitor of the classroom's
 * public course site. Strictly narrower than isItemPublished:
 *
 *   - PAGE and SLIDE additionally require `is_public`. Published-to-students is
 *     not published-to-the-web; the author opts in per resource.
 *   - REPOSITORY and QUIZ are never shown, published or not, because the title
 *     alone leaks the assignment ("Final Project: Raytracer", "Quiz 3:
 *     Pointers") before the course wants it public.
 *   - FORM additionally requires `access: PUBLIC`. A PUBLIC form is already a
 *     link anyone may open and fill without signing in — `access` is the
 *     author's opt-in, exactly as `is_public` is for a page or slide. A
 *     CLASSROOM form is members-only and is never named on the public site.
 *
 * This is a predicate about the ITEM, not about whether a row appears. The
 * public schedule reads it together with isItemPublished and renders a typed,
 * title-free placeholder in between the two (site.listPublicModulesForViewer) —
 * so `false` here means "never with its title", not "never at all".
 *
 * Members (any role) go through isItemPublished instead: a signed-in student
 * still must not see an unpublished repo just because its module is public.
 */
export const isItemPubliclyVisible = (item: ModuleItemVisibility): boolean => {
  switch (item.item_type) {
    case 'PAGE':
      return !!item.page && !item.page.is_draft && item.page.is_public;
    case 'SLIDE':
      return !!item.slide && !item.slide.is_draft && item.slide.is_public;
    case 'FORM':
      return !!item.form && item.form.status !== 'DRAFT' && item.form.access === 'PUBLIC';
    case 'REPOSITORY':
    case 'QUIZ':
      return false;
    default:
      return unhandledItemType(item.item_type);
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
    case 'FORM':
      return item.form?.classroom_id === classroomId;
    default:
      return unhandledItemType(item.item_type);
  }
};

const findClassroomIdBySlug = async (classroomSlug: string) => {
  const classroom = await getPrisma().classroom.findUnique({
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
    include: { _count: { select: { items: true, assignments: true } } },
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
  });
};

/**
 * One module with everything it owns, for the admin module page: its
 * assignments of every kind (targets resolved) and its ordered content items
 * scoped to the classroom.
 */
export const listModuleContents = async (moduleId: string, classroomId: string) => {
  const module = await getPrisma().module.findFirst({
    where: { id: moduleId, classroom_id: classroomId },
    include: DETAIL_INCLUDE,
  });
  if (!module) return null;
  return {
    ...module,
    items: module.items.filter(item => isItemTargetInClassroom(item, classroomId)),
  };
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

/**
 * Every module in a classroom with everything each one owns, in display
 * order, for the admin Modules page (one expandable card per module).
 */
export const listModuleContentsForClassroom = async (classroomId: string) => {
  const modules = await getPrisma().module.findMany({
    where: { classroom_id: classroomId },
    include: DETAIL_INCLUDE,
    orderBy: [{ position: 'asc' }, { created_at: 'asc' }],
  });
  return modules.map(m => ({
    ...m,
    items: m.items.filter(item => isItemTargetInClassroom(item, classroomId)),
  }));
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

  // Drop items and assignments that are not published. A REPO assignment also
  // needs its repository published: until then no student repo exists to
  // submit through. Module-level publish is already filtered in the query.
  return modulesWithScopedItems.map(m => ({
    ...m,
    items: m.items.filter(isItemPublished),
    assignments: (m.assignments ?? []).filter(
      a => a.is_published && (a.type !== 'REPO' || a.repository?.is_published === true)
    ),
  }));
};

/**
 * Cheap existence check used to drive student/assistant nav: does this classroom
 * have any modules? Students gate on published modules; staff (who preview
 * drafts) pass `includeUnpublished` to count drafts too.
 */
export const hasModulesForClassroom = async (
  classroomSlug: string,
  { includeUnpublished = false }: { includeUnpublished?: boolean } = {}
): Promise<boolean> => {
  const classroomId = await findClassroomIdBySlug(classroomSlug);
  if (!classroomId) return false;
  const count = await getPrisma().module.count({
    where: {
      classroom_id: classroomId,
      ...(includeUnpublished ? {} : { is_published: true }),
    },
  });
  return count > 0;
};

/**
 * The content types a module item can point at, with the minimal fields the
 * admin "add item" picker needs (id, label, and publish state for a pill).
 * Forms additionally carry `access` and `closes_at`, which the picker shows so
 * the instructor can tell a members-only form from a public one and see the
 * close date that will render as the item's due date. Quizzes and forms are
 * also what the assignment form picks a QUIZ / FORM target from.
 */
export const getCandidateContent = async (classroomId: string) => {
  const prisma = getPrisma();
  const [pages, slides, quizzes, forms] = await Promise.all([
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
    prisma.form.findMany({
      where: { classroom_id: classroomId },
      select: { id: true, title: true, slug: true, status: true, access: true, closes_at: true },
      orderBy: { title: 'asc' },
    }),
  ]);
  return { pages, slides, quizzes, forms };
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
  type: ContentItemType,
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
    case ModuleItemType.FORM:
      target = await prisma.form.findFirst({
        where: { id: targetId, classroom_id: classroomId },
        select,
      });
      break;
    default:
      return unhandledItemType(type);
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
  // A module that still owns assignments cannot go: deleting it would cascade
  // into their submissions, grades and regrades. Move or delete them first.
  const owned = await getPrisma().module.findUnique({
    where: { id },
    select: { _count: { select: { assignments: true } } },
  });
  if (owned && owned._count.assignments > 0) {
    throw new Error('Module still has assignments');
  }
  // ModuleItem rows cascade; the underlying pages/quizzes/slides/forms remain.
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
 * Toggle a module's visibility on the classroom's public course site.
 *
 * Independent of setPublished on purpose: the site shows a module only when
 * BOTH flags are true, so this can be turned on ahead of time without leaking
 * anything, and turning a site on never publishes coursework by itself.
 */
export const setPublic = async (id: string, isPublic: boolean, classroomId?: string) => {
  if (classroomId) await assertModuleInClassroom(id, classroomId);
  return getPrisma().module.update({
    where: { id },
    data: { is_public: isPublic },
  });
};

/**
 * Append a content item of the given type to a module (at max position + 1).
 * The unique (module, target) constraint prevents adding the same item twice.
 * REPOSITORY is not a content item any more: a repository reaches a module
 * only through a REPO assignment (see the legacy block at the bottom).
 */
export const addItem = async (
  moduleId: string,
  type: ContentItemType,
  targetId: string,
  classroomId?: string
) => {
  const prisma = getPrisma();
  if (!CONTENT_ITEM_TYPES.includes(type)) {
    throw new Error('Repositories are attached to assignments, not placed in modules as items');
  }
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

  // Legacy REPOSITORY items are hidden from the admin content list, so the
  // caller orders only the content items; those rows keep their positions.
  const existingItems = await prisma.moduleItem.findMany({
    where: { module_id: moduleId, item_type: { not: 'REPOSITORY' } },
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

// The content item types callers (routes/UI) may add, without importing Prisma.
export const CONTENT_ITEM_TYPES: ContentItemType[] = [
  ModuleItemType.PAGE,
  ModuleItemType.QUIZ,
  ModuleItemType.SLIDE,
  ModuleItemType.FORM,
];

// ── Legacy REPOSITORY items ──────────────────────────────────────────────────
// `ModuleItemType.REPOSITORY` rows predate typed assignments. They are kept
// read-only and no UI renders them; nothing writes new ones, `addItem` refuses
// the type, and the visibility predicates above still resolve them from the
// repository's own publish flag. Dropping the enum value is a later cleanup.
/** @deprecated Use CONTENT_ITEM_TYPES; REPOSITORY is read-only. */
export const MODULE_ITEM_TYPES: ModuleItemType[] = [
  ...CONTENT_ITEM_TYPES,
  ModuleItemType.REPOSITORY,
];
