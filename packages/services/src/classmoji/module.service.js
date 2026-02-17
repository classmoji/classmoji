import prisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';

/**
 * Find a Module by ID
 * @param {string} id - UUID of the Module
 * @returns {Promise<Object|null>}
 */
export const findById = async id => {
  return prisma.module.findUnique({
    where: { id },
    include: {
      assignments: true,
      classroom: true,
      tag: true,
    },
  });
};

/**
 * Find a Module by classroom and title
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} title - Module title
 * @returns {Promise<Object|null>}
 */
export const findByClassroomAndTitle = async (classroomId, title) => {
  return prisma.module.findUnique({
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
 * Find a Module by classroom slug and title
 * @param {string} classroomSlug - Classroom slug
 * @param {string} title - Module title
 * @param {Object} [options] - Additional options
 * @returns {Promise<Object|null>}
 */
export const findBySlugAndTitle = async (classroomSlug, title, options = {}) => {
  const classroom = await prisma.classroom.findUnique({
    where: { slug: classroomSlug },
    select: { id: true },
  });

  if (!classroom) return null;

  return prisma.module.findUnique({
    where: {
      classroom_id_title: {
        classroom_id: classroom.id,
        title,
      },
    },
    include: {
      assignments: options.includeAssignments !== false
        ? {
            include: {
              pages: options.includePages === true
                ? { include: { page: true } }
                : false,
              slides: options.includeSlides === true
                ? { include: { slide: true } }
                : false,
            },
          }
        : false,
      tag: true,
      quizzes: options.includeQuizzes === true,
      pages: options.includePages === true
        ? { include: { page: true } }
        : false,
      slides: options.includeSlides === true
        ? { include: { slide: true } }
        : false,
    },
  });
};

/**
 * Find a Module by classroom slug and module slug
 * @param {string} classroomSlug - Classroom slug
 * @param {string} moduleSlug - Module slug
 * @param {Object} [options] - Additional options
 * @returns {Promise<Object|null>}
 */
export const findByClassroomSlugAndModuleSlug = async (classroomSlug, moduleSlug, options = {}) => {
  const classroom = await prisma.classroom.findUnique({
    where: { slug: classroomSlug },
    select: { id: true },
  });

  if (!classroom) return null;

  return prisma.module.findFirst({
    where: {
      classroom_id: classroom.id,
      slug: moduleSlug,
    },
    include: {
      assignments: options.includeAssignments !== false
        ? {
            include: {
              pages: options.includePages === true
                ? { include: { page: true } }
                : false,
              slides: options.includeSlides === true
                ? { include: { slide: true } }
                : false,
            },
          }
        : false,
      tag: true,
      quizzes: options.includeQuizzes === true,
      pages: options.includePages === true
        ? { include: { page: true } }
        : false,
      slides: options.includeSlides === true
        ? { include: { slide: true } }
        : false,
    },
  });
};

/**
 * Find all Modules for a classroom
 * @param {string} classroomId - UUID of the Classroom
 * @returns {Promise<Object[]>}
 */
export const findByClassroomId = async classroomId => {
  return prisma.module.findMany({
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
export const findByClassroomSlug = async classroomSlug => {
  return prisma.module.findMany({
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
export const findPublished = async classroomId => {
  return prisma.module.findMany({
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
 * Create a Module with assignments
 * @param {Object} data - Module data
 * @param {string} data.classroom_id - UUID of the Classroom
 * @param {string} data.title - Module title
 * @param {string} data.template - Template repo name
 * @param {string} data.type - INDIVIDUAL or GROUP
 * @param {number} [data.weight] - Weight for grading
 * @param {string} [data.tag_id] - Tag UUID
 * @param {Object[]} [data.assignments] - Assignments to create
 * @returns {Promise<Object>}
 */
export const create = async data => {
  const { assignments, ...moduleData } = data;

  // Generate slug from title (set once, never updated)
  const slug = titleToIdentifier(moduleData.title);

  // Filter out non-Prisma fields from assignments and add slugs
  const cleanedAssignments = assignments?.map(assignment => {
    const { linkedPageIds, linkedSlideIds, branch, workflow_file, ...assignmentData } = assignment;
    return {
      ...assignmentData,
      slug: titleToIdentifier(assignmentData.title),
    };
  });

  return prisma.module.create({
    data: {
      ...moduleData,
      slug,
      weight: Number(moduleData.weight ?? 100),
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
 * Create a Module from form data (legacy compat)
 * @param {Object} values - Form values
 * @returns {Promise<Object>}
 */
export const createFromForm = async values => {
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

  const classroom = await prisma.classroom.findUnique({
    where: { slug: classroomSlug },
  });

  if (!classroom) {
    throw new Error('Classroom not found');
  }

  // Generate slug from title (set once, never updated)
  const slug = titleToIdentifier(title);

  return prisma.module.create({
    data: {
      title,
      slug,
      type,
      template,
      weight: Number(weight ?? 100),
      classroom_id: classroom.id,
      ...(tag && { tag_id: tag }),
      assignments: {
        create: assignments.map(a => ({
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
 * Update a Module
 * @param {string} id - UUID of the Module
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>}
 */
export const update = async (id, updates) => {
  return prisma.module.update({
    where: { id },
    data: updates,
    include: {
      assignments: true,
      tag: true,
    },
  });
};

/**
 * Update a Module with assignment changes
 * @param {Object} values - Update values
 * @returns {Promise<Object>}
 */
export const updateWithAssignments = async values => {
  const { id, assignments, assignmentsToRemove, tag, weight, ...updateData } = values;

  // Coerce module-level dates
  if (updateData.team_formation_deadline && !(updateData.team_formation_deadline instanceof Date)) {
    updateData.team_formation_deadline = new Date(updateData.team_formation_deadline);
  }

  // Update module
  await prisma.module.update({
    where: { id },
    data: {
      ...updateData,
      weight: Number(weight ?? 100),
      ...(updateData.type === 'GROUP' && tag && { tag_id: tag }),
    },
  });

  // Delete removed assignments
  if (assignmentsToRemove?.length) {
    await prisma.assignment.deleteMany({
      where: {
        id: { in: assignmentsToRemove.map(a => a.id) },
      },
    });
  }

  // Upsert assignments
  if (assignments?.length) {
    for (const assignment of assignments) {
      // Extract fields that shouldn't go to Prisma
      const {
        id: assignmentId,
        linkedPageIds,
        linkedSlideIds,
        branch,
        workflow_file,
        ...assignmentData
      } = assignment;

      // Coerce assignment date fields to Date objects
      for (const field of ['student_deadline', 'grader_deadline', 'release_at']) {
        if (assignmentData[field] && !(assignmentData[field] instanceof Date)) {
          assignmentData[field] = new Date(assignmentData[field]);
        }
      }

      await prisma.assignment.upsert({
        where: { id: assignmentId || crypto.randomUUID() },
        update: assignmentData,
        create: {
          id: assignmentId || undefined,
          ...assignmentData,
          slug: titleToIdentifier(assignmentData.title),
          module_id: id,
        },
      });
    }
  }

  return prisma.module.findUnique({
    where: { id },
    include: {
      assignments: true,
      tag: true,
    },
  });
};

/**
 * Delete a Module
 * @param {string} id - UUID of the Module
 * @returns {Promise<Object>}
 */
export const deleteById = async id => {
  return prisma.module.delete({
    where: { id },
  });
};

/**
 * Publish or unpublish a Module
 * @param {string} id - UUID of the Module
 * @param {boolean} isPublished - Whether to publish
 * @returns {Promise<Object>}
 */
export const setPublished = async (id, isPublished) => {
  return prisma.module.update({
    where: { id },
    data: { is_published: isPublished },
  });
};

/**
 * Get Modules with repository status for a student
 * @param {string} classroomId - UUID of the Classroom
 * @param {string} studentId - UUID of the student
 * @returns {Promise<Object[]>}
 */
export const findWithStudentStatus = async (classroomId, studentId) => {
  return prisma.module.findMany({
    where: {
      classroom_id: classroomId,
      is_published: true,
    },
    include: {
      assignments: {
        where: { is_published: true },
      },
      repositories: {
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
