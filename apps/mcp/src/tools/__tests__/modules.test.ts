/**
 * Unit tests for the module (curriculum) tool batch — module_create /
 * module_update / module_publish / module_item_add / module_delete /
 * module_reorder.
 *
 * The focus is the FIFTH item type. `ModuleItemType` gained `FORM`, and a
 * module item that links a form is the one place the curriculum surface touches
 * a Pro-only feature, so three things have to hold at once:
 *
 *   - S4 role parity: all four tools are OWNER-only (requireClassroomAdmin,
 *     admin.$class.modules), FORM included. Attaching a form does not widen the
 *     tier to the forms batch's OWNER|TEACHER — it is still a curriculum edit.
 *   - The Pro gate runs on the FORM BRANCH ONLY. A free-tier classroom must
 *     keep adding pages and slides; it must not be able to attach a form. A
 *     quiz is not an item at all: it sits in a module through its assignment
 *     (quiz_create / quiz_update module_id), so QUIZ is not offered.
 *   - S1: a form belonging to another classroom is refused by
 *     `module.service.assertTargetInClassroom` with a generic Error, and this
 *     layer must translate it into the same uniform `not_found` every other
 *     scoped tool raises — never "that form is in classroom X".
 *
 * Only the service boundary and the platform Pro gate are mocked; these tools
 * fire no external effects. Enum-level rules are asserted against
 * `tool.inputSchema` itself, because the registry/SDK validates arguments
 * BEFORE the handler runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolError } from '../../mcp/errors.ts';
import { toolAnnotations, type ToolContext, type ToolDefinition } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  assertProTier: vi.fn(),
  quizzesVisible: vi.fn(),
  moduleCreate: vi.fn(),
  moduleUpdateForClassroom: vi.fn(),
  moduleSetPublished: vi.fn(),
  moduleAddItem: vi.fn(),
  moduleFindById: vi.fn(),
  moduleDeleteById: vi.fn(),
  moduleListContents: vi.fn(),
  moduleReorderModules: vi.fn(),
  moduleReorderItems: vi.fn(),
  assignmentReorderInModule: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    module: {
      create: (...a: unknown[]) => mocks.moduleCreate(...a),
      updateForClassroom: (...a: unknown[]) => mocks.moduleUpdateForClassroom(...a),
      setPublished: (...a: unknown[]) => mocks.moduleSetPublished(...a),
      addItem: (...a: unknown[]) => mocks.moduleAddItem(...a),
      findById: (...a: unknown[]) => mocks.moduleFindById(...a),
      deleteById: (...a: unknown[]) => mocks.moduleDeleteById(...a),
      listModuleContentsForClassroom: (...a: unknown[]) => mocks.moduleListContents(...a),
      reorderModules: (...a: unknown[]) => mocks.moduleReorderModules(...a),
      reorderItems: (...a: unknown[]) => mocks.moduleReorderItems(...a),
    },
    assignment: {
      reorderInModule: (...a: unknown[]) => mocks.assignmentReorderInModule(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    entitlement: { quizzesVisible: (...a: unknown[]) => mocks.quizzesVisible(...a) },
  },
}));

const {
  moduleCreateTool,
  moduleUpdateTool,
  modulePublishTool,
  moduleItemAddTool,
  moduleDeleteTool,
  moduleReorderTool,
} = await import('../modules.ts');

const ALL_TOOLS: ToolDefinition<never>[] = [
  moduleCreateTool,
  moduleUpdateTool,
  modulePublishTool,
  moduleItemAddTool,
  moduleDeleteTool,
  moduleReorderTool,
] as unknown as ToolDefinition<never>[];

/** OWNER authorized in `class-1`, whose classroom slug is `w26`. */
const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { slug: 'w26', settings: {} },
  },
} as unknown as ToolContext;

const MODULE_ROW = {
  id: 'mod-1',
  classroom_id: 'class-1',
  title: 'Week 3: Recursion',
  slug: 'week-3-recursion',
  description: null,
  position: 0,
  is_published: false,
};

const ITEM_ROW = { id: 'item-1', item_type: 'FORM', position: 3 };

/** The generic Error `module.service.assertTargetInClassroom` throws (S1). */
const foreignTarget = () => new Error('Module item target not found in classroom');

/** The 403 the lifted platform gate throws for a non-Pro classroom. */
const proDenial = () => new Response('This feature requires a Pro subscription', { status: 403 });

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertProTier.mockResolvedValue(undefined);
  mocks.quizzesVisible.mockResolvedValue(true);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.moduleCreate.mockResolvedValue(MODULE_ROW);
  mocks.moduleUpdateForClassroom.mockResolvedValue(MODULE_ROW);
  mocks.moduleSetPublished.mockResolvedValue({ ...MODULE_ROW, is_published: true });
  mocks.moduleAddItem.mockResolvedValue(ITEM_ROW);
});

// ─── Definition-level guarantees (the registry enforces these pre-handler) ───

