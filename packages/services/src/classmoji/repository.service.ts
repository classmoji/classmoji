import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import type { RepositoryType, Prisma } from '@prisma/client';
import * as notificationService from './notification.service.ts';

interface RepositoryQueryOptions {
  includeAssignments?: boolean;
  includePages?: boolean;
  includeSlides?: boolean;
  includeQuizzes?: boolean;
}

type RepositoryCreateInput = Prisma.RepositoryUncheckedCreateInput;

type RepositoryUpdateValues = {
  id: string;
  tag?: string | null;
  team_formation_deadline?: Date | string | null;
  type?: RepositoryType;
  [key: string]: unknown;
};

/**
 * Find a Repository by ID
 * @param {string} id - UUID of the Repository
 * @returns {Promise<Object|null>}
 */
export const findById = async (id: string) => {
  return getPrisma().repository.findUnique({
    where: { id },
    include: {
      assignments: true,
      classroom: true,
      tag: true,
    },
  });
};

/**
 * Find a Repository by classroom and title
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} title - Repository title
 * @returns {Promise<Object|null>}
 */
export const findByClassroomAndTitle = async (classroomId: string, title: string) => {
  return getPrisma().repository.findUnique({
    where: {
      classroom_id_title: {
        classroom_id: classroomId,
        title,
      },
    },
    include: {
      assignments: true,
      tag: true,
    },
  });
};

/**
 * Find a Repository by classroom slug and title
 * @param {string} classroomSlug - Classroom slug
 * @param {string} title - Repository title
 * @param {Object} [options] - Additional options
 * @returns {Promise<Object|null>}
 */
export const findBySlugAndTitle = async (
  classroomSlug: string,
  title: string,
  options: RepositoryQueryOptions = {}
) => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: classroomSlug },
    select: { id: true },
  });

  if (!classroom) return null;

  return getPrisma().repository.findUnique({
    where: {
      classroom_id_title: {
        classroom_id: classroom.id,
        title,
      },
    },
    include: {
      assignments:
        options.includeAssignments !== false
          ? {
              include: {
                pages: options.includePages === true ? { include: { page: true } } : false,
                slides: options.includeSlides === true ? { include: { slide: true } } : false,
              },
            }
          : false,
      tag: true,
      quizzes: options.includeQuizzes === true,
      pages: options.includePages === true ? { include: { page: true } } : false,
      slides: options.includeSlides === true ? { include: { slide: true } } : false,
    },
  });
};

/**
 * Find a Repository by classroom slug and repository slug
 * @param {string} classroomSlug - Classroom slug
 * @param {string} repositorySlug - Repository slug
 * @param {Object} [options] - Additional options
 * @returns {Promise<Object|null>}
 */
export const findByClassroomSlugAndModuleSlug = async (
  classroomSlug: string,
  repositorySlug: string,
  options: RepositoryQueryOptions = {}
) => {
  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: classroomSlug },
    select: { id: true },
  });

  if (!classroom) return null;

  return getPrisma().repository.findFirst({
    where: {
      classroom_id: classroom.id,
      slug: repositorySlug,
    },
    include: {
      assignments:
        options.includeAssignments !== false
          ? {
              include: {
                pages: options.includePages === true ? { include: { page: true } } : false,
                slides: options.includeSlides === true ? { include: { slide: true } } : false,
              },
            }
          : false,
      tag: true,
      quizzes: options.includeQuizzes === true,
      pages: options.includePages === true ? { include: { page: true } } : false,
      slides: options.includeSlides === true ? { include: { slide: true } } : false,
    },
  });
};

/**
 * Find all Modules for a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findByClassroomId = async (classroomId: string) => {
  return getPrisma().repository.findMany({
    where: { classroom_id: classroomId },
    include: {
      assignments: true,
      tag: true,
    },
    orderBy: { title: 'asc' },
  });
};

/**
 * Find all Modules for a classroom by slug
 * @param {string} classroomSlug - Classroom slug
 * @returns {Promise<Object[]>}
 */
export const findByClassroomSlug = async (
  classroomSlug: string,
  _options?: { includeAssignments?: boolean }
) => {
  return getPrisma().repository.findMany({
    where: {
      classroom: { slug: classroomSlug },
    },
    include: {
      assignments: true,
      tag: true,
    },
    orderBy: { title: 'asc' },
  });
};

