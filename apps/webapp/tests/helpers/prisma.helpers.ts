import getPrisma from '@classmoji/database';
import { getDevContext } from './env.helpers';

/**
 * Prisma client for test setup/teardown.
 * Uses DATABASE_URL from .dev-context if process.env.DATABASE_URL isn't already set.
 *
 * Tests should inject their own data through this client and clean up after themselves
 * rather than relying on whatever the seed left behind.
 */
let cached: ReturnType<typeof getPrisma> | null = null;

export function getTestPrisma(): ReturnType<typeof getPrisma> {
  if (!process.env.DATABASE_URL) {
    const ctx = getDevContext();
    if (ctx.databaseUrl) process.env.DATABASE_URL = ctx.databaseUrl;
  }
  if (!cached) {
    cached = getPrisma();
  }
  return cached;
}

/**
 * Find the User row matching a TestUser login. Throws if not present —
 * tests assume the configured GitHub user has been onboarded into the dev DB.
 */
export async function getUserByLogin(login: string): Promise<{ id: string; login: string }> {
  const prisma = getTestPrisma();
  const user = await prisma.user.findFirst({ where: { login } });
  if (!user) {
    throw new Error(
      `Test user '${login}' not found in database. Run \`npm run db:seed\` or sign in once.`
    );
  }
  return user;
}

/**
 * Find the Classroom row matching a slug. Throws if not present.
 */
export async function getClassroomBySlug(
  slug: string
): Promise<{ id: string; slug: string; name: string }> {
  const prisma = getTestPrisma();
  const classroom = await prisma.classroom.findFirst({ where: { slug } });
  if (!classroom) {
    throw new Error(`Classroom '${slug}' not found. Run \`npm run db:seed\`.`);
  }
  return classroom;
}

// Assignment / Repository helpers.
// A Repository maps to the `repositories` table and owns Assignment rows.
// A student "submission" is a GitRepoAssignment row whose `status` is CLOSED.

/**
 * Read a Repository row by classroom + title.
 * Returns null when absent so callers can assert creation/deletion.
 */
export async function getRepositoryByTitle(
  classroomId: string,
  title: string
): Promise<{ id: string; title: string; is_published: boolean; weight: number } | null> {
  const prisma = getTestPrisma();
  return prisma.repository.findUnique({
    where: { classroom_id_title: { classroom_id: classroomId, title } },
    select: { id: true, title: true, is_published: true, weight: true },
  });
}

/**
 * Read the `is_published` flag for a Repository by id. Throws if missing.
 */
export async function getRepositoryPublishedState(id: string): Promise<boolean> {
  const prisma = getTestPrisma();
  const repo = await prisma.repository.findUnique({
    where: { id },
    select: { is_published: true },
  });
  if (!repo) throw new Error(`Repository '${id}' not found in database.`);
  return repo.is_published;
}

export interface SeededRepository {
  repositoryId: string;
  title: string;
  assignmentId: string;
  assignmentTitle: string;
}

/**
 * Create a self-contained Repository + Assignment for a classroom so a spec
 * can drive publish/unpublish/edit/delete against known rows. Idempotent:
 * deletes any prior row with the same title first (cascades to assignments).
 */
export async function seedRepositoryWithAssignment(
  classroomId: string,
  title: string,
  options: { isPublished?: boolean; weight?: number; assignmentTitle?: string } = {}
): Promise<SeededRepository> {
  const prisma = getTestPrisma();
  const { isPublished = true, weight = 5, assignmentTitle = `${title} Part 1` } = options;

  await prisma.repository
    .delete({ where: { classroom_id_title: { classroom_id: classroomId, title } } })
    .catch(() => undefined);

  const repository = await prisma.repository.create({
    data: {
      classroom_id: classroomId,
      title,
      slug: title,
      template: 'dev-org/test-template',
      weight,
      type: 'INDIVIDUAL',
      is_published: isPublished,
      assignments: {
        create: [
          {
            title: assignmentTitle,
            slug: assignmentTitle.toLowerCase().replace(/\s+/g, '-'),
            weight: 100,
            is_published: isPublished,
          },
        ],
      },
    },
    include: { assignments: true },
  });

  return {
    repositoryId: repository.id,
    title: repository.title,
    assignmentId: repository.assignments[0].id,
    assignmentTitle: repository.assignments[0].title,
  };
}

