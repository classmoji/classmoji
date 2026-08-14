import { getAuthSession } from '@classmoji/auth/server';
import { checkAuth } from '~/utils/helpers';
import {
  ClassmojiService,
  GitHubProvider,
  getGitProvider,
  ensureClassroomTeam,
} from '@classmoji/services';
import {
  applyPhaseUpdates,
  buildInitialProgress,
  buildSummaryParts,
  withCounts,
  withIdMaps,
  type ImportPhaseCounts,
  type ImportPhaseSelections,
  type ImportProgress,
  type ImportSummaryCounts,
} from '@classmoji/services/import-progress';
import Tasks from '@classmoji/tasks';
import { ActionTypes } from '~/constants';
import getPrisma from '@classmoji/database';
import {
  defaultContentRepoName,
  sanitizeRepoName,
  suggestContentNamespace,
} from '@classmoji/utils';
import { slugify } from './utils';

/** Background work needs Trigger.dev; without it the async phases can't run. */
const isTriggerConfigured = () =>
  Boolean(process.env.TRIGGER_SECRET_KEY || process.env.TRIGGER_ACCESS_TOKEN);

/**
 * Pick a free internal content namespace for a new classroom in this org.
 *
 * content_namespace no longer names anything on GitHub (content_repo does), but
 * it keeps a [git_org_id, content_namespace] unique constraint and is no longer
 * user-editable — so a collision has to be resolved silently here instead of
 * being handed back as an error the user has no field to fix. Candidates, in
 * order: the org-prefix-stripped slug, the raw slug (unique per org), then
 * numeric suffixes.
 */
