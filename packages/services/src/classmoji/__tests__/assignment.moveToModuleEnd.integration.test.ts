/**
 * `assignment.moveToModuleEnd` against a REAL Postgres.
 *
 * What cannot be mocked, and is therefore the whole point of this file:
 *   - the move, the target's renumbering and the source's compaction commit
 *     together or not at all;
 *   - the module row locks: several moves into one module at the same time
 *     (how an agent places a week's labs) must each land on their own
 *     position, and moves in opposite directions must not deadlock;
 *   - the re-read under the lock, when the SAME assignment is moved to two
 *     different modules at once.
 * A fake Prisma would run every "concurrent" call one after another and agree
 * with whatever the service did.
 *
 * Also pinned here, because the MCP's module read leans on it: the student
 * filter in `module.listForClassroom` (published assignments only, and a REPO
 * one only once its repository is published).
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (which cascades classroom → modules
 * → assignments, and classroom → repositories). Nothing is truncated and no
 * pre-existing row is touched.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * moduleItems.form.integration.test.ts does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as assignmentService from '../assignment.service.ts';
import * as moduleService from '../module.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('assignment.moveToModuleEnd (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classroomId: string;
  let classroomSlug: string;
  let otherClassroomId: string;
  let repositoryId: string;
  let draftRepositoryId: string;

  const makeModule = (inClassroom = classroomId) =>
    moduleService.create(inClassroom, { title: `Module ${randomUUID().slice(0, 8)} ${suite}` });

  // Assignment titles are unique per repository, so each stored title carries a
  // serial after `#`; `layout` reads it back off.
  let serial = 0;

  /** A REPO assignment written straight to the table, at a chosen position. */
  const makeAssignment = async (
    moduleId: string,
    {
      position = 0,
      title = `A ${randomUUID().slice(0, 8)}`,
      deadline = null as Date | null,
      published = false,
      repository = repositoryId,
    } = {}
  ) =>
    prisma.assignment.create({
      data: {
        module_id: moduleId,
        type: 'REPO',
        repository_id: repository,
        title: `${title}#${++serial}`,
        position,
        student_deadline: deadline,
        is_published: published,
      },
      select: { id: true },
    });

  /** `title@position` for a module's rows, by stored position then title. */
  const layout = async (moduleId: string) =>
    (
      await prisma.assignment.findMany({
        where: { module_id: moduleId },
        orderBy: [{ position: 'asc' }, { title: 'asc' }],
        select: { title: true, position: true },
      })
    ).map(a => `${a.title.split('#')[0]}@${a.position}`);

  const positions = async (moduleId: string) =>
    (
      await prisma.assignment.findMany({
        where: { module_id: moduleId },
        orderBy: { position: 'asc' },
        select: { position: true },
      })
    ).map(a => a.position);

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `mvtest-${suite}`, login: `mvtest-org-${suite}` },
    });
    orgId = org.id;

    const makeClassroom = (tag: string) =>
      prisma.classroom.create({
        data: {
          slug: `mvtest-${tag}-${suite}`,
          git_org_id: orgId,
          name: `Move Test ${tag} ${suite}`,
          content_namespace: `mvtest-${tag}-${suite}`,
          content_repo: `content-mvtest-${tag}-${suite}`,
        },
      });
    const classroom = await makeClassroom('main');
    classroomId = classroom.id;
    classroomSlug = classroom.slug;
    otherClassroomId = (await makeClassroom('other')).id;

    const makeRepository = (title: string, isPublished: boolean) =>
      prisma.repository.create({
        data: {
          classroom_id: classroomId,
          title: `${title}-${suite}`,
          template: 'org/template',
          type: 'INDIVIDUAL',
          is_published: isPublished,
        },
        select: { id: true },
      });
    repositoryId = (await makeRepository('labs', true)).id;
    draftRepositoryId = (await makeRepository('draft-labs', false)).id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
  });

  it('puts the assignment at the end of the target and compacts the module it left', async () => {
    const from = await makeModule();
    const to = await makeModule();
    const moving = await makeAssignment(from.id, { position: 1, title: 'moving' });
    await makeAssignment(from.id, { position: 0, title: 'stays-a' });
    await makeAssignment(from.id, { position: 2, title: 'stays-b' });
    await makeAssignment(to.id, { position: 0, title: 'there-a' });
    await makeAssignment(to.id, { position: 1, title: 'there-b' });

    const result = await assignmentService.moveToModuleEnd(moving.id, to.id, classroomId);

    expect(result).toEqual({ moved: true, fromModuleId: from.id });
    expect(await layout(to.id)).toEqual(['there-a@0', 'there-b@1', 'moving@2']);
    expect(await layout(from.id)).toEqual(['stays-a@0', 'stays-b@1']);
  });

  it('keeps the display order of rows that were never dragged (all stored at one position)', async () => {
    // Created after the position column existed and never arranged: every row
    // sits at 0 and the screen orders them by deadline, then title.
    const from = await makeModule();
    const to = await makeModule();
    const moving = await makeAssignment(from.id, { title: 'moving' });
    await makeAssignment(to.id, { title: 'due-later', deadline: new Date('2026-11-01T00:00:00Z') });
    await makeAssignment(to.id, { title: 'due-first', deadline: new Date('2026-10-01T00:00:00Z') });
    await makeAssignment(to.id, { title: 'no-deadline' });

    await assignmentService.moveToModuleEnd(moving.id, to.id, classroomId);

    expect(await layout(to.id)).toEqual([
      'due-first@0',
      'due-later@1',
      'no-deadline@2',
      'moving@3',
    ]);
  });

  it('moves only the module: weight, deadline and publish state travel with it', async () => {
    const from = await makeModule();
    const to = await makeModule();
    const deadline = new Date('2026-10-12T03:59:00Z');
    const moving = await prisma.assignment.create({
      data: {
        module_id: from.id,
        type: 'REPO',
        repository_id: repositoryId,
        title: `weighted ${suite}`,
        weight: 37,
        is_extra_credit: true,
        is_published: true,
        grades_released: true,
        student_deadline: deadline,
      },
    });

    await assignmentService.moveToModuleEnd(moving.id, to.id, classroomId);

    const after = await prisma.assignment.findUniqueOrThrow({ where: { id: moving.id } });
    expect(after).toMatchObject({
      module_id: to.id,
      repository_id: repositoryId,
      weight: 37,
      is_extra_credit: true,
      is_published: true,
      grades_released: true,
      student_deadline: deadline,
    });
  });

  it('moves nothing when the assignment is already in that module', async () => {
    const module = await makeModule();
    await makeAssignment(module.id, { position: 4, title: 'first' });
    const same = await makeAssignment(module.id, { position: 9, title: 'second' });

    const result = await assignmentService.moveToModuleEnd(same.id, module.id, classroomId);

    // Not even a renumbering: the stored positions are left exactly as found.
    expect(result).toEqual({ moved: false, fromModuleId: module.id });
    expect(await layout(module.id)).toEqual(['first@4', 'second@9']);
  });

  it('refuses a target module or an assignment outside the classroom, writing nothing', async () => {
    const from = await makeModule();
    const to = await makeModule();
    const foreignModule = await makeModule(otherClassroomId);
    const assignment = await makeAssignment(from.id, { title: 'scoped' });

    await expect(
      assignmentService.moveToModuleEnd(assignment.id, foreignModule.id, classroomId)
    ).rejects.toThrow('Module not found in classroom');
    await expect(
      assignmentService.moveToModuleEnd(assignment.id, to.id, otherClassroomId)
    ).rejects.toThrow('Module not found in classroom');
    await expect(
      assignmentService.moveToModuleEnd(assignment.id, foreignModule.id, otherClassroomId)
    ).rejects.toThrow('Assignment not found in classroom');
    await expect(
      assignmentService.moveToModuleEnd(randomUUID(), to.id, classroomId)
    ).rejects.toThrow('Assignment not found in classroom');

    expect(await layout(from.id)).toEqual(['scoped@0']);
    expect(await layout(to.id)).toEqual([]);
    expect(await layout(foreignModule.id)).toEqual([]);
  });

  it('gives every one of several simultaneous moves into a module its own position', async () => {
    const sources = await Promise.all(Array.from({ length: 8 }, () => makeModule()));
    const to = await makeModule();
    await makeAssignment(to.id, { position: 0, title: 'already-there' });
    const moving = await Promise.all(
      sources.map((source, index) => makeAssignment(source.id, { title: `lab-${index}` }))
    );

    const results = await Promise.all(
      moving.map(a => assignmentService.moveToModuleEnd(a.id, to.id, classroomId))
    );

    expect(results.every(r => r.moved)).toBe(true);
    // All nine present, on nine distinct positions with no gap, and the row
    // that was there first still first.
    expect(await positions(to.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect((await layout(to.id))[0]).toBe('already-there@0');
    for (const source of sources) expect(await layout(source.id)).toEqual([]);
  });

  it('does not deadlock when two modules trade assignments at the same time', async () => {
    const a = await makeModule();
    const b = await makeModule();
    const fromA = await Promise.all(
      [0, 1, 2].map(position => makeAssignment(a.id, { position, title: `a-${position}` }))
    );
    const fromB = await Promise.all(
      [0, 1, 2].map(position => makeAssignment(b.id, { position, title: `b-${position}` }))
    );

    const results = await Promise.all([
      ...fromA.map(x => assignmentService.moveToModuleEnd(x.id, b.id, classroomId)),
      ...fromB.map(x => assignmentService.moveToModuleEnd(x.id, a.id, classroomId)),
    ]);

    expect(results.every(r => r.moved)).toBe(true);
    expect((await layout(a.id)).map(row => row.split('@')[0]).sort()).toEqual([
      'b-0',
      'b-1',
      'b-2',
    ]);
    expect(await positions(a.id)).toEqual([0, 1, 2]);
    expect(await positions(b.id)).toEqual([0, 1, 2]);
  });

  it('lets exactly one of two simultaneous moves of the SAME assignment win', async () => {
    const from = await makeModule();
    const left = await makeModule();
    const right = await makeModule();
    const contested = await makeAssignment(from.id, { title: 'contested' });

    const outcomes = await Promise.allSettled([
      assignmentService.moveToModuleEnd(contested.id, left.id, classroomId),
      assignmentService.moveToModuleEnd(contested.id, right.id, classroomId),
    ]);

    const won = outcomes.filter(o => o.status === 'fulfilled');
    const lost = outcomes.filter(o => o.status === 'rejected') as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The loser wrote nothing and says so, rather than silently re-moving it.
    expect(String(lost[0].reason)).toContain('Assignment moved concurrently');
    const landed = [await layout(left.id), await layout(right.id)];
    expect(landed.flat()).toEqual(['contested@0']);
    expect(await layout(from.id)).toEqual([]);
  });

  it('student module list: published assignments only, a REPO one only with its repository published', async () => {
    const module = await makeModule();
    await moduleService.setPublished(module.id, true, classroomId);
    await makeAssignment(module.id, { position: 0, title: 'visible', published: true });
    await makeAssignment(module.id, { position: 1, title: 'draft-assignment', published: false });
    await makeAssignment(module.id, {
      position: 2,
      title: 'published-on-draft-repo',
      published: true,
      repository: draftRepositoryId,
    });
    const hidden = await makeModule();
    await makeAssignment(hidden.id, { title: 'in-unpublished-module', published: true });

    const titlesFor = async (includeUnpublished: boolean) =>
      (await moduleService.listForClassroom(classroomSlug, { includeUnpublished }))
        .filter(m => m.id === module.id || m.id === hidden.id)
        .flatMap(m => m.assignments.map(a => a.title.split('#')[0]));

    expect(await titlesFor(false)).toEqual(['visible']);
    expect(await titlesFor(true)).toEqual([
      'visible',
      'draft-assignment',
      'published-on-draft-repo',
      'in-unpublished-module',
    ]);
  });
});