/**
 * Remove a Repository (and its cascading assignments / git repos) by id.
 * Safe to call in cleanup even if already deleted.
 */
export async function deleteRepositoryById(id: string): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.repository.delete({ where: { id } }).catch(() => undefined);
}

export interface SeededStudentSubmission extends SeededRepository {
  gitRepoId: string;
  gitRepoAssignmentId: string;
}

/**
 * Seed a published Repository + Assignment plus a GitRepo and a
 * GitRepoAssignment owned by `studentId`, so the student `assignments` page
 * has a real row to render and a spec can assert submission status in the DB.
 *
 * `status` controls whether the submission shows as "Submitted" (CLOSED) or
 * "Not submitted" (OPEN) on the student page.
 */
export async function seedStudentSubmission(
  classroomId: string,
  studentId: string,
  title: string,
  options: { status?: 'OPEN' | 'CLOSED'; gradesReleased?: boolean } = {}
): Promise<SeededStudentSubmission> {
  const prisma = getTestPrisma();
  const { status = 'OPEN', gradesReleased = false } = options;

  await prisma.repository
    .delete({ where: { classroom_id_title: { classroom_id: classroomId, title } } })
    .catch(() => undefined);

  const repository = await prisma.repository.create({
    data: {
      classroom_id: classroomId,
      title,
      slug: title,
      template: 'dev-org/test-template',
      weight: 5,
      type: 'INDIVIDUAL',
      is_published: true,
      assignments: {
        create: [
          {
            title: `${title} Assignment`,
            slug: `${title}-assignment`,
            weight: 100,
            is_published: true,
            grades_released: gradesReleased,
          },
        ],
      },
    },
    include: { assignments: true },
  });

  const assignment = repository.assignments[0];
  const uniqueSuffix = `${title}-${Date.now()}`;

  const gitRepo = await prisma.gitRepo.create({
    data: {
      classroom_id: classroomId,
      repository_id: repository.id,
      provider: 'GITHUB',
      provider_id: `test-repo-${uniqueSuffix}`,
      name: `${title}-repo`,
      student_id: studentId,
    },
  });

  const gitRepoAssignment = await prisma.gitRepoAssignment.create({
    data: {
      git_repo_id: gitRepo.id,
      assignment_id: assignment.id,
      provider: 'GITHUB',
      provider_id: `test-issue-${uniqueSuffix}`,
      provider_issue_number: 9001,
      status,
    },
  });

  return {
    repositoryId: repository.id,
    title: repository.title,
    assignmentId: assignment.id,
    assignmentTitle: assignment.title,
    gitRepoId: gitRepo.id,
    gitRepoAssignmentId: gitRepoAssignment.id,
  };
}

/**
 * Read a GitRepoAssignment's status by id. Throws if missing. Lets a spec
 * assert that a (re)submission flipped the row's status in the DB.
 */
export async function getSubmissionStatus(
  gitRepoAssignmentId: string
): Promise<'OPEN' | 'CLOSED'> {
  const prisma = getTestPrisma();
  const row = await prisma.gitRepoAssignment.findUnique({
    where: { id: gitRepoAssignmentId },
    select: { status: true },
  });
  if (!row) throw new Error(`GitRepoAssignment '${gitRepoAssignmentId}' not found.`);
  return row.status as 'OPEN' | 'CLOSED';
}

/**
 * Force a submission's status in the DB (used to model a student re-submitting
 * via GitHub, which the webapp surfaces but does not itself mutate).
 */
export async function setSubmissionStatus(
  gitRepoAssignmentId: string,
  status: 'OPEN' | 'CLOSED'
): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.gitRepoAssignment.update({
    where: { id: gitRepoAssignmentId },
    data: { status },
  });
}

// Grading helpers.
// A "grade" is an emoji row in the `assignment_grades` table, keyed by
// git_repo_assignment_id.

/**
 * Ensure the classroom has at least one emoji mapping so the EmojiGrader popover
 * renders a clickable button. Returns the emoji that is guaranteed to exist.
 * Idempotent via upsert on the (classroom_id, emoji) unique constraint.
 */
export async function ensureEmojiMapping(
  classroomId: string,
  emoji = '⭐',
  grade = 100
): Promise<string> {
  const prisma = getTestPrisma();
  await prisma.emojiMapping.upsert({
    where: { classroom_id_emoji: { classroom_id: classroomId, emoji } },
    create: { classroom_id: classroomId, emoji, grade, description: 'Test grade' },
    update: {},
  });
  return emoji;
}