describe('module tool definitions', () => {
  it('gates every tool on OWNER — the requireClassroomAdmin tier', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.roles).toEqual(['OWNER']);
    }
  });

  it('does not widen module_item_add to the forms tier just because FORM exists', () => {
    expect(moduleItemAddTool.roles).not.toContain('TEACHER');
    expect(moduleItemAddTool.roles).not.toContain('ASSISTANT');
    expect(moduleItemAddTool.roles).not.toContain('STUDENT');
  });

  it('accepts the content item types (and REPOSITORY, to refuse it by name) and nothing else', () => {
    const itemType = moduleItemAddTool.inputSchema.item_type as z.ZodTypeAny;
    for (const type of ['PAGE', 'REPOSITORY', 'SLIDE', 'FORM']) {
      expect(itemType.safeParse(type).success, type).toBe(true);
    }
    // QUIZ is not offered: a quiz is placed by its assignment's module.
    for (const bogus of ['QUIZ', 'ASSIGNMENT', 'form', 'Form', '', 'GRADE']) {
      expect(itemType.safeParse(bogus).success, bogus).toBe(false);
    }
    expect(itemType.safeParse(undefined).success).toBe(false);
  });

  it('names forms in the tool description, with the Pro requirement', () => {
    expect(moduleItemAddTool.description).toContain('form');
    expect(moduleItemAddTool.description).toContain('Pro subscription');
    expect(moduleItemAddTool.inputSchema.target_id.description).toContain('form');
  });

  /**
   * `idempotent` means "repeating the call with the same args has no
   * ADDITIONAL effect" (mcp/registry.ts). The unique (module_id, target_id)
   * constraint is what makes that true here: a second identical call cannot
   * append the same content twice — it is refused as a duplicate.
   */
  it('declares honest annotations on module_item_add', () => {
    expect(moduleItemAddTool.annotations).toEqual({
      destructive: false,
      idempotent: true,
      openWorld: false,
    });
    expect(toolAnnotations(moduleItemAddTool as unknown as ToolDefinition<never>)).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });
});

// ─── module_item_add: FORM ──────────────────────────────────────────────────

