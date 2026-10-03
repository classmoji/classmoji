/**
 * The `quiz_assignments` migration's backfill against a REAL Postgres.
 *
 * The SQL after the `-- ==== BACKFILL ====` marker is run inside one
 * REPEATABLE READ transaction over fixtures made for this file, read back in
 * the same transaction, and rolled back by throwing at the end. Nothing it
 * writes survives, so the backfill can run again on every test without
 * touching the rows the applied migration already wrote.
 *
 * The backfill and its guard read every quiz in the database, so before it
 * runs, the same transaction takes every QUIZ assignment and QUIZ module item
 * of any other classroom out of its sight (deleted, and restored by the
 * rollback). What the test asserts, the guard included, then depends on its
 * own fixtures alone, never on what else the database holds.
 *
 * Shapes covered (plan §5): a quiz with an assignment; with one QUIZ item;
 * with items in two modules; an assignment in one module and an item in
 * another; a quiz in no module; a CLOSED quiz; a weight-0 quiz; differing due
 * dates; a module that already has assignments (positions); an item in a
 * module of another classroom; and the guard refusing an assignment whose
 * module is in another classroom.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const getPrisma = (await import('@classmoji/database')).default;

const MIGRATION = fileURLToPath(
  new URL(
    '../../../../database/migrations/20261002120000_quiz_assignments/migration.sql',
    import.meta.url
  )
);

/**
 * Split SQL into statements on top-level semicolons. Prisma runs one statement
 * per call (prepared statements refuse several), so the file is cut the way
 * psql would cut it: not inside quotes, dollar-quoted bodies or comments.
 */
export function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      current += '\n';
      continue;
    }
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) {
          j += 2;
          continue;
        }
        if (sql[j] === ch) break;
        j++;
      }
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const backfillStatements = () => {
  const sql = readFileSync(MIGRATION, 'utf8');
  const marker = sql.indexOf('-- ==== BACKFILL ====');
  if (marker === -1) throw new Error('backfill marker not found in the migration');
  return splitSql(sql.slice(marker));
};

class Rollback extends Error {}

describe('splitSql', () => {
  it('keeps dollar-quoted bodies, quoted semicolons and comments out of the cut', () => {
    const parts = splitSql(
      "SELECT ';' AS a; -- a; comment\nDO $$ BEGIN RAISE NOTICE 'x;y'; END $$;\nSELECT 2"
    );
    expect(parts).toEqual([
      "SELECT ';' AS a",
      "DO $$ BEGIN RAISE NOTICE 'x;y'; END $$",
      'SELECT 2',
    ]);
  });
});

