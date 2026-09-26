import { getAuthSession } from '@classmoji/auth/server';
import { checkAuth } from '~/utils/helpers';
import {
  ClassmojiService,
  ClassroomSlugUnavailableError,
  GitHubProvider,
  createWithUniqueClassroomSlug,
  getGitProvider,
  ensureClassroomTeam,
} from '@classmoji/services';
import { ActionTypes } from '~/constants';
import getPrisma from '@classmoji/database';
import { canonicalTimeZone, defaultContentRepoName, sanitizeRepoName } from '@classmoji/utils';
import { slugify } from './utils';
import { pickContentNamespace } from './contentNamespace.server';
import { createGitLabClassroom } from './createGitLabClassroom.server';
import { prepareClassroomImport, runClassroomImport } from './importFlow.server';

export const action = checkAuth(async ({ request }: { request: Request }) => {
  const authData = await getAuthSession(request);
  const body = await request.json();

  // A GitLab classroom: its own lean path (connection + group + subgroup).
  if (body?.intent === 'create-gitlab' && authData) {
    return createGitLabClassroom(authData.userId, body);
  }

  if (!authData?.token) {
    return { error: 'Creating a classroom currently requires Github.' };
  }
  const octokit = GitHubProvider.getUserOctokit(authData.token);

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
    timezone: browserTimeZone,
  } = body;

  // The creator's browser zone becomes the course's time zone. Validated
  // against Intl and stored canonically; anything else is dropped (the course
  // simply starts with no zone, which the owner can set in General settings)
  // rather than failing the creation over a rendering preference.
  const initialTimeZone = canonicalTimeZone(browserTimeZone);

  if (!name) {
    return { error: 'Classroom name is required' };
  }

  // Get GitOrganization. Reassigned by the installation guard below, which may
  // hand back a repaired row carrying the installation id (and current login).
  let gitOrg = await getPrisma().gitOrganization.findUnique({
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

  // An org with no installation id cannot be provisioned: `getGitProvider`
  // throws on it, and it throws AFTER the transaction has already created the
  // classroom, its settings and the owner membership — leaving a half-built
  // classroom that also holds the slug the retry wants. Refuse here instead.
  //
  // The id is missing far more often than the app is: rows created GitHub-free
  // by the Classroom ZIP import never had one, and a stale `installation.deleted`
  // could clear one that a reinstall had replaced. So ask GitHub before
  // refusing — most of these are one lookup away from working.
  if (gitOrg.provider === 'GITHUB' && !gitOrg.github_installation_id) {
    // `bypassCooldown` because this is a deliberate form submit, not a poll.
    // The service's 15 s per-org cooldown exists to stop a button being mashed;
    // honouring it here would have refused the create with "GitHub is rate
    // limiting" when GitHub had never been asked — the instructor would have
    // been told to wait on a limit that only ever lived in this process. One
    // GitHub call per create is fine, and the in-flight map still collapses
    // genuinely simultaneous callers into one request.
    const repair = await ClassmojiService.gitOrganization.repairInstallation(gitOrg.id, {
      bypassCooldown: true,
    });

    if (repair.status === 'connected' || repair.status === 'already-connected') {
      if (!repair.org?.github_installation_id) {
        return {
          error: `Connect the Classmoji GitHub app to ${gitOrg.login} before creating a classroom.`,
        };
      }

      // The org admin check above ran against the login as it stood BEFORE the
      // repair. A repaired row can come back under a different login (a rename
      // GitHub reports on the installation), and adopting it here would mean
      // provisioning into an organization nobody verified this user administers.
      // Refuse and make the next attempt re-run the check against the new name.
      if (repair.org.login !== gitOrg.login) {
        return {
          error:
            'The GitHub organization for this classroom has changed name; reload and try again.',
        };
      }

      gitOrg = repair.org;
    } else if (repair.status === 'rate-limited') {
      // With the local cooldown bypassed, this can now only be GitHub's own
      // 403/429 (a `GitHubRateLimitedError` out of the lookup), so the sentence
      // is allowed to name GitHub — which is what it always claimed.
      return {
        error: `GitHub is rate limiting installation checks; try again in ${repair.retryAfterSeconds} seconds.`,
      };
    } else {
      return {
        error: `Connect the Classmoji GitHub app to ${gitOrg.login} before creating a classroom.`,
      };
    }
  }

  // Slug: prefer client-provided (user override / suggestion) when present, else derive from name.
  // The slug is globally unique, so this is only the FIRST candidate — the
  // create below retries down `slug`, `slug-{org}`, `slug-N` and the row's own
  // slug is what gets returned.
  const slug = slugInput && typeof slugInput === 'string' ? slugify(slugInput) : slugify(name);

  // An empty slug is not a URL. Refuse here rather than store one and let the
  // global unique index reject the next classroom that also slugifies to ''.
  if (!slug) {
    return {
      error: 'That name has no letters or numbers to build a URL from — add some, or set a slug',
    };
  }

  // Internal identifier only — names no repo, and no longer user-editable.
  //
  // Deliberately pinned to the ORIGINAL slug and NOT re-derived if the slug
  // retry suffixes it. Both this and `content_repo` below are unique PER ORG,
  // while the slug suffix answers a GLOBAL collision — so the values picked
  // here stay free whatever the slug ends up as. More importantly, `contentRepo`
  // is validated against GitHub further down ("content repos must be created
  // fresh") and may be a name the user typed; re-deriving it inside the retry
  // would create a classroom pointing at a repo name that gate never saw.
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
  const prepared = await prepareClassroomImport(user.id, importConfig);
  if ('error' in prepared) return { error: prepared.error };

  // Create Classroom, Settings, and Membership in transaction.
  //
  // The slug guard wraps the WHOLE `$transaction` call: a P2002 inside an
  // interactive transaction aborts it (Postgres 25P02), so retrying from within
  // would fail every remaining candidate. `classroom.slug` below is therefore
  // the slug that actually won, which is what the response redirects on.
  let classroom;
  try {
    const created = await createWithUniqueClassroomSlug(
      { slug, orgLogin: gitOrg.login },
      classroomSlug =>
        getPrisma().$transaction(async tx => {
          const row = await tx.classroom.create({
            data: {
              git_org_id,
              slug: classroomSlug,
              name,
              content_namespace: contentNamespace,
              content_repo: contentRepo,
            },
          });

          await tx.classroomSettings.create({
            data: { classroom_id: row.id, timezone: initialTimeZone },
          });

          await tx.classroomMembership.create({
            data: {
              classroom_id: row.id,
              user_id: user.id,
              role: 'OWNER',
              has_accepted_invite: true,
            },
          });

          return row;
        })
    );
    classroom = created.result;
  } catch (error: unknown) {
    if (error instanceof ClassroomSlugUnavailableError) {
      return {
        error: `'${slug}' and every variation of it are already taken — pick a different slug`,
      };
    }
    // Unique-constraint race on something the guard does NOT retry: the content
    // repo or the internal namespace, claimed between the pre-checks and the
    // insert. A slug collision is no longer one of these, and the collision can
    // be with a classroom in any organization — the slug is globally unique.
    if ((error as { code?: string })?.code === 'P2002') {
      return {
        error: 'That content repo name was just taken in this organization — adjust and try again',
      };
    }
    throw error;
  }

  // Import from a source classroom if configured (see importFlow.server.ts).
  // The classroom teams are made before the background work is handed off.
  const { successMessage, importJobId, importWarnings, unreachableSourceOrg } =
    await runClassroomImport({
      state: prepared.state,
      classroom,
      gitOrgLogin: gitOrg.login,
      userId: user.id,
      beforeBackground: async () => {
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
      },
    });

  return {
    success: successMessage,
    action: ActionTypes.CREATE_CLASSROOM,
    classroomSlug: classroom.slug,
    import_job_id: importJobId,
    import_warnings: importWarnings,
    /** Source org login when its GitHub App installation was unreachable, else null. */
    import_github_unavailable: unreachableSourceOrg,
  };
});
