/**
 * Module (curriculum) tools — module_create / module_update / module_publish /
 * module_item_add / module_delete / module_reorder.
 *
 * A Module ("Week 3: Recursion") holds two things: an ORDERED CONTENT LIST of
 * pages, slides and forms (ModuleItem rows, what module_item_add writes), and
 * the ASSIGNMENTS that belong to it (`Assignment.module_id`, set by
 * assignment_create, quiz_create and moved by assignment_update or, for a
 * quiz, quiz_update). A repository is neither: it is the storage a REPO
 * assignment submits through and reaches a module only through that
 * assignment, and a quiz reaches a module through its QUIZ assignment.
 * `ModuleItemType.REPOSITORY` and `ModuleItemType.QUIZ` are legacy values
 * nothing writes any more (old rows are read-only and listed nowhere):
 * module_item_add accepts both only to refuse them by name, with the tool
 * that places each instead. Publishing a Module spawns nothing.
 *
 * FORMS ARE THE GATED ITEM TYPE. The forms surface is a Pro feature everywhere
 * else it appears (apps/pages' `assertFormAdmin`, the whole forms tool batch),
 * so attaching a form is gated the same way. The gate runs on its own branch
 * only: a free-tier classroom keeps adding pages and slides exactly as before.
 *
 * Tier confirmed against apps/webapp/app/routes/admin.$class.modules/route.tsx:
 * requireClassroomAdmin — OWNER only.
 *
 * module_delete mirrors the Modules page's Delete (same route, same tier): a
 * module that still owns ASSIGNMENTS is refused, because the foreign key would
 * cascade the delete into their submissions and grades; its content items are
 * only links and go with it. Where the classroom shows no quizzes, its owner
 * cannot see quiz assignments, so a module whose only assignments are quiz
 * ones is deleted with them (module.deleteById's `quizzesHidden`, as the web
 * page does; the quizzes and their attempts stay, in no module) and the audit
 * row names them; a module that also owns listed assignments is refused, and
 * one that owns other unlisted ones is refused without naming them, as the
 * web's "This module can't be deleted." does.
 *
 * module_reorder is the Modules page's three drags in one tool (`kind`): the
 * assignments of a module, the content items of a module, or the modules of
 * the classroom. Each replaces every position of one list at once, so the
 * caller hands over the list in full, as the page does. Where the classroom
 * shows no quizzes the caller was never given the quiz rows, so they are put
 * back where they sit now (withHiddenRows, the helper the page's action uses)
 * before the list reaches a service. Legacy REPOSITORY and QUIZ item rows are
 * not part of the items list: the service orders the content items around
 * them.
 *
 * Backbone (plan §6): module.create / updateForClassroom / setPublished (NOT
 * `publish` — no such method) / addItem / deleteById. The *ForClassroom/classroomId-taking
 * service variants enforce S1 inside packages/services (module AND item
 * target must belong to the classroom); their generic `Error` throws are
 * translated to non-leaking ToolErrors here.
 */