async function pickContentNamespace(gitOrgId: string, orgLogin: string, slug: string) {
  const suggested = suggestContentNamespace({ orgLogin, slug });
  const candidates = [suggested, slug, ...Array.from({ length: 20 }, (_, i) => `${slug}-${i + 2}`)];

  const taken = new Set(
    (
      await getPrisma().classroom.findMany({
        where: { git_org_id: gitOrgId, content_namespace: { in: candidates } },
        select: { content_namespace: true },
      })
    ).map(c => c.content_namespace)
  );

  return candidates.find(c => !taken.has(c)) ?? `${slug}-${Date.now()}`;
}

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
    content_repo: contentRepoInput,
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

  // Internal identifier only — names no repo, and no longer user-editable.
  const contentNamespace = await pickContentNamespace(git_org_id, gitOrg.login, slug);

  // Content repo: the user's name when supplied, else `content-{namespace}`.
  // Sanitized to what GitHub accepts so the stored name and the real repo can
  // never diverge; an input that sanitizes away entirely falls back to the
  // default rather than storing an empty name.
  const contentRepo =
    (typeof contentRepoInput === 'string' ? sanitizeRepoName(contentRepoInput) : '') ||
    defaultContentRepoName(contentNamespace);

  // Two classrooms in one org sharing a content repo would share (and could
  // overwrite or delete) each other's content. The DB unique constraint
  // backstops the race; this check gives a friendly error.
  const repoTaken = await getPrisma().classroom.findFirst({
    where: { git_org_id, content_repo: contentRepo },
    select: { slug: true },
  });
  if (repoTaken) {
    return {
      error: `Content repo '${contentRepo}' is already used by classroom '${repoTaken.slug}' in this organization — pick a different name`,
    };
  }

  // The content repo must be created FRESH. ensureContentRepo adopts a repo
  // that already exists rather than failing, so an existing name here would
  // silently make a student/template repo into this classroom's content repo
  // (and a later classroom delete would offer to delete it). Refuse up front.
  // Availability is best-effort: a failed check (network, rate limit) must not
  // block creation — the DB constraint and ensure behavior are unchanged.
  try {
    await octokit.rest.repos.get({ owner: gitOrg.login, repo: contentRepo });
    return {
      error: `Repository '${contentRepo}' already exists in ${gitOrg.login} — content repos must be created fresh; pick another name`,
    };
  } catch (error: unknown) {
    if ((error as { status?: number })?.status !== 404) {
      console.warn(
        `Could not verify content repo availability for ${gitOrg.login}/${contentRepo}:`,
        error instanceof Error ? error.message : error
      );
    }
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
          content_repo: contentRepo,
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
    // Unique-constraint race (slug, content repo, or the internal namespace
    // claimed between the pre-checks and the insert) — refuse cleanly
    // instead of a 500.
    if ((error as { code?: string })?.code === 'P2002') {
      return {
        error:
          'That classroom slug or content repo was just taken in this organization — adjust and try again',
      };
    }
    throw error;
  }

  // Import from a source classroom if configured.
  //
  // SPLIT BY COST, not by phase order. Everything that is pure DB and finishes
  // in seconds runs here, inside the request: the settings/scales/calendar copy
  // and the repository(+assignment/quiz) clone. Everything that talks to GitHub
  // — template duplication, the content-repo copy, and the modules phase that
  // depends on the ids those mint — is handed to the `classroom-import`
  // Trigger.dev task, and this action returns as soon as the job row exists.
  // Before that split a real course pinned this request for 40+ minutes.
  let importResult = null;
  let configSummary: {
    settings_fields: string[];
    emoji_mappings: number;
    letter_grade_mappings: number;
    calendar_events: number;
  } | null = null;
  const importWarnings: string[] = [];
  /** Source repositories that survived the ownership filter (drives templates). */
  let repoConfigs: Array<{ id: string; includeQuizzes?: boolean }> = [];

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
      repoConfigs = requestedRepos.filter(r => sourceRepoIds.has(r.id));
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

  // ── Hand the GitHub-bound phases to the background task ────────────────────
  // Templates only matter if repositories were actually cloned — there is
  // nothing to duplicate or relink otherwise.
  const wantsTemplates =
    !!contentSelections.duplicateTemplates && (importResult?.repositories.length ?? 0) > 0;
  const wantsPages = !!contentSelections.pages;
  const wantsSlides = !!contentSelections.slides;
  const wantsModules = !!contentSelections.modules;
  const hasBackgroundWork =
    importRequested &&
    !!sourceClassroomId &&
    (wantsTemplates || wantsPages || wantsSlides || wantsModules);

  /** What THIS request imported — seeded onto the job so the final line is whole. */
  const syncCounts: ImportSummaryCounts = {
    repositories: importResult?.repositories.length ?? 0,
    assignments: importResult?.assignments.length ?? 0,
    quizzes: importResult?.quizzes.length ?? 0,
    settings: (configSummary?.settings_fields.length ?? 0) > 0,
    grade_mappings:
      (configSummary?.emoji_mappings ?? 0) + (configSummary?.letter_grade_mappings ?? 0),
    calendar_events: configSummary?.calendar_events ?? 0,
  };

  let importJobId: string | null = null;
  if (hasBackgroundWork) {
    // Cheap totals so the bars are sized before the task even starts — an
    // unsized bar is the thing that makes a slow import look broken. The task
    // re-reports the real total when each phase begins.
    const [sourcePages, sourceSlides, templateRows] = await Promise.all([
      wantsPages
        ? getPrisma().page.count({ where: { classroom_id: sourceClassroomId } })
        : Promise.resolve(0),
      wantsSlides
        ? getPrisma().slide.count({ where: { classroom_id: sourceClassroomId } })
        : Promise.resolve(0),
      wantsTemplates
        ? getPrisma().repository.findMany({
            where: { id: { in: repoConfigs.map(r => r.id) } },
            select: { template: true },
          })
        : Promise.resolve([] as Array<{ template: string | null }>),
    ]);

    const phaseSelections: ImportPhaseSelections = {
      config: anyConfigSelected,
      repositories: repoConfigs.length > 0,
      templates: wantsTemplates,
      pages: wantsPages,
      slides: wantsSlides,
      modules: wantsModules,
    };
    const phaseCounts: ImportPhaseCounts = {
      repositories: importResult?.repositories.length ?? 0,
      // Distinct templates, not rows: several assignments commonly share one.
      templates: ClassmojiService.templateImport.groupTemplateRefs(templateRows, gitOrg.login)
        .length,
      pages: sourcePages,
      slides: sourceSlides,
    };

    let progress: ImportProgress = buildInitialProgress(phaseSelections, phaseCounts);
    // The two phases this request already finished are recorded as done up
    // front, so the banner opens showing real completed work rather than an
    // empty bar that has to catch up.
    progress = applyPhaseUpdates(progress, [
      ...(anyConfigSelected
        ? [
            {
              phase: 'config' as const,
              status: 'done' as const,
              summary:
                buildSummaryParts({
                  settings: syncCounts.settings,
                  grade_mappings: syncCounts.grade_mappings,
                  calendar_events: syncCounts.calendar_events,
                }).join(', ') || 'nothing to copy',
            },
          ]
        : []),
      ...(repoConfigs.length > 0
        ? [
            {
              phase: 'repositories' as const,
              status: 'done' as const,
              done: importResult?.repositories.length ?? 0,
              total: importResult?.repositories.length ?? 0,
            },
          ]
        : []),
    ]);
    // The ids the modules phase will remap onto. They exist only in this
    // request's memory, so the row is the only way they reach the task.
    progress = withIdMaps(progress, {
      repositories: importResult?.idMaps.repositories ?? {},
      quizzes: importResult?.idMaps.quizzes ?? {},
    });
    progress = withCounts(progress, syncCounts);

    try {
      const job = await getPrisma().importJob.create({
        data: {
          classroom_id: classroom.id,
          source_classroom_id: sourceClassroomId,
          requested_by: user.id,
          status: 'PENDING',
          selections: {
            config: configSelections,
            repositories: repoConfigs,
            content: contentSelections,
          },
          progress: progress as unknown as object,
          warnings: importWarnings as unknown as object,
        },
      });
      importJobId = job.id;

      if (!isTriggerConfigured()) {
        // No worker to pick this up. Fail the job immediately rather than leave
        // a PENDING row the banner would poll forever.
        await getPrisma().importJob.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            error: 'The background job service (Trigger.dev) is not configured here.',
          },
        });
        importWarnings.push('background import service unavailable — import not started');
      } else {
        await Tasks.classroomImportTask.trigger({ importJobId: job.id });
      }
    } catch (error: unknown) {
      // The classroom itself is fine and everything synchronous already landed,
      // so this is a warning on a successful create — never an error response.
      console.error('Error starting the background import:', error);
      if (importJobId) {
        await getPrisma()
          .importJob.update({
            where: { id: importJobId },
            data: {
              status: 'FAILED',
              error: error instanceof Error ? error.message : String(error),
            },
          })
          .catch(() => {});
      }
      importWarnings.push('could not start the background import');
    }
  }

  // Build success message — only what this request actually imported. The
  // background phases report themselves through the progress banner.
  const syncParts = buildSummaryParts(syncCounts);
  let successMessage =
    syncParts.length > 0
      ? `Classroom created with ${syncParts.join(', ')} imported!`
      : 'Classroom created successfully!';
  if (importJobId) {
    successMessage += ' Import continuing in the background.';
  }
  if (importWarnings.length > 0) {
    successMessage += ` (${importWarnings.length} item${importWarnings.length === 1 ? '' : 's'} skipped — see server logs)`;
  }

  return {
    success: successMessage,
    action: ActionTypes.CREATE_CLASSROOM,
    classroomSlug: classroom.slug,
    import_job_id: importJobId,
    import_warnings: importWarnings,
  };
});
