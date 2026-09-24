import { useMemo, useState } from 'react';
import { useFetcher, useParams } from 'react-router';
import { Button } from 'antd';
import { namedAction } from 'remix-utils/named-action';
import { IconPlus } from '@tabler/icons-react';

import { SearchInput, ButtonNew, RequireRole } from '~/components';
import { useDragReorder, dragRowClass } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import type { ModuleItemType } from '@prisma/client';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import { assertClassroomMutationAllowed } from '~/utils/helpers';
import ModuleCard, { type ModuleCardData } from '~/components/features/modules/ModuleCard';
import {
  useCourseworkDrag,
  type CourseworkMove,
} from '~/components/features/modules/useCourseworkDrag';
import ModuleFormModal from './ModuleFormModal';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_modules',
  });

  // Every module with everything it owns, plus what the pickers may add.
  const [modules, candidates, allAssignments, repositories, tags] = await Promise.all([
    ClassmojiService.module.listModuleContentsForClassroom(classroom.id),
    ClassmojiService.module.getCandidateContent(classroom.id),
    ClassmojiService.assignment.listForClassroom(classroom.id),
    ClassmojiService.repository.findByClassroomId(classroom.id),
    ClassmojiService.organizationTag.findByClassroomId(classroom.id),
  ]);

  return {
    modules,
    candidates,
    // A REPO assignment may submit through any repository in the classroom.
    repositories: repositories.map(r => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      is_published: r.is_published,
    })),
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    // Team tags, for an instructor-assigned team assignment created from a card.
    tags: tags.map(t => ({ id: t.id, name: t.name })),
    // A quiz or form binds to at most one assignment in the classroom.
    boundQuizIds: allAssignments.map(a => a.quiz_id).filter(Boolean) as string[],
    boundFormIds: allAssignments.map(a => a.form_id).filter(Boolean) as string[],
  };
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'manage_modules',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = (await request.json()) as {
    id?: string;
    title?: string;
    description?: string | null;
    isPublished?: boolean;
    isPublic?: boolean;
    moduleId?: string;
    itemType?: ModuleItemType;
    targetId?: string;
    moduleItemId?: string;
    orderedItemIds?: string[];
    orderedModuleIds?: string[];
    orderedAssignmentIds?: string[];
    assignmentId?: string;
    toModuleId?: string;
  };

  return namedAction(request, {
    async create() {
      try {
        const module = await ClassmojiService.module.create(classroom.id, {
          title: data.title!,
          description: data.description,
        });
        return { success: 'Module created', module };
      } catch (error: unknown) {
        console.error('Module create error:', error);
        return { error: 'Failed to create module. A module with this title may already exist.' };
      }
    },
    async update() {
      try {
        await ClassmojiService.module.updateForClassroom(data.id!, classroom.id, {
          title: data.title!,
          description: data.description,
        });
        return { success: 'Module updated' };
      } catch (error: unknown) {
        console.error('Module update error:', error);
        return { error: 'Failed to update module. Please try again.' };
      }
    },
    async delete() {
      try {
        await ClassmojiService.module.deleteById(data.id!, classroom.id);
        return { success: 'Module deleted' };
      } catch (error: unknown) {
        console.error('Module delete error:', error);
        const message = error instanceof Error ? error.message : '';
        return {
          error: message.includes('still has')
            ? 'Move or delete this module’s assignments first.'
            : 'Failed to delete module. Please try again.',
        };
      }
    },
    async setPublished() {
      try {
        await ClassmojiService.module.setPublished(data.id!, !!data.isPublished, classroom.id);
        return {
          success: data.isPublished
            ? 'Module published to students'
            : 'Module hidden from students',
        };
      } catch (error: unknown) {
        console.error('Module setPublished error:', error);
        return { error: 'Failed to update module visibility. Please try again.' };
      }
    },
    async setPublic() {
      try {
        await ClassmojiService.module.setPublic(data.id!, !!data.isPublic, classroom.id);
        return {
          success: data.isPublic
            ? 'Module shown on the course website'
            : 'Module hidden from the course website',
        };
      } catch (error: unknown) {
        console.error('Module setPublic error:', error);
        return { error: 'Failed to update module site visibility. Please try again.' };
      }
    },
    async addItem() {
      try {
        await ClassmojiService.module.addItem(
          data.moduleId!,
          // Repositories join a module through Repository.module_id, not as
          // an item; the service refuses REPOSITORY at runtime as well.
          data.itemType! as Exclude<ModuleItemType, 'REPOSITORY'>,
          data.targetId!,
          classroom.id
        );
        return { success: 'Item added to module' };
      } catch (error: unknown) {
        console.error('Module addItem error:', error);
        return { error: 'Failed to add item. It may already be in this module.' };
      }
    },
    async removeItem() {
      try {
        await ClassmojiService.module.removeItem(data.moduleItemId!, classroom.id);
        return { success: 'Item removed from module' };
      } catch (error: unknown) {
        console.error('Module removeItem error:', error);
        return { error: 'Failed to remove item. Please try again.' };
      }
    },
    async reorderItems() {
      try {
        await ClassmojiService.module.reorderItems(
          data.moduleId!,
          data.orderedItemIds ?? [],
          classroom.id
        );
        return { success: 'Module order updated' };
      } catch (error: unknown) {
        console.error('Module reorderItems error:', error);
        return { error: 'Failed to reorder items. Please try again.' };
      }
    },
    async reorderAssignments() {
      try {
        await ClassmojiService.assignment.reorderInModule(
          data.moduleId!,
          data.orderedAssignmentIds ?? [],
          classroom.id
        );
        return { success: 'Module order updated' };
      } catch (error: unknown) {
        console.error('Module reorderAssignments error:', error);
        return { error: 'Failed to reorder assignments. Please try again.' };
      }
    },
    async moveItem() {
      try {
        await ClassmojiService.module.moveItemToModule(
          data.moduleItemId!,
          data.toModuleId!,
          data.orderedItemIds ?? [],
          classroom.id
        );
        return { success: 'Item moved' };
      } catch (error: unknown) {
        console.error('Module moveItem error:', error);
        const message = error instanceof Error ? error.message : '';
        return {
          error: message.includes('already has')
            ? message
            : 'Failed to move the item. Please try again.',
        };
      }
    },
    async moveAssignment() {
      try {
        await ClassmojiService.assignment.moveToModule(
          data.assignmentId!,
          data.toModuleId!,
          data.orderedAssignmentIds ?? [],
          classroom.id
        );
        return { success: 'Assignment moved' };
      } catch (error: unknown) {
        console.error('Module moveAssignment error:', error);
        return { error: 'Failed to move the assignment. Please try again.' };
      }
    },
    async reorderModules() {
      try {
        await ClassmojiService.module.reorderModules(classroom.id, data.orderedModuleIds ?? []);
        return { success: 'Modules reordered' };
      } catch (error: unknown) {
        console.error('Module reorderModules error:', error);
        return { error: 'Failed to reorder modules. Please try again.' };
      }
    },
  });
};

