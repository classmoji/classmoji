import getPrisma from '@classmoji/database';
import { titleToIdentifier } from '@classmoji/utils';
import type { Prisma } from '@prisma/client';

type RepositoryImportClient = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

type SourceAssignmentWithLegacyFields = Prisma.AssignmentGetPayload<Record<string, never>> & {
  branch?: string | null;
  workflow_file?: string | null;
};

/**
 * Clone or find an existing tag in the target classroom
 * @param {string} sourceTagId - Source tag ID
 * @param {string} targetClassroomId - Target classroom ID
 * @param {Object} [tx] - Optional Prisma transaction client
 * @returns {Promise<Object>} - The cloned or existing tag
 */
export const cloneTag = async (
  sourceTagId: string,
  targetClassroomId: string,
  tx: RepositoryImportClient = getPrisma()
) => {
  const sourceTag = await tx.tag.findUnique({
    where: { id: sourceTagId },
  });

  if (!sourceTag) {
    throw new Error(`Source tag not found: ${sourceTagId}`);
  }

  // Check if tag with same name already exists in target classroom
  const existingTag = await tx.tag.findUnique({
    where: {
      classroom_id_name: {
        classroom_id: targetClassroomId,
        name: sourceTag.name,
      },
    },
  });

  if (existingTag) {
    return existingTag;
  }

  // Create new tag with same name
  return tx.tag.create({
    data: {
      classroom_id: targetClassroomId,
      name: sourceTag.name,
    },
  });
};

/**
 * Clone an assignment to a target repository
 * @param {string} sourceAssignmentId - Source assignment ID
 * @param {string} targetRepositoryId - Target repository ID
 * @param {Object} [options] - Clone options
 * @param {boolean} [options.stripDeadlines=true] - Remove deadline fields
 * @param {Object} [tx] - Optional Prisma transaction client
 * @returns {Promise<Object>} - The cloned assignment
 */
export const cloneAssignment = async (
  sourceAssignmentId: string,
  targetRepositoryId: string,
  options: { stripDeadlines?: boolean } = {},
  tx: RepositoryImportClient = getPrisma()
) => {
  const { stripDeadlines = true } = options;

  const sourceAssignment = (await tx.assignment.findUnique({
    where: { id: sourceAssignmentId },
  })) as SourceAssignmentWithLegacyFields | null;

  if (!sourceAssignment) {
    throw new Error(`Source assignment not found: ${sourceAssignmentId}`);
  }

  const assignmentCreateData: unknown = {
    repository_id: targetRepositoryId,
    title: sourceAssignment.title,
    weight: sourceAssignment.weight,
    is_published: false,
    description: sourceAssignment.description || '',
    tokens_per_hour: sourceAssignment.tokens_per_hour || 0,
    branch: sourceAssignment.branch,
    workflow_file: sourceAssignment.workflow_file,
    // Conditionally strip deadlines
    student_deadline: stripDeadlines ? null : sourceAssignment.student_deadline,
    grader_deadline: stripDeadlines ? null : sourceAssignment.grader_deadline,
    release_at: stripDeadlines ? null : sourceAssignment.release_at,
    grades_released: false,
  };
  // TODO: narrow further once legacy assignment fields are aligned with the generated Prisma schema.
  return tx.assignment.create({
    data: assignmentCreateData as Prisma.AssignmentUncheckedCreateInput,
  });
};

/**
 * Clone a quiz to a target classroom/repository
 * @param {string} sourceQuizId - Source quiz ID
 * @param {string} targetClassroomId - Target classroom ID
 * @param {string|null} targetRepositoryId - Target repository ID (optional)
 * @param {Object} [options] - Clone options
 * @param {boolean} [options.setDraft=true] - Set status to DRAFT
 * @param {boolean} [options.stripDeadlines=true] - Remove due_date
 * @param {Object} [tx] - Optional Prisma transaction client
 * @returns {Promise<Object>} - The cloned quiz
 */
export const cloneQuiz = async (
  sourceQuizId: string,
  targetClassroomId: string,
  targetRepositoryId: string | null,
  options: { setDraft?: boolean; stripDeadlines?: boolean } = {},
  tx: RepositoryImportClient = getPrisma()
) => {
  const { setDraft = true, stripDeadlines = true } = options;

  const sourceQuiz = await tx.quiz.findUnique({
    where: { id: sourceQuizId },
  });

  if (!sourceQuiz) {
    throw new Error(`Source quiz not found: ${sourceQuizId}`);
  }

  return tx.quiz.create({
    data: {
      classroom_id: targetClassroomId,
      repository_id: targetRepositoryId,
      name: sourceQuiz.name,
      system_prompt: sourceQuiz.system_prompt,
      rubric_prompt: sourceQuiz.rubric_prompt,
      weight: sourceQuiz.weight,
      question_count: sourceQuiz.question_count,
      difficulty_level: sourceQuiz.difficulty_level,
      subject: sourceQuiz.subject,
      include_code_context: sourceQuiz.include_code_context,
      grading_strategy: sourceQuiz.grading_strategy,
      max_attempts: sourceQuiz.max_attempts,
      // Conditionally set status and deadline
      status: setDraft ? 'DRAFT' : sourceQuiz.status,
      due_date: stripDeadlines ? null : sourceQuiz.due_date,
    },
  });
};

