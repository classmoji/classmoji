import getPrisma from '@classmoji/database';
import { openToStudents, titleToIdentifier } from '@classmoji/utils';
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
  // The quiz's name only: its publish state, due and close dates are the
  // assignment's own columns.
  quiz: { select: { id: true, name: true } },
  form: { select: { id: true, title: true, slug: true, status: true } },
  pages: { include: { page: true }, orderBy: { order: 'asc' } },
  slides: { include: { slide: true }, orderBy: { order: 'asc' } },
  _count: { select: { git_repo_assignments: true } },
} satisfies Prisma.AssignmentInclude;

// A module's assignments in the order the Modules screen arranges them by
// hand, with the old deadline sort kept as the tie-break for rows that have
// never been dragged (they all sit at the position the migration gave them).
const ASSIGNMENT_ORDER = [
  { position: 'asc' },
  { student_deadline: { sort: 'asc', nulls: 'last' } },
  { title: 'asc' },
] satisfies Prisma.AssignmentOrderByWithRelationInput[];

const DETAIL_INCLUDE = {
  items: { orderBy: { position: 'asc' }, include: ITEM_INCLUDE },
  assignments: {
    include: ASSIGNMENT_INCLUDE,
    orderBy: ASSIGNMENT_ORDER,
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
 * published modules and published items, and only the assignments the
 * student-visibility rule admits (`openToStudents`, which reads
 * `quizzesVisible` for quiz assignments); the teaching team sees everything.
 */
export const listForClassroom = async (
  classroomSlug: string,
  {
    includeUnpublished = false,
    quizzesVisible = false,
  }: { includeUnpublished?: boolean; quizzesVisible?: boolean } = {}
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

  // Legacy QUIZ items are left out for every viewer: a quiz sits in a module
  // through its assignment, which is listed with the module's assignments.
  const modulesWithScopedItems = modules.map(m => ({
    ...m,
    items: m.items.filter(
      item => item.item_type !== ModuleItemType.QUIZ && isItemTargetInClassroom(item, classroomId)
    ),
  }));

  if (includeUnpublished) return modulesWithScopedItems;

  // Drop items that are not published, and assignments students cannot see
  // under the one visibility rule the Assignments page, the dashboard and the
  // calendar also apply: published, a REPO one's repository published (until
  // then no student repo exists to submit through), a quiz only where quizzes
  // are visible, a quiz or form neither a draft nor before `release_at`.
  // Module-level publish is already filtered in the query.
  const now = new Date();
  return modulesWithScopedItems.map(m => ({
    ...m,
    items: m.items.filter(isItemPublished),
    assignments: (m.assignments ?? []).filter(a => openToStudents(a, now, { quizzesVisible })),
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
  const prisma = getPrisma();
  // Position 0 is the top of the Modules page, so a new module has to be
  // placed explicitly at the end instead of taking the column default.
  const last = await prisma.module.findFirst({
    where: { classroom_id: classroomId },
    orderBy: { position: 'desc' },
    select: { position: true },
  });
  return prisma.module.create({
    data: {
      classroom_id: classroomId,
      title: input.title,
      slug: titleToIdentifier(input.title),
      description: input.description ?? null,
      position: last ? last.position + 1 : 0,
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

/**
 * Delete a module. A module that still owns assignments is refused: deleting
 * it would cascade into their submissions, grades and regrades.
 *
 * One exception, for a classroom whose quizzes are hidden (`quizzesHidden`,
 * the caller's reading of the classroom): its owner cannot see quiz
 * assignments, so a module whose only assignments are quiz ones would refuse
 * for a reason nobody can see. There those QUIZ assignment rows go with the
 * module; the quizzes and their attempts stay, and each quiz is set back to
 * DRAFT, so it shows as an unpublished quiz in no module once quizzes are
 * back. `deleted_quiz_assignment_ids` names them, so the caller can record it.
 */
export const deleteById = async (
  id: string,
  classroomId?: string,
  { quizzesHidden = false }: { quizzesHidden?: boolean } = {}
) => {
  if (classroomId) await assertModuleInClassroom(id, classroomId);
  return getPrisma().$transaction(async tx => {
    // The module row is locked for the check and the delete together. An
    // assignment being moved in at the same moment (assignment.moveToModuleEnd
    // takes this lock; any other write of `module_id` needs a key-share on the
    // row) either lands first and is counted below, or waits and finds the
    // module gone. Without the lock it could land between the two statements
    // and be cascade-deleted with its submissions.
    const locked = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM modules WHERE id = ${id} FOR UPDATE`;
    // Another delete of this module finished while this one waited for the row.
    if (locked.length === 0) throw new Error('Module not found in classroom');
    // A module that still owns assignments cannot go: deleting it would cascade
    // into their submissions, grades and regrades. Move or delete them first.
    const owned = await tx.assignment.findMany({
      where: { module_id: id },
      select: { id: true, type: true, quiz_id: true },
    });
    const onlyQuizzes = owned.length > 0 && owned.every(a => a.type === 'QUIZ');
    if (owned.length > 0 && !(quizzesHidden && onlyQuizzes)) {
      throw new Error('Module still has assignments');
    }
    const deletedQuizAssignmentIds = owned.map(a => a.id);
    if (deletedQuizAssignmentIds.length > 0) {
      await tx.assignment.deleteMany({
        where: { id: { in: deletedQuizAssignmentIds }, type: 'QUIZ' },
      });
      // Each quiz comes back as a draft in no module, for the owner to place
      // and publish again: a quiz with no assignment is shown to students by
      // its own status, and none of them saw it while quizzes were hidden.
      // After the assignments, so the rows are locked in the order every
      // other writer takes them (assignment, then quiz).
      const quizIds = owned.flatMap(a => (a.quiz_id ? [a.quiz_id] : []));
      if (quizIds.length > 0) {
        await tx.quiz.updateMany({ where: { id: { in: quizIds } }, data: { status: 'DRAFT' } });
      }
    }
    // ModuleItem rows cascade; the underlying pages/quizzes/slides/forms remain.
    const deleted = await tx.module.delete({ where: { id } });
    return { ...deleted, deleted_quiz_assignment_ids: deletedQuizAssignmentIds };
  });
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

/** Why a QUIZ item is not added: a quiz reaches a module through its assignment. */
export const QUIZ_ITEM_REFUSAL =
  'A quiz is placed in a module from the quiz form (or quiz_create / quiz_update with module_id)';

/**
 * Append a content item of the given type to a module (at max position + 1).
 * The unique (module, target) constraint prevents adding the same item twice.
 * REPOSITORY is not a content item any more: a repository reaches a module
 * only through a REPO assignment (see the legacy block at the bottom). Nor is
 * QUIZ: a quiz is placed in a module by its assignment, which the quiz form
 * writes; QUIZ items are no longer written and are ignored when ordering.
 */
export const addItem = async (
  moduleId: string,
  type: ContentItemType,
  targetId: string,
  classroomId?: string
) => {
  const prisma = getPrisma();
  if (type === ModuleItemType.QUIZ) throw new Error(QUIZ_ITEM_REFUSAL);
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
 * A reorder replaces every position in one go, so the caller has to hand back
 * exactly the rows it was given: a short, padded or foreign list would leave
 * the rest of the list sitting on stale positions.
 */
const assertSameSet = (existing: string[], ordered: string[], message: string) => {
  const existingIds = new Set(existing);
  const orderedIds = new Set(ordered);
  const matches =
    existingIds.size === ordered.length &&
    orderedIds.size === ordered.length &&
    ordered.every(id => existingIds.has(id));
  if (!matches) throw new Error(message);
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

  // Legacy REPOSITORY and QUIZ items are not part of the content list (a quiz
  // is placed by its assignment), so the caller orders only the content
  // items; those rows keep their positions.
  const existingItems = await prisma.moduleItem.findMany({
    where: { module_id: moduleId, item_type: { notIn: LEGACY_ITEM_TYPES } },
    select: { id: true },
  });
  assertSameSet(
    existingItems.map(item => item.id),
    orderedItemIds,
    'Ordered item ids must match module items'
  );

  await prisma.$transaction(
    orderedItemIds.map((id, index) =>
      prisma.moduleItem.update({
        where: { id, module_id: moduleId },
        data: { position: index },
      })
    )
  );
};

/**
 * Is this a unique violation on one of ModuleItem's (module_id, <target>)
 * indexes? All five mean the same thing to a caller — that module already
 * holds this page, slide, quiz or form — so they are matched as a group, by
 * `module_id` appearing in the reported field set. Prisma does not pin
 * `meta.target`: it arrives as field names, the raw constraint name, or that
 * name inside a one-element array depending on driver and version.
 */
const isModuleItemDuplicate = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: unknown }).code !== 'P2002') return false;
  const raw = (error as { meta?: { target?: unknown } }).meta?.target;
  const tokens = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [])
    .map(token => String(token).trim().toLowerCase())
    .filter(Boolean);
  return tokens.some(token => token.includes('module_id'));
};

/** Close the gap a departing item leaves behind, so positions stay 0..n-1. */
const compactItems = async (moduleId: string) => {
  const prisma = getPrisma();
  const remaining = await prisma.moduleItem.findMany({
    where: { module_id: moduleId, item_type: { notIn: LEGACY_ITEM_TYPES } },
    orderBy: { position: 'asc' },
    select: { id: true },
  });
  await prisma.$transaction(
    remaining.map((item, index) =>
      prisma.moduleItem.update({ where: { id: item.id }, data: { position: index } })
    )
  );
};

/**
 * Move a content item into `toModuleId` and give that module the ordering the
 * caller hands over. `orderedItemIds` is the TARGET module's full list after
 * the move, the moved id included; the module the item came from is compacted
 * behind it. Passing the module the item is already in is a plain reorder.
 */
export const moveItemToModule = async (
  moduleItemId: string,
  toModuleId: string,
  orderedItemIds: string[],
  classroomId: string
) => {
  const prisma = getPrisma();
  await assertModuleInClassroom(toModuleId, classroomId);

  const item = await prisma.moduleItem.findFirst({
    where: { id: moduleItemId, module: { classroom_id: classroomId } },
    select: { id: true, module_id: true, item_type: true },
  });
  if (!item) throw new Error('Module item not found in classroom');
  // Legacy pointers are invisible in the UI and keep their positions; nothing
  // should be able to drag one somewhere else. A quiz moves with its
  // assignment.
  if (item.item_type === 'REPOSITORY') throw new Error('Repository items cannot be moved');
  if (item.item_type === 'QUIZ') throw new Error(QUIZ_ITEM_REFUSAL);

  const fromModuleId = item.module_id;
  if (fromModuleId !== toModuleId) {
    try {
      await prisma.moduleItem.update({
        where: { id: moduleItemId },
        data: { module_id: toModuleId },
      });
    } catch (error: unknown) {
      if (isModuleItemDuplicate(error)) throw new Error('That module already has this item');
      throw error;
    }
  }

  await reorderItems(toModuleId, orderedItemIds, classroomId);
  if (fromModuleId !== toModuleId) await compactItems(fromModuleId);
};

/**
 * Persist a new ordering for a classroom's modules. `orderedModuleIds` is the
 * full list of module ids in their new order; each row's position becomes its
 * index, which is what the Modules page and every student-facing tree read.
 */
export const reorderModules = async (classroomId: string, orderedModuleIds: string[]) => {
  const prisma = getPrisma();

  const existing = await prisma.module.findMany({
    where: { classroom_id: classroomId },
    select: { id: true },
  });
  assertSameSet(
    existing.map(m => m.id),
    orderedModuleIds,
    'Ordered module ids must match the classroom modules'
  );

  await prisma.$transaction(
    orderedModuleIds.map((id, index) =>
      prisma.module.update({
        where: { id, classroom_id: classroomId },
        data: { position: index },
      })
    )
  );
};

// The content item types callers (routes/UI) may add, without importing Prisma.
// QUIZ is not one: a quiz reaches a module through its assignment.
export const CONTENT_ITEM_TYPES: ContentItemType[] = [
  ModuleItemType.PAGE,
  ModuleItemType.SLIDE,
  ModuleItemType.FORM,
];

/**
 * Item types kept read-only: no new rows, left out of every ordering. QUIZ
 * items predate quiz assignments (the migration gave each quiz in a module
 * an assignment) and are deleted in a later cleanup.
 */
const LEGACY_ITEM_TYPES: ModuleItemType[] = [ModuleItemType.REPOSITORY, ModuleItemType.QUIZ];

// ── Legacy REPOSITORY items ──────────────────────────────────────────────────
// `ModuleItemType.REPOSITORY` rows predate typed assignments. They are kept
// read-only and no UI renders them; nothing writes new ones, `addItem` refuses
// the type, and the visibility predicates above still resolve them from the
// repository's own publish flag. Dropping the enum value is a later cleanup.
/** @deprecated Use CONTENT_ITEM_TYPES; REPOSITORY is read-only. */
export const MODULE_ITEM_TYPES: ModuleItemType[] = [
  ...CONTENT_ITEM_TYPES,
  ModuleItemType.QUIZ,
  ModuleItemType.REPOSITORY,
];