import { ClassmojiService } from '@classmoji/services';
import { withHiddenRows } from '@classmoji/utils';
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
    // slide or form is untouched, and so is every item already in the module.
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
    'Appends a content item to a module: a page, a slide deck, or a form. The target ' +
    'must belong to the same classroom. A repository is not a module item, so REPOSITORY is ' +
    'refused: a lab sits in a module through its assignment. QUIZ is refused too: a quiz is ' +
    'placed by its own module_id (quiz_create, or quiz_update to move it). To place an existing ' +
    'assignment use assignment_update with module_id; assignment_create adds a NEW gradeable ' +
    'one. Owner only.\n' +
    'A FORM item links one of the classroom’s forms (list_forms / form_create) into the ' +
    'curriculum, so a waitlist, survey, team bid or peer review sits in the week it belongs to ' +
    'rather than as a link somebody has to remember to send. The form’s `closes_at` becomes the ' +
    'item’s due date, so setting one (form_update) is what puts the module row on the schedule. ' +
    'A DRAFT form can be attached — the item is created now and simply stays hidden from members ' +
    'until form_publish. A CLOSED form stays visible on purpose, reading as closed. Attaching a ' +
    'form requires a Pro subscription (the forms surface is Pro everywhere); pages and slides ' +
    'do not.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    module_id: z.string().uuid().describe('Module id'),
    item_type: z
      .enum(['PAGE', 'REPOSITORY', 'QUIZ', 'SLIDE', 'FORM'])
      .describe(
        'What kind of content the item links. REPOSITORY is refused: to place a lab in a ' +
          'module, move its assignment with assignment_update module_id. QUIZ is refused: use ' +
          'quiz_create or quiz_update with module_id.'
      ),
    target_id: z.string().uuid().describe('Id of the page/slide/form to link'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // The forms surface is Pro-gated on every other surface it has, so linking
    // a form from a module is gated too. The check runs on its own branch only,
    // outside the try below so a refusal surfaces as `forbidden` rather than
    // being rewritten by translateModuleError. Adding a page or slide is
    // unchanged for a free-tier classroom.
    if (args.item_type === 'FORM') await assertProTier(ctx);

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
    // Nor is a quiz: it sits in a module through its own assignment, which the
    // quiz tools place. Refused by name before any lookup, so it says nothing
    // about any quiz.
    if (args.item_type === 'QUIZ') {
      throw new ToolError(
        'invalid_params',
        'QUIZ is not a module item: a quiz is placed in a module by its own module_id. Use ' +
          'quiz_create with module_id for a new quiz, or quiz_update with module_id to move one.'
      );
    }

    try {
      const item = await ClassmojiService.module.addItem(
        args.module_id,
        args.item_type as Exclude<ModuleItemType, 'REPOSITORY' | 'QUIZ'>,
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

interface ModuleDeleteArgs {
  classroom: string;
  module_id: string;
}

export const moduleDeleteTool: ToolDefinition<ModuleDeleteArgs> = {
  name: 'module_delete',
  // Removes the module and its item rows for good. Database only: nothing on
  // GitHub, no notification.
  annotations: { destructive: true, idempotent: false, openWorld: false },
  title: 'Delete a module',
  description:
    'Permanently deletes a module that owns no assignments. Owner only. A module that still ' +
    'owns assignments is refused and nothing is deleted: move them to another module first ' +
    '(assignment_update with module_id; a quiz with quiz_update module_id), or delete a REPO ' +
    'one (assignment_delete); ' +
    'list_modules shows what a module owns. The module’s content items go with it and are counted in the ' +
    'response: they are only its links to pages, slides and forms, and the pages, ' +
    'slides and forms themselves are untouched. THIS CANNOT BE UNDONE: the module and ' +
    'the order of its items are gone. A published module is deleted like any other, so ' +
    'students stop seeing it. Use it to clear out a module left empty once its assignments ' +
    'were moved elsewhere.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    module_id: z.string().uuid().describe('Module id (see list_modules)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);

    // S1: the module with what it owns, verified against the authorized
    // classroom. Missing and foreign get the same not_found.
    const module = await ClassmojiService.module.findById(args.module_id);
    if (!module || module.classroom_id !== classroom.classroomId) {
      throw scopedNotFound('Module');
    }

    // What this caller can see of it. A classroom that shows no quizzes lists
    // no quiz assignment (list_modules), so none may be named or counted here.
    // Asked only when a quiz assignment is present.
    const quizzesHidden =
      module.assignments.some(a => a.type === 'QUIZ') &&
      !(await ClassmojiService.entitlement.quizzesVisible(classroom.classroomId));
    const listed = module.assignments.filter(a => !(quizzesHidden && a.type === 'QUIZ'));
    // Held back only by quiz assignments its owner cannot see: those go with
    // the module (the quizzes and their attempts stay, in no module), as on the
    // web Modules page.
    const onlyHiddenQuizzes = quizzesHidden && listed.length === 0;

    const refuseOwned = (): never => {
      // Held back by assignments this classroom does not list: moving the
      // listed ones could never unblock it, so say no more than that — the
      // line the Modules page gives, which offers no Delete for such a module.
      // No code either: MODULE_HAS_ASSIGNMENTS on a module list_modules shows
      // as owning none would say what the message does not.
      if (listed.length < module.assignments.length) {
        throw new ToolError('invalid_params', 'This module can’t be deleted.');
      }
      throw new ToolError(
        'invalid_params',
        `This module still owns ${listed.length} assignment(s), so nothing was deleted. Move ` +
          'each to another module (assignment_update with module_id), then retry. A REPO ' +
          'assignment can be deleted instead (assignment_delete).',
        'MODULE_HAS_ASSIGNMENTS',
        { assignments: listed.map(a => ({ id: a.id, title: a.title, type: a.type })) }
      );
    };
    if (module.assignments.length > 0 && !onlyHiddenQuizzes) refuseOwned();

    let deletedQuizAssignmentIds: string[] = [];
    try {
      const deleted = await ClassmojiService.module.deleteById(module.id, classroom.classroomId, {
        quizzesHidden,
      });
      deletedQuizAssignmentIds = deleted.deleted_quiz_assignment_ids;
    } catch (error) {
      if (error instanceof Error) {
        // The service re-checks under a lock: an assignment moved in, or the
        // module deleted, since the read above.
        if (error.message === 'Module not found in classroom') throw scopedNotFound('Module');
        if (error.message === 'Module still has assignments') {
          throw new ToolError(
            'invalid_params',
            'An assignment was moved into this module while the delete ran, so nothing was ' +
              'deleted. Check list_modules and retry.',
            'MODULE_HAS_ASSIGNMENTS'
          );
        }
      }
      throw error;
    }

    // Legacy QUIZ items are listed for nobody (a quiz is in a module through
    // its assignment), so they are not counted in the reply either.
    const itemsRemoved = module.items.filter(item => item.item_type !== 'QUIZ').length;

    await writeAudit(ctx, {
      resource_type: 'MODULES',
      resource_id: module.id,
      action: 'DELETE',
      data: {
        tool: 'module_delete',
        title: module.title,
        slug: module.slug,
        was_published: module.is_published,
        // The true count: the audit log is the owner's record, not a read surface.
        items_removed: module.items.length,
        ...(deletedQuizAssignmentIds.length > 0
          ? { quiz_assignment_ids: deletedQuizAssignmentIds }
          : {}),
      },
    });

    return ok({
      success: true,
      deleted_module_id: module.id,
      title: module.title,
      items_removed: itemsRemoved,
    });
  },
};

type ReorderKind = 'ASSIGNMENTS' | 'ITEMS' | 'MODULES';

interface ModuleReorderArgs {
  classroom: string;
  kind: ReorderKind;
  module_id?: string;
  ordered_ids: string[];
}

/** One row of a list being reordered, as the caller may see it (or not). */
interface ReorderRow {
  id: string;
  title: string | null;
  hidden: boolean;
}

const REORDER_NOUN: Record<ReorderKind, string> = {
  ASSIGNMENTS: 'assignment of the module',
  ITEMS: 'content item of the module',
  MODULES: 'module of the classroom',
};

/**
 * `ordered` has to be exactly the rows the caller can see, each once. Anything
 * else is refused before a service runs, naming what is off: the rows left out
 * (with titles — they are the caller's own list), and the ids that are not in
 * the list, echoed back as sent. A hidden row is not in `visible`, so an id of
 * one is "not in the list" like any stranger: nothing here confirms it exists.
 */
function assertFullOrder(kind: ReorderKind, visible: ReorderRow[], ordered: string[]): void {
  const seen = new Set<string>();
  const repeats = new Set<string>();
  for (const id of ordered) (seen.has(id) ? repeats : seen).add(id);
  const duplicated = [...repeats];
  const visibleIds = new Set(visible.map(row => row.id));
  const unknown = [...seen].filter(id => !visibleIds.has(id));
  const missing = visible.filter(row => !seen.has(row.id));
  if (duplicated.length === 0 && unknown.length === 0 && missing.length === 0) return;

  const parts = [
    missing.length > 0 ? `${missing.length} left out` : null,
    unknown.length > 0 ? `${unknown.length} not in the list` : null,
    duplicated.length > 0 ? `${duplicated.length} given more than once` : null,
  ].filter(Boolean);
  throw new ToolError(
    'invalid_params',
    `ordered_ids must name every ${REORDER_NOUN[kind]} exactly once (see list_modules): ` +
      `${parts.join(', ')}. Nothing was reordered.`,
    'ORDER_MISMATCH',
    {
      missing: missing.map(row => ({ id: row.id, title: row.title })),
      unknown,
      duplicated,
    }
  );
}

export const moduleReorderTool: ToolDefinition<ModuleReorderArgs> = {
  name: 'module_reorder',
  annotations: {
    // Rewrites positions only: nothing is added, removed or moved between
    // modules.
    destructive: false,
    // The same list twice leaves the same order.
    idempotent: true,
    openWorld: false,
  },
  title: 'Reorder modules, or a module’s assignments or items',
  description:
    'Sets the display order of one list, as dragging does on the Modules page. Owner only. ' +
    '`kind` picks the list: ASSIGNMENTS (the assignments of module_id), ITEMS (the content ' +
    'items of module_id: its pages, slides and forms) or MODULES (the modules of the ' +
    'classroom; omit module_id). ordered_ids is the WHOLE list in its new order, every id ' +
    'exactly once: assignment ids, module item ids (the `id` of an entry in `items`, not its ' +
    'target_id) or module ids, all from list_modules. A partial list is refused, naming what ' +
    'was left out, and nothing is reordered. Only the order changes; students see the new ' +
    'order at once. It does not move anything between modules: assignment_update with ' +
    'module_id does that (the assignment lands last; reorder afterwards). Items of type ' +
    'REPOSITORY are legacy rows that cannot be reordered: leave them out of an ITEMS list.',
  scope: 'write',
  roles: OWNER_ONLY,
  inputSchema: {
    classroom: z.string().describe("Classroom reference as 'org/slug'"),
    kind: z
      .enum(['ASSIGNMENTS', 'ITEMS', 'MODULES'])
      .describe('Which list to reorder: a module’s ASSIGNMENTS or ITEMS, or the MODULES'),
    module_id: z
      .string()
      .uuid()
      .optional()
      .describe('The module whose list is reordered. Required for ASSIGNMENTS and ITEMS'),
    ordered_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(500)
      .describe('Every id of the list, once each, in the new order (first = top)'),
  },
  handler: async (args, ctx) => {
    const classroom = requireClassroomCtx(ctx);
    const { kind, ordered_ids: ordered } = args;

    let rows: ReorderRow[];
    let moduleId: string | null = null;
    // The service call for this kind, given the full list.
    let apply: (full: string[]) => Promise<unknown>;

    if (kind === 'MODULES') {
      if (args.module_id !== undefined) {
        throw new ToolError(
          'invalid_params',
          'module_id does not apply to kind MODULES: the list is the classroom’s modules.'
        );
      }
      const modules = await ClassmojiService.module.listModuleContentsForClassroom(
        classroom.classroomId
      );
      rows = modules.map(m => ({ id: m.id, title: m.title, hidden: false }));
      apply = full => ClassmojiService.module.reorderModules(classroom.classroomId, full);
    } else {
      if (args.module_id === undefined) {
        throw new ToolError('invalid_params', `module_id is required for kind ${kind}.`);
      }
      // S1: the module with what it owns, verified against the authorized
      // classroom. Missing and foreign get the same not_found.
      const module = await ClassmojiService.module.findById(args.module_id);
      if (!module || module.classroom_id !== classroom.classroomId) {
        throw scopedNotFound('Module');
      }
      moduleId = module.id;

      // The rows list_modules does not show this caller: quiz assignments
      // where the classroom shows no quizzes. Asked only when the list holds
      // one.
      const quizzesHidden =
        kind === 'ASSIGNMENTS' &&
        module.assignments.some(a => a.type === 'QUIZ') &&
        !(await ClassmojiService.entitlement.quizzesVisible(classroom.classroomId));

      if (kind === 'ASSIGNMENTS') {
        rows = module.assignments.map(a => ({
          id: a.id,
          title: a.title,
          hidden: quizzesHidden && a.type === 'QUIZ',
        }));
        apply = full =>
          ClassmojiService.assignment.reorderInModule(module.id, full, classroom.classroomId);
      } else {
        // Legacy REPOSITORY and QUIZ items are not in the content list (a
        // repository and a quiz sit in a module through an assignment): the
        // service orders the content items around them, so they are neither
        // listed here nor accepted.
        const isLegacy = (item: { item_type: string }) =>
          item.item_type === 'REPOSITORY' || item.item_type === 'QUIZ';
        const named = module.items.filter(item => isLegacy(item) && ordered.includes(item.id));
        if (named.length > 0) {
          throw new ToolError(
            'invalid_params',
            `${named.length} of the ordered_ids are legacy items, which cannot be ` +
              'reordered. Leave them out and send the other content items. Nothing was reordered.',
            'LEGACY_ITEM',
            { legacy_item_ids: named.map(item => item.id) }
          );
        }
        rows = module.items
          .filter(item => !isLegacy(item))
          .map(item => {
            const target = item.page ?? item.slide ?? item.form ?? null;
            return {
              id: item.id,
              title: item.page?.title ?? item.slide?.title ?? item.form?.title ?? null,
              // Hidden from this caller, as list_modules hides it: a row whose
              // target is not in this classroom (the service lists that row
              // too, so it has to go back in, but nothing here may name it).
              hidden: target?.classroom_id !== classroom.classroomId,
            };
          });
        apply = full =>
          ClassmojiService.module.reorderItems(module.id, full, classroom.classroomId);
      }
    }

    const visible = rows.filter(row => !row.hidden);
    assertFullOrder(kind, visible, ordered);
    // The services take the full list: hidden rows go back where they sit now.
    try {
      await apply(withHiddenRows(rows, ordered));
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Module not found in classroom') throw scopedNotFound('Module');
        // The list changed between the read above and the write (a move, an
        // add or a delete landed in between). The service refuses a stale list
        // ('Ordered … must match …'); a row that leaves between ITS read and
        // its batch makes one update match nothing (P2025), and a batch that
        // crosses a move's renumbering can be the one Postgres aborts (P2034).
        // Each rolls the whole batch back.
        const code = (error as { code?: unknown }).code;
        if (error.message.startsWith('Ordered ') || code === 'P2025' || code === 'P2034') {
          throw new ToolError(
            'invalid_params',
            'The list changed while the reorder ran, so nothing was reordered. Read ' +
              'list_modules again and retry.',
            'ORDER_MISMATCH'
          );
        }
      }
      throw error;
    }

    await writeAudit(ctx, {
      resource_type: 'MODULES',
      resource_id: moduleId,
      action: 'UPDATE',
      data: {
        tool: 'module_reorder',
        kind,
        ordered_ids: ordered,
        // The dedup key: a different order inside audit's 5s window is a
        // different row; the same order re-sent still dedups.
        value: `${kind}:${ordered.join(',')}`,
      },
    });

    const titles = new Map(visible.map(row => [row.id, row.title]));
    return ok({
      success: true,
      kind,
      ...(moduleId ? { module_id: moduleId } : {}),
      // In the new order. No position number: the array is the order, and a
      // number here would not match list_modules where it lists rows this
      // list leaves out (legacy items).
      order: ordered.map(id => ({ id, title: titles.get(id) ?? null })),
    });
  },
};