/**
 * Clone a repository to a target classroom
 * @param {string} sourceRepositoryId - Source repository ID
 * @param {string} targetClassroomId - Target classroom ID
 * @param {Object} [options] - Clone options
 * @param {boolean} [options.includeAssignments=true] - Clone assignments
 * @param {boolean} [options.includeQuizzes=false] - Clone quizzes
 * @param {boolean} [options.stripDeadlines=true] - Remove deadline fields
 * @param {Object} [tx] - Optional Prisma transaction client
 * @returns {Promise<Object>} - The cloned repository with relations
 */
export const cloneModule = async (
  sourceRepositoryId: string,
  targetClassroomId: string,
  options: {
    includeAssignments?: boolean;
    includeQuizzes?: boolean;
    stripDeadlines?: boolean;
  } = {},
  tx: RepositoryImportClient = getPrisma()
) => {
  const { includeAssignments = true, includeQuizzes = false, stripDeadlines = true } = options;

  const sourceModule = await tx.repository.findUnique({
    where: { id: sourceRepositoryId },
    include: {
      assignments: true,
      quizzes: true,
      tag: true,
    },
  });

  if (!sourceModule) {
    throw new Error(`Source repository not found: ${sourceRepositoryId}`);
  }

  // Handle tag for GROUP repositories
  let targetTagId = null;
  if (sourceModule.type === 'GROUP' && sourceModule.tag_id) {
    const clonedTag = await cloneTag(sourceModule.tag_id, targetClassroomId, tx);
    targetTagId = clonedTag.id;
  }

  // Create the repository
  const newModule = await tx.repository.create({
    data: {
      classroom_id: targetClassroomId,
      title: titleToIdentifier(sourceModule.title),
      template: sourceModule.template,
      is_published: false,
      weight: sourceModule.weight,
      type: sourceModule.type,
      tag_id: targetTagId,
      is_extra_credit: sourceModule.is_extra_credit,
      drop_lowest_count: sourceModule.drop_lowest_count,
    },
  });

  const results: {
    repository: typeof newModule;
    assignments: Awaited<ReturnType<typeof cloneAssignment>>[];
    quizzes: Awaited<ReturnType<typeof cloneQuiz>>[];
  } = {
    repository: newModule,
    assignments: [],
    quizzes: [],
  };

  // Clone assignments
  if (includeAssignments && sourceModule.assignments.length > 0) {
    for (const assignment of sourceModule.assignments) {
      const clonedAssignment = await cloneAssignment(
        assignment.id,
        newModule.id,
        { stripDeadlines },
        tx
      );
      results.assignments.push(clonedAssignment);
    }
  }

  // Clone quizzes
  if (includeQuizzes && sourceModule.quizzes.length > 0) {
    for (const quiz of sourceModule.quizzes) {
      const clonedQuiz = await cloneQuiz(
        quiz.id,
        targetClassroomId,
        newModule.id,
        { setDraft: true, stripDeadlines },
        tx
      );
      results.quizzes.push(clonedQuiz);
    }
  }

  return results;
};

/**
 * Clone multiple repositories with their relations (high-level orchestrator)
 * @param {string} targetClassroomId - Target classroom ID
 * @param {Object[]} moduleConfigs - Array of repository configurations
 * @param {string} moduleConfigs[].id - Source repository ID
 * @param {boolean} [moduleConfigs[].includeQuizzes=false] - Include quizzes
 * @param {Object} [options] - Global options
 * @param {boolean} [options.stripDeadlines=true] - Remove deadline fields
 * @returns {Promise<Object>} - Summary of cloned items
 */
export const cloneModulesWithRelations = async (
  targetClassroomId: string,
  moduleConfigs: Array<{ id: string; includeQuizzes?: boolean }>,
  options: { stripDeadlines?: boolean } = {}
) => {
  const { stripDeadlines = true } = options;

  return getPrisma().$transaction(async tx => {
    const results: {
      repositories: Awaited<ReturnType<typeof cloneModule>>['repository'][];
      assignments: Awaited<ReturnType<typeof cloneAssignment>>[];
      quizzes: Awaited<ReturnType<typeof cloneQuiz>>[];
      tags: Prisma.TagUncheckedCreateInput[];
    } = {
      repositories: [],
      assignments: [],
      quizzes: [],
      tags: [],
    };

    for (const config of moduleConfigs) {
      const cloneResult = await cloneModule(
        config.id,
        targetClassroomId,
        {
          includeAssignments: true,
          includeQuizzes: config.includeQuizzes || false,
          stripDeadlines,
        },
        tx
      );

      results.repositories.push(cloneResult.repository);
      results.assignments.push(...cloneResult.assignments);
      results.quizzes.push(...cloneResult.quizzes);
    }

    return results;
  });
};

/**
 * Get repositories from a classroom with counts for import preview
 * @param {string} classroomId - Classroom ID
 * @returns {Promise<Object[]>} - Modules with relation counts
 */
export const getModulesForImport = async (classroomId: string) => {
  return getPrisma().repository.findMany({
    where: { classroom_id: classroomId },
    select: {
      id: true,
      title: true,
      template: true,
      type: true,
      weight: true,
      is_extra_credit: true,
      _count: {
        select: {
          assignments: true,
          quizzes: true,
        },
      },
    },
    orderBy: { title: 'asc' },
  });
};