/**
 * Find published Modules for a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findPublished = async (classroomId: string) => {
  return getPrisma().repository.findMany({
    where: {
      classroom_id: classroomId,
      is_published: true,
    },
    include: {
      assignments: {
        where: { is_published: true },
      },
      tag: true,
    },
    orderBy: { title: 'asc' },
  });
};

/**
 * Create a Repository with assignments
 * @param {Object} data - Repository data
 * @param {string} data.classroom_id - UUID of the Classroom
 * @param {string} data.title - Repository title
 * @param {string} data.template - Template repo name
 * @param {string} data.type - INDIVIDUAL or GROUP
 * @param {string} [data.tag_id] - Tag UUID
 * @returns {Promise<Object>}
 */
export const create = async (data: RepositoryCreateInput) => {
  // Generate slug from title (set once, never updated)
  const slug = titleToIdentifier(data.title);

  return getPrisma().repository.create({
    data: { ...data, slug },
    include: { assignments: true, tag: true },
  });
};

/**
 * Reject ids that cannot safely stand in a scoped `where` clause.
 *
 * The scoped writes below pair the repository id with `classroom_id` so the
 * write itself can only touch the authorized classroom, but that pairing only
 * holds while both values are real strings. Prisma drops an `undefined` value
 * from a `where` instead of rejecting it, and these id fields also accept a
 * `StringFilter` object — so `undefined` or `{ not: '' }` would leave a
 * `deleteMany`/`updateMany` matching EVERY row in the classroom. Ids reach these
 * functions from untyped request bodies, so the check has to be a runtime one.
 */
const assertScopedIds = (id: unknown, classroomId: unknown): void => {
  if (typeof id !== 'string' || !id) throw new Error('Invalid repository id');
  if (typeof classroomId !== 'string' || !classroomId) throw new Error('Invalid classroom id');
};

/**
 * Update a Repository.
 *
 * `classroomId` is REQUIRED and scopes the write — see `deleteById` below.
 *
 * @param {string} id - UUID of the Repository
 * @param {Object} updates - Fields to update
 * @param {string} classroomId - UUID of the authorized Classroom
 * @returns {Promise<Object>}
 */
export const update = async (
  id: string,
  // Unchecked so the tag_id FK scalar is writable; id and classroom_id are
  // omitted so an update can never move a repository to another classroom.
  updates: Omit<Prisma.RepositoryUncheckedUpdateManyInput, 'id' | 'classroom_id'>,
  classroomId: string
) => {
  assertScopedIds(id, classroomId);

  const { count } = await getPrisma().repository.updateMany({
    where: { id, classroom_id: classroomId },
    data: updates,
  });
  if (count !== 1) throw new Error('Repository not found in classroom');

  return getPrisma().repository.findFirst({
    where: { id, classroom_id: classroomId },
    include: {
      assignments: true,
      tag: true,
    },
  });
};

/**
 * Update a Repository from the repository form. Assignments are managed on
 * the module page, not here.
 * @param {Object} values - Update values
 * @returns {Promise<Object>}
 */
export const updateFromForm = async (values: RepositoryUpdateValues) => {
  const { id, tag, ...updateData } = values;

  // Coerce repository-level dates
  if (updateData.team_formation_deadline && !(updateData.team_formation_deadline instanceof Date)) {
    updateData.team_formation_deadline = new Date(updateData.team_formation_deadline);
  }

  const repositoryUpdateData = {
    ...(updateData as Prisma.RepositoryUncheckedUpdateInput),
    ...(updateData.type === 'GROUP' && tag && { tag_id: tag }),
  } satisfies Prisma.RepositoryUncheckedUpdateInput;

  return getPrisma().repository.update({
    where: { id },
    data: repositoryUpdateData,
    include: { assignments: true, tag: true },
  });
};

/**
 * Delete a Repository.
 *
 * `classroomId` is REQUIRED and is part of the write itself rather than a check
 * performed beforehand: `delete({ where: { id } })` would destroy any repository
 * whose id a caller can name, in any classroom. `deleteMany` accepts the
 * non-unique compound.
 *
 * `assertScopedIds` runs FIRST because the compound only narrows the write while
 * both halves are real strings — see its docblock. Past that guard `id` is the
 * primary key, so the compound matches at most one row: a count other than 1
 * means zero rows matched, the id did not belong to the authorized classroom,
 * and nothing was written — which throws rather than passing as a silent no-op.
 *
 * @param {string} id - UUID of the Repository
 * @param {string} classroomId - UUID of the authorized Classroom
 * @returns {Promise<Object>}
 */
