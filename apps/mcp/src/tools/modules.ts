/**
 * Module (curriculum) tools — module_create / module_update / module_publish /
 * module_item_add.
 *
 * A Module is an ORDERED CURRICULUM CONTENT LIST ("Week 3: Recursion") of
 * pages, repos (assignment containers), quizzes, and slides — NOT the
 * assignment container (plan §2.2; that is `Repository`). A ModuleItem of type
 * REPOSITORY links a container, not a git repo. Publishing a Module spawns
 * nothing.
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
  title: 'Create a module',
  description:
    'Creates a curriculum module — an ordered list of content (pages, repos/labs, quizzes, ' +
    'slides) such as "Week 3: Recursion". Created unpublished. Owner only.',
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
  item_type: 'PAGE' | 'REPOSITORY' | 'QUIZ' | 'SLIDE';
  target_id: string;
}

export const moduleItemAddTool: ToolDefinition<ModuleItemAddArgs> = {
  name: 'module_item_add',
  title: 'Add an item to a module',
  description:
    'Appends a content item to a module: a page, a repo/lab (REPOSITORY links the assignment ' +
    'container, not a git repo), a quiz, or a slide deck. The target must belong to the same ' +
    'classroom. Owner only.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    module_id: z.string().uuid().describe('Module id'),
    item_type: z
      .enum(['PAGE', 'REPOSITORY', 'QUIZ', 'SLIDE'])
      .describe('What kind of content the item links'),
    target_id: z.string().uuid().describe('Id of the page/repository/quiz/slide to link'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    try {
      const item = await ClassmojiService.module.addItem(
        args.module_id,
        args.item_type as ModuleItemType,
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