/**
 * Read the highest-value emoji configured for a classroom's grade scale. Tests
 * use this to click a real emoji button rather than hardcoding one.
 */
export async function getFirstEmojiMapping(
  classroomId: string
): Promise<{ emoji: string; grade: number } | null> {
  const prisma = getTestPrisma();
  const mapping = await prisma.emojiMapping.findFirst({
    where: { classroom_id: classroomId },
    orderBy: { grade: 'desc' },
    select: { emoji: true, grade: true },
  });
  return mapping ?? null;
}

/** Count `assignment_grades` rows for a git_repo_assignment. */
export async function countAssignmentGrades(gitRepoAssignmentId: string): Promise<number> {
  const prisma = getTestPrisma();
  return prisma.assignmentGrade.count({
    where: { git_repo_assignment_id: gitRepoAssignmentId },
  });
}

/** Fetch `assignment_grades` rows (emoji + grader) for a git_repo_assignment. */
export async function findAssignmentGrades(
  gitRepoAssignmentId: string
): Promise<Array<{ id: string; emoji: string; grader_id: string | null }>> {
  const prisma = getTestPrisma();
  return prisma.assignmentGrade.findMany({
    where: { git_repo_assignment_id: gitRepoAssignmentId },
    select: { id: true, emoji: true, grader_id: true },
  });
}

/** Delete all grades for a git_repo_assignment (test cleanup / pre-condition). */
export async function clearAssignmentGrades(gitRepoAssignmentId: string): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.assignmentGrade.deleteMany({
    where: { git_repo_assignment_id: gitRepoAssignmentId },
  });
}

/**
 * Directly insert a grade row, modelling a TA who has already graded. Used to
 * set up the student grade-view test (grades must exist AND be released for the
 * student to see them). Returns the created row id.
 */
export async function seedAssignmentGrade(
  gitRepoAssignmentId: string,
  emoji: string,
  graderId: string | null = null
): Promise<string> {
  const prisma = getTestPrisma();
  const row = await prisma.assignmentGrade.create({
    data: {
      git_repo_assignment_id: gitRepoAssignmentId,
      emoji,
      grader_id: graderId,
    },
    select: { id: true },
  });
  return row.id;
}

/** Flip an assignment's `grades_released` flag (controls student visibility). */
export async function setGradesReleased(
  assignmentId: string,
  released: boolean
): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.assignment.update({
    where: { id: assignmentId },
    data: { grades_released: released },
  });
}

// Quiz helpers.
// The dev seed creates no quizzes, so quiz specs seed their own uniquely-named
// rows and clean up afterwards. A Quiz maps to the `quizzes` table.

export interface SeededQuiz {
  id: string;
  name: string;
}

/**
 * Create a self-contained PUBLISHED quiz for a classroom so quiz-list/detail
 * specs have a real row to render and assert on. Deletes any prior row with the
 * same name first (so the helper is idempotent and deterministic).
 */
export async function seedQuiz(
  classroomId: string,
  name: string,
  options: { status?: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'; weight?: number } = {}
): Promise<SeededQuiz> {
  const prisma = getTestPrisma();
  const { status = 'PUBLISHED', weight = 10 } = options;

  await prisma.quiz.deleteMany({ where: { classroom_id: classroomId, name } });

  const quiz = await prisma.quiz.create({
    data: {
      classroom_id: classroomId,
      name,
      rubric_prompt: 'Assess understanding of core concepts.',
      subject: 'JavaScript Fundamentals',
      difficulty_level: 'Beginner',
      question_count: 5,
      max_attempts: 1,
      weight,
      status,
    },
    select: { id: true, name: true },
  });

  return quiz;
}

/** Delete a quiz by id. Safe to call in cleanup even if already deleted. */
export async function deleteQuizById(id: string): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.quiz.delete({ where: { id } }).catch(() => undefined);
}

/** Delete all quizzes for a classroom whose name matches a prefix (cleanup). */
export async function deleteQuizzesByNamePrefix(
  classroomId: string,
  prefix: string
): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.quiz.deleteMany({
    where: { classroom_id: classroomId, name: { startsWith: prefix } },
  });
}
