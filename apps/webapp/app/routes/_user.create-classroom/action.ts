import { getAuthSession } from '@classmoji/auth/server';
import { checkAuth } from '~/utils/helpers';
import {
  ClassmojiService,
  GitHubProvider,
  getGitProvider,
  ensureClassroomTeam,
} from '@classmoji/services';
import { ActionTypes } from '~/constants';
import getPrisma from '@classmoji/database';
import { maxContentNamespaceLength, suggestContentNamespace } from '@classmoji/utils';
import { slugify } from './utils';

export const action = checkAuth(async ({ request }: { request: Request }) => {
  const authData = await getAuthSession(request);
  const octokit = GitHubProvider.getUserOctokit(authData!.token!);

  // Get authenticated user
  const { data: authenticatedUser } = await octokit.rest.users.getAuthenticated();
  const user = await ClassmojiService.user.findByLogin(authenticatedUser.login);

  if (!user) {
    return { error: 'Unauthorized' };
  }

  const {
    git_org_id,
    name,
    slug: slugInput,
    content_namespace: namespaceInput,
    importConfig,
  } = await request.json();

  if (!name) {
    return { error: 'Classroom name is required' };
  }

  // Get GitOrganization
  const gitOrg = await getPrisma().gitOrganization.findUnique({
    where: { id: git_org_id },
  });

  if (!gitOrg) {
    return { error: 'GitHub organization not found' };
  }

  // Verify user is admin in the selected organization using GraphQL
  try {
    const { organization } = await octokit.graphql<any>(
      `
      query($login: String!) {
        organization(login: $login) {
          login
          viewerCanAdminister
        }
      }
    `,
      {
        login: gitOrg.login,
      }
    );

    if (!organization?.viewerCanAdminister) {
      return {
        error: 'You must be an organization admin to create a classroom',
      };
    }
  } catch (error: unknown) {
    console.error('Error checking org membership:', error instanceof Error ? error.message : error);
    return {
      error: 'Unable to verify organization membership',
    };
  }

  // Slug: prefer client-provided (user override / suggestion) when present, else derive from name.
  const slug = slugInput && typeof slugInput === 'string' ? slugify(slugInput) : slugify(name);

  // Content namespace (names the classroom's content repo,
  // `content-{orgLogin}-{namespace}`): client-provided override when present,
  // else the org-prefix-stripped slug — never the raw slug, which doubles the
  // org name in the repo whenever the slug starts with the course/org name.
  const contentNamespace =
    namespaceInput && typeof namespaceInput === 'string' && slugify(namespaceInput).length > 0
      ? slugify(namespaceInput)
      : suggestContentNamespace({ orgLogin: gitOrg.login, slug });

  if (contentNamespace.length > maxContentNamespaceLength(gitOrg.login)) {
    return {
      error: `Content namespace is too long — keep it under ${maxContentNamespaceLength(gitOrg.login)} characters so the content repo name fits GitHub's limit`,
    };
  }

  // The namespace names the content repo (content-{org}-{namespace}); a
  // collision would make two classrooms share one repo. The DB unique
  // constraint backstops the race; this check gives a friendly error.
  const namespaceTaken = await getPrisma().classroom.findFirst({
    where: { git_org_id, content_namespace: contentNamespace },
    select: { slug: true },
  });
  if (namespaceTaken) {
    return {
      error: `Content namespace '${contentNamespace}' is already used by classroom '${namespaceTaken.slug}' in this organization — pick a different one`,
    };
  }

  // ALL validation that can refuse creation must run BEFORE the transaction —
  // returning an error after it leaves an orphaned classroom that also blocks
  // a same-slug retry. Source-ownership for imports is part of that gate.
  const sourceClassroomId: string | undefined = importConfig?.sourceClassroomId;
  const configSelections = importConfig?.config ?? {};
  const contentSelections = importConfig?.content ?? {};
  const anyConfigSelected = Object.values(configSelections).some(Boolean);
  const anyContentSelected = Object.values(contentSelections).some(Boolean);
  const requestedRepos: Array<{ id: string; includeQuizzes?: boolean }> =
    importConfig?.repositories ?? [];
  const importRequested =
    !!sourceClassroomId && (requestedRepos.length > 0 || anyConfigSelected || anyContentSelected);

  if (importRequested) {
    // The picker only OFFERS owned classrooms, but every id here arrives from
    // the request body — re-verify ownership server-side before copying
    // anything (settings can carry API keys; content must not be exfiltrated
    // from classrooms the requester doesn't own).
    const sourceMembership = await getPrisma().classroomMembership.findFirst({
      where: { classroom_id: sourceClassroomId, user_id: user.id, role: 'OWNER' },
    });
    if (!sourceMembership) {
      return { error: 'You must own the source classroom to import from it' };
    }
  }

  // Create Classroom, Settings, and Membership in transaction
  let classroom;
  try {
    classroom = await getPrisma().$transaction(async tx => {
      const created = await tx.classroom.create({
        data: {
          git_org_id,
          slug,
          name,
          content_namespace: contentNamespace,
        },
      });

      await tx.classroomSettings.create({
        data: { classroom_id: created.id },
      });

      await tx.classroomMembership.create({
        data: {
          classroom_id: created.id,
          user_id: user.id,
          role: 'OWNER',
          has_accepted_invite: true,
        },
      });

      return created;
    });
  } catch (error: unknown) {
    // Unique-constraint race (slug or content namespace claimed between the
    // pre-checks and the insert) — refuse cleanly instead of a 500.
    if ((error as { code?: string })?.code === 'P2002') {
      return {
        error:
          'That classroom slug or content namespace was just taken in this organization — adjust and try again',
      };
    }
    throw error;
  }

  // Import from a source classroom if configured. Phases (each best-effort,
  // logged, never fails classroom creation): 1 settings/scales/calendar,
  // 2 repositories(+assignments/quizzes), 3 pages/slides content,
  // 4 module containers last (they remap onto the ids minted in 2 and 3).
  let importResult = null;
  let configSummary: {
    settings_fields: string[];
    emoji_mappings: number;
    letter_grade_mappings: number;
    calendar_events: number;
  } | null = null;
  let contentSummary: {
    pages: number;
    slides: number;
    page_id_map: Record<string, string>;
    slide_id_map: Record<string, string>;
    warnings: string[];
  } | null = null;
  let modulesSummary: { modules: number; items: number; skipped_items: number } | null = null;
  const importWarnings: string[] = [];

  if (importRequested && sourceClassroomId) {
    if (anyConfigSelected) {
      try {
        configSummary = await ClassmojiService.classroomConfigImport.importClassroomConfig(
          sourceClassroomId,
          classroom.id,
          user.id,
          configSelections
        );
      } catch (error: unknown) {
        console.error('Error importing classroom settings:', error);
        importWarnings.push('settings copy failed');
      }
    }

    if (requestedRepos.length > 0) {
      // Repositories must belong to the (ownership-verified) source classroom.
      const sourceRepoIds = new Set(
        (
          await getPrisma().repository.findMany({
            where: { classroom_id: sourceClassroomId },
            select: { id: true },
          })
        ).map(r => r.id)
      );
      const repoConfigs = requestedRepos.filter(r => sourceRepoIds.has(r.id));
      if (repoConfigs.length !== requestedRepos.length) {
        importWarnings.push('repositories outside the source classroom were skipped');
      }
      if (repoConfigs.length > 0) {
        try {
          importResult = await ClassmojiService.repositoryImport.cloneModulesWithRelations(
            classroom.id,
            repoConfigs,
            { stripDeadlines: true }
          );
        } catch (error: unknown) {
          console.error('Error importing repositories:', error);
          importWarnings.push('repository copy failed');
        }
      }
    }

    if (contentSelections.pages || contentSelections.slides) {
      try {
        contentSummary = await ClassmojiService.contentImport.importClassroomContent(
          sourceClassroomId,
          classroom.id,
          user.id,
          { pages: !!contentSelections.pages, slides: !!contentSelections.slides }
        );
        importWarnings.push(...(contentSummary?.warnings ?? []));
      } catch (error: unknown) {
        console.error('Error importing pages/slides content:', error);
        importWarnings.push('page/slide content copy failed');
      }
    }

    if (contentSelections.modules) {
      try {
        modulesSummary = await ClassmojiService.classroomConfigImport.importModules(
          sourceClassroomId,
          classroom.id,
          {
            repositories: importResult?.idMaps?.repositories ?? {},
            quizzes: importResult?.idMaps?.quizzes ?? {},
            pages: contentSummary?.page_id_map ?? {},
            slides: contentSummary?.slide_id_map ?? {},
          }
        );
      } catch (error: unknown) {
        console.error('Error importing modules:', error);
        importWarnings.push('module copy failed');
      }
    }
  }

  // Create per-classroom GitHub teams (e.g., "cs101-25w-students", "cs101-25w-assistants")
  const gitProvider = getGitProvider(gitOrg);

  try {
    await ensureClassroomTeam(gitProvider, gitOrg.login, classroom, 'STUDENT');
  } catch (error: unknown) {
    console.error(
      `Failed to create students team: ${error instanceof Error ? error.message : error}`
    );
  }

  try {
    await ensureClassroomTeam(gitProvider, gitOrg.login, classroom, 'ASSISTANT');
  } catch (error: unknown) {
    console.error(
      `Failed to create assistants team: ${error instanceof Error ? error.message : error}`
    );
  }

  // Build success message
  let successMessage = 'Classroom created successfully!';
  {
    const plural = (n: number, singular: string, pluralForm = `${singular}s`) =>
      `${n} ${n === 1 ? singular : pluralForm}`;
    const parts: string[] = [];
    if (importResult) {
      if (importResult.repositories.length > 0)
        parts.push(plural(importResult.repositories.length, 'repository', 'repositories'));
      if (importResult.assignments.length > 0)
        parts.push(plural(importResult.assignments.length, 'assignment'));
      if (importResult.quizzes.length > 0)
        parts.push(plural(importResult.quizzes.length, 'quiz', 'quizzes'));
    }
    if (configSummary) {
      if (configSummary.settings_fields.length > 0) parts.push('settings');
      const scales = configSummary.emoji_mappings + configSummary.letter_grade_mappings;
      if (scales > 0) parts.push(plural(scales, 'grade mapping'));
      if (configSummary.calendar_events > 0)
        parts.push(plural(configSummary.calendar_events, 'calendar event'));
    }
    if (contentSummary) {
      if (contentSummary.pages > 0) parts.push(plural(contentSummary.pages, 'page'));
      if (contentSummary.slides > 0) parts.push(plural(contentSummary.slides, 'slide deck'));
    }
    if (modulesSummary && modulesSummary.modules > 0) {
      parts.push(plural(modulesSummary.modules, 'module'));
    }
    if (parts.length > 0) {
      successMessage = `Classroom created with ${parts.join(', ')} imported!`;
    }
    if (importWarnings.length > 0) {
      successMessage += ` (${importWarnings.length} item${importWarnings.length === 1 ? '' : 's'} skipped — see server logs)`;
    }
  }

  return {
    success: successMessage,
    action: ActionTypes.CREATE_CLASSROOM,
    classroomSlug: classroom.slug,
    import_warnings: importWarnings,
  };
});
