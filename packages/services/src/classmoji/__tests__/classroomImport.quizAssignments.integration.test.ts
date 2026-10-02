/**
 * Copying a classroom into a new one, against a REAL Postgres: the
 * repository copy (`cloneModulesWithRelations`, the create-classroom request)
 * and then the modules copy (`importModules`, the background job), with
 * repositories, quiz assignments and module contents together.
 *
 *   - Each copied quiz gets its assignment ONCE, in the counterpart of its
 *     module: the repository copy gives one to the quizzes it brings, and the
 *     modules copy skips those and gives one to every other quiz placed in a
 *     source module (repo-less ones included).
 *   - Both copies land in the same target modules: the modules copy reuses the
 *     modules the repository copy made instead of creating a second module of
 *     the same title (a module's title is unique in its classroom).
 *   - A retry after a partial run copies nothing twice.
 *   - A classroom whose only quizzes have no repository copies them through
 *     its modules.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organizations (cascades classroom → modules,
 * quizzes, assignments) and the user. Nothing is truncated.
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
const { cloneModulesWithRelations } = await import('../repositoryImport.service.ts');
const { importModules } = await import('../classroomConfigImport.service.ts');

describe.skipIf(!RUN)('classroom import: quizzes as assignments (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const orgIds: string[] = [];
  let userId: string;

  const classroomIn = async (tag: string) => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `qimp-${tag}-${suite}`,
        login: `qimp-${tag}-${suite}`,
      },
    });
    orgIds.push(org.id);
    const classroom = await prisma.classroom.create({
      data: {
        slug: `qimp-${tag}-${suite}`,
        git_org_id: org.id,
        name: `Quiz Import ${tag} ${suite}`,
        content_namespace: `qimp-${tag}-${suite}`,
        content_repo: `content-qimp-${tag}-${suite}`,
      },
    });
    return classroom.id;
  };

  const page = (classroomId: string, title: string) =>
    prisma.page.create({
      data: {
        classroom_id: classroomId,
        title,
        content_path: `pages/${title}`,
        created_by: userId,
      },
    });

  /** A quiz placed in `moduleId` by its assignment, as the quiz form saves one. */
  const placedQuiz = async (
    classroomId: string,
    moduleId: string,
    name: string,
    over: { repositoryId?: string; weight?: number; due?: Date | null; position?: number } = {}
  ) => {
    const quiz = await prisma.quiz.create({
      data: {
        classroom_id: classroomId,
        repository_id: over.repositoryId ?? null,
        name,
        rubric_prompt: 'r',
        status: 'PUBLISHED',
        weight: Math.round(over.weight ?? 0),
        due_date: over.due ?? null,
      },
    });
    await prisma.assignment.create({
      data: {
        module_id: moduleId,
        type: 'QUIZ',
        quiz_id: quiz.id,
        title: name,
        position: over.position ?? 0,
        weight: over.weight ?? 0,
        is_published: true,
        student_deadline: over.due ?? null,
        tokens_per_hour: 2,
      },
    });
    return quiz;
  };

  /** The target classroom's quizzes with their assignments, by name. */
  const targetQuizzes = async (classroomId: string) => {
    const quizzes = await prisma.quiz.findMany({
      where: { classroom_id: classroomId },
      include: { assignment: { include: { module: { select: { title: true } } } } },
    });
    return new Map(quizzes.map(q => [q.name, q]));
  };

  /** Every QUIZ assignment agrees with its quiz, as the release guard requires. */
  const expectMirrorsAgree = async (classroomId: string) => {
    const quizzes = await prisma.quiz.findMany({
      where: { classroom_id: classroomId, assignment: { isNot: null } },
      include: { assignment: { include: { module: true } } },
    });
    for (const quiz of quizzes) {
      const a = quiz.assignment!;
      expect(a.title, quiz.name).toBe(quiz.name);
      expect(a.module.classroom_id, quiz.name).toBe(classroomId);
      expect(Math.round(a.weight), quiz.name).toBe(quiz.weight);
      expect(a.student_deadline, quiz.name).toEqual(quiz.due_date);
    }
  };

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `qimp-${suite}@example.test`, name: `Quiz Import ${suite}` },
    });
    userId = user.id;
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await prisma.gitOrganization.delete({ where: { id } }).catch(() => {});
    }
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  describe('repositories, quiz assignments and module contents together', () => {
    let source: string;
    let target: string;
    let repoId: string;
    let pageIds: { week1: string; week2: string };
    /** Source page id → the target page standing in for its copy. */
    let sourcePages: Record<string, string> = {};
    const due = new Date('2026-09-10T23:59:00.000Z');

    beforeAll(async () => {
      source = await classroomIn('src');
      target = await classroomIn('dst');

      const week1 = await prisma.module.create({
        data: { classroom_id: source, title: 'Week 1', position: 0, is_published: true },
      });
      const week2 = await prisma.module.create({
        data: { classroom_id: source, title: 'Week 2', position: 1, is_published: true },
      });
      const repo = await prisma.repository.create({
        data: { classroom_id: source, title: 'lab', template: 'org/lab', type: 'INDIVIDUAL' },
      });
      repoId = repo.id;
      await prisma.assignment.create({
        data: { module_id: week1.id, type: 'REPO', repository_id: repo.id, title: 'Lab 1' },
      });

      // A quiz linked to the repository, placed in Week 2.
      await placedQuiz(source, week2.id, 'Repo quiz', {
        repositoryId: repo.id,
        weight: 2.5,
        due,
      });
      // A quiz with no repository, placed in Week 1, still carrying the
      // legacy QUIZ item that placed it before.
      const loose = await placedQuiz(source, week1.id, 'Loose quiz', { weight: 0, position: 1 });
      await prisma.moduleItem.create({
        data: { module_id: week1.id, item_type: 'QUIZ', quiz_id: loose.id, position: 5 },
      });
      // A quiz linked to the repository but in no module.
      await prisma.quiz.create({
        data: {
          classroom_id: source,
          repository_id: repo.id,
          name: 'Unplaced quiz',
          rubric_prompt: 'r',
          status: 'DRAFT',
        },
      });
      // A page in each module.
      const p1 = await page(source, `Reading 1 ${suite}`);
      const p2 = await page(source, `Reading 2 ${suite}`);
      await prisma.moduleItem.create({
        data: { module_id: week1.id, item_type: 'PAGE', page_id: p1.id, position: 0 },
      });
      await prisma.moduleItem.create({
        data: { module_id: week2.id, item_type: 'PAGE', page_id: p2.id, position: 0 },
      });
      // The content copy (a GitHub-bound phase) is stood in for by target
      // pages of the same titles.
      const t1 = await page(target, `Reading 1 ${suite}`);
      const t2 = await page(target, `Reading 2 ${suite}`);
      pageIds = { week1: t1.id, week2: t2.id };
      sourcePages = { [p1.id]: t1.id, [p2.id]: t2.id };
    });

    let firstSummary: Awaited<ReturnType<typeof importModules>>;
    let repoCopy: Awaited<ReturnType<typeof cloneModulesWithRelations>>;

    it('the repository copy gives its quizzes their assignments, in the module counterparts', async () => {
      repoCopy = await cloneModulesWithRelations(target, [{ id: repoId, includeQuizzes: true }], {
        stripDeadlines: true,
      });

      const quizzes = await targetQuizzes(target);
      const repoQuiz = quizzes.get('Repo quiz')!;
      expect(repoQuiz.assignment).toMatchObject({
        type: 'QUIZ',
        title: 'Repo quiz',
        weight: 2.5,
        tokens_per_hour: 2,
        is_published: false,
        student_deadline: null,
        closes_at: null,
      });
      expect(repoQuiz.assignment!.module.title).toBe('Week 2');
      // Its own copy agrees: no due date, weight rounded, unpublished.
      expect(repoQuiz).toMatchObject({ due_date: null, weight: 3, status: 'DRAFT' });
      // A quiz in no module lands in no module.
      expect(quizzes.get('Unplaced quiz')!.assignment).toBeNull();
      // The repository copy does not bring a quiz linked to no repository.
      expect(quizzes.has('Loose quiz')).toBe(false);
      expect(Object.keys(repoCopy.idMaps.modules).length).toBe(2);
    });

    it('the modules copy reuses those modules and gives every other placed quiz its assignment', async () => {
      // A first try that fails part-way: Week 2's page is mapped to a page
      // that does not exist, after Week 1 (and its quiz) are done.
      const failing = importModules(
        source,
        target,
        {
          repositories: repoCopy.idMaps.repositories,
          quizzes: repoCopy.idMaps.quizzes,
          pages: Object.fromEntries(
            Object.entries(sourcePages).map(([src, dst]) => [
              src,
              dst === pageIds.week2 ? randomUUID() : dst,
            ])
          ),
          slides: {},
          modules: repoCopy.idMaps.modules,
        },
        { quizzesImported: true, declinedQuizRepositoryIds: [] }
      );
      await expect(failing).rejects.toThrow();

      // The retry, with nothing it minted saved (the run threw), and the
      // right page map.
      firstSummary = await importModules(
        source,
        target,
        {
          repositories: repoCopy.idMaps.repositories,
          quizzes: repoCopy.idMaps.quizzes,
          pages: sourcePages,
          slides: {},
          modules: repoCopy.idMaps.modules,
        },
        { quizzesImported: true, declinedQuizRepositoryIds: [] }
      );

      const modules = await prisma.module.findMany({
        where: { classroom_id: target },
        orderBy: { position: 'asc' },
        include: { items: true, assignments: true },
      });
      // Week 1 and Week 2, once each.
      expect(modules.map(m => m.title)).toEqual(['Week 1', 'Week 2']);
      // No legacy QUIZ item is copied; each page once.
      for (const m of modules) {
        expect(
          m.items.map(i => i.item_type),
          m.title
        ).toEqual(['PAGE']);
      }
      expect(modules[0].items[0].page_id).toBe(pageIds.week1);
      expect(modules[1].items[0].page_id).toBe(pageIds.week2);

      const quizzes = await targetQuizzes(target);
      expect([...quizzes.keys()].sort()).toEqual(['Loose quiz', 'Repo quiz', 'Unplaced quiz']);
      const loose = quizzes.get('Loose quiz')!;
      expect(loose.repository_id).toBeNull();
      expect(loose.assignment).toMatchObject({ weight: 0, is_published: false });
      expect(loose.assignment!.module.title).toBe('Week 1');
      // The repository copy's quiz keeps the one assignment it was given.
      expect(
        await prisma.assignment.count({ where: { quiz_id: quizzes.get('Repo quiz')!.id } })
      ).toBe(1);
      // Week 1: the lab and the loose quiz; Week 2: the repo quiz.
      expect(modules[0].assignments.map(a => a.type).sort()).toEqual(['QUIZ', 'REPO']);
      expect(modules[1].assignments.map(a => a.type)).toEqual(['QUIZ']);
      await expectMirrorsAgree(target);
    });

    it('a second retry copies nothing more', async () => {
      const again = await importModules(
        source,
        target,
        {
          repositories: repoCopy.idMaps.repositories,
          quizzes: { ...repoCopy.idMaps.quizzes, ...firstSummary.id_maps.quizzes },
          pages: sourcePages,
          slides: {},
          modules: { ...repoCopy.idMaps.modules, ...firstSummary.id_maps.modules },
        },
        { quizzesImported: true, declinedQuizRepositoryIds: [] }
      );

      // Both pages already in place (counted, not written again); no quiz copied.
      expect(again).toMatchObject({ items: 2, quizzes: 0, quiz_assignments: 0 });
      expect(await prisma.moduleItem.count({ where: { module: { classroom_id: target } } })).toBe(
        2
      );
      expect(await prisma.module.count({ where: { classroom_id: target } })).toBe(2);
      expect(await prisma.quiz.count({ where: { classroom_id: target } })).toBe(3);
      expect(
        await prisma.assignment.count({ where: { module: { classroom_id: target }, type: 'QUIZ' } })
      ).toBe(2);
    });
  });

  it('copies a classroom whose only quizzes have no repository, through its modules', async () => {
    const source = await classroomIn('loose-src');
    const target = await classroomIn('loose-dst');
    const module = await prisma.module.create({
      data: { classroom_id: source, title: 'Unit 1', is_published: true },
    });
    await placedQuiz(source, module.id, 'Check-in', { weight: 1 });
    await placedQuiz(source, module.id, 'Exit ticket', { weight: 1, position: 1 });

    const summary = await importModules(
      source,
      target,
      { repositories: {}, quizzes: {}, pages: {}, slides: {} },
      { quizzesImported: true }
    );

    expect(summary).toMatchObject({ modules: 1, quizzes: 2, quiz_assignments: 2 });
    const quizzes = await targetQuizzes(target);
    expect([...quizzes.keys()].sort()).toEqual(['Check-in', 'Exit ticket']);
    for (const quiz of quizzes.values()) {
      expect(quiz.assignment!.module.title).toBe('Unit 1');
      expect(quiz.assignment!.is_published).toBe(false);
    }
    // Appended in the source order.
    const positions = await prisma.assignment.findMany({
      where: { module: { classroom_id: target } },
      orderBy: { position: 'asc' },
      select: { title: true, position: true },
    });
    expect(positions).toEqual([
      { title: 'Check-in', position: 0 },
      { title: 'Exit ticket', position: 1 },
    ]);
    await expectMirrorsAgree(target);
  });

  it('copies two quizzes of the same name in one module as two quizzes', async () => {
    const source = await classroomIn('same-src');
    const target = await classroomIn('same-dst');
    const module = await prisma.module.create({
      data: { classroom_id: source, title: 'Unit 1', is_published: true },
    });
    await placedQuiz(source, module.id, 'Check-in', { weight: 1 });
    await placedQuiz(source, module.id, 'Check-in', { weight: 2, position: 1 });

    const summary = await importModules(
      source,
      target,
      { repositories: {}, quizzes: {}, pages: {}, slides: {} },
      { quizzesImported: true }
    );

    expect(summary).toMatchObject({ quizzes: 2, quiz_assignments: 2 });
    const copies = await prisma.quiz.findMany({
      where: { classroom_id: target },
      include: { assignment: true },
      orderBy: { weight: 'asc' },
    });
    expect(copies.map(q => [q.name, q.assignment?.weight])).toEqual([
      ['Check-in', 1],
      ['Check-in', 2],
    ]);
    await expectMirrorsAgree(target);
  });

  it('copies a repo-less quiz named like one the repository copy brought as its own quiz', async () => {
    const source = await classroomIn('twin-src');
    const target = await classroomIn('twin-dst');
    const module = await prisma.module.create({
      data: { classroom_id: source, title: 'Unit 1', is_published: true },
    });
    const repo = await prisma.repository.create({
      data: { classroom_id: source, title: 'lab', template: 'org/lab', type: 'INDIVIDUAL' },
    });
    await placedQuiz(source, module.id, 'Twin', { repositoryId: repo.id, weight: 1 });
    await placedQuiz(source, module.id, 'Twin', { weight: 2, position: 1 });

    const repoCopy = await cloneModulesWithRelations(
      target,
      [{ id: repo.id, includeQuizzes: true }],
      { stripDeadlines: true }
    );
    const summary = await importModules(
      source,
      target,
      {
        repositories: repoCopy.idMaps.repositories,
        quizzes: repoCopy.idMaps.quizzes,
        pages: {},
        slides: {},
        modules: repoCopy.idMaps.modules,
      },
      { quizzesImported: true, declinedQuizRepositoryIds: [] }
    );

    expect(summary).toMatchObject({ quizzes: 1, quiz_assignments: 1 });
    const copies = await prisma.quiz.findMany({
      where: { classroom_id: target },
      include: { assignment: true },
      orderBy: { weight: 'asc' },
    });
    // The repository's quiz keeps its repository; the repo-less one has none,
    // and each has its own assignment.
    expect(copies).toHaveLength(2);
    expect(copies[0]).toMatchObject({ name: 'Twin', weight: 1 });
    expect(copies[0].repository_id).not.toBeNull();
    expect(copies[1]).toMatchObject({ name: 'Twin', weight: 2, repository_id: null });
    expect(copies.map(q => q.assignment?.weight)).toEqual([1, 2]);
    await expectMirrorsAgree(target);
  });

  it('copies no quiz where the new classroom shows none', async () => {
    const source = await classroomIn('none-src');
    const target = await classroomIn('none-dst');
    const module = await prisma.module.create({ data: { classroom_id: source, title: 'Unit 1' } });
    await placedQuiz(source, module.id, 'Check-in');

    const summary = await importModules(
      source,
      target,
      { repositories: {}, quizzes: {}, pages: {}, slides: {} },
      { quizzesImported: false }
    );

    expect(summary).toMatchObject({ modules: 1, quizzes: 0 });
    expect(await prisma.quiz.count({ where: { classroom_id: target } })).toBe(0);
  });
});
