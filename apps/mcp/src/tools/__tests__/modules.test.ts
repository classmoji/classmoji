/**
 * Unit tests for the module (curriculum) tool batch — module_create /
 * module_update / module_publish / module_item_add.
 *
 * The focus is the FIFTH item type. `ModuleItemType` gained `FORM`, and a
 * module item that links a form is the one place the curriculum surface touches
 * a Pro-only feature, so three things have to hold at once:
 *
 *   - S4 role parity: all four tools are OWNER-only (requireClassroomAdmin,
 *     admin.$class.modules), FORM included. Attaching a form does not widen the
 *     tier to the forms batch's OWNER|TEACHER — it is still a curriculum edit.
 *   - The Pro gate runs on the FORM BRANCH ONLY. A free-tier classroom must
 *     keep adding pages, repos, quizzes and slides; it must not be able to
 *     attach a form.
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
  moduleCreate: vi.fn(),
  moduleUpdateForClassroom: vi.fn(),
  moduleSetPublished: vi.fn(),
  moduleAddItem: vi.fn(),
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
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { moduleCreateTool, moduleUpdateTool, modulePublishTool, moduleItemAddTool } =
  await import('../modules.ts');

const ALL_TOOLS: ToolDefinition<never>[] = [
  moduleCreateTool,
  moduleUpdateTool,
  modulePublishTool,
  moduleItemAddTool,
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

  it('accepts all five item types and rejects anything else', () => {
    const itemType = moduleItemAddTool.inputSchema.item_type as z.ZodTypeAny;
    for (const type of ['PAGE', 'REPOSITORY', 'QUIZ', 'SLIDE', 'FORM']) {
      expect(itemType.safeParse(type).success, type).toBe(true);
    }
    // The enum is the whole vocabulary: nothing outside ModuleItemType gets in.
    for (const bogus of ['ASSIGNMENT', 'form', 'Form', '', 'GRADE']) {
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

  it('gives every item type the identical refusal (FORM is not special)', async () => {
    const messages: string[] = [];
    for (const item_type of ['PAGE', 'REPOSITORY', 'QUIZ', 'SLIDE', 'FORM']) {
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

  it('still adds a PAGE (and the other three types) in that same non-Pro classroom', async () => {
    mocks.assertProTier.mockRejectedValue(proDenial());

    for (const item_type of ['PAGE', 'REPOSITORY', 'QUIZ', 'SLIDE']) {
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
      // The branch is what proves the gate is scoped: the non-FORM path never
      // even asks.
      expect(mocks.assertProTier, item_type).not.toHaveBeenCalled();
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
