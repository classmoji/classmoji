/**
 * A quiz and its QUIZ assignment against a REAL Postgres.
 *
 * The assignment owns the quiz's module, opens, due date, close date, weight,
 * tokens per hour and publish state; the quiz's own `due_date`, `weight` and
 * `status` are written as a mirror of it in the same transaction. Pinned here:
 *
 *   - quiz.create writes the quiz, its assignment and its source material in
 *     ONE transaction: no module, a module of another classroom or a document
 *     of another classroom leaves nothing behind;
 *   - quiz.update writes the assignment and re-mirrors the quiz, moves it to
 *     the end of another module, and rolls a refused module back with every
 *     other field of that save; a quiz with no assignment gets one when a
 *     save names a module, carrying over what it had;
 *   - the assignment paths (update, the calendar's deadline drag;
 *     updateInClassroom, the Assignments page and MCP) mirror a QUIZ row onto
 *     its quiz, and createInClassroom / deleteInClassroom / deleteById leave a
 *     quiz's assignment to the quiz;
 *   - quiz.publish publishes the assignment and mirrors PUBLISHED.
 *
 * No Pro subscription is set up, so quizzes are not visible in these
 * classrooms and no notification is written by any publish or due-date change.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organization (cascades classroom → modules →
 * assignments, quizzes, pages) and then the one user. Nothing is truncated.
 *
 * Skipped unless DATABASE_URL names a LOCAL database, and the SHARED dev
 * database only with CONTENT_INDEX_INTEGRATION=1 (the house rule; see
 * contentIndex.integration.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const optedIn = process.env.CONTENT_INDEX_INTEGRATION === '1';
const RUN = Boolean(DATABASE_URL) && isLocal && (!isSharedDevDb || optedIn);

const getPrisma = (await import('@classmoji/database')).default;
const { titleToIdentifier } = await import('@classmoji/utils');
const quizService = await import('../quiz.service.ts');
const assignmentService = await import('../assignment.service.ts');
const { QuizAssignmentError } = await import('../quizAssignment.service.ts');
const { ResourceLinkServiceError } = await import('../resourceLink.service.ts');

const DAY = 24 * 60 * 60 * 1000;

/** The error a rejected promise carries, or undefined when it resolved. */
const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
};

