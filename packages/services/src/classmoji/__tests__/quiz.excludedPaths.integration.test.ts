/**
 * A quiz's "Paths to exclude" against a REAL Postgres: the `excluded_paths`
 * text-array column's default, and create, update, read and a class-to-class
 * clone carrying the list as stored.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organizations (cascades classroom → quizzes).
 * Nothing is truncated.
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
const quizService = await import('../quiz.service.ts');
const { cloneQuiz } = await import('../repositoryImport.service.ts');

describe.skipIf(!RUN)('quiz excluded paths (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const orgIds: string[] = [];
  let classroomId: string;
  let targetClassroomId: string;
  /** Every quiz lives in a module (its assignment's). */
  let inModule: { assignment: { moduleId: string } };

  const classroomIn = async (tag: string) => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `qex-${tag}-${suite}`,
        login: `qex-${tag}-${suite}`,
      },
    });
    orgIds.push(org.id);
    const classroom = await prisma.classroom.create({
      data: {
        slug: `qex-${tag}-${suite}`,
        git_org_id: org.id,
        name: `Quiz Excluded Paths ${tag} ${suite}`,
        content_namespace: `qex-${tag}-${suite}`,
        content_repo: `content-qex-${tag}-${suite}`,
      },
    });
    return classroom.id;
  };

  beforeAll(async () => {
    classroomId = await classroomIn('src');
    targetClassroomId = await classroomIn('dst');
    const module = await prisma.module.create({
      data: { classroom_id: classroomId, title: `Week 1 ${suite}` },
    });
    inModule = { assignment: { moduleId: module.id } };
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await prisma.gitOrganization.delete({ where: { id } }).catch(() => {});
    }
  });

  it('defaults to an empty list for a quiz saved without any', async () => {
    const quiz = await quizService.create({
      name: 'Plain',
      classroomId,
      rubricPrompt: 'r',
      ...inModule,
    });
    const read = await quizService.findById(quiz.id);
    expect(read?.excluded_paths).toEqual([]);
  });

  it('stores, reads, replaces, clears and clones the list', async () => {
    const created = await quizService.create({
      name: 'Code-aware',
      classroomId,
      rubricPrompt: 'r',
      ...inModule,
      includeCodeContext: true,
      excludedPaths: [' tests/** ', '**/*.spec.js', 'playwright.config.*', 'tests/**'],
    });
    expect((await quizService.findById(created.id))?.excluded_paths).toEqual([
      'tests/**',
      '**/*.spec.js',
      'playwright.config.*',
    ]);

    const updated = await quizService.update(created.id, { excludedPaths: ['e2e/'] });
    expect(updated.excluded_paths).toEqual(['e2e/']);

    // An update that does not name them leaves them alone.
    await quizService.update(created.id, { weight: 5 });
    expect((await quizService.findById(created.id))?.excluded_paths).toEqual(['e2e/']);

    const clone = await cloneQuiz(created.id, targetClassroomId, null, {}, prisma as never);
    expect(clone.excluded_paths).toEqual(['e2e/']);

    await quizService.update(created.id, { excludedPaths: [] });
    expect((await quizService.findById(created.id))?.excluded_paths).toEqual([]);
  });

  it('refuses a bad list and keeps what was stored', async () => {
    const quiz = await quizService.create({
      name: 'Guarded',
      classroomId,
      rubricPrompt: 'r',
      ...inModule,
      excludedPaths: ['tests/**'],
    });
    await expect(
      quizService.update(quiz.id, { name: 'Renamed', excludedPaths: ['/abs/**'] })
    ).rejects.toBeInstanceOf(quizService.QuizExcludedPathsError);
    const read = await quizService.findById(quiz.id);
    expect(read?.name).toBe('Guarded');
    expect(read?.excluded_paths).toEqual(['tests/**']);
  });
});
