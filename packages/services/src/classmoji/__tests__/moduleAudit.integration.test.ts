/**
 * The module services write the audit row of each change they make, against a
 * REAL Postgres: one row with exactly the actor's fields (a web actor, and an
 * MCP one under View as), written after the change; no row when nothing
 * changed (the same title and description, the flag it already has, the same
 * order); none and no throw for `actor: null`; and a saved change that reports
 * `missed` when its row could not be written (an actor with no user row, which
 * the `audit_logs.user_id` foreign key refuses). A reorder names the rows that
 * moved and their new places, not the whole list. Owner A in classroom X and
 * owner B in classroom Y never touch or see each other's modules or rows.
 *
 * Covers module.create, updateForClassroom, deleteById, setPublished,
 * setPublic, addItem, removeItem, moveItemToModule, moveItemToModuleEnd,
 * reorderItems, reorderModules, and assignment.reorderInModule / moveToModule.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down in afterAll
 * (deleting the git organization cascades classrooms, modules, items, pages,
 * assignments and audit rows). Skipped unless DATABASE_URL names a LOCAL,
 * non-shared database, like the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import type { AuditActor } from '../audit.service.ts';
import { REORDER_AUDIT_MAX_MOVED } from '../orderAudit.ts';

const moduleService = await import('../module.service.ts');
const assignmentService = await import('../assignment.service.ts');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

describe.skipIf(!RUN)('module services write their audit rows (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const userIds: string[] = [];
  let orgId: string;
  let serial = 0;

  interface Fixture {
    label: string;
    classroomId: string;
    ownerId: string;
    repositoryId: string;
  }
  let X: Fixture;
  let Y: Fixture;

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: { email: `moduleaudit-${label}-${++serial}-${suite}@example.test` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (label: string): Promise<Fixture> => {
    const row = await prisma.classroom.create({
      data: {
        slug: `moduleaudit-${label}-${suite}`,
        git_org_id: orgId,
        name: `Module audit ${label} ${suite}`,
        content_namespace: `moduleaudit-${label}-${suite}`,
        content_repo: `content-moduleaudit-${label}-${suite}`,
      },
      select: { id: true },
    });
    const ownerId = await makeUser(`owner-${label}`);
    await prisma.classroomMembership.create({
      data: { classroom_id: row.id, user_id: ownerId, role: 'OWNER', has_accepted_invite: true },
    });
    const repository = await prisma.repository.create({
      data: {
        classroom_id: row.id,
        title: `Lab ${label} ${suite}`,
        slug: `lab-${label}-${suite}`,
        template: 'org/template',
        type: 'INDIVIDUAL',
      },
      select: { id: true },
    });
    return { label, classroomId: row.id, ownerId, repositoryId: repository.id };
  };

  const SELECT = {
    user_id: true,
    classroom_id: true,
    role: true,
    resource_type: true,
    resource_id: true,
    action: true,
    data: true,
  } as const;
  const rowsIn = (classroomId: string) =>
    prisma.auditLog.findMany({
      where: { classroom_id: classroomId },
      orderBy: { timestamp: 'asc' },
      select: SELECT,
    });
  /** The rows a call wrote in `f`'s classroom. */
  const newRows = async <T>(f: Fixture, fn: () => Promise<T>) => {
    const before = (await rowsIn(f.classroomId)).length;
    const value = await fn();
    return { value, rows: (await rowsIn(f.classroomId)).slice(before) };
  };

  const webActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.ownerId,
    role: 'OWNER',
    tool,
    impersonatedBy: null,
  });
  const ADMIN = randomUUID();
  const mcpActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.ownerId,
    role: 'OWNER',
    tool,
    impersonatedBy: ADMIN,
    clientId: 'client-1',
    via: 'mcp',
  });
  /** An actor whose user row does not exist: the foreign key refuses its row. */
  const ghost = (tool: string): AuditActor => ({ userId: randomUUID(), role: 'OWNER', tool });

  const quietly = async <T>(fn: () => Promise<T>) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const value = await fn();
      const misses = logged.mock.calls.filter(c => c[0] === 'audit_miss');
      return { value, misses };
    } finally {
      logged.mockRestore();
    }
  };

  /** A module of `f`'s classroom, made without a row. */
  const makeModule = async (f: Fixture, title = `Week ${++serial}`) =>
    (await moduleService.create(f.classroomId, { title: `${title} ${suite}` }, null)).module;
  const makePage = async (f: Fixture) =>
    prisma.page.create({
      data: {
        classroom_id: f.classroomId,
        title: `Page ${++serial} ${suite}`,
        content_path: `pages/p-${serial}`,
        created_by: f.ownerId,
      },
      select: { id: true },
    });
  const makeAssignment = async (f: Fixture, moduleId: string, position: number) =>
    prisma.assignment.create({
      data: {
        module_id: moduleId,
        type: 'REPO',
        repository_id: f.repositoryId,
        title: `Assignment ${++serial} ${suite}`,
        position,
      },
      select: { id: true },
    });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `moduleaudit-${suite}`,
        login: `ma-${suite}`,
        github_installation_id: `inst-${suite}`,
      },
    });
    orgId = org.id;
    X = await makeClassroom('x');
    Y = await makeClassroom('y');
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });

  describe('module.create', () => {
    it('one row for a web actor: MODULES / CREATE with the title', async () => {
      const { value, rows } = await newRows(X, () =>
        moduleService.create(
          X.classroomId,
          { title: `Week create ${suite}` },
          webActor(X, 'web:modules.create')
        )
      );
      expect(value.audit).toEqual({ written: 1, missed: 0 });
      expect(rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'MODULES',
          resource_id: value.module.id,
          action: 'CREATE',
          data: { tool: 'web:modules.create', title: `Week create ${suite}` },
        },
      ]);
    });

    it('an MCP actor under View as carries via, the client and the admin', async () => {
      const { value, rows } = await newRows(X, () =>
        moduleService.create(
          X.classroomId,
          { title: `Week mcp ${suite}` },
          mcpActor(X, 'module_create')
        )
      );
      expect(rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'MODULES',
          resource_id: value.module.id,
          action: 'CREATE',
          data: {
            via: 'mcp',
            tool: 'module_create',
            title: `Week mcp ${suite}`,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
    });

    it('no row and no throw for actor: null', async () => {
      const { value, rows } = await newRows(X, () =>
        moduleService.create(X.classroomId, { title: `Week null ${suite}` }, null)
      );
      expect(value.audit).toEqual({ written: 0, missed: 0 });
      expect(rows).toEqual([]);
    });

    it('the module stands when its row cannot be written', async () => {
      const { value, misses } = await quietly(() =>
        moduleService.create(
          X.classroomId,
          { title: `Week ghost ${suite}` },
          ghost('web:modules.create')
        )
      );
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(await prisma.module.findUnique({ where: { id: value.module.id } })).not.toBeNull();
    });
  });

  describe('module.updateForClassroom', () => {
    it('records the changed fields and the previous title; a description by name only', async () => {
      const module = await makeModule(X, 'Before');
      const { value, rows } = await newRows(X, () =>
        moduleService.updateForClassroom(
          module.id,
          X.classroomId,
          { title: `After ${suite}`, description: 'A long description of the week.' },
          webActor(X, 'web:modules.update')
        )
      );
      expect(value.audit).toEqual({ written: 1, missed: 0 });
      expect(rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'MODULES',
          resource_id: module.id,
          action: 'UPDATE',
          data: {
            tool: 'web:modules.update',
            title: `After ${suite}`,
            fields: ['title', 'description'],
            previous_title: `Before ${suite}`,
          },
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain('long description');
    });

    it('a save that changes nothing writes no row', async () => {
      const module = await makeModule(X, 'Same');
      const { value, rows } = await newRows(X, () =>
        moduleService.updateForClassroom(
          module.id,
          X.classroomId,
          { title: `Same ${suite}`, description: null },
          webActor(X, 'web:modules.update')
        )
      );
      expect(value.audit).toEqual({ written: 0, missed: 0 });
      expect(rows).toEqual([]);
    });
  });

  describe('module.setPublished / setPublic', () => {
    it('records a flag that changed, and nothing for the value it already has', async () => {
      const module = await makeModule(X);
      const first = await newRows(X, () =>
        moduleService.setPublished(module.id, true, X.classroomId, mcpActor(X, 'module_publish'))
      );
      expect(first.rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'MODULES',
          resource_id: module.id,
          action: 'UPDATE',
          data: {
            via: 'mcp',
            tool: 'module_publish',
            published: true,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
      const again = await newRows(X, () =>
        moduleService.setPublished(module.id, true, X.classroomId, mcpActor(X, 'module_publish'))
      );
      expect(again.value.audit).toEqual({ written: 0, missed: 0 });
      expect(again.rows).toEqual([]);

      const site = await newRows(X, () =>
        moduleService.setPublic(
          module.id,
          true,
          X.classroomId,
          webActor(X, 'web:modules.set_public')
        )
      );
      expect(site.rows.map(r => r.data)).toEqual([
        { tool: 'web:modules.set_public', public: true },
      ]);
      const siteAgain = await newRows(X, () =>
        moduleService.setPublic(
          module.id,
          true,
          X.classroomId,
          webActor(X, 'web:modules.set_public')
        )
      );
      expect(siteAgain.rows).toEqual([]);
    });

    it('refuses a module of another classroom: nothing changes, no row anywhere', async () => {
      const theirs = await makeModule(Y);
      const before = (await rowsIn(Y.classroomId)).length;
      const { rows } = await newRows(X, async () =>
        expect(
          moduleService.setPublished(
            theirs.id,
            true,
            X.classroomId,
            webActor(X, 'web:modules.set_published')
          )
        ).rejects.toThrow('Module not found in classroom')
      );
      expect(rows).toEqual([]);
      expect((await rowsIn(Y.classroomId)).length).toBe(before);
      expect(
        (await prisma.module.findUniqueOrThrow({ where: { id: theirs.id } })).is_published
      ).toBe(false);
    });
  });

  describe('items: add, remove, move', () => {
    it('records an add and a remove with the module, type and target', async () => {
      const module = await makeModule(X);
      const page = await makePage(X);
      const added = await newRows(X, () =>
        moduleService.addItem(
          module.id,
          'PAGE',
          page.id,
          X.classroomId,
          webActor(X, 'web:modules.add_item')
        )
      );
      expect(added.rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'MODULE_ITEM',
          resource_id: added.value.item.id,
          action: 'CREATE',
          data: {
            tool: 'web:modules.add_item',
            module_id: module.id,
            item_type: 'PAGE',
            target_id: page.id,
            position: 0,
          },
        },
      ]);
      const removed = await newRows(X, () =>
        moduleService.removeItem(
          added.value.item.id,
          X.classroomId,
          mcpActor(X, 'module_item_remove')
        )
      );
      expect(removed.rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'MODULE_ITEM',
          resource_id: added.value.item.id,
          action: 'DELETE',
          data: {
            via: 'mcp',
            tool: 'module_item_remove',
            module_id: module.id,
            item_type: 'PAGE',
            target_id: page.id,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
    });

    it('records a move to the end of another module, and a drag across modules', async () => {
      const from = await makeModule(X);
      const to = await makeModule(X);
      const page = await makePage(X);
      const other = await makePage(X);
      const { item } = await moduleService.addItem(from.id, 'PAGE', page.id, X.classroomId, null);
      const { item: there } = await moduleService.addItem(
        to.id,
        'PAGE',
        other.id,
        X.classroomId,
        null
      );

      const end = await newRows(X, () =>
        moduleService.moveItemToModuleEnd(
          item.id,
          to.id,
          X.classroomId,
          mcpActor(X, 'module_item_move')
        )
      );
      expect(end.rows.map(r => [r.resource_type, r.resource_id, r.action, r.data])).toEqual([
        [
          'MODULE_ITEM',
          item.id,
          'UPDATE',
          {
            via: 'mcp',
            tool: 'module_item_move',
            module_id: to.id,
            from_module_id: from.id,
            position: 1,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        ],
      ]);

      // The drag back, to the top of `from`: the move's row only.
      const drag = await newRows(X, () =>
        moduleService.moveItemToModule(
          item.id,
          from.id,
          [item.id],
          X.classroomId,
          webActor(X, 'web:modules.move_item')
        )
      );
      expect(drag.rows.map(r => r.data)).toEqual([
        { tool: 'web:modules.move_item', module_id: from.id, from_module_id: to.id, position: 0 },
      ]);
      // A drag within one module is a reorder.
      const { item: second } = await moduleService.addItem(
        from.id,
        'PAGE',
        other.id,
        X.classroomId,
        null
      );
      const within = await newRows(X, () =>
        moduleService.moveItemToModule(
          second.id,
          from.id,
          [second.id, item.id],
          X.classroomId,
          webActor(X, 'web:modules.move_item')
        )
      );
      expect(within.rows.map(r => [r.resource_type, r.resource_id, r.data])).toEqual([
        [
          'MODULES',
          from.id,
          {
            tool: 'web:modules.move_item',
            kind: 'ITEMS',
            count: 2,
            moved_count: 1,
            moved: [{ id: second.id, position: 0, previous_position: 1 }],
          },
        ],
      ]);
      expect(there.id).toBeTruthy();
    });
  });

  describe('reorders', () => {
    it('names the moved row and its place, not the list; the same order again writes none', async () => {
      const module = await makeModule(X);
      const pages = await Promise.all([makePage(X), makePage(X), makePage(X), makePage(X)]);
      const items: string[] = [];
      for (const page of pages) {
        items.push(
          (await moduleService.addItem(module.id, 'PAGE', page.id, X.classroomId, null)).item.id
        );
      }
      const [a, b, c, d] = items;
      // d dragged to the top: the others shift a place, d is what moved.
      const first = await newRows(X, () =>
        moduleService.reorderItems(
          module.id,
          [d, a, b, c],
          X.classroomId,
          webActor(X, 'web:modules.reorder_items')
        )
      );
      expect(first.rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'MODULES',
          resource_id: module.id,
          action: 'UPDATE',
          data: {
            tool: 'web:modules.reorder_items',
            kind: 'ITEMS',
            count: 4,
            moved_count: 1,
            moved: [{ id: d, position: 0, previous_position: 3 }],
          },
        },
      ]);
      const again = await newRows(X, () =>
        moduleService.reorderItems(
          module.id,
          [d, a, b, c],
          X.classroomId,
          webActor(X, 'web:modules.reorder_items')
        )
      );
      expect(again.value.audit).toEqual({ written: 0, missed: 0 });
      expect(again.rows).toEqual([]);
    });

    it('bounds a large reorder to the moved rows it can name', async () => {
      const modules: string[] = [];
      const Z = await makeClassroom(`z${serial}`);
      for (let i = 0; i < REORDER_AUDIT_MAX_MOVED * 2 + 2; i++)
        modules.push((await makeModule(Z)).id);
      const reversed = [...modules].reverse();
      const { rows } = await newRows(Z, () =>
        moduleService.reorderModules(Z.classroomId, reversed, mcpActor(Z, 'module_reorder'))
      );
      expect(rows).toHaveLength(1);
      const data = rows[0].data as { count: number; moved_count: number; moved: unknown[] };
      expect(rows[0].resource_id).toBeNull();
      expect(data.count).toBe(modules.length);
      expect(data.moved_count).toBe(modules.length - 1);
      expect(data.moved).toHaveLength(REORDER_AUDIT_MAX_MOVED);
      expect(JSON.stringify(data)).not.toContain('ordered_ids');
    });

    it('records an assignment reorder and a move between modules', async () => {
      const from = await makeModule(X);
      const to = await makeModule(X);
      const one = await makeAssignment(X, from.id, 0);
      const two = await makeAssignment(X, from.id, 1);
      const reorder = await newRows(X, () =>
        assignmentService.reorderInModule(
          from.id,
          [two.id, one.id],
          X.classroomId,
          webActor(X, 'web:modules.reorder_assignments')
        )
      );
      expect(reorder.rows.map(r => [r.resource_type, r.resource_id, r.data])).toEqual([
        [
          'MODULES',
          from.id,
          {
            tool: 'web:modules.reorder_assignments',
            kind: 'ASSIGNMENTS',
            count: 2,
            moved_count: 1,
            moved: [{ id: two.id, position: 0, previous_position: 1 }],
          },
        ],
      ]);
      const move = await newRows(X, () =>
        assignmentService.moveToModule(
          one.id,
          to.id,
          [one.id],
          X.classroomId,
          webActor(X, 'web:modules.move_assignment')
        )
      );
      expect(move.rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'ASSIGNMENT',
          resource_id: one.id,
          action: 'UPDATE',
          data: {
            tool: 'web:modules.move_assignment',
            fields: ['module_id'],
            values: { module_id: to.id },
            from_module_id: from.id,
            value: JSON.stringify({ module_id: to.id, from_module_id: from.id }),
            position: 0,
          },
        },
      ]);
    });
  });

  describe('module.deleteById', () => {
    it('records what the module was, every item row that went, for the actor', async () => {
      const module = await makeModule(X, 'Doomed');
      await moduleService.setPublished(module.id, true, X.classroomId, null);
      const page = await makePage(X);
      await moduleService.addItem(module.id, 'PAGE', page.id, X.classroomId, null);
      const { value, rows } = await newRows(X, () =>
        moduleService.deleteById(module.id, X.classroomId, {}, mcpActor(X, 'module_delete'))
      );
      expect(value.audit).toEqual({ written: 1, missed: 0 });
      expect(rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'MODULES',
          resource_id: module.id,
          action: 'DELETE',
          data: {
            via: 'mcp',
            tool: 'module_delete',
            title: `Doomed ${suite}`,
            slug: module.slug,
            was_published: true,
            items_removed: 1,
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
    });

    it('owner A of classroom X cannot delete owner B’s module of Y; B’s delete is B’s row in Y', async () => {
      const theirs = await makeModule(Y, 'Theirs');
      const beforeX = (await rowsIn(X.classroomId)).length;
      await expect(
        moduleService.deleteById(theirs.id, X.classroomId, {}, webActor(X, 'web:modules.delete'))
      ).rejects.toThrow('Module not found in classroom');
      expect(await prisma.module.findUnique({ where: { id: theirs.id } })).not.toBeNull();
      expect((await rowsIn(X.classroomId)).length).toBe(beforeX);

      const { rows } = await newRows(Y, () =>
        moduleService.deleteById(theirs.id, Y.classroomId, {}, webActor(Y, 'web:modules.delete'))
      );
      expect(rows.map(r => [r.user_id, r.classroom_id, r.action])).toEqual([
        [Y.ownerId, Y.classroomId, 'DELETE'],
      ]);
      // Nothing of Y's delete reached X.
      expect((await rowsIn(X.classroomId)).length).toBe(beforeX);
      expect(JSON.stringify(await rowsIn(X.classroomId))).not.toContain(theirs.id);
    });

    it('a delete with actor: null writes no row; one whose row fails still deletes', async () => {
      const quiet = await makeModule(X);
      const nulled = await newRows(X, () =>
        moduleService.deleteById(quiet.id, X.classroomId, {}, null)
      );
      expect(nulled.rows).toEqual([]);
      const lost = await makeModule(X);
      const { value } = await quietly(() =>
        moduleService.deleteById(lost.id, X.classroomId, {}, ghost('web:modules.delete'))
      );
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(await prisma.module.findUnique({ where: { id: lost.id } })).toBeNull();
    });
  });
});
