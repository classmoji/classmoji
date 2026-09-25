// An assistant sees the coursework the way the owner does — the same modules,
// the same cards, the same rows — and can open an assignment to read its
// submissions. What they cannot do is change any of it, so this route reuses
// the admin page's component and lets it render read-only: `canEdit` there is
// false outside /admin, which drops the drag handles, Edit, the row and module
// menus, the publish switch and "Add item".
//
// Only the loader differs, and only in who it admits. The admin loader is
// OWNER-only; this one opens the same reads to the teaching team. The admin
// ACTION is deliberately not re-exported: every write stays on /admin, behind
// requireClassroomAdmin, so a read-only surface has nothing to post to.
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export { default } from '../admin.$class.modules/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomTeachingTeam(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_modules',
  });

  const [modules, candidates, allAssignments, repositories, tags] = await Promise.all([
    ClassmojiService.module.listModuleContentsForClassroom(classroom.id),
    ClassmojiService.module.getCandidateContent(classroom.id),
    ClassmojiService.assignment.listForClassroom(classroom.id),
    ClassmojiService.repository.findByClassroomId(classroom.id),
    ClassmojiService.organizationTag.findByClassroomId(classroom.id),
  ]);

  // Same shape as the admin loader: the component reads all of it, and the
  // picker data stays harmless on a surface with no pickers.
  return {
    modules,
    candidates,
    repositories: repositories.map(r => ({
      id: r.id,
      title: r.title,
      slug: r.slug,
      type: r.type,
      is_published: r.is_published,
    })),
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    tags: tags.map(t => ({ id: t.id, name: t.name })),
    boundQuizIds: allAssignments.map(a => a.quiz_id).filter(Boolean) as string[],
    boundFormIds: allAssignments.map(a => a.form_id).filter(Boolean) as string[],
  };
};