describe('module_item_add with a FORM target', () => {
  const ARGS = {
    classroom: 'org/w26',
    module_id: 'mod-1',
    item_type: 'FORM' as const,
    target_id: 'form-1',
  };

  it('passes FORM, the form id and the AUTHORIZED classroom id to the service', async () => {
    const payload = parse(await moduleItemAddTool.handler(ARGS as never, CTX));

    expect(mocks.moduleAddItem).toHaveBeenCalledWith('mod-1', 'FORM', 'form-1', 'class-1');
    expect(payload).toEqual({
      success: true,
      item: { id: 'item-1', item_type: 'FORM', position: 3 },
    });
  });

  it('scopes to the ctx classroom, never to the classroom argument', async () => {
    await moduleItemAddTool.handler({ ...ARGS, classroom: 'other-org/other' } as never, CTX);
    expect(mocks.moduleAddItem.mock.calls[0][3]).toBe('class-1');
  });

  it('writes the MODULE_ITEM audit row with the item type and target', async () => {
    await moduleItemAddTool.handler(ARGS as never, CTX);

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      user_id: string;
      classroom_id: string;
      role: string;
      resource_type: string;
      resource_id: string;
      data: { tool: string; module_id: string; item_type: string; target_id: string };
    };
    expect(audit).toMatchObject({
      action: 'CREATE',
      user_id: 'owner-1',
      classroom_id: 'class-1',
      role: 'OWNER',
      resource_type: 'MODULE_ITEM',
      resource_id: 'item-1',
    });
    expect(audit.data).toEqual({
      tool: 'module_item_add',
      module_id: 'mod-1',
      item_type: 'FORM',
      target_id: 'form-1',
    });
  });

  it('reports a second identical add as a duplicate, not a silent success', async () => {
    // What Prisma raises against the unique (module_id, target_id) index — the
    // constraint the `idempotent: true` annotation rests on.
    mocks.moduleAddItem.mockRejectedValue(
      Object.assign(new Error('Unique constraint'), {
        code: 'P2002',
      })
    );

    const error = await moduleItemAddTool.handler(ARGS as never, CTX).catch(e => e);
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).kind).toBe('invalid_params');
    expect((error as ToolError).message).toContain('Duplicate');
    // A refused write is not an event.
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

// ─── S1: cross-classroom scoping ────────────────────────────────────────────

describe('cross-classroom scoping (S1)', () => {
  /**
   * A form that exists — in SOMEBODY ELSE'S classroom.
   *
   * `module.service` refuses it (assertTargetInClassroom's
   * `prisma.form.findFirst({ id, classroom_id })` finds nothing) and throws a
   * generic Error. What is pinned here is this layer's half: the caller learns
   * only that the target is not in THEIR classroom — the same sentence an id
   * that exists nowhere at all produces.
   */
  it('refuses a form from another classroom without leaking that it exists', async () => {
    mocks.moduleAddItem.mockRejectedValue(foreignTarget());

    const error = await moduleItemAddTool
      .handler(
        {
          classroom: 'org/w26',
          module_id: 'mod-1',
          item_type: 'FORM',
          target_id: 'form-in-class-2',
        } as never,
        CTX
      )
      .catch(e => e);

    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).kind).toBe('not_found');
    expect((error as ToolError).message).toBe('Item target not found in this classroom');
    // Nothing names the other classroom, the form, or its owner.
    expect((error as ToolError).message).not.toContain('form-in-class-2');
    expect((error as ToolError).message).not.toContain('class-2');
    // And a refused add writes no audit row claiming the module changed.
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses REPOSITORY before any lookup: repos are attached to assignments', async () => {
    const error = await moduleItemAddTool
      .handler(
        {
          classroom: 'org/w26',
          module_id: 'mod-1',
          item_type: 'REPOSITORY',
          target_id: 'repo-1',
        } as never,
        CTX
      )
      .catch(e => e);
    expect((error as ToolError).kind).toBe('invalid_params');
    // The caller usually holds a lab that already HAS its assignment, so the
    // message leads with the move. assignment_create is named only as the way
    // to make a new one: followed blindly it adds a second gradebook entry.
    const message = (error as ToolError).message;
    expect(message).toMatch(/existing assignment.*assignment_update\s+with module_id/s);
    expect(message).toMatch(/assignment_create only for a NEW assignment/);
    expect(message.indexOf('assignment_update')).toBeLessThan(message.indexOf('assignment_create'));
    expect(mocks.moduleAddItem).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('points at the move wherever the tool list mentions REPOSITORY', () => {
    const itemType = z.object(moduleItemAddTool.inputSchema).shape.item_type;
    for (const text of [moduleItemAddTool.description, itemType.description ?? '']) {
      expect(text).toMatch(/REPOSITORY is refused/);
      expect(text).toMatch(/assignment_update/);
      expect(text).toMatch(/module_id/);
    }
    // A module is no longer described as a list that holds repos.
    expect(moduleCreateTool.description).not.toMatch(/repos/);
    expect(moduleCreateTool.description).toMatch(/assignment_update with module_id/);
  });

  it('gives every content item type the identical refusal (FORM is not special)', async () => {
    const messages: string[] = [];
    for (const item_type of ['PAGE', 'QUIZ', 'SLIDE', 'FORM']) {
      mocks.moduleAddItem.mockRejectedValue(foreignTarget());
      const error = await moduleItemAddTool
        .handler(
          { classroom: 'org/w26', module_id: 'mod-1', item_type, target_id: 'elsewhere' } as never,
          CTX
        )
        .catch(e => e);
      expect((error as ToolError).kind, item_type).toBe('not_found');
      messages.push((error as ToolError).message);
    }
    expect(new Set(messages).size).toBe(1);
  });

  it('refuses a module from another classroom the same way', async () => {
    mocks.moduleAddItem.mockRejectedValue(new Error('Module not found in classroom'));
    const error = await moduleItemAddTool
      .handler(
        {
          classroom: 'org/w26',
          module_id: 'mod-x',
          item_type: 'FORM',
          target_id: 'form-1',
        } as never,
        CTX
      )
      .catch(e => e);
    expect((error as ToolError).kind).toBe('not_found');
    expect((error as ToolError).message).toBe('Module not found in this classroom');
  });

  it('does not swallow an unexpected failure as a scoping refusal', async () => {
    mocks.moduleAddItem.mockRejectedValue(new Error('connection reset'));
    const error = await moduleItemAddTool
      .handler(
        {
          classroom: 'org/w26',
          module_id: 'mod-1',
          item_type: 'FORM',
          target_id: 'form-1',
        } as never,
        CTX
      )
      .catch(e => e);
    expect(error).not.toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe('connection reset');
  });
});

// ─── The Pro gate, on the FORM branch only ──────────────────────────────────

describe('Pro gating of FORM items', () => {
  it('refuses a FORM item in a non-Pro classroom, before touching the service', async () => {
    mocks.assertProTier.mockRejectedValue(proDenial());

    const error = await moduleItemAddTool
      .handler(
        {
          classroom: 'org/w26',
          module_id: 'mod-1',
          item_type: 'FORM',
          target_id: 'form-1',
        } as never,
        CTX
      )
      .catch(e => e);

    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).kind).toBe('forbidden');
    expect((error as ToolError).message).toBe('This feature requires a Pro subscription');
    // The gate refused it: no item row, no audit row.
    expect(mocks.moduleAddItem).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('still adds a PAGE and a SLIDE in that same non-Pro classroom', async () => {
    mocks.assertProTier.mockRejectedValue(proDenial());
    mocks.quizzesVisible.mockResolvedValue(false);

    for (const item_type of ['PAGE', 'SLIDE']) {
      mocks.moduleAddItem.mockClear();
      mocks.assertProTier.mockClear();
      mocks.moduleAddItem.mockResolvedValue({ ...ITEM_ROW, item_type });

      const payload = parse(
        await moduleItemAddTool.handler(
          { classroom: 'org/w26', module_id: 'mod-1', item_type, target_id: 'target-1' } as never,
          CTX
        )
      );

      expect(payload.success, item_type).toBe(true);
      expect(mocks.moduleAddItem).toHaveBeenCalledWith('mod-1', item_type, 'target-1', 'class-1');
      // The branch is what proves the gates are scoped: a page or slide never
      // even asks either of them.
      expect(mocks.assertProTier, item_type).not.toHaveBeenCalled();
      expect(mocks.quizzesVisible, item_type).not.toHaveBeenCalled();
    }
  });

  it('asks the gate about the AUTHORIZED classroom slug, never an argument', async () => {
    await moduleItemAddTool.handler(
      {
        classroom: 'other-org/some-other-slug',
        module_id: 'mod-1',
        item_type: 'FORM',
        target_id: 'form-1',
      } as never,
      CTX
    );
    expect(mocks.assertProTier).toHaveBeenCalledWith('w26');
    expect(mocks.assertProTier).not.toHaveBeenCalledWith('some-other-slug');
  });

  it('leaves the other three module tools ungated (they touch no Pro surface)', async () => {
    mocks.assertProTier.mockRejectedValue(proDenial());

    await moduleCreateTool.handler({ classroom: 'org/w26', title: 'Week 4' } as never, CTX);
    await moduleUpdateTool.handler(
      { classroom: 'org/w26', module_id: 'mod-1', title: 'Week 4' } as never,
      CTX
    );
    await modulePublishTool.handler(
      { classroom: 'org/w26', module_id: 'mod-1', published: true } as never,
      CTX
    );

    expect(mocks.assertProTier).not.toHaveBeenCalled();
    expect(mocks.moduleCreate).toHaveBeenCalled();
    expect(mocks.moduleUpdateForClassroom).toHaveBeenCalled();
    expect(mocks.moduleSetPublished).toHaveBeenCalled();
  });
});

// ─── Quizzes are not module items ──────────────────────────────────────────

describe('module_item_add and quizzes', () => {
  it('points a quiz at its own module_id in the description, and asks nothing about quizzes', async () => {
    expect(moduleItemAddTool.description).toContain('A quiz is placed by its own module_id');
    expect(moduleItemAddTool.inputSchema.target_id.description).not.toMatch(/quiz/);
    expect(Buffer.byteLength(moduleItemAddTool.description, 'utf8')).toBeLessThan(1500);

    await moduleItemAddTool.handler(
      { classroom: 'org/w26', module_id: 'mod-1', item_type: 'PAGE', target_id: 'page-1' } as never,
      CTX
    );
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
  });
});

// ─── module_delete ──────────────────────────────────────────────────────────

describe('module_delete', () => {
  const ARGS = { classroom: 'org/w26', module_id: 'mod-1' };
  const lab = { id: 'asg-lab', title: 'Lab 1', type: 'REPO' };
  const quizAssignment = { id: 'asg-quiz', title: 'Midterm quiz', type: 'QUIZ' };
  const pageItem = { id: 'i-page', item_type: 'PAGE' };
  const quizItem = { id: 'i-quiz', item_type: 'QUIZ' };

  /** The module as module.findById loads it (DETAIL_INCLUDE). */
  const owning = (
    assignments: Array<{ id: string; title: string; type: string }>,
    items: Array<{ id: string; item_type: string }> = []
  ) => ({ ...MODULE_ROW, title: 'starterpack', slug: 'starterpack', assignments, items });

  const run = () => moduleDeleteTool.handler(ARGS as never, CTX);
  const refusal = async () => (await run().catch(e => e)) as ToolError;

  beforeEach(() => {
    mocks.moduleFindById.mockResolvedValue(owning([]));
    mocks.moduleDeleteById.mockResolvedValue({ id: 'mod-1', deleted_quiz_assignment_ids: [] });
  });

  it('is destructive, closed-world, and says what goes and what stays', () => {
    expect(toolAnnotations(moduleDeleteTool as unknown as ToolDefinition<never>)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    const text = moduleDeleteTool.description;
    expect(text).toMatch(/owns no assignments/);
    expect(text).toMatch(/assignment_update with module_id/);
    expect(text).toMatch(/CANNOT BE UNDONE/);
    expect(text).toMatch(/themselves are untouched/);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(1500);
    expect(
      z.object(moduleDeleteTool.inputSchema).safeParse({ ...ARGS, module_id: 'x' }).success
    ).toBe(false);
  });

  it('deletes a module that owns no assignments, scoped to the AUTHORIZED classroom', async () => {
    const payload = parse(await run());

    expect(mocks.moduleFindById).toHaveBeenCalledWith('mod-1');
    expect(mocks.moduleDeleteById).toHaveBeenCalledWith('mod-1', 'class-1', {
      quizzesHidden: false,
    });
    expect(payload).toEqual({
      success: true,
      deleted_module_id: 'mod-1',
      title: 'starterpack',
      items_removed: 0,
    });
  });

  it('takes the content items with it and counts them: they are only links', async () => {
    mocks.moduleFindById.mockResolvedValue(
      owning([], [pageItem, { id: 'i-2', item_type: 'SLIDE' }])
    );

    const payload = parse(await run());

    expect(payload.items_removed).toBe(2);
    expect(mocks.moduleDeleteById).toHaveBeenCalledTimes(1);
  });

  it('audits the delete with what the module was', async () => {
    mocks.moduleFindById.mockResolvedValue({ ...owning([], [pageItem]), is_published: true });

    await run();

    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      resource_type: 'MODULES',
      resource_id: 'mod-1',
      action: 'DELETE',
      data: {
        tool: 'module_delete',
        title: 'starterpack',
        slug: 'starterpack',
        was_published: true,
        items_removed: 1,
      },
    });
  });

  it('refuses a module that still owns assignments, names them, and deletes nothing', async () => {
    mocks.moduleFindById.mockResolvedValue(
      owning([lab, { id: 'a2', title: 'Lab 2', type: 'REPO' }])
    );

    const error = await refusal();

    // Deleting would cascade into their submissions and grades.
    expect(error).toMatchObject({ kind: 'invalid_params', code: 'MODULE_HAS_ASSIGNMENTS' });
    expect(error.message).toMatch(/still owns 2 assignment\(s\)/);
    expect(error.message).toMatch(/assignment_update with module_id/);
    expect(error.data).toEqual({
      assignments: [
        { id: 'asg-lab', title: 'Lab 1', type: 'REPO' },
        { id: 'a2', title: 'Lab 2', type: 'REPO' },
      ],
    });
    expect(mocks.moduleDeleteById).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'in another classroom',
      { ...MODULE_ROW, classroom_id: 'class-2', assignments: [], items: [] },
    ],
    ['that does not exist', null],
  ])('refuses a module %s with the uniform not_found (S1)', async (_label, module) => {
    mocks.moduleFindById.mockResolvedValue(module);

    const error = await refusal();

    expect(error).toMatchObject({
      kind: 'not_found',
      message: 'Module not found in this classroom',
    });
    expect(mocks.moduleDeleteById).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  describe('where the classroom shows no quizzes', () => {
    beforeEach(() => {
      mocks.quizzesVisible.mockResolvedValue(false);
    });

    it('deletes a module held back by quiz assignments alone, with them, saying nothing of them', async () => {
      // The owner cannot see them: as on the web, they go with the module (the
      // quizzes and attempts stay, in no module) and only the audit row names
      // them.
      mocks.moduleFindById.mockResolvedValue(owning([quizAssignment], [pageItem]));
      mocks.moduleDeleteById.mockResolvedValue({
        id: 'mod-1',
        deleted_quiz_assignment_ids: ['asg-quiz'],
      });

      const payload = parse(await run());

      expect(mocks.moduleDeleteById).toHaveBeenCalledWith('mod-1', 'class-1', {
        quizzesHidden: true,
      });
      expect(payload).toEqual({
        success: true,
        deleted_module_id: 'mod-1',
        title: 'starterpack',
        items_removed: 1,
      });
      expect(JSON.stringify(payload)).not.toMatch(/quiz/i);
      expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
        data: { tool: 'module_delete', quiz_assignment_ids: ['asg-quiz'] },
      });
    });

    it.each([['a quiz assignment beside a listed one', [lab, quizAssignment]]])(
      'refuses a module held back by %s without naming any',
      async (_label, assignments) => {
        mocks.moduleFindById.mockResolvedValue(owning(assignments));

        const error = await refusal();

        // The Modules page's own line: moving the listed assignments could never
        // unblock it, and nothing here may say a quiz exists.
        expect(error.kind).toBe('invalid_params');
        expect(error.message).toBe('This module can’t be deleted.');
        // Nothing that reaches the client says why: the web's own bar for this
        // refusal (quizVisibility.test.ts) is no quiz, no assignment, no "hidden".
        expect(error.code).toBeUndefined();
        expect(error.data).toBeUndefined();
        expect(JSON.stringify({ m: error.message, c: error.code, d: error.data })).not.toMatch(
          /quiz|assignment|hidden/i
        );
        expect(mocks.quizzesVisible).toHaveBeenCalledWith('class-1');
        expect(mocks.moduleDeleteById).not.toHaveBeenCalled();
      }
    );
  });

  it('leaves a legacy QUIZ item out of the count it reports, not out of the audit row', async () => {
    // A quiz is in a module through its assignment; the old item is listed
    // for nobody, whether or not the classroom shows quizzes.
    mocks.moduleFindById.mockResolvedValue(owning([], [pageItem, quizItem]));

    const payload = parse(await run());

    expect(payload.items_removed).toBe(1);
    expect(
      (mocks.auditCreate.mock.calls[0][0] as { data: { items_removed: number } }).data.items_removed
    ).toBe(2);
  });

  it('names a quiz assignment where quizzes are visible', async () => {
    mocks.moduleFindById.mockResolvedValue(owning([quizAssignment]));

    const error = await refusal();

    expect(error.message).toMatch(/still owns 1 assignment/);
    expect(error.data).toEqual({
      assignments: [{ id: 'asg-quiz', title: 'Midterm quiz', type: 'QUIZ' }],
    });
  });

  it('asks about quizzes only when the module holds a quiz assignment', async () => {
    mocks.moduleFindById.mockResolvedValue(owning([], [pageItem, quizItem]));
    await run();
    expect(mocks.quizzesVisible).not.toHaveBeenCalled();
  });

  it('reports an assignment that arrived during the delete, and deletes nothing', async () => {
    // The service re-checks under its lock; the read above saw an empty module.
    mocks.moduleDeleteById.mockRejectedValue(new Error('Module still has assignments'));

    const error = await refusal();

    expect(error).toMatchObject({ kind: 'invalid_params', code: 'MODULE_HAS_ASSIGNMENTS' });
    expect(error.message).toMatch(/moved into this module while the delete ran/);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('gives the uniform not_found when the module vanished before the delete', async () => {
    mocks.moduleDeleteById.mockRejectedValue(new Error('Module not found in classroom'));

    expect(await refusal()).toMatchObject({
      kind: 'not_found',
      message: 'Module not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('does not swallow an unexpected failure, and writes no audit row for it', async () => {
    mocks.moduleDeleteById.mockRejectedValue(new Error('connection lost'));

    await expect(run()).rejects.toThrow('connection lost');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('is not Pro-gated: a free classroom can clear out its modules', async () => {
    mocks.assertProTier.mockRejectedValue(proDenial());
    expect(parse(await run()).success).toBe(true);
    expect(mocks.assertProTier).not.toHaveBeenCalled();
  });
});

// ─── module_reorder ─────────────────────────────────────────────────────────

describe('module_reorder', () => {
  // Real-looking ids: the schema takes uuids only.
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const [A, B, C, Q, LEGACY, STRANGER] = [1, 2, 3, 4, 5, 9].map(uuid);
  const MODULE_ID = uuid(100);

  /** The module as module.findById loads it (DETAIL_INCLUDE), in display order. */
  const MODULE = {
    ...MODULE_ROW,
    id: MODULE_ID,
    assignments: [
      { id: A, title: 'Lab 1', type: 'REPO' },
      { id: Q, title: 'Midterm quiz', type: 'QUIZ' },
      { id: B, title: 'Lab 2', type: 'REPO' },
      { id: C, title: 'Team prefs', type: 'FORM' },
    ],
    items: [
      { id: A, item_type: 'PAGE', page: { title: 'Intro', classroom_id: 'class-1' } },
      {
        id: LEGACY,
        item_type: 'REPOSITORY',
        repository: { title: 'starterpack', classroom_id: 'class-1' },
      },
      { id: Q, item_type: 'QUIZ', quiz: { name: 'Warm-up quiz', classroom_id: 'class-1' } },
      { id: B, item_type: 'SLIDE', slide: { title: 'Deck', classroom_id: 'class-1' } },
      { id: C, item_type: 'FORM', form: { title: 'Survey', classroom_id: 'class-1' } },
    ],
  };

  const run = (args: Record<string, unknown>) =>
    moduleReorderTool.handler({ classroom: 'org/w26', ...args } as never, CTX);
  const refusal = async (args: Record<string, unknown>) =>
    (await run(args).catch(e => e)) as ToolError;
  const noWrite = () => {
    expect(mocks.assignmentReorderInModule).not.toHaveBeenCalled();
    expect(mocks.moduleReorderItems).not.toHaveBeenCalled();
    expect(mocks.moduleReorderModules).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    mocks.moduleFindById.mockResolvedValue(MODULE);
    mocks.moduleListContents.mockResolvedValue([
      { id: A, title: 'Week 1' },
      { id: B, title: 'Week 2' },
      { id: C, title: 'Week 3' },
    ]);
  });

  it('is an idempotent, non-destructive write with a description that fits', () => {
    expect(toolAnnotations(moduleReorderTool as unknown as ToolDefinition<never>)).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(Buffer.byteLength(moduleReorderTool.description, 'utf8')).toBeLessThan(1500);
    expect(moduleReorderTool.description).toMatch(/WHOLE list/);
    expect(moduleReorderTool.description).toMatch(/not its target_id/);
  });

  it('takes one of three kinds and a non-empty list of uuids', () => {
    const schema = z.object(moduleReorderTool.inputSchema);
    const base = { classroom: 'org/w26', kind: 'ASSIGNMENTS', module_id: MODULE_ID };
    expect(schema.safeParse({ ...base, ordered_ids: [A, B] }).success).toBe(true);
    expect(
      schema.safeParse({ classroom: 'org/w26', kind: 'MODULES', ordered_ids: [A] }).success
    ).toBe(true);
    expect(schema.safeParse({ ...base, ordered_ids: [] }).success).toBe(false);
    expect(schema.safeParse({ ...base, ordered_ids: ['lab-1'] }).success).toBe(false);
    expect(schema.safeParse({ ...base, kind: 'PAGES', ordered_ids: [A] }).success).toBe(false);
    expect(schema.safeParse({ ...base, kind: 'assignments', ordered_ids: [A] }).success).toBe(
      false
    );
  });

  describe('ASSIGNMENTS', () => {
    const args = (ordered_ids: string[]) => ({
      kind: 'ASSIGNMENTS',
      module_id: MODULE_ID,
      ordered_ids,
    });

    it('hands the module’s full list to assignment.reorderInModule, scoped to the classroom', async () => {
      const payload = parse(await run(args([C, B, Q, A])));

      expect(mocks.assignmentReorderInModule).toHaveBeenCalledWith(
        MODULE_ID,
        [C, B, Q, A],
        'class-1'
      );
      expect(mocks.moduleReorderItems).not.toHaveBeenCalled();
      expect(payload).toEqual({
        success: true,
        kind: 'ASSIGNMENTS',
        module_id: MODULE_ID,
        order: [
          { id: C, title: 'Team prefs' },
          { id: B, title: 'Lab 2' },
          { id: Q, title: 'Midterm quiz' },
          { id: A, title: 'Lab 1' },
        ],
      });
    });

    it('audits the new order', async () => {
      await run(args([C, B, Q, A]));

      expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
      expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
        resource_type: 'MODULES',
        resource_id: MODULE_ID,
        action: 'UPDATE',
        data: {
          tool: 'module_reorder',
          kind: 'ASSIGNMENTS',
          ordered_ids: [C, B, Q, A],
          value: `ASSIGNMENTS:${[C, B, Q, A].join(',')}`,
        },
      });
    });

    it('refuses a partial list, names what was left out, and reorders nothing', async () => {
      const error = await refusal(args([B, A]));

      expect(error).toMatchObject({ kind: 'invalid_params', code: 'ORDER_MISMATCH' });
      expect(error.message).toMatch(/every assignment of the module exactly once/);
      expect(error.message).toMatch(/2 left out/);
      expect(error.data).toEqual({
        missing: [
          { id: Q, title: 'Midterm quiz' },
          { id: C, title: 'Team prefs' },
        ],
        unknown: [],
        duplicated: [],
      });
      noWrite();
    });

    it('refuses an id that is not in the list and one given twice, echoing only what was sent', async () => {
      const error = await refusal(args([A, B, C, Q, STRANGER, A]));

      expect(error).toMatchObject({ kind: 'invalid_params', code: 'ORDER_MISMATCH' });
      expect(error.message).toMatch(/1 not in the list, 1 given more than once/);
      expect(error.data).toEqual({ missing: [], unknown: [STRANGER], duplicated: [A] });
      noWrite();
    });

    it('needs module_id', async () => {
      const error = await refusal({ kind: 'ASSIGNMENTS', ordered_ids: [A] });
      expect(error).toMatchObject({ kind: 'invalid_params' });
      expect(error.message).toMatch(/module_id is required/);
      expect(mocks.moduleFindById).not.toHaveBeenCalled();
      noWrite();
    });

    it.each([
      ['in another classroom', { ...MODULE, classroom_id: 'class-2' }],
      ['that does not exist', null],
    ])('refuses a module %s with the uniform not_found (S1)', async (_label, module) => {
      mocks.moduleFindById.mockResolvedValue(module);

      expect(await refusal(args([A, B, C, Q]))).toMatchObject({
        kind: 'not_found',
        message: 'Module not found in this classroom',
      });
      noWrite();
    });

    describe('where the classroom shows no quizzes', () => {
      beforeEach(() => {
        mocks.quizzesVisible.mockResolvedValue(false);
      });

      it('takes the list the caller can see and puts the quiz row back where it sits', async () => {
        // list_modules showed A, B, C. The quiz sits after A now, so it follows
        // A wherever A goes.
        const payload = parse(await run(args([C, A, B])));

        expect(mocks.assignmentReorderInModule).toHaveBeenCalledWith(
          MODULE_ID,
          [C, A, Q, B],
          'class-1'
        );
        // Neither the response nor the audit row names the hidden row, by
        // title or by id.
        expect(payload.order.map((row: { id: string }) => row.id)).toEqual([C, A, B]);
        const audit = mocks.auditCreate.mock.calls[0][0] as {
          data: { ordered_ids: string[]; value: string };
        };
        expect(audit.data.ordered_ids).toEqual([C, A, B]);
        expect(audit.data.value).toBe(`ASSIGNMENTS:${[C, A, B].join(',')}`);
        for (const text of [JSON.stringify(payload), JSON.stringify(audit.data)]) {
          expect(text.toLowerCase()).not.toContain('quiz');
          expect(text).not.toContain(Q);
        }
        expect(mocks.quizzesVisible).toHaveBeenCalledWith('class-1');
        expect(mocks.moduleFindById).toHaveBeenCalledWith(MODULE_ID);
      });

      it('sees a module that holds only hidden rows as one with nothing to reorder', async () => {
        mocks.moduleFindById.mockResolvedValue({
          ...MODULE,
          assignments: MODULE.assignments.filter(a => a.type === 'QUIZ'),
        });

        // Whatever is sent is "not in the list"; nothing says a row is there.
        const error = await refusal(args([STRANGER]));
        expect(error.data).toEqual({ missing: [], unknown: [STRANGER], duplicated: [] });
        noWrite();
      });

      it('does not count the hidden row as left out', async () => {
        const error = await refusal(args([A, B]));

        expect(error.data).toMatchObject({ missing: [{ id: C, title: 'Team prefs' }] });
        expect(JSON.stringify({ m: error.message, d: error.data }).toLowerCase()).not.toContain(
          'quiz'
        );
        noWrite();
      });

      it('treats the hidden row’s id like any id that is not in the list', async () => {
        const error = await refusal(args([A, B, C, Q]));

        // Indistinguishable from a stranger: nothing confirms it exists.
        expect(error.data).toEqual({ missing: [], unknown: [Q], duplicated: [] });
        const stranger = await refusal(args([A, B, C, STRANGER]));
        expect(stranger.message).toBe(error.message);
        noWrite();
      });
    });

    it('asks about quizzes only when the list holds one', async () => {
      mocks.moduleFindById.mockResolvedValue({
        ...MODULE,
        assignments: MODULE.assignments.filter(a => a.type !== 'QUIZ'),
      });
      await run(args([C, B, A]));
      expect(mocks.quizzesVisible).not.toHaveBeenCalled();
    });

    it.each([
      [
        'the service refusing a stale list',
        new Error('Ordered assignment ids must match the module assignments'),
      ],
      [
        'a row leaving mid-batch (P2025)',
        Object.assign(new Error('Record to update not found'), { code: 'P2025' }),
      ],
      [
        'a batch Postgres aborted (P2034)',
        Object.assign(new Error('write conflict or deadlock'), { code: 'P2034' }),
      ],
    ])('reports %s as a retry, with no audit row', async (_label, thrown) => {
      mocks.assignmentReorderInModule.mockRejectedValue(thrown);

      const error = await refusal(args([C, B, Q, A]));

      expect(error).toMatchObject({ kind: 'invalid_params', code: 'ORDER_MISMATCH' });
      expect(error.message).toMatch(/changed while the reorder ran/);
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    });

    it('gives the uniform not_found when the module vanished before the write', async () => {
      mocks.assignmentReorderInModule.mockRejectedValue(new Error('Module not found in classroom'));

      expect(await refusal(args([C, B, Q, A]))).toMatchObject({
        kind: 'not_found',
        message: 'Module not found in this classroom',
      });
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    });

    it('does not swallow an unexpected failure', async () => {
      mocks.assignmentReorderInModule.mockRejectedValue(new Error('connection lost'));
      await expect(run(args([C, B, Q, A]))).rejects.toThrow('connection lost');
      expect(mocks.auditCreate).not.toHaveBeenCalled();
    });
  });

  describe('ITEMS', () => {
    const args = (ordered_ids: string[]) => ({ kind: 'ITEMS', module_id: MODULE_ID, ordered_ids });

    it('orders the content items through module.reorderItems, legacy rows left out', async () => {
      const payload = parse(await run(args([C, B, A])));

      // The service orders the content items around the legacy REPOSITORY and
      // QUIZ rows (a quiz sits in a module through its assignment).
      expect(mocks.moduleReorderItems).toHaveBeenCalledWith(MODULE_ID, [C, B, A], 'class-1');
      expect(mocks.assignmentReorderInModule).not.toHaveBeenCalled();
      expect(payload.order).toEqual([
        { id: C, title: 'Survey' },
        { id: B, title: 'Deck' },
        { id: A, title: 'Intro' },
      ]);
      // Items never ask about quizzes: no quiz row is in the list.
      expect(mocks.quizzesVisible).not.toHaveBeenCalled();
    });

    it.each([
      ['REPOSITORY', LEGACY],
      ['QUIZ', Q],
    ])('refuses a list that names a legacy %s item, saying to leave it out', async (_type, id) => {
      const error = await refusal(args([A, id, B, C]));

      expect(error).toMatchObject({ kind: 'invalid_params', code: 'LEGACY_ITEM' });
      expect(error.message).toMatch(/Leave them out/);
      expect(error.data).toEqual({ legacy_item_ids: [id] });
      noWrite();
    });

    it('does not ask for the legacy rows: a list without them is complete', async () => {
      await run(args([A, B, C]));
      expect(mocks.moduleReorderItems).toHaveBeenCalledTimes(1);
    });

    it('treats an item whose target is in another classroom as list_modules does: not there', async () => {
      // list_modules filters such a row out, so the caller never saw it; the
      // service still counts it, so it goes back in without being named.
      mocks.moduleFindById.mockResolvedValue({
        ...MODULE,
        items: MODULE.items.map(item =>
          item.id === B
            ? { ...item, slide: { title: 'Foreign deck', classroom_id: 'class-2' } }
            : item
        ),
      });

      const payload = parse(await run(args([C, A])));

      // B goes back after A, the row it follows now.
      expect(mocks.moduleReorderItems).toHaveBeenCalledWith(MODULE_ID, [C, A, B], 'class-1');
      expect(JSON.stringify(payload)).not.toContain('Foreign deck');
      const error = await refusal(args([C]));
      expect(JSON.stringify(error.data)).not.toContain('Foreign deck');
      expect(error.data).toMatchObject({ missing: [{ id: A, title: 'Intro' }] });
    });

    it.each([
      ['Ordered item ids must match module items', 'ITEMS', () => mocks.moduleReorderItems],
      [
        'Ordered module ids must match the classroom modules',
        'MODULES',
        () => mocks.moduleReorderModules,
      ],
    ])('translates the service message "%s" into the retry', async (message, kind, mock) => {
      // The exact strings module.service throws: reworded there, this fails.
      mock().mockRejectedValue(new Error(message));

      const error = await refusal(
        kind === 'ITEMS' ? args([A, B, C]) : { kind, ordered_ids: [A, B, C] }
      );

      expect(error).toMatchObject({ kind: 'invalid_params', code: 'ORDER_MISMATCH' });
      expect(error.message).toMatch(/changed while the reorder ran/);
    });
  });

  describe('MODULES', () => {
    const args = (ordered_ids: string[]) => ({ kind: 'MODULES', ordered_ids });

    it('orders the AUTHORIZED classroom’s modules through module.reorderModules', async () => {
      const payload = parse(await run(args([C, A, B])));

      expect(mocks.moduleListContents).toHaveBeenCalledWith('class-1');
      expect(mocks.moduleReorderModules).toHaveBeenCalledWith('class-1', [C, A, B]);
      expect(mocks.moduleFindById).not.toHaveBeenCalled();
      expect(payload).toEqual({
        success: true,
        kind: 'MODULES',
        order: [
          { id: C, title: 'Week 3' },
          { id: A, title: 'Week 1' },
          { id: B, title: 'Week 2' },
        ],
      });
      expect(
        (mocks.auditCreate.mock.calls[0][0] as { resource_id: string | null }).resource_id
      ).toBeNull();
    });

    it('refuses a list that leaves a module out, or names one from elsewhere', async () => {
      const short = await refusal(args([C, A]));
      expect(short.data).toMatchObject({ missing: [{ id: B, title: 'Week 2' }] });

      const foreign = await refusal(args([C, A, B, STRANGER]));
      expect(foreign.data).toMatchObject({ unknown: [STRANGER] });
      noWrite();
    });

    it('refuses a module_id: the list is the classroom’s', async () => {
      const error = await refusal({ ...args([C, A, B]), module_id: MODULE_ID });
      expect(error).toMatchObject({ kind: 'invalid_params' });
      expect(error.message).toMatch(/does not apply to kind MODULES/);
      noWrite();
    });
  });

  it('is not Pro-gated', async () => {
    mocks.assertProTier.mockRejectedValue(proDenial());
    expect(parse(await run({ kind: 'MODULES', ordered_ids: [C, A, B] })).success).toBe(true);
    expect(mocks.assertProTier).not.toHaveBeenCalled();
  });
});
