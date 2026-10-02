/**
 * Quiz source material against a REAL Postgres.
 *
 * What a fake Prisma would agree with whatever the service did, and so is run
 * for real here:
 *
 *   - the quiz links, their `order` and the partial unique index the
 *     quiz_source_material migration adds by hand (Prisma cannot express it);
 *   - `load` reading `content_index` through `getContentText` under the
 *     viewer's role: a student's material leaves out a draft as `not_visible`,
 *     staff get it, a document with no index row is `not_indexed`;
 *   - `countStartable`'s SQL agreeing with `load` on the same fixtures;
 *   - quiz.create/update writing the material in the quiz's transaction, and an
 *     unknown document rolling the quiz write back.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * `afterAll` by deleting the git organization (cascades classroom → pages,
 * slides, quizzes, links, content_index) and the users. Nothing is truncated.
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
const { loadQuizSourceMaterial, countStartableSourceMaterial } =
  await import('../quizSourceMaterial.service.ts');
const quizService = await import('../quiz.service.ts');
const { ResourceLinkServiceError } = await import('../resourceLink.service.ts');

describe.skipIf(!RUN)('quiz source material (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();

  let orgId: string;
  let classroomId: string;
  let studentId: string;
  let teacherId: string;
  let publishedPageId: string;
  let draftPageId: string;
  let unindexedPageId: string;
  let deckId: string;
  let quizId: string;

  const insertIndexRow = (docKind: 'page' | 'slide', docId: string, title: string, text: string) =>
    prisma.$executeRaw`
      INSERT INTO content_index (
        classroom_id, doc_kind, doc_id, chunk_ix, chunk_count,
        source_path, source_sha, extract_version, embed_model, title, text, embedding
      ) VALUES (
        ${classroomId}, ${docKind}, ${docId}, 0, 1,
        ${`${docKind}s/${docId}`}, ${`sha-${docId}`}, 1, ${'@cf/qwen/qwen3-embedding-0.6b'},
        ${title}, ${text}, NULL::vector
      )`;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `qsm-${suite}`, login: `qsm-org-${suite}` },
    });
    orgId = org.id;

    const classroom = await prisma.classroom.create({
      data: {
        slug: `qsm-${suite}`,
        git_org_id: orgId,
        name: `Quiz Material ${suite}`,
        content_namespace: `qsm-${suite}`,
        content_repo: `content-qsm-${suite}`,
      },
    });
    classroomId = classroom.id;

    const student = await prisma.user.create({
      data: {
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `qsm-${suite}-student`,
            username: `qsm-${suite}-student`,
          },
        },
        email: `qsm-s-${suite}@example.test`,
        name: 'S',
      },
    });
    studentId = student.id;
    const teacher = await prisma.user.create({
      data: {
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `qsm-${suite}-teacher`,
            username: `qsm-${suite}-teacher`,
          },
        },
        email: `qsm-t-${suite}@example.test`,
        name: 'T',
      },
    });
    teacherId = teacher.id;
    await prisma.classroomMembership.createMany({
      data: [
        { classroom_id: classroomId, user_id: studentId, role: 'STUDENT' },
        { classroom_id: classroomId, user_id: teacherId, role: 'TEACHER' },
      ],
    });

    const page = (title: string, is_draft: boolean) =>
      prisma.page.create({
        data: {
          classroom_id: classroomId,
          title,
          slug: `${title.toLowerCase().replace(/\s+/g, '-')}-${suite}`,
          content_path: `pages/${title}`,
          created_by: teacherId,
          is_draft,
        },
      });
    publishedPageId = (await page('Semantic HTML', false)).id;
    draftPageId = (await page('Next Week', true)).id;
    unindexedPageId = (await page('Fresh Page', false)).id;

    deckId = (
      await prisma.slide.create({
        data: {
          classroom_id: classroomId,
          title: 'Forms Deck',
          slug: `forms-deck-${suite}`,
          content_path: 'slides/forms',
          created_by: teacherId,
          is_draft: false,
        },
      })
    ).id;

    await insertIndexRow('page', publishedPageId, 'Semantic HTML', 'nav header main footer');
    await insertIndexRow('page', draftPageId, 'Next Week', 'unreleased material');
    await insertIndexRow('slide', deckId, 'Forms Deck', 'label and input');

    const quiz = await quizService.create({
      name: `Quiz ${suite}`,
      classroomId,
      rubricPrompt: 'grade it',
      sourceMaterial: [
        { kind: 'slide', id: deckId },
        { kind: 'page', id: draftPageId },
        { kind: 'page', id: publishedPageId },
        { kind: 'page', id: unindexedPageId },
      ],
    });
    quizId = quiz.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    for (const id of [studentId, teacherId]) {
      if (id) await prisma.user.delete({ where: { id } }).catch(() => {});
    }
  });

  it('stores the material in order across both link tables', async () => {
    const quiz = await quizService.findById(quizId);
    expect(quiz?.source_material.map(d => `${d.kind}:${d.id}:${d.order}`)).toEqual([
      `slide:${deckId}:0`,
      `page:${draftPageId}:1`,
      `page:${publishedPageId}:2`,
      `page:${unindexedPageId}:3`,
    ]);
  });

  it('student: omits the draft as not_visible and the unindexed page as not_indexed', async () => {
    const material = await loadQuizSourceMaterial({ quizId, classroomId, userId: studentId });

    expect(material.configured).toBe(4);
    expect(material.docs.map(d => d.id)).toEqual([deckId, publishedPageId]);
    expect(material.docs[1]).toMatchObject({
      title: 'Semantic HTML',
      text: 'nav header main footer',
      sourceSha: `sha-${publishedPageId}`,
    });
    expect(material.omitted).toEqual([
      { kind: 'page', id: draftPageId, title: 'Next Week', reason: 'not_visible' },
      { kind: 'page', id: unindexedPageId, title: 'Fresh Page', reason: 'not_indexed' },
    ]);
  });

  it('staff: includes the draft', async () => {
    const material = await loadQuizSourceMaterial({ quizId, classroomId, userId: teacherId });
    expect(material.docs.map(d => d.id)).toEqual([deckId, draftPageId, publishedPageId]);
  });

  it('countStartable agrees with load for each viewer', async () => {
    await expect(
      countStartableSourceMaterial({ quizId, classroomId, userId: studentId })
    ).resolves.toEqual({ configured: 4, startable: 2 });
    await expect(
      countStartableSourceMaterial({ quizId, classroomId, userId: teacherId })
    ).resolves.toEqual({ configured: 4, startable: 3 });
  });

  it('the partial unique index refuses a second link of the same page to the same quiz', async () => {
    await expect(
      prisma.pageLink.create({ data: { page_id: publishedPageId, quiz_id: quizId, order: 9 } })
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('an unknown document rolls back the whole update, field changes included', async () => {
    await expect(
      quizService.update(quizId, {
        name: 'renamed',
        sourceMaterial: [{ kind: 'page', id: randomUUID() }],
      })
    ).rejects.toBeInstanceOf(ResourceLinkServiceError);

    const quiz = await quizService.findById(quizId);
    expect(quiz?.name).toBe(`Quiz ${suite}`);
    expect(quiz?.source_material).toHaveLength(4);
  });

  it('an all-drafts quiz has nothing startable for a student', async () => {
    await quizService.update(quizId, { sourceMaterial: [{ kind: 'page', id: draftPageId }] });

    await expect(
      countStartableSourceMaterial({ quizId, classroomId, userId: studentId })
    ).resolves.toEqual({ configured: 1, startable: 0 });
    const material = await loadQuizSourceMaterial({ quizId, classroomId, userId: studentId });
    expect(material.docs).toEqual([]);
  });
});
