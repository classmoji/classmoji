import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import type { AssignmentType, Prisma } from '@prisma/client';
import * as notificationService from './notification.service.ts';

interface RepositoryQueryOptions {
  includeAssignments?: boolean;
  includePages?: boolean;
  includeSlides?: boolean;
  includeQuizzes?: boolean;
}

interface RepositoryAssignmentInput extends Prisma.AssignmentUncheckedCreateWithoutRepositoryInput {
  linkedPageIds?: string[];
  linkedSlideIds?: string[];
  branch?: string | null;
  workflow_file?: string | null;
}

type RepositoryCreateInput = Prisma.RepositoryUncheckedCreateInput & {
  assignments?: RepositoryAssignmentInput[];
};

interface RepositoryFormValues {
  title: string;
  type: AssignmentType;
  template: string;
  classroomSlug: string;
  assignments: RepositoryAssignmentInput[];
  weight?: number | string | null;
  tag?: string | null;
  tokens_per_hour?: number;
  branch?: string | null;
}

interface RepositoryAssignmentUpdateInput extends Prisma.AssignmentUncheckedCreateWithoutRepositoryInput {
  id?: string;
  title: string;
  linkedPageIds?: string[];
  linkedSlideIds?: string[];
  branch?: string | null;
  workflow_file?: string | null;
  student_deadline?: Date | string | null;
  grader_deadline?: Date | string | null;
  release_at?: Date | string | null;
}

type RepositoryUpdateValues = {
  id: string;
  assignments?: RepositoryAssignmentUpdateInput[];
  assignmentsToRemove?: Array<{ id: string }>;
  tag?: string | null;
  weight?: number | string | null;
  team_formation_deadline?: Date | string | null;
  type?: AssignmentType;
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
 * @param {number} [data.weight] - Weight for grading
 * @param {string} [data.tag_id] - Tag UUID
 * @param {Object[]} [data.assignments] - Assignments to create
 * @returns {Promise<Object>}
 */
export const create = async (data: RepositoryCreateInput) => {
  const { assignments, ...repositoryData } = data;

  // Generate slug from title (set once, never updated)
  const slug = titleToIdentifier(repositoryData.title);

  // Filter out non-Prisma fields from assignments and add slugs
  const cleanedAssignments = assignments?.map((assignment: RepositoryAssignmentInput) => {
    const {
      linkedPageIds: _linkedPageIds,
      linkedSlideIds: _linkedSlideIds,
      branch: _branch,
      workflow_file: _workflow_file,
      ...assignmentData
    } = assignment;
    return {
      ...assignmentData,
      slug: titleToIdentifier(assignmentData.title),
    };
  });

  return getPrisma().repository.create({
    data: {
      ...repositoryData,
      slug,
      weight: Number(repositoryData.weight ?? 100),
      ...(cleanedAssignments && {
        assignments: {
          create: cleanedAssignments,
        },
      }),
    },
    include: {
      assignments: true,
      tag: true,
    },
  });
};

/**
 * Create a Repository from form data (legacy compat)
 * @param {Object} values - Form values
 * @returns {Promise<Object>}
 */
export const createFromForm = async (values: RepositoryFormValues) => {
  const {
    title,
    type,
    template,
    classroomSlug,
    assignments,
    weight,
    tag,
    tokens_per_hour,
    branch,
  } = values;

  const classroom = await getPrisma().classroom.findUnique({
    where: { slug: classroomSlug },
  });

  if (!classroom) {
    throw new Error('Classroom not found');
  }

  // Generate slug from title (set once, never updated)
  const slug = titleToIdentifier(title);

  return getPrisma().repository.create({
    data: {
      title,
      slug,
      type,
      template,
      weight: Number(weight ?? 100),
      classroom_id: classroom.id,
      ...(tag && { tag_id: tag }),
      assignments: {
        create: assignments.map((a: RepositoryAssignmentInput) => ({
          ...a,
          slug: titleToIdentifier(a.title),
          tokens_per_hour: tokens_per_hour || 0,
          branch: branch || null,
        })),
      },
    },
    include: {
      assignments: true,
      tag: true,
    },
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
  updates: Prisma.RepositoryUpdateManyMutationInput,
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
 * Update a Repository with assignment changes
 * @param {Object} values - Update values
 * @returns {Promise<Object>}
 */
export const updateWithAssignments = async (values: RepositoryUpdateValues) => {
  const { id, assignments, assignmentsToRemove, tag, weight, ...updateData } = values;

  // Coerce repository-level dates
  if (updateData.team_formation_deadline && !(updateData.team_formation_deadline instanceof Date)) {
    updateData.team_formation_deadline = new Date(updateData.team_formation_deadline);
  }

  const repositoryUpdateData = {
    ...(updateData as Prisma.RepositoryUncheckedUpdateInput),
    weight: Number(weight ?? 100),
    ...(updateData.type === 'GROUP' && tag && { tag_id: tag }),
  } satisfies Prisma.RepositoryUncheckedUpdateInput;

  // Update repository
  await getPrisma().repository.update({
    where: { id },
    data: repositoryUpdateData,
  });

  // Delete removed assignments
  if (assignmentsToRemove?.length) {
    await getPrisma().assignment.deleteMany({
      where: {
        id: { in: assignmentsToRemove.map((a: { id: string }) => a.id) },
      },
    });
  }

  // Upsert assignments
  if (assignments?.length) {
    for (const assignment of assignments) {
      // Extract fields that shouldn't go to Prisma
      const {
        id: assignmentId,
        linkedPageIds: _linkedPageIds,
        linkedSlideIds: _linkedSlideIds,
        branch: _branch,
        workflow_file: _workflow_file,
        ...assignmentData
      } = assignment;
      const assignmentMutationData = assignmentData as Prisma.AssignmentUncheckedUpdateInput;

      // Coerce assignment date fields to Date objects
      const dateFields = ['student_deadline', 'grader_deadline', 'release_at'] as const;
      for (const field of dateFields) {
        if (assignmentMutationData[field] && !(assignmentMutationData[field] instanceof Date)) {
          assignmentMutationData[field] = new Date(assignmentMutationData[field] as string | Date);
        }
      }

      await getPrisma().assignment.upsert({
        where: { id: assignmentId || crypto.randomUUID() },
        update: assignmentMutationData,
        create: {
          id: assignmentId || undefined,
          ...(assignmentMutationData as Prisma.AssignmentUncheckedCreateWithoutRepositoryInput),
          slug: titleToIdentifier(assignment.title),
          repository_id: id,
        },
      });
    }
  }

  return getPrisma().repository.findUnique({
    where: { id },
    include: {
      assignments: true,
      tag: true,
    },
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
        title: isPublished ? `Repository published: ${mod.title}` : `Repository unpublished: ${mod.title}`,
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
