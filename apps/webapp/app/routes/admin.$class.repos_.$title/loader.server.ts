// The repository page's data, loaded once and served to two routes.
//
// It lives outside the route module because React Router only strips
// `loader`, `action`, `middleware` and `headers` from a route's client bundle.
// A loader FACTORY exported from the route file is none of those, so its
// `~/utils/routeAuth.server` import would follow the component into the
// browser. Here, behind `.server`, both routes import a ready-made loader and
// the whole module drops out of the client build with their `loader` export.
import { ClassmojiService } from '@classmoji/services';
import { requireClassroomAdmin, requireClassroomTeachingTeam } from '~/utils/routeAuth.server';
import type { LinkedPage } from './LinkedPages';

type LoaderArgs = { params: Record<string, string | undefined>; request: Request };

/**
 * The repository page's loader, with the access gate left open.
 *
 * Everything it does is a read, so the assistant route serves the same page
 * from the same query with `requireClassroomTeachingTeam` instead — see
 * `assistant.$class_.repos_.$title`. The gate is the only difference; keeping
 * one loader is what stops the two pages drifting apart. Writes are NOT shared:
 * the action below stays behind requireClassroomAdmin.
 */
export const buildLoader =
  (gate: typeof requireClassroomAdmin | typeof requireClassroomTeachingTeam) =>
  async ({ params, request }: LoaderArgs) => {
    const { class: classSlug, title } = params;

    const { classroom } = await gate(request, classSlug!, {
      resourceType: 'REPOSITORIES',
      action: 'view_module',
    });

    const repository = await ClassmojiService.repository.findBySlugAndTitle(classSlug!, title!, {
      includePages: true,
    });
    const repos = await ClassmojiService.gitRepo.findByRepository(classSlug!, repository!.id);

    // Attach each repo's latest autograding result + the configured test count.
    const latestAutograding = await ClassmojiService.autogradingResult.findLatestByGitRepoIds(
      repos.map(r => r.id)
    );
    const reposWithAutograding = repos.map(r => ({
      ...r,
      autograding_result: latestAutograding.get(r.id) ?? null,
    }));
    const autogradingTestCount = (
      await ClassmojiService.autogradingTest.findByRepositoryId(repository!.id)
    ).length;
    // The grader pool spans every staff role that can be flagged as a grader —
    // ASSISTANT and TEACHER — the same pair the RANDOM bulk assignment draws from.
    // Listing only assistants here would offer a narrower set of options than the
    // graders actually assigned to these repos.
    const assistants = (
      await ClassmojiService.classroomMembership.findUsersByRoles(
        classroom.id,
        ['ASSISTANT', 'TEACHER'],
        { is_grader: true }
      )
    ).filter(({ is_grader }) => is_grader);

    const emojiMappings = await ClassmojiService.emojiMapping.findByClassroomId(classroom.id);

    // The assignments that submit through this repository (with their module),
    // plus what the assignment modal needs to edit one, and the roster size so
    // the header can say how many students have a copy.
    const [allAssignments, modules, repositories, candidates, students] = await Promise.all([
      ClassmojiService.assignment.listForClassroom(classroom.id),
      ClassmojiService.module.findByClassroomSlug(classSlug!),
      ClassmojiService.repository.findByClassroomId(classroom.id),
      ClassmojiService.module.getCandidateContent(classroom.id),
      ClassmojiService.classroomMembership.findUsersByRoles(classroom.id, ['STUDENT']),
    ]);
    const assignments = allAssignments.filter(a => a.repository_id === repository!.id);

    // Linked pages = pages linked to the repository unit + to any of its assignments.
    // PageLink rows carry `.page` (the Page) when includePages is set on the query.
    const linkedPages: LinkedPage[] = [];
    type PageLinkLike = {
      id: string;
      page?: { id: string; title: string; is_draft: boolean; updated_at: Date } | null;
    };
    for (const link of (repository?.pages ?? []) as PageLinkLike[]) {
      if (link.page) {
        linkedPages.push({
          id: link.id,
          pageId: link.page.id,
          title: link.page.title,
          linkedTo: 'linked to repository',
          isDraft: link.page.is_draft,
          updatedAt: link.page.updated_at,
        });
      }
    }
    for (const a of (repository?.assignments ?? []) as Array<{
      title: string;
      pages?: PageLinkLike[];
    }>) {
      for (const link of a.pages ?? []) {
        if (link.page) {
          linkedPages.push({
            id: link.id,
            pageId: link.page.id,
            title: link.page.title,
            linkedTo: `linked to ${a.title}`,
            isDraft: link.page.is_draft,
            updatedAt: link.page.updated_at,
          });
        }
      }
    }

    return {
      repository,
      repos: reposWithAutograding,
      assignments,
      assistants,
      emojiMappings,
      classroom,
      linkedPages,
      autogradingTestCount,
      studentCount: students.length,
      modules: modules.map(m => ({ id: m.id, title: m.title })),
      repositories: repositories.map(r => ({
        id: r.id,
        title: r.title,
        slug: r.slug,
        type: r.type,
        is_published: r.is_published,
      })),
      candidates,
      boundQuizIds: allAssignments.map(a => a.quiz_id).filter(Boolean) as string[],
      boundFormIds: allAssignments.map(a => a.form_id).filter(Boolean) as string[],
    };
  };

/** OWNER only — the /admin repository page. */
export const adminLoader = buildLoader(requireClassroomAdmin);

/** OWNER, TEACHER or ASSISTANT — the same page under /assistant, read-only. */
export const teachingTeamLoader = buildLoader(requireClassroomTeachingTeam);