/**
 * The Modules page is the coursework workspace: one expandable card per
 * module, expanded by default, showing and managing its repositories,
 * assignments and content in place. Nothing needs the module detail page.
 */
const ModulesIndex = ({ loaderData }: Route.ComponentProps) => {
  const { modules, candidates, repositories, slidesUrl, boundQuizIds, boundFormIds, tags } =
    loaderData;
  const { class: classSlug } = useParams();
  const orderFetcher = useFetcher<{ success?: string; error?: string }>();
  const [query, setQuery] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  // Every module starts expanded; the user collapses what they are done with.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const cards = modules as unknown as ModuleCardData[];
  const searching = Boolean(query.trim());

  // Cards are dragged into order on the page. A reorder rewrites every
  // position at once, so it has to see the whole list: dragging is off while a
  // search hides part of it.
  const drag = useDragReorder(
    cards,
    orderedModuleIds =>
      orderFetcher.submit(JSON.stringify({ orderedModuleIds }), {
        method: 'post',
        action: `/admin/${classSlug}/modules?/reorderModules`,
        encType: 'application/json',
      }),
    !searching
  );

  const filtered = useMemo(
    () =>
      searching
        ? drag.ordered.filter(m => m.title.toLowerCase().includes(query.trim().toLowerCase()))
        : drag.ordered,
    [drag.ordered, query, searching]
  );

  // The rows every card holds, in one place: a page or an assignment dragged
  // out of one module and into another is a single gesture across two cards,
  // so the page owns that state rather than each card owning its own list.
  // Legacy REPOSITORY items are a pre-assignment pointer nobody renders.
  const lists = useMemo(
    () =>
      cards.map(m => ({
        id: m.id,
        content: m.items.filter(i => i.item_type !== 'REPOSITORY'),
        assignments: m.assignments,
      })),
    [cards]
  );

  const submitMove = ({ scope, rowId, toModuleId, orderedIds }: CourseworkMove) =>
    orderFetcher.submit(
      JSON.stringify(
        scope === 'content'
          ? { moduleItemId: rowId, toModuleId, orderedItemIds: orderedIds }
          : { assignmentId: rowId, toModuleId, orderedAssignmentIds: orderedIds }
      ),
      {
        method: 'post',
        action: `/admin/${classSlug}/modules?/${scope === 'content' ? 'moveItem' : 'moveAssignment'}`,
        encType: 'application/json',
      }
    );

  const coursework = useCourseworkDrag({ lists, onMove: submitMove });
  const allCollapsed = filtered.length > 0 && filtered.every(m => collapsed.has(m.id));

  const toggle = (id: string) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const quizSet = useMemo(() => new Set(boundQuizIds), [boundQuizIds]);
  const formSet = useMemo(() => new Set(boundFormIds), [boundFormIds]);

  return (
    <div className="min-h-full relative">
      <div className="flex flex-col gap-3 mt-2 mb-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Modules</h1>

        <div className="flex items-center gap-3">
          <SearchInput
            query={query}
            setQuery={setQuery}
            placeholder="Search by title"
            className="flex-1 min-w-0 sm:grow-0 sm:basis-56"
          />
          <Button
            onClick={() =>
              setCollapsed(allCollapsed ? new Set() : new Set(filtered.map(m => m.id)))
            }
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </Button>
          <RequireRole roles={['OWNER']}>
            <ButtonNew action={() => setFormOpen(true)}>New module</ButtonNew>
          </RequireRole>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        {filtered.map(m => (
          <ModuleCard
            key={m.id}
            module={m}
            index={drag.ordered.indexOf(m)}
            classSlug={classSlug!}
            slidesUrl={slidesUrl}
            expanded={!collapsed.has(m.id)}
            onToggle={() => toggle(m.id)}
            candidates={candidates}
            repositories={repositories}
            boundQuizIds={quizSet}
            boundFormIds={formSet}
            tags={tags}
            coursework={coursework.forModule(m.id)}
            dragProps={drag.rowProps(m.id)}
            dragHandleProps={drag.handleProps(m.id)}
            dragClassName={dragRowClass(m.id, drag.draggingId, drag.dropTarget)}
          />
        ))}

        {filtered.length === 0 && (
          <div className="rounded-2xl bg-panel ring-1 ring-line text-center py-12 text-gray-500">
            <div className="font-medium">
              {query ? `No modules found matching '${query}'` : 'No modules yet'}
            </div>
            <div className="text-sm">
              {query
                ? 'Try adjusting your search terms.'
                : 'A module is a unit of your course. Add one, then add assignments, pages and slides to it.'}
            </div>
          </div>
        )}

        <RequireRole roles={['OWNER']}>
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="flex w-full items-center gap-3 py-2 text-sm text-ink-3 hover:text-ink-1"
          >
            <span className="h-px flex-1 border-t border-dashed border-line" />
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <IconPlus size={14} />
              Add module
            </span>
            <span className="h-px flex-1 border-t border-dashed border-line" />
          </button>
        </RequireRole>
      </div>{' '}
      <ModuleFormModal open={formOpen} module={null} onClose={() => setFormOpen(false)} />
    </div>
  );
};

export default ModulesIndex;