describe.skipIf(!RUN)('quiz_assignments migration backfill (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const orgIds: string[] = [];
  let classroomId: string;
  let otherClassroomId: string;

  const classroomIn = async (tag: string) => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `qam-${tag}-${suite}`,
        login: `qam-${tag}-${suite}`,
      },
    });
    orgIds.push(org.id);
    const classroom = await prisma.classroom.create({
      data: {
        slug: `qam-${tag}-${suite}`,
        git_org_id: org.id,
        name: `Quiz migration ${tag} ${suite}`,
        content_namespace: `qam-${tag}-${suite}`,
        content_repo: `content-qam-${tag}-${suite}`,
      },
    });
    return classroom.id;
  };

  let serial = 0;
  const makeModule = (position: number, inClassroom = classroomId, isPublished = false) =>
    prisma.module.create({
      data: {
        classroom_id: inClassroom,
        title: `Week ${position} ${suite} ${serial++}`,
        position,
        is_published: isPublished,
      },
    });

  const makeQuiz = (
    name: string,
    over: { status?: 'DRAFT' | 'PUBLISHED' | 'CLOSED'; weight?: number; due?: Date | null } = {},
    inClassroom = classroomId
  ) =>
    prisma.quiz.create({
      data: {
        classroom_id: inClassroom,
        name,
        rubric_prompt: 'r',
        status: over.status ?? 'PUBLISHED',
        weight: over.weight ?? 5,
        due_date: over.due ?? null,
        created_at: new Date(Date.now() + serial++),
      },
    });

  const addItem = (moduleId: string, quizId: string, position: number) =>
    prisma.moduleItem.create({
      data: { module_id: moduleId, item_type: 'QUIZ', quiz_id: quizId, position },
    });

  const addAssignment = (
    moduleId: string,
    quizId: string,
    over: Partial<{
      title: string;
      weight: number;
      is_published: boolean;
      student_deadline: Date | null;
      release_at: Date | null;
      position: number;
    }> = {}
  ) =>
    prisma.assignment.create({
      data: {
        module_id: moduleId,
        type: 'QUIZ',
        quiz_id: quizId,
        title: over.title ?? 'Old title',
        weight: over.weight ?? 100,
        is_published: over.is_published ?? false,
        student_deadline: over.student_deadline ?? null,
        release_at: over.release_at ?? null,
        position: over.position ?? 0,
      },
    });

  /**
   * Run the backfill and `read` in one transaction, then roll it all back.
   * The backfill reads and writes every quiz and quiz assignment in the
   * database, so another test file writing one at the same moment can make
   * this snapshot fail to serialize (40001) or deadlock (40P01); the attempt
   * wrote nothing, and is run again.
   */
  const runBackfill = async <T>(read: (tx: typeof prisma) => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await runBackfillOnce(read);
      } catch (error) {
        const { message, code } = (error ?? {}) as { message?: unknown; code?: unknown };
        // Raw statements report the Postgres code in the message; Prisma's own
        // queries report a write conflict or deadlock as P2034.
        const retryable = code === 'P2034' || /\b(40001|40P01)\b/.test(String(message ?? ''));
        if (!retryable || attempt >= 5) throw error;
        await new Promise(resolve => setTimeout(resolve, 200 * attempt));
      }
    }
  };

  const runBackfillOnce = async <T>(read: (tx: typeof prisma) => Promise<T>): Promise<T> => {
    let result: T | undefined;
    await prisma
      .$transaction(
        async tx => {
          // Only this file's classrooms are in sight of the backfill (see the
          // header); the rollback below restores the rest.
          await tx.$executeRaw`
            DELETE FROM "module_items" mi
            USING "quizzes" q
            WHERE mi."quiz_id" = q."id" AND mi."item_type" = 'QUIZ'
              AND q."classroom_id" NOT IN (${classroomId}, ${otherClassroomId})`;
          await tx.$executeRaw`
            DELETE FROM "assignments" a
            USING "quizzes" q
            WHERE a."quiz_id" = q."id" AND a."type" = 'QUIZ'
              AND q."classroom_id" NOT IN (${classroomId}, ${otherClassroomId})`;
          for (const statement of backfillStatements()) {
            await tx.$executeRawUnsafe(statement);
          }
          result = await read(tx as unknown as typeof prisma);
          throw new Rollback();
        },
        { isolationLevel: 'RepeatableRead', timeout: 60_000, maxWait: 10_000 }
      )
      .catch(error => {
        if (!(error instanceof Rollback)) throw error;
      });
    return result as T;
  };

  const reports = (tx: typeof prisma, kind: string, subjectId: string) =>
    tx.courseworkMigrationReport.findMany({ where: { kind, subject_id: subjectId } });

  beforeAll(async () => {
    classroomId = await classroomIn('a');
    otherClassroomId = await classroomIn('b');
  });

  afterAll(async () => {
    for (const id of orgIds) {
      await prisma.gitOrganization.delete({ where: { id } }).catch(() => {});
    }
  });

  it('backfills every shape, reports it, and leaves the guard satisfied', async () => {
    const week1 = await makeModule(1);
    const week2 = await makeModule(2);
    const week3 = await makeModule(3);
    const foreign = await makeModule(1, otherClassroomId);

    // A module that already holds assignments: new rows go after them.
    const existingQuiz = await makeQuiz('Existing', { status: 'DRAFT' });
    await addAssignment(week2.id, existingQuiz.id, { title: 'Existing', weight: 5, position: 4 });

    const due = new Date('2026-10-20T18:00:00.000Z');
    const otherDue = new Date('2026-10-22T18:00:00.000Z');

    // 1. Has an assignment: title, weight and publish follow the quiz; the
    //    quiz's due date fills an empty deadline.
    const assigned = await makeQuiz('HTML & CSS Landing Page Basics', { weight: 2, due });
    const assignedRow = await addAssignment(week1.id, assigned.id, {
      title: 'Lab quiz',
      weight: 100,
      is_published: false,
    });

    // 1b. Both dates set and different: the assignment wins, the quiz follows.
    const conflicting = await makeQuiz('Conflicting dates', { due: otherDue });
    await addAssignment(week1.id, conflicting.id, {
      title: 'Conflicting dates',
      weight: 5,
      is_published: true,
      student_deadline: due,
      position: 1,
    });

    // 1c. Assignment in week 1, item in week 3: the assignment's module wins.
    const split = await makeQuiz('Split');
    const splitRow = await addAssignment(week1.id, split.id, { title: 'Split', position: 2 });
    const splitItem = await addItem(week3.id, split.id, 0);

    // 2. One item: an assignment is created in that module.
    const single = await makeQuiz('Single item', { due });
    await addItem(week2.id, single.id, 1);

    // 2b. Items in two modules: the lower module position wins.
    const twice = await makeQuiz('Twice');
    await addItem(week3.id, twice.id, 2);
    await addItem(week2.id, twice.id, 0);

    // 2c. A CLOSED quiz in a module: published, closing at its last update.
    const closed = await makeQuiz('Closed', { status: 'CLOSED' });
    await addItem(week3.id, closed.id, 1);

    // 2d. Weight 0 stays 0 (a practice quiz), never the column default 100.
    const practice = await makeQuiz('Practice', { weight: 0, status: 'DRAFT' });
    await addItem(week3.id, practice.id, 3);

    // 3. Nowhere: untouched.
    const nowhere = await makeQuiz('Nowhere', { due });

    // An item in a module of another classroom places nothing.
    const strayed = await makeQuiz('Strayed');
    const strayedItem = await addItem(foreign.id, strayed.id, 0);

    const closedBefore = await prisma.quiz.findUniqueOrThrow({ where: { id: closed.id } });

    const out = await runBackfill(async tx => {
      const assignmentOf = (quizId: string) =>
        tx.assignment.findUnique({ where: { quiz_id: quizId } });
      return {
        assigned: await assignmentOf(assigned.id),
        assignedQuiz: await tx.quiz.findUniqueOrThrow({ where: { id: assigned.id } }),
        conflicting: await assignmentOf(conflicting.id),
        conflictingQuiz: await tx.quiz.findUniqueOrThrow({ where: { id: conflicting.id } }),
        split: await assignmentOf(split.id),
        single: await assignmentOf(single.id),
        twice: await assignmentOf(twice.id),
        closed: await assignmentOf(closed.id),
        practice: await assignmentOf(practice.id),
        nowhere: await assignmentOf(nowhere.id),
        nowhereQuiz: await tx.quiz.findUniqueOrThrow({ where: { id: nowhere.id } }),
        strayed: await assignmentOf(strayed.id),
        week2: await tx.assignment.findMany({
          where: { module_id: week2.id },
          orderBy: { position: 'asc' },
          select: { quiz_id: true, position: true },
        }),
        week3: await tx.assignment.findMany({
          where: { module_id: week3.id },
          orderBy: { position: 'asc' },
          select: { quiz_id: true, position: true },
        }),
        reports: {
          backup: await reports(tx, 'backup_quiz', assigned.id),
          conflict: await reports(tx, 'quiz_due_date_conflict', conflicting.id),
          weight: await reports(tx, 'quiz_assignment_weight_changed', assigned.id),
          publish: await reports(tx, 'quiz_publish_changed', assigned.id),
          itemDiffers: await reports(tx, 'quiz_item_module_differs', split.id),
          created: await reports(tx, 'quiz_assignment_created', single.id),
          multiple: await reports(tx, 'quiz_in_multiple_modules', twice.id),
          unassigned: await reports(tx, 'quiz_unassigned', nowhere.id),
          foreign: await reports(tx, 'quiz_item_foreign_module', strayed.id),
          weights: await tx.courseworkMigrationReport.findMany({
            where: { kind: 'quiz_weight_summary', classroom_id: classroomId },
          }),
          summary: await tx.courseworkMigrationReport.findMany({
            where: { kind: 'quiz_assignments_summary' },
            orderBy: { created_at: 'desc' },
            take: 1,
          }),
        },
      };
    });

    // 1. The existing assignment now carries the quiz's name, weight and
    //    publish state, and the quiz's date filled its empty deadline.
    expect(out.assigned).toMatchObject({
      id: assignedRow.id,
      title: 'HTML & CSS Landing Page Basics',
      weight: 2,
      is_published: true,
      student_deadline: due,
      closes_at: null,
    });
    expect(out.assignedQuiz.due_date).toEqual(due);
    expect(out.reports.backup[0].details).toMatchObject({
      name: 'HTML & CSS Landing Page Basics',
      weight: 2,
      status: 'PUBLISHED',
      assignment: { id: assignedRow.id, title: 'Lab quiz', weight: 100, is_published: false },
    });
    expect(out.reports.weight[0].details).toMatchObject({ old_weight: 100, new_weight: 2 });
    expect(out.reports.publish[0].details).toMatchObject({
      old_is_published: false,
      new_is_published: true,
    });

    // 1b. The assignment's date wins; the quiz is mirrored to it.
    expect(out.conflicting?.student_deadline).toEqual(due);
    expect(out.conflictingQuiz.due_date).toEqual(due);
    expect(out.reports.conflict).toHaveLength(1);

    // 1c. The assignment stays where it was; the stray item is reported.
    expect(out.split).toMatchObject({ id: splitRow.id, module_id: week1.id });
    expect(out.reports.itemDiffers[0].details).toMatchObject({
      assignment_module_id: week1.id,
      item_id: splitItem.id,
      item_module_id: week3.id,
    });

    // 2. Created in the item's module, after the module's existing rows.
    expect(out.single).toMatchObject({
      module_id: week2.id,
      type: 'QUIZ',
      title: 'Single item',
      slug: 'single-item',
      weight: 5,
      is_published: true,
      student_deadline: due,
      tokens_per_hour: null,
      closes_at: null,
    });
    expect(out.reports.created[0].details).toMatchObject({
      assignment_id: out.single!.id,
      module_id: week2.id,
    });

    // 2b. Lowest module position wins; the other module is reported.
    expect(out.twice?.module_id).toBe(week2.id);
    expect(out.reports.multiple[0].details).toMatchObject({
      module_id: week3.id,
      canonical_module_id: week2.id,
    });

    // Positions: appended after the module's max, one each, by item position.
    expect(out.week2).toEqual([
      { quiz_id: existingQuiz.id, position: 4 },
      { quiz_id: twice.id, position: 5 },
      { quiz_id: single.id, position: 6 },
    ]);
    expect(out.week3).toEqual([
      { quiz_id: closed.id, position: 0 },
      { quiz_id: practice.id, position: 1 },
    ]);

    // 2c. CLOSED: published, closing at the quiz's last update.
    expect(out.closed).toMatchObject({ is_published: true, closes_at: closedBefore.updated_at });

    // 2d. Weight 0 kept; a draft stays unpublished.
    expect(out.practice).toMatchObject({ weight: 0, is_published: false });

    // 3. Nowhere: no assignment, quiz unchanged, reported.
    expect(out.nowhere).toBeNull();
    expect(out.nowhereQuiz.due_date).toEqual(due);
    expect(out.reports.unassigned).toHaveLength(1);

    // An item in another classroom's module creates nothing.
    expect(out.strayed).toBeNull();
    expect(out.reports.foreign[0].details).toMatchObject({
      item_id: strayedItem.id,
      module_id: foreign.id,
    });

    // One weight summary row for this classroom.
    expect(out.reports.weights).toHaveLength(1);
    expect(out.reports.weights[0].details).toMatchObject({
      // existing, assigned, conflicting, split, single, twice, closed, practice
      quiz_assignments: 8,
      quiz_weight_sum: 5 + 2 + 5 + 5 + 5 + 5 + 5 + 0,
      zero_weight_quizzes: 1,
    });
    expect(out.reports.summary).toHaveLength(1);

    // Rolled back: nothing the backfill wrote is left.
    expect(await prisma.assignment.findUnique({ where: { quiz_id: single.id } })).toBeNull();
    expect(
      (await prisma.assignment.findUniqueOrThrow({ where: { id: assignedRow.id } })).title
    ).toBe('Lab quiz');
  });

  it('refuses to finish when a quiz assignment sits in another classroom', async () => {
    const elsewhere = await makeModule(9, otherClassroomId);
    const quiz = await makeQuiz('Misplaced');
    await addAssignment(elsewhere.id, quiz.id, { title: 'Misplaced', weight: 5 });

    try {
      await expect(runBackfill(async () => null)).rejects.toThrow(/disagree with their quiz/);
    } finally {
      // Never left behind for the next test, whatever happened above.
      await prisma.quiz.delete({ where: { id: quiz.id } });
    }
  });

  it('is not tripped by another classroom’s rows, only by its own', async () => {
    // A QUIZ assignment in a classroom outside this file whose module is in yet
    // another classroom: the guard would refuse it, but it is out of sight.
    const outsider = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `qam-out-${suite}`, login: `qam-out-${suite}` },
    });
    orgIds.push(outsider.id);
    const outsideClassroom = await prisma.classroom.create({
      data: {
        slug: `qam-out-${suite}`,
        git_org_id: outsider.id,
        name: `Quiz migration outsider ${suite}`,
        content_namespace: `qam-out-${suite}`,
        content_repo: `content-qam-out-${suite}`,
      },
    });
    const foreignModule = await makeModule(9, otherClassroomId);
    const outsideQuiz = await makeQuiz('Outsider', {}, outsideClassroom.id);
    await addAssignment(foreignModule.id, outsideQuiz.id, { title: 'Outsider' });
    const own = await makeQuiz('Own');
    const ownModule = await makeModule(10);
    await addItem(ownModule.id, own.id, 0);

    try {
      const created = await runBackfill(tx =>
        tx.assignment.findUnique({ where: { quiz_id: own.id } })
      );
      expect(created).toMatchObject({ module_id: ownModule.id, title: 'Own' });
    } finally {
      await prisma.quiz.delete({ where: { id: outsideQuiz.id } });
    }
  });

  it('reports what changes on existing assignments, and places a quiz in a published module first', async () => {
    const unpublished = await makeModule(20);
    const published = await makeModule(21, classroomId, true);
    const due = new Date('2026-10-20T18:00:00.000Z');
    const opens = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // A CLOSED quiz that already has an (unpublished) assignment: published,
    // closing at the quiz's last update.
    const closed = await makeQuiz('Closed with row', { status: 'CLOSED' });
    await addAssignment(unpublished.id, closed.id, { title: 'Closed with row', weight: 5 });
    // A DRAFT quiz whose assignment was published: unpublished.
    const draft = await makeQuiz('Draft with row', { status: 'DRAFT' });
    await addAssignment(unpublished.id, draft.id, {
      title: 'Draft with row',
      weight: 5,
      is_published: true,
      position: 1,
    });
    // No due date on the quiz, one on the assignment: the quiz takes it.
    const dated = await makeQuiz('Dated by row');
    await addAssignment(unpublished.id, dated.id, {
      title: 'Old name',
      weight: 5,
      is_published: true,
      student_deadline: due,
      position: 2,
    });
    // A published quiz whose assignment opens next month.
    const later = await makeQuiz('Opens later');
    await addAssignment(unpublished.id, later.id, {
      title: 'Opens later',
      weight: 5,
      is_published: true,
      release_at: opens,
      position: 3,
    });
    // Items in an unpublished module first in order and a published one:
    // the published module wins.
    const placed = await makeQuiz('Placed twice');
    await addItem(unpublished.id, placed.id, 0);
    await addItem(published.id, placed.id, 0);

    const closedBefore = await prisma.quiz.findUniqueOrThrow({ where: { id: closed.id } });

    const out = await runBackfill(async tx => ({
      closed: await tx.assignment.findUnique({ where: { quiz_id: closed.id } }),
      closedQuiz: await tx.quiz.findUniqueOrThrow({ where: { id: closed.id } }),
      draft: await tx.assignment.findUnique({ where: { quiz_id: draft.id } }),
      draftQuiz: await tx.quiz.findUniqueOrThrow({ where: { id: draft.id } }),
      datedQuiz: await tx.quiz.findUniqueOrThrow({ where: { id: dated.id } }),
      later: await tx.assignment.findUnique({ where: { quiz_id: later.id } }),
      placed: await tx.assignment.findUnique({ where: { quiz_id: placed.id } }),
      reports: {
        closedPublish: await reports(tx, 'quiz_publish_changed', closed.id),
        draftPublish: await reports(tx, 'quiz_publish_changed', draft.id),
        title: await reports(tx, 'quiz_assignment_title_changed', dated.id),
        dueFromRow: await reports(tx, 'quiz_due_date_from_assignment', dated.id),
        opensLater: await reports(tx, 'quiz_opens_in_future', later.id),
        multiple: await reports(tx, 'quiz_in_multiple_modules', placed.id),
        summary: await tx.courseworkMigrationReport.findMany({
          where: { kind: 'quiz_assignments_summary' },
          orderBy: { created_at: 'desc' },
          take: 1,
        }),
      },
    }));

    expect(out.closed).toMatchObject({
      is_published: true,
      closes_at: closedBefore.updated_at,
    });
    expect(out.reports.closedPublish[0].details).toMatchObject({
      old_is_published: false,
      new_is_published: true,
      quiz_status: 'CLOSED',
    });

    expect(out.draft?.is_published).toBe(false);
    expect(out.draftQuiz.status).toBe('DRAFT');
    expect(out.reports.draftPublish[0].details).toMatchObject({
      old_is_published: true,
      new_is_published: false,
      quiz_status: 'DRAFT',
    });

    expect(out.datedQuiz.due_date).toEqual(due);
    expect(out.reports.dueFromRow).toHaveLength(1);
    expect(
      String(
        (out.reports.dueFromRow[0].details as { assignment_deadline: unknown }).assignment_deadline
      )
    ).toContain('2026-10-20T18:00');
    expect(out.reports.title[0].details).toMatchObject({
      old_title: 'Old name',
      new_title: 'Dated by row',
    });

    expect(out.later).toMatchObject({ is_published: true, release_at: opens });
    expect(out.reports.opensLater[0].details).toMatchObject({ quiz_status: 'PUBLISHED' });

    expect(out.placed?.module_id).toBe(published.id);
    expect(out.reports.multiple[0].details).toMatchObject({
      module_id: unpublished.id,
      canonical_module_id: published.id,
    });

    expect(out.reports.summary[0].details).toMatchObject({
      titles_changed: expect.any(Number),
      due_dates_from_assignment: expect.any(Number),
      opens_in_future: expect.any(Number),
    });
  });
});