describe.skipIf(!RUN)('a quiz and its assignment (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let authorId: string;
  let classroomId: string;
  let otherClassroomId: string;

  const short = () => randomUUID().slice(0, 8);

  const makeModule = async (inClassroom = classroomId) =>
    (
      await prisma.module.create({
        data: { classroom_id: inClassroom, title: `Module ${short()} ${suite}` },
        select: { id: true },
      })
    ).id;

  /** A quiz made through the service, in `moduleId`, with any extra fields. */
  const newQuiz = (
    moduleId: string,
    over: Partial<Parameters<typeof quizService.create>[0]> = {},
    assignment: Record<string, unknown> = {}
  ) =>
    quizService.create({
      name: `Quiz ${short()} ${suite}`,
      classroomId,
      rubricPrompt: 'grade it',
      ...over,
      assignment: { moduleId, ...assignment },
    });

  /** A quiz in no module, written straight to the table as older quizzes are. */
  const quizWithoutAssignment = (data: {
    status: 'DRAFT' | 'PUBLISHED' | 'CLOSED';
    weight?: number;
    due_date?: Date | null;
  }) =>
    prisma.quiz.create({
      data: {
        classroom_id: classroomId,
        name: `Unassigned ${short()} ${suite}`,
        rubric_prompt: 'grade it',
        ...data,
      },
    });

  const assignmentOf = (quizId: string) =>
    prisma.assignment.findUniqueOrThrow({ where: { quiz_id: quizId } });

  const quizRow = (quizId: string) => prisma.quiz.findUniqueOrThrow({ where: { id: quizId } });

  /** `quiz name@position` for a module's assignments, in stored order. */
  const layout = async (moduleId: string) =>
    (
      await prisma.assignment.findMany({
        where: { module_id: moduleId },
        orderBy: { position: 'asc' },
        select: { title: true, position: true },
      })
    ).map(a => `${a.title}@${a.position}`);

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `qasg-${suite}`, login: `qasg-org-${suite}` },
    });
    orgId = org.id;
    const makeClassroom = async (tag: string) =>
      (
        await prisma.classroom.create({
          data: {
            slug: `qasg-${tag}-${suite}`,
            git_org_id: orgId,
            name: `Quiz Assignment ${tag} ${suite}`,
            content_namespace: `qasg-${tag}-${suite}`,
            content_repo: `content-qasg-${tag}-${suite}`,
          },
          select: { id: true },
        })
      ).id;
    classroomId = await makeClassroom('main');
    otherClassroomId = await makeClassroom('other');
    authorId = (
      await prisma.user.create({
        data: { email: `qasg-${suite}@example.test`, name: `Quiz Assignment Author ${suite}` },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    if (authorId) await prisma.user.delete({ where: { id: authorId } }).catch(() => {});
  });

  // ─── quiz.create ──────────────────────────────────────────────────────────

  describe('quiz.create', () => {
    it('refuses a quiz with no module and writes nothing', async () => {
      const name = `No module ${short()} ${suite}`;
      for (const input of [
        { name, classroomId, rubricPrompt: 'r' },
        { name, classroomId, rubricPrompt: 'r', assignment: { weight: 5 } },
        { name, classroomId, rubricPrompt: 'r', status: 'PUBLISHED' as const, weight: 5 },
      ]) {
        const error = await errorOf(quizService.create(input));
        expect(error).toBeInstanceOf(QuizAssignmentError);
        expect(error).toMatchObject({ code: 'module_required' });
      }
      expect(await prisma.quiz.count({ where: { name } })).toBe(0);
    });

    it('refuses a module of another classroom: no quiz row and no assignment are left', async () => {
      const foreignModuleId = await makeModule(otherClassroomId);
      const name = `Foreign module ${short()} ${suite}`;

      const error = await errorOf(
        quizService.create({
          name,
          classroomId,
          rubricPrompt: 'r',
          assignment: { moduleId: foreignModuleId, isPublished: true },
        })
      );

      expect(error).toBeInstanceOf(QuizAssignmentError);
      expect(error).toMatchObject({ code: 'module_not_found', status: 404 });
      expect(await prisma.quiz.count({ where: { name } })).toBe(0);
      expect(await prisma.assignment.count({ where: { module_id: foreignModuleId } })).toBe(0);
    });

    it("creates the assignment from the quiz and the panel, after the module's existing assignments", async () => {
      const moduleId = await makeModule();
      await newQuiz(moduleId);
      await newQuiz(moduleId);
      const releaseAt = new Date(Date.now() - DAY);
      const dueDate = new Date(Date.now() + 7 * DAY);
      const closesAt = new Date(Date.now() + 8 * DAY);
      const name = `Week 3 Check-in ${suite}`;

      const created = await newQuiz(
        moduleId,
        { name },
        {
          releaseAt: releaseAt.toISOString(),
          dueDate,
          closesAt,
          weight: 2.6,
          tokensPerHour: 3,
          isPublished: true,
        }
      );

      const assignment = await assignmentOf(created.id);
      expect(assignment).toMatchObject({
        type: 'QUIZ',
        quiz_id: created.id,
        module_id: moduleId,
        title: name,
        slug: titleToIdentifier(name),
        release_at: releaseAt,
        student_deadline: dueDate,
        closes_at: closesAt,
        weight: 2.6,
        tokens_per_hour: 3,
        is_published: true,
        position: 2,
        repository_id: null,
        form_id: null,
      });
      // The quiz's own columns are the assignment's, the weight rounded.
      expect(await quizRow(created.id)).toMatchObject({
        name,
        due_date: dueDate,
        weight: 3,
        status: 'PUBLISHED',
      });
      // What create hands back carries the assignment and its module.
      expect(created.assignment).toMatchObject({ id: assignment.id, module: { id: moduleId } });
    });

    it('keeps a weight of 0 at 0, and an unweighted quiz at 0', async () => {
      const moduleId = await makeModule();
      const zero = await newQuiz(moduleId, {}, { weight: 0 });
      const flatZero = await newQuiz(moduleId, { weight: 0 });
      const unweighted = await newQuiz(moduleId);

      for (const quiz of [zero, flatZero, unweighted]) {
        expect((await assignmentOf(quiz.id)).weight).toBe(0);
        expect((await quizRow(quiz.id)).weight).toBe(0);
      }
    });

    it("mirrors the assignment's publish state onto the quiz status", async () => {
      const moduleId = await makeModule();
      const draft = await newQuiz(moduleId);
      const published = await newQuiz(moduleId, {}, { isPublished: true });
      const closed = await newQuiz(
        moduleId,
        {},
        { isPublished: true, closesAt: new Date(Date.now() - 60_000) }
      );
      const closesLater = await newQuiz(
        moduleId,
        {},
        { isPublished: true, closesAt: new Date(Date.now() + DAY) }
      );

      expect((await assignmentOf(draft.id)).is_published).toBe(false);
      expect((await quizRow(draft.id)).status).toBe('DRAFT');
      expect((await quizRow(published.id)).status).toBe('PUBLISHED');
      expect((await quizRow(closed.id)).status).toBe('CLOSED');
      expect((await quizRow(closesLater.id)).status).toBe('PUBLISHED');
    });

    it('routes the old flat dueDate, weight and status to the assignment', async () => {
      const moduleId = await makeModule();
      const dueDate = new Date(Date.now() + 3 * DAY);
      const before = Date.now();

      const published = await newQuiz(moduleId, { dueDate, weight: 5, status: 'PUBLISHED' });
      const closed = await newQuiz(moduleId, { status: 'CLOSED' });
      const draft = await newQuiz(moduleId, { status: 'DRAFT', weight: 4 });

      expect(await assignmentOf(published.id)).toMatchObject({
        student_deadline: dueDate,
        weight: 5,
        is_published: true,
        closes_at: null,
      });
      expect(await quizRow(published.id)).toMatchObject({
        due_date: dueDate,
        weight: 5,
        status: 'PUBLISHED',
      });

      // CLOSED is published and closed as of the save.
      const closedAssignment = await assignmentOf(closed.id);
      expect(closedAssignment.is_published).toBe(true);
      const closedAt = closedAssignment.closes_at?.getTime() ?? Number.NaN;
      expect(closedAt).toBeGreaterThanOrEqual(before - 1_000);
      expect(closedAt).toBeLessThanOrEqual(Date.now());
      expect((await quizRow(closed.id)).status).toBe('CLOSED');

      expect(await assignmentOf(draft.id)).toMatchObject({ is_published: false, weight: 4 });
      expect((await quizRow(draft.id)).status).toBe('DRAFT');
    });

    it('takes the assignment object over an old flat field naming the same thing', async () => {
      const moduleId = await makeModule();
      const flatDue = new Date(Date.now() + DAY);
      const panelDue = new Date(Date.now() + 2 * DAY);

      const quiz = await newQuiz(
        moduleId,
        { dueDate: flatDue, weight: 9, status: 'PUBLISHED' },
        { dueDate: panelDue, weight: 4, isPublished: false }
      );

      expect(await assignmentOf(quiz.id)).toMatchObject({
        student_deadline: panelDue,
        weight: 4,
        is_published: false,
      });
    });

    it('a source document of another classroom rolls back the quiz and its assignment', async () => {
      const moduleId = await makeModule();
      const foreignPage = await prisma.page.create({
        data: {
          classroom_id: otherClassroomId,
          title: `Elsewhere ${suite}`,
          slug: `elsewhere-${suite}`,
          content_path: 'pages/elsewhere',
          created_by: authorId,
          is_draft: false,
        },
      });
      const name = `Foreign material ${short()} ${suite}`;

      const error = await errorOf(
        quizService.create({
          name,
          classroomId,
          rubricPrompt: 'r',
          assignment: { moduleId, isPublished: true },
          sourceMaterial: [{ kind: 'page', id: foreignPage.id }],
        })
      );

      expect(error).toBeInstanceOf(ResourceLinkServiceError);
      expect(await prisma.quiz.count({ where: { name } })).toBe(0);
      expect(await prisma.assignment.count({ where: { module_id: moduleId } })).toBe(0);
      expect(await prisma.pageLink.count({ where: { page_id: foreignPage.id } })).toBe(0);
    });
  });

  // ─── quiz.update ──────────────────────────────────────────────────────────

  describe('quiz.update', () => {
    it('a rename renames the assignment too', async () => {
      const quiz = await newQuiz(await makeModule());
      const renamed = `Renamed ${short()} ${suite}`;

      await quizService.update(quiz.id, { name: renamed });

      expect((await quizRow(quiz.id)).name).toBe(renamed);
      expect((await assignmentOf(quiz.id)).title).toBe(renamed);
    });

    it('writes assignment fields to the assignment and mirrors them back onto the quiz', async () => {
      const quiz = await newQuiz(await makeModule(), {}, { isPublished: true, weight: 1 });
      const dueDate = new Date(Date.now() + 5 * DAY);
      const releaseAt = new Date(Date.now() - DAY);

      const saved = await quizService.update(quiz.id, {
        assignment: { dueDate, releaseAt, weight: 7.5, tokensPerHour: 5 },
      });

      expect(await assignmentOf(quiz.id)).toMatchObject({
        student_deadline: dueDate,
        release_at: releaseAt,
        weight: 7.5,
        tokens_per_hour: 5,
        is_published: true,
      });
      expect(await quizRow(quiz.id)).toMatchObject({
        due_date: dueDate,
        weight: 8,
        status: 'PUBLISHED',
      });
      expect(saved.assignment).toMatchObject({ weight: 7.5, student_deadline: dueDate });
    });

    it('moves the quiz to the end of another module of the classroom and closes the gap it left', async () => {
      const from = await makeModule();
      const to = await makeModule();
      const a = await newQuiz(from, { name: `a ${suite}` });
      const moving = await newQuiz(from, { name: `moving ${suite}` });
      const c = await newQuiz(from, { name: `c ${suite}` });
      await newQuiz(to, { name: `there ${suite}` });
      expect(await layout(from)).toEqual([`a ${suite}@0`, `moving ${suite}@1`, `c ${suite}@2`]);

      const saved = await quizService.update(moving.id, { assignment: { moduleId: to } });

      expect(await layout(to)).toEqual([`there ${suite}@0`, `moving ${suite}@1`]);
      expect(await layout(from)).toEqual([`a ${suite}@0`, `c ${suite}@1`]);
      expect(saved.assignment?.module).toMatchObject({ id: to });
      expect((await assignmentOf(a.id)).module_id).toBe(from);
      expect((await assignmentOf(c.id)).module_id).toBe(from);
    });

    it('refuses a module of another classroom, and writes nothing else from that save', async () => {
      const moduleId = await makeModule();
      const foreignModuleId = await makeModule(otherClassroomId);
      const quiz = await newQuiz(moduleId, {}, { isPublished: true, weight: 2 });
      const before = await assignmentOf(quiz.id);

      const error = await errorOf(
        quizService.update(quiz.id, {
          name: `Renamed ${short()} ${suite}`,
          rubricPrompt: 'changed',
          assignment: { moduleId: foreignModuleId, weight: 9 },
        })
      );

      expect(error).toBeInstanceOf(QuizAssignmentError);
      expect(error).toMatchObject({ code: 'module_not_found', status: 404 });
      expect(await quizRow(quiz.id)).toMatchObject({
        name: quiz.name,
        rubric_prompt: 'grade it',
        weight: 2,
      });
      expect(await assignmentOf(quiz.id)).toEqual(before);
      expect(await prisma.assignment.count({ where: { module_id: foreignModuleId } })).toBe(0);
    });

    it('a close date that has passed closes the quiz; clearing it opens the quiz again', async () => {
      const quiz = await newQuiz(await makeModule(), {}, { isPublished: true });
      const closesAt = new Date(Date.now() - 60_000);

      await quizService.update(quiz.id, { assignment: { closesAt } });
      expect((await assignmentOf(quiz.id)).closes_at).toEqual(closesAt);
      expect((await quizRow(quiz.id)).status).toBe('CLOSED');

      await quizService.update(quiz.id, { assignment: { closesAt: null } });
      expect((await assignmentOf(quiz.id)).closes_at).toBeNull();
      expect((await quizRow(quiz.id)).status).toBe('PUBLISHED');
    });

    it('unpublishing the assignment puts the quiz back to DRAFT', async () => {
      const quiz = await newQuiz(await makeModule(), {}, { isPublished: true });

      await quizService.update(quiz.id, { assignment: { isPublished: false } });

      expect((await assignmentOf(quiz.id)).is_published).toBe(false);
      expect((await quizRow(quiz.id)).status).toBe('DRAFT');
    });

    it('a content-only save leaves the assignment untouched', async () => {
      const quiz = await newQuiz(await makeModule(), {}, { isPublished: true, weight: 3 });
      const before = await assignmentOf(quiz.id);

      await quizService.update(quiz.id, {
        rubricPrompt: 'a new rubric',
        questionCount: 4,
        excludedPaths: ['tests/**'],
      });

      expect(await quizRow(quiz.id)).toMatchObject({
        rubric_prompt: 'a new rubric',
        question_count: 4,
      });
      const after = await assignmentOf(quiz.id);
      expect(after.updated_at).toEqual(before.updated_at);
      expect(after).toEqual(before);
    });
  });

  // ─── a quiz with no assignment ────────────────────────────────────────────

  describe('a quiz with no assignment', () => {
    const DUE = new Date('2026-11-20T23:59:00.000Z');

    it('two first saves at once give the quiz one assignment, and both land', async () => {
      const moduleId = await makeModule();
      const quiz = await quizWithoutAssignment({ status: 'DRAFT', weight: 7 });

      const results = await Promise.allSettled([
        quizService.update(quiz.id, { assignment: { moduleId, weight: 3 } }),
        quizService.update(quiz.id, { assignment: { moduleId, dueDate: DUE } }),
      ]);

      expect(results.map(r => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await prisma.assignment.count({ where: { quiz_id: quiz.id } })).toBe(1);
      // The second save landed on the first one's assignment.
      expect(await assignmentOf(quiz.id)).toMatchObject({
        module_id: moduleId,
        weight: 3,
        student_deadline: DUE,
      });
    });

    it('refuses assignment fields without a module, and writes nothing from that save', async () => {
      const quiz = await quizWithoutAssignment({ status: 'PUBLISHED', weight: 7, due_date: DUE });

      const error = await errorOf(
        quizService.update(quiz.id, { name: 'Renamed', assignment: { weight: 3 } })
      );

      expect(error).toBeInstanceOf(QuizAssignmentError);
      expect(error).toMatchObject({ code: 'module_required' });
      expect(await quizRow(quiz.id)).toMatchObject({ name: quiz.name, weight: 7 });
      expect(await prisma.assignment.count({ where: { quiz_id: quiz.id } })).toBe(0);
    });

    it('still writes the old flat fields to the quiz itself when no module is named', async () => {
      const quiz = await quizWithoutAssignment({ status: 'PUBLISHED', weight: 7, due_date: DUE });
      const dueDate = new Date('2026-12-01T23:59:00.000Z');

      await quizService.update(quiz.id, { weight: 4, dueDate, status: 'CLOSED' });

      expect(await quizRow(quiz.id)).toMatchObject({
        weight: 4,
        due_date: dueDate,
        status: 'CLOSED',
      });
      expect(await prisma.assignment.count({ where: { quiz_id: quiz.id } })).toBe(0);
    });

    it('naming a module creates the assignment, carrying the weight, due date and publish state', async () => {
      const moduleId = await makeModule();
      await newQuiz(moduleId);
      const quiz = await quizWithoutAssignment({ status: 'PUBLISHED', weight: 7, due_date: DUE });

      const saved = await quizService.update(quiz.id, { assignment: { moduleId } });

      expect(await assignmentOf(quiz.id)).toMatchObject({
        type: 'QUIZ',
        module_id: moduleId,
        title: quiz.name,
        weight: 7,
        student_deadline: DUE,
        is_published: true,
        release_at: null,
        closes_at: null,
        tokens_per_hour: 0,
        position: 1,
      });
      expect(await quizRow(quiz.id)).toMatchObject({
        weight: 7,
        due_date: DUE,
        status: 'PUBLISHED',
      });
      expect(saved.assignment).toMatchObject({ module_id: moduleId });
    });

    it('a draft that gets a module stays unpublished; the save can set what it carries', async () => {
      const moduleId = await makeModule();
      const draft = await quizWithoutAssignment({ status: 'DRAFT', weight: 7, due_date: DUE });
      const reweighted = await quizWithoutAssignment({
        status: 'PUBLISHED',
        weight: 7,
        due_date: DUE,
      });

      await quizService.update(draft.id, { assignment: { moduleId } });
      await quizService.update(reweighted.id, {
        assignment: { moduleId, weight: 2, dueDate: null },
      });

      expect(await assignmentOf(draft.id)).toMatchObject({ is_published: false, weight: 7 });
      expect((await quizRow(draft.id)).status).toBe('DRAFT');
      expect(await assignmentOf(reweighted.id)).toMatchObject({
        weight: 2,
        student_deadline: null,
        is_published: true,
      });
      expect(await quizRow(reweighted.id)).toMatchObject({ weight: 2, due_date: null });
    });

    it('a CLOSED quiz that gets a module closes as of its last update before the save', async () => {
      const moduleId = await makeModule();
      const quiz = await quizWithoutAssignment({ status: 'CLOSED', weight: 7, due_date: DUE });
      const lastUpdate = (await quizRow(quiz.id)).updated_at;

      await quizService.update(quiz.id, { assignment: { moduleId } });

      expect(await assignmentOf(quiz.id)).toMatchObject({
        is_published: true,
        closes_at: lastUpdate,
      });
      expect((await quizRow(quiz.id)).status).toBe('CLOSED');
    });

    it('a module of another classroom is refused and no assignment is created', async () => {
      const foreignModuleId = await makeModule(otherClassroomId);
      const quiz = await quizWithoutAssignment({ status: 'PUBLISHED', weight: 7, due_date: DUE });

      const error = await errorOf(
        quizService.update(quiz.id, { name: 'Renamed', assignment: { moduleId: foreignModuleId } })
      );

      expect(error).toMatchObject({ code: 'module_not_found' });
      expect((await quizRow(quiz.id)).name).toBe(quiz.name);
      expect(await prisma.assignment.count({ where: { quiz_id: quiz.id } })).toBe(0);
    });
  });

  // ─── the assignment paths on a QUIZ row ───────────────────────────────────

  describe('assignment service on a QUIZ row', () => {
    it('updateInClassroom renames the quiz and mirrors its due date, weight and status', async () => {
      const quiz = await newQuiz(await makeModule(), {}, { isPublished: true });
      const { id } = await assignmentOf(quiz.id);
      const dueDate = new Date(Date.now() + 4 * DAY);
      const title = `Retitled ${short()} ${suite}`;

      await assignmentService.updateInClassroom(id, classroomId, {
        title,
        student_deadline: dueDate.toISOString(),
        weight: 4.4,
      });

      expect(await quizRow(quiz.id)).toMatchObject({
        name: title,
        due_date: dueDate,
        weight: 4,
        status: 'PUBLISHED',
      });

      await assignmentService.updateInClassroom(id, classroomId, {
        closes_at: new Date(Date.now() - 60_000),
      });
      expect((await quizRow(quiz.id)).status).toBe('CLOSED');

      await assignmentService.updateInClassroom(id, classroomId, { is_published: false });
      expect((await quizRow(quiz.id)).status).toBe('DRAFT');
    });

    it("update (the calendar's deadline drag) moves the quiz's due date", async () => {
      const quiz = await newQuiz(
        await makeModule(),
        {},
        { isPublished: true, dueDate: new Date(Date.now() + DAY) }
      );
      const { id } = await assignmentOf(quiz.id);
      const dragged = new Date(Date.now() + 6 * DAY);

      await assignmentService.update(id, { student_deadline: dragged });

      expect((await assignmentOf(quiz.id)).student_deadline).toEqual(dragged);
      expect((await quizRow(quiz.id)).due_date).toEqual(dragged);
    });

    it('createInClassroom refuses a QUIZ assignment and writes nothing', async () => {
      const moduleId = await makeModule();
      const quiz = await quizWithoutAssignment({ status: 'PUBLISHED' });

      const error = await errorOf(
        assignmentService.createInClassroom(classroomId, {
          module_id: moduleId,
          type: 'QUIZ',
          quiz_id: quiz.id,
          title: quiz.name,
        })
      );

      expect(error).toBeInstanceOf(QuizAssignmentError);
      expect(error).toMatchObject({ code: 'quiz_assignment' });
      expect(await prisma.assignment.count({ where: { quiz_id: quiz.id } })).toBe(0);
      expect(await prisma.assignment.count({ where: { module_id: moduleId } })).toBe(0);
    });

    it('deleteInClassroom and deleteById refuse a QUIZ row; the row and its quiz stay', async () => {
      const quiz = await newQuiz(await makeModule(), {}, { isPublished: true });
      const { id } = await assignmentOf(quiz.id);

      for (const remove of [
        () => assignmentService.deleteInClassroom(id, classroomId),
        () => assignmentService.deleteById(id),
      ]) {
        const error = await errorOf(remove());
        expect(error).toBeInstanceOf(QuizAssignmentError);
        expect(error).toMatchObject({ code: 'quiz_assignment' });
      }

      expect(await prisma.assignment.count({ where: { id } })).toBe(1);
      expect(await prisma.quiz.count({ where: { id: quiz.id } })).toBe(1);
    });

    it('createMany and deleteMany refuse QUIZ rows and write nothing', async () => {
      const moduleId = await makeModule();
      const unassigned = await quizWithoutAssignment({ status: 'PUBLISHED' });
      const placed = await newQuiz(moduleId, {}, { isPublished: true });
      const { id } = await assignmentOf(placed.id);

      const created = await errorOf(
        assignmentService.createMany([
          { module_id: moduleId, type: 'QUIZ', quiz_id: unassigned.id, title: unassigned.name },
        ])
      );
      const deleted = await errorOf(assignmentService.deleteMany([id]));

      for (const error of [created, deleted]) {
        expect(error).toBeInstanceOf(QuizAssignmentError);
        expect(error).toMatchObject({ code: 'quiz_assignment' });
      }
      expect(await prisma.assignment.count({ where: { quiz_id: unassigned.id } })).toBe(0);
      expect(await prisma.assignment.count({ where: { id } })).toBe(1);
    });
  });

  // ─── quiz.publish ─────────────────────────────────────────────────────────

  describe('quiz.publish', () => {
    it('refuses a quiz with no assignment and changes nothing', async () => {
      const quiz = await quizWithoutAssignment({ status: 'DRAFT' });

      const error = await errorOf(quizService.publish(quiz.id));

      expect(error).toBeInstanceOf(QuizAssignmentError);
      expect(error).toMatchObject({ code: 'module_required' });
      expect((await quizRow(quiz.id)).status).toBe('DRAFT');
    });

    it('publishes the assignment and mirrors PUBLISHED onto the quiz', async () => {
      const quiz = await newQuiz(await makeModule());
      expect((await quizRow(quiz.id)).status).toBe('DRAFT');

      const result = await quizService.publish(quiz.id);

      expect(result).toMatchObject({
        id: quiz.id,
        status: 'PUBLISHED',
        wasPublished: false,
        // Quizzes are not visible in this classroom (no Pro): nobody is told.
        notified: false,
        sourceMaterialAllDraft: false,
      });
      expect((await assignmentOf(quiz.id)).is_published).toBe(true);
      expect((await quizRow(quiz.id)).status).toBe('PUBLISHED');
    });
  });
});
