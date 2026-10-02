/**
 * Module (curriculum) tools — module_create / module_update / module_publish /
 * module_item_add.
 *
 * A Module ("Week 3: Recursion") holds two things: an ORDERED CONTENT LIST of
 * pages, slides, quizzes and forms (ModuleItem rows, what module_item_add
 * writes), and the ASSIGNMENTS that belong to it (`Assignment.module_id`, set
 * by assignment_create and moved by assignment_update). A repository is neither:
 * it is the storage a REPO assignment submits through and reaches a module only
 * through that assignment. `ModuleItemType.REPOSITORY` is a legacy value no
 * surface writes or renders any more, refused here. Publishing a Module spawns
 * nothing.
 *
 * FORMS AND QUIZZES ARE THE GATED ITEM TYPES. The forms surface is a Pro
 * feature everywhere else it appears (apps/pages' `assertFormAdmin`, the whole
 * forms tool batch), so attaching a form is gated the same way. Quizzes appear
 * only where `entitlement.quizzesVisible` holds (Pro, and quizzes switched on),
 * the predicate list_modules and the web app filter on, so attaching a quiz is
 * refused anywhere else. Each gate runs on its own branch only: a free-tier
 * classroom keeps adding pages and slides exactly as before.
 *
 * Tier confirmed against apps/webapp/app/routes/admin.$class.modules/route.tsx:
 * requireClassroomAdmin — OWNER only.
 *
 * Backbone (plan §6): module.create / updateForClassroom / setPublished (NOT
 * `publish` — no such method) / addItem. The *ForClassroom/classroomId-taking
 * service variants enforce S1 inside packages/services (module AND item
 * target must belong to the classroom); their generic `Error` throws are
 * translated to non-leaking ToolErrors here.
 */

import { ClassmojiService } from '@classmoji/services';
import type { ModuleItemType } from '@prisma/client';
import { z } from 'zod';
import { ToolError } from '../mcp/errors.ts';
import type { ToolDefinition } from '../mcp/registry.ts';
import { assertProTier } from '../authz/proTier.ts';
import { ok, OWNER_ONLY, requireClassroomCtx, scopedNotFound, writeAudit } from './shared.ts';

/**
 * Translate module.service's classroom-scoping throws (generic Errors) into
 * the uniform non-leaking not_found, and Prisma unique violations into a
 * friendly invalid_params.
 */
function translateModuleError(error: unknown): never {
  if (error instanceof Error) {
    if (error.message === 'Module not found in classroom') throw scopedNotFound('Module');
    if (error.message === 'Module item target not found in classroom') {
      throw scopedNotFound('Item target');
    }
    if ('code' in error && (error as { code?: string }).code === 'P2002') {
      throw new ToolError(
        'invalid_params',
        'Duplicate: a module with this title (or an identical item) already exists'
      );
    }
  }
  throw error;
}

interface ModuleCreateArgs {
  classroom: string;
  title: string;
  description?: string;
}

export const moduleCreateTool: ToolDefinition<ModuleCreateArgs> = {
  name: 'module_create',
  annotations: { destructive: false },
  title: 'Create a module',
  description:
    'Creates a curriculum module such as "Week 3: Recursion": an ordered list of content ' +
    '(pages, slides, quizzes, forms) plus the assignments placed in it (assignment_create, or ' +
    'assignment_update with module_id for an existing one). Created unpublished. Owner only.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    title: z.string().min(1).max(200).describe('Module title (unique per classroom)'),
    description: z.string().max(2000).optional().describe('Optional description'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    try {
      const module = await ClassmojiService.module.create(classroom.classroomId, {
        title: args.title,
        description: args.description ?? null,
      });

      await writeAudit(ctx, {
        resource_type: 'MODULES',
        resource_id: module.id,
        action: 'CREATE',
        data: { tool: 'module_create', title: args.title },
      });

      return ok({
        success: true,
        module: {
          id: module.id,
          title: module.title,
          slug: module.slug,
          is_published: module.is_published,
        },
      });
    } catch (error) {
      translateModuleError(error);
    }
  },
};

interface ModuleUpdateArgs {
  classroom: string;
  module_id: string;
  title: string;
  description?: string;
}

export const moduleUpdateTool: ToolDefinition<ModuleUpdateArgs> = {
  name: 'module_update',
  annotations: { destructive: false },
  title: 'Update a module',
  description: "Updates a module's title and/or description (the slug never changes). Owner only.",
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    module_id: z.string().uuid().describe('Module id'),
    title: z.string().min(1).max(200).describe('New title'),
    description: z.string().max(2000).optional().describe('New description (omit to clear)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    try {
      const module = await ClassmojiService.module.updateForClassroom(
        args.module_id,
        classroom.classroomId,
        { title: args.title, description: args.description ?? null }
      );

      await writeAudit(ctx, {
        resource_type: 'MODULES',
        resource_id: module.id,
        action: 'UPDATE',
        data: { tool: 'module_update', title: args.title },
      });

      return ok({
        success: true,
        module: { id: module.id, title: module.title, description: module.description },
      });
    } catch (error) {
      translateModuleError(error);
    }
  },
};

interface ModulePublishArgs {
  classroom: string;
  module_id: string;
  published: boolean;
}