export const deleteById = async (id: string, classroomId: string) => {
  assertScopedIds(id, classroomId);

  const { count } = await getPrisma().repository.deleteMany({
    where: { id, classroom_id: classroomId },
  });
  if (count !== 1) throw new Error('Repository not found in classroom');
  return { id };
};

/**
 * Publish or unpublish a Repository.
 *
 * `classroomId` is REQUIRED and scopes the write — see `deleteById` above.
 *
 * @param {string} id - UUID of the Repository
 * @param {boolean} isPublished - Whether to publish
 * @param {string} classroomId - UUID of the authorized Classroom
 * @returns {Promise<Object>}
 */
export const setPublished = async (id: string, isPublished: boolean, classroomId: string) => {
  // Before the read as well as the write: an unusable id would make the lookup
  // below return an arbitrary repository in the classroom, and the notification
  // would then be decided by one row while another was flipped.
  assertScopedIds(id, classroomId);

  const previous = await getPrisma().repository.findFirst({
    where: { id, classroom_id: classroomId },
    select: { is_published: true },
  });

  const { count } = await getPrisma().repository.updateMany({
    where: { id, classroom_id: classroomId },
    data: { is_published: isPublished },
  });
  if (count !== 1) throw new Error('Repository not found in classroom');

  // `updateMany` returns a count, not the row, and the notification below needs
  // the record. The scoped write above has already proven it exists.
  const mod = await getPrisma().repository.findUniqueOrThrow({
    where: { id },
  });

  if (previous && previous.is_published !== isPublished) {
    await notificationService.runSafely('repository publish notification', async () => {
      const studentIds = await notificationService.getStudentsInClassroom(mod.classroom_id);
      await notificationService.createNotifications({
        type: isPublished ? 'REPOSITORY_PUBLISHED' : 'REPOSITORY_UNPUBLISHED',
        classroomId: mod.classroom_id,
        recipientUserIds: studentIds,
        resourceType: 'repository',
        resourceId: mod.id,
        title: isPublished
          ? `Repository published: ${mod.title}`
          : `Repository unpublished: ${mod.title}`,
      });
    });
  }

  return mod;
};

/**
 * Get Repositories with gitRepo status for a student
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} studentId - UUID of the student
 * @returns {Promise<Object[]>}
 */
export const findWithStudentStatus = async (classroomId: string, studentId: string) => {
  return getPrisma().repository.findMany({
    where: {
      classroom_id: classroomId,
      is_published: true,
    },
    include: {
      assignments: {
        where: { is_published: true },
      },
      git_repos: {
        where: { student_id: studentId },
        include: {
          assignments: {
            include: {
              grades: true,
            },
          },
        },
      },
      tag: true,
    },
    orderBy: { title: 'asc' },
  });
};

/**
 * What hangs off a repository, read inside the authorized classroom: its
 * assignments (id + title) and counts of every dependent row. Returns null when
 * the id is not a repository of `classroomId`.
 *
 * `git_repos` > 0 means student/team copies were provisioned from it, which is
 * what freezes its structural fields and blocks a delete. The other counts are
 * the blast radius of a delete: assignments, module items, page/slide links and
 * autograding tests cascade with the repository; quizzes are unlinked (SET NULL).
 *
 * `classroomId` is REQUIRED and part of the query — see `deleteById`.
 */
export const findDependents = async (id: string, classroomId: string) => {
  assertScopedIds(id, classroomId);

  return getPrisma().repository.findFirst({
    where: { id, classroom_id: classroomId },
    select: {
      id: true,
      assignments: { select: { id: true, title: true }, orderBy: { title: 'asc' } },
      _count: {
        select: {
          git_repos: true,
          module_items: true,
          pages: true,
          slides: true,
          quizzes: true,
          autograding_tests: true,
        },
      },
    },
  });
};

/** Prove a repository belongs to the classroom, or throw. */
export const assertInClassroom = async (repositoryId: string, classroomId: string) => {
  const repository = await getPrisma().repository.findFirst({
    where: { id: repositoryId, classroom_id: classroomId },
    select: { id: true },
  });
  if (!repository) throw new Error('Repository not found in classroom');
  return repository;
};
