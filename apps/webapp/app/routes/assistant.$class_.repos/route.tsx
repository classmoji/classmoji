// An assistant sees the repositories the way the owner does — the same folder
// tree, the same rows — but cannot change any of them. This route reuses the
// admin page's component and lets it render read-only: `canEdit` there is false
// outside /admin, which drops Edit, Publish/Sync and the overflow menu holding
// Autograde, Update student repositories and Delete. View and search remain.
//
// Only the loader differs, and only in who it admits. The admin loader is
// OWNER-only; this one opens the same reads to the teaching team. The admin
// ACTION is deliberately not re-exported: every write stays on /admin, behind
// requireClassroomAdmin, so a read-only surface has nothing to post to.
//
// The teaching team sees EVERY repository and assignment, published or not — a
// teacher prepping next term has nothing but drafts, and filtering them out
// left this page empty for the people meant to be building it. Drafts are
// marked as such in the view rather than hidden.
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export { default } from '../admin.$class.repos/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const { class: classSlug } = params;

  // Named so a denial is identifiable rather than the shared default
  // 'TEACHING_RESOURCE'/'access'. 'REPOSITORIES' is the vocabulary the MCP repo
  // tools already write.
  const { classroom } = await requireClassroomTeachingTeam(request, classSlug!, {
    resourceType: 'REPOSITORIES',
    action: 'view_repos',
  });

  const [repositories, assignments, modules, candidates] = await Promise.all([
    ClassmojiService.repository.findByClassroomSlug(classSlug!),
    ClassmojiService.assignment.listForClassroom(classroom.id),
    ClassmojiService.module.findByClassroomSlug(classSlug!),
    ClassmojiService.module.getCandidateContent(classroom.id),
  ]);

  // Same shape as the admin loader: the component reads all of it, and the
  // editor context stays harmless on a surface with no editors.
  return {
    repositories,
    editor: {
      assignments,
      modules: modules.map(m => ({ id: m.id, title: m.title })),
      quizzes: candidates.quizzes,
      forms: candidates.forms,
      pages: candidates.pages,
      slides: candidates.slides,
    },
  };
};
