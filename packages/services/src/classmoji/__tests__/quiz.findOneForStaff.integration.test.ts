/**
 * `quiz.findOneForStaff` against a REAL Postgres: one quiz of a classroom as
 * the staff list shows it (MCP quiz_get), read on its own. The query is
 * scoped to the quiz id AND the classroom, so it loads only that quiz's
 * attempts, finds nothing for another classroom's quiz, and keeps the list's
 * access rule.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organizations (cascades classroom → quizzes
 * → attempts) and the user. Nothing is truncated.
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

describe.skipIf(!RUN)('quiz.findOneForStaff (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const orgIds: string[] = [];
  let userId: string;
  let classX: string;
  let classY: string;
  let quizA: string;
  let quizB: string;
  let quizInY: string;

  const classroomIn = async (tag: string) => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `qone-${tag}-${suite}`,
        login: `qone-${tag}-${suite}`,
      },
    });
    orgIds.push(org.id);
    const classroom = await prisma.classroom.create({
      data: {
        slug: `qone-${tag}-${suite}`,
        git_org_id: org.id,
        name: `Quiz One ${tag} ${suite}`,
        content_namespace: `qone-${tag}-${suite}`,
        content_repo: `content-qone-${tag}-${suite}`,
      },
    });
    return classroom.id;
  };

  const quizIn = async (classroomId: string, name: string) =>
    (
      await prisma.quiz.create({
        data: {
          classroom_id: classroomId,
          name: `${name} ${suite}`,
          rubric_prompt: `RUBRIC ${name}`,
          system_prompt: `GUIDANCE ${name}`,
        },
      })
    ).id;

  const attempt = (quizId: string, score: number) =>
    prisma.quizAttempt.create({
      data: { quiz_id: quizId, user_id: userId, completed_at: new Date(), score },
    });

  const owner = (classroomId: string) => ({ role: 'OWNER' as const, classroom_id: classroomId });

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { email: `qone-${suite}@example.test`, name: `Quiz One ${suite}` },
    });
    userId = user.id;
    classX = await classroomIn('x');
    classY = await classroomIn('y');
    quizA = await quizIn(classX, 'A');
    quizB = await quizIn(classX, 'B');
    quizInY = await quizIn(classY, 'Y');
    await attempt(quizA, 80);
    await attempt(quizA, 90);
    await attempt(quizB, 10);
    await attempt(quizInY, 50);
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await prisma.gitOrganization.delete({ where: { id } }).catch(() => {});
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  it("returns the list's row for that quiz, with only its own attempts", async () => {
    const one = await quizService.findOneForStaff(classX, quizA, owner(classX));
    const list = await quizService.findByClassroom(classX, owner(classX));
    expect(one).not.toBeNull();
    expect(one!.id).toBe(quizA);
    expect(one!.attempts.map(a => a.quiz_id)).toEqual([quizA, quizA]);
    expect(one!.attemptsCount).toBe(2);
    // The same row the list builds, stats included.
    expect(one).toEqual(list.find(q => q.id === quizA));
  });

  it("finds nothing for another classroom's quiz, or an id that is no quiz", async () => {
    expect(await quizService.findOneForStaff(classX, quizInY, owner(classX))).toBeNull();
    expect(await quizService.findOneForStaff(classX, randomUUID(), owner(classX))).toBeNull();
    // No id is no quiz, never the classroom's newest one.
    expect(await quizService.findOneForStaff(classX, '', owner(classX))).toBeNull();
    expect(
      await quizService.findOneForStaff(classX, undefined as unknown as string, owner(classX))
    ).toBeNull();
  });

  it("keeps the staff list's access rule", async () => {
    await expect(
      quizService.findOneForStaff(classX, quizA, { role: 'STUDENT', classroom_id: classX })
    ).rejects.toMatchObject({ code: 'role_not_allowed' });
    await expect(quizService.findOneForStaff(classX, quizA, owner(classY))).rejects.toMatchObject({
      code: 'classroom_mismatch',
    });
    await expect(quizService.findOneForStaff(classX, quizA, null)).rejects.toMatchObject({
      code: 'membership_required',
    });
  });
});
