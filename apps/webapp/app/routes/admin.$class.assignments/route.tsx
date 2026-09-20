import { useMemo, useState } from 'react';
import { useFetcher, useParams } from 'react-router';
import { Button, Select } from 'antd';
import { IconPlus } from '@tabler/icons-react';
import { namedAction } from 'remix-utils/named-action';

import { SearchInput } from '~/components';
import AssignmentsTable, {
  type AssignmentRowData,
} from '~/components/features/assignments/AssignmentsTable';
import AssignmentFormModal from '~/components/features/assignments/AssignmentFormModal';
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'ASSIGNMENTS',
    action: 'view_assignments',
  });

  const [assignments, modules, repositories, candidates] = await Promise.all([
    ClassmojiService.assignment.listForClassroom(classroom.id),
    ClassmojiService.module.findByClassroomSlug(classSlug!),
    ClassmojiService.repository.findByClassroomSlug(classSlug!),
    ClassmojiService.module.getCandidateContent(classroom.id),
  ]);

  return {
    assignments,
    modules: modules.map(m => ({ id: m.id, title: m.title, slug: m.slug, position: m.position })),
    repositories: repositories.map(r => ({
      id: r.id,
      title: r.title,
      is_published: r.is_published,
    })),
    quizzes: candidates.quizzes,
    forms: candidates.forms,
    pages: candidates.pages,
    slides: candidates.slides,
  };
};

export const action = async ({ params, request }: Route.ActionArgs) => {
  const { class: classSlug } = params;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'ASSIGNMENTS',
    action: 'manage_assignments',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();

  return namedAction(request, {
    async create() {
      try {
        const created = await ClassmojiService.assignment.createInClassroom(classroom.id, data);
        return { success: `Assignment "${created.title}" created` };
      } catch (error: unknown) {
        console.error('Assignment create error:', error);
        return { error: error instanceof Error ? error.message : 'Failed to create assignment' };
      }
    },
    async update() {
      try {
        const { id, ...updates } = data;
        const updated = await ClassmojiService.assignment.updateInClassroom(
          id,
          classroom.id,
          updates
        );
        return { success: `Assignment "${updated.title}" updated` };
      } catch (error: unknown) {
        console.error('Assignment update error:', error);
        return { error: error instanceof Error ? error.message : 'Failed to update assignment' };
      }
    },
    async delete() {
      try {
        await ClassmojiService.assignment.deleteInClassroom(data.id, classroom.id);
        return { success: 'Assignment deleted' };
      } catch (error: unknown) {
        console.error('Assignment delete error:', error);
        return { error: error instanceof Error ? error.message : 'Failed to delete assignment' };
      }
    },
  });
};

const AdminAssignments = ({ loaderData }: Route.ComponentProps) => {
  const { assignments, modules, repositories, quizzes, forms, pages, slides } = loaderData;
  const { class: classSlug } = useParams();
  const deleteFetcher = useFetcher<{ success?: string; error?: string }>();

  const [query, setQuery] = useState('');
  const [moduleFilter, setModuleFilter] = useState<string | undefined>();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<AssignmentRowData | null>(null);

  const rows = assignments as unknown as AssignmentRowData[];

  const visible = useMemo(
    () =>
      rows.filter(
        a =>
          (!moduleFilter || a.module.id === moduleFilter) &&
          (!query.trim() || a.title.toLowerCase().includes(query.trim().toLowerCase()))
      ),
    [rows, moduleFilter, query]
  );

  // Non-extra-credit weight across the whole class. It need not be 100, but
  // instructors usually aim for it, so the total is shown with that cue.
  const weightTotal = rows
    .filter(a => !a.is_extra_credit && a.is_published)
    .reduce((sum, a) => sum + a.weight, 0);

  const boundQuizIds = new Set(rows.map(a => a.quiz?.id).filter(Boolean) as string[]);
  const boundFormIds = new Set(rows.map(a => a.form?.id).filter(Boolean) as string[]);

  const openNew = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (a: AssignmentRowData) => {
    setEditing(a);
    setModalOpen(true);
  };
  const remove = (a: AssignmentRowData) =>
    deleteFetcher.submit(JSON.stringify({ id: a.id }), {
      method: 'post',
      action: `/admin/${classSlug}/assignments?/delete`,
      encType: 'application/json',
    });

  return (
    <div className="min-h-full relative">
      <div className="flex flex-col gap-3 mt-2 mb-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Assignments</h1>
        <div className="flex items-center gap-3">
          <SearchInput
            query={query}
            setQuery={setQuery}
            placeholder="Search by title"
            className="flex-1 min-w-0 sm:grow-0 sm:basis-56"
          />
          <Select
            allowClear
            placeholder="All modules"
            className="min-w-44"
            value={moduleFilter}
            onChange={setModuleFilter}
            options={modules.map(m => ({ value: m.id, label: m.title }))}
          />
          <Button type="primary" icon={<IconPlus size={16} />} onClick={openNew}>
            New assignment
          </Button>
        </div>
      </div>

      <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        <AssignmentsTable
          assignments={visible}
          classSlug={classSlug!}
          onEdit={openEdit}
          onDelete={remove}
          busy={deleteFetcher.state !== 'idle'}
        />
        {rows.length > 0 && (
          <div className="mt-4 flex items-center justify-end gap-2 text-sm text-ink-2">
            <span>Published weight total (excluding extra credit):</span>
            <span
              className={`font-semibold tabular-nums ${
                Math.round(weightTotal * 10) / 10 === 100 ? 'text-green-600' : 'text-amber-600'
              }`}
            >
              {Math.round(weightTotal * 10) / 10}%
            </span>
          </div>
        )}
      </div>

      <AssignmentFormModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        classSlug={classSlug!}
        modules={modules}
        repositories={repositories}
        quizzes={quizzes}
        forms={forms}
        pages={pages}
        slides={slides}
        boundQuizIds={boundQuizIds}
        boundFormIds={boundFormIds}
        assignment={editing}
      />
    </div>
  );
};

export default AdminAssignments;