export const modulePublishTool: ToolDefinition<ModulePublishArgs> = {
  name: 'module_publish',
  annotations: { destructive: false },
  title: 'Publish or unpublish a module',
  description:
    'Sets whether a curriculum module is visible to students. Items whose underlying content ' +
    'is unpublished stay hidden regardless. Owner only.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    module_id: z.string().uuid().describe('Module id'),
    published: z.boolean().describe('true to publish, false to unpublish'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    try {
      const module = await ClassmojiService.module.setPublished(
        args.module_id,
        args.published,
        classroom.classroomId
      );

      await writeAudit(ctx, {
        resource_type: 'MODULES',
        resource_id: module.id,
        action: 'UPDATE',
        data: { tool: 'module_publish', published: args.published },
      });

      return ok({
        success: true,
        module: { id: module.id, title: module.title, is_published: module.is_published },
      });
    } catch (error) {
      translateModuleError(error);
    }
  },
};

interface ModuleItemAddArgs {
  classroom: string;
  module_id: string;
  item_type: 'PAGE' | 'REPOSITORY' | 'QUIZ' | 'SLIDE' | 'FORM';
  target_id: string;
}

export const moduleItemAddTool: ToolDefinition<ModuleItemAddArgs> = {
  name: 'module_item_add',
  annotations: {
    // Appends one ModuleItem row. Nothing is removed: the underlying page,
    // repo, quiz, slide or form is untouched, and so is every item already in
    // the module.
    destructive: false,
    // Repeating the call with the same args has no ADDITIONAL effect — the
    // unique (module_id, target_id) constraint means the second attempt is
    // refused (P2002 → invalid_params "Duplicate…") rather than silently
    // appending the same content twice. A retry cannot corrupt the module; it
    // just reports that the item is already there.
    idempotent: true,
    // Purely a database write: no GitHub, no email, no external system.
    openWorld: false,
  },
  title: 'Add an item to a module',
  description:
    'Appends a content item to a module: a page, a quiz, a slide deck, or a form. The target ' +
    'must belong to the same classroom. A repository is not a module item, so REPOSITORY is ' +
    'refused: a lab sits in a module through its assignment. To place an existing assignment ' +
    'use assignment_update with module_id; assignment_create adds a NEW gradeable one. ' +
    'Owner only.\n' +
    'A FORM item links one of the classroom’s forms (list_forms / form_create) into the ' +
    'curriculum, so a waitlist, survey, team bid or peer review sits in the week it belongs to ' +
    'rather than as a link somebody has to remember to send. The form’s `closes_at` becomes the ' +
    'item’s due date, so setting one (form_update) is what puts the module row on the schedule. ' +
    'A DRAFT form can be attached — the item is created now and simply stays hidden from members ' +
    'until form_publish, exactly as a DRAFT quiz does. A CLOSED form stays ' +
    'visible on purpose, reading as closed. Attaching a form requires a Pro subscription (the ' +
    'forms surface is Pro everywhere); attaching a quiz requires Pro with quizzes_enabled on. ' +
    'Pages and slides need neither.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    module_id: z.string().uuid().describe('Module id'),
    item_type: z
      .enum(['PAGE', 'REPOSITORY', 'QUIZ', 'SLIDE', 'FORM'])
      .describe(
        'What kind of content the item links. REPOSITORY is refused: to place a lab in a ' +
          'module, move its assignment with assignment_update module_id.'
      ),
    target_id: z.string().uuid().describe('Id of the page/quiz/slide/form to link'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // The forms surface is Pro-gated on every other surface it has, so linking
    // a form from a module is gated too. A quiz is refused wherever quizzes are
    // not visible, the same predicate list_modules filters them out on. Both
    // checks run on their own branch only, outside the try below so a refusal
    // surfaces as `forbidden` rather than being rewritten by
    // translateModuleError. Adding a page or slide is unchanged for a free-tier
    // classroom.
    if (args.item_type === 'FORM') await assertProTier(ctx);
    if (
      args.item_type === 'QUIZ' &&
      !(await ClassmojiService.entitlement.quizzesVisible(classroom.classroomId))
    ) {
      throw new ToolError(
        'forbidden',
        'Quizzes are not available in this classroom: they require a Pro subscription with quizzes_enabled on'
      );
    }

    // A repository is not a module item: it reaches a module through a REPO
    // assignment. Refused before any lookup. The message names the move first,
    // because the caller usually holds a lab that already has its assignment,
    // and assignment_create there would add a second gradebook entry.
    if (args.item_type === 'REPOSITORY') {
      throw new ToolError(
        'invalid_params',
        'REPOSITORY is not a module item: a repository sits in a module through its ' +
          'assignments. To place an existing assignment in this module, call assignment_update ' +
          'with module_id (list_repos shows each assignment and the module it is in). Use ' +
          'assignment_create only for a NEW assignment: it adds another gradeable entry.'
      );
    }

    try {
      const item = await ClassmojiService.module.addItem(
        args.module_id,
        args.item_type as Exclude<ModuleItemType, 'REPOSITORY'>,
        args.target_id,
        classroom.classroomId
      );

      await writeAudit(ctx, {
        resource_type: 'MODULE_ITEM',
        resource_id: item.id,
        action: 'CREATE',
        data: {
          tool: 'module_item_add',
          module_id: args.module_id,
          item_type: args.item_type,
          target_id: args.target_id,
        },
      });

      return ok({
        success: true,
        item: { id: item.id, item_type: item.item_type, position: item.position },
      });
    } catch (error) {
      translateModuleError(error);
    }
  },
};
